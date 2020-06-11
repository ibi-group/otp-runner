const { Readable } = require('stream')

const fs = require('fs-extra')

const { addCustomExecaMock, addCustomSpawnMock } = require('./modules')

/**
 * This variable is private only to this file and can only be either accessed or
 * reset from outside of this file.
 */
let s3uploads = {}

/**
 * Adds a mocks of an s3 transfer. If the destination of the file is an s3
 * bucket, the contents of the source file will be copied to the s3uploads
 * variable for future verification.
 *
 * @param  {string} src the source file
 * @param  {string} dst the destination of where to write the sourc file to
 */
function mockS3Transfer (src, dst) {
  addCustomExecaMock({
    args: ['aws', ['s3', 'cp', src, dst]],
    fn: async () => {
      // if the destination is an s3 bucket, simulate the upload by storing the
      // contents of the file as uploaded in a lookup table
      if (dst.startsWith('s3:')) {
        s3uploads[dst] = await fs.readFile(src, 'UTF-8')
      }
    }
  })
}

/**
 * Returns the map of files that have been "mock uploaded" to s3
 */
function getS3Uploads () {
  return s3uploads
}

/**
 * A helper for mocking OTP graph builds
 * @param  {Boolean} [shouldPass=false] if set to true, a mock OTP run will be
 *  setup that successfully "runs" by writing a Graph.obj file, a graph report
 *  and mock logging success
 */
function mockOTPGraphBuild (shouldPass = false) {
  addCustomExecaMock({
    args: [
      'java',
      [
        '-jar',
        '-Xmx7902848k',
        './temp-test-files/ok.jar',
        '--build',
        'temp-test-files/default'
      ],
      { all: true }
    ],
    fn: () => {
      if (shouldPass) {
        // write a mock graph to file
        fs.writeFileSync('./temp-test-files/default/Graph.obj', 'mock graph')

        // write a mock graph build report to file
        fs.writeFileSync(
          './temp-test-files/default/report',
          'mock graph build report'
        )
      }

      // create a readable stream that otp-runner can read from in order to
      // write and analyze build logs
      const graphBuildLog = new Readable({
        read () {}
      })
      graphBuildLog.push(
        shouldPass
          ? 'Mock building completed successfully!'
          : 'Mock building failed!'
      )
      return {
        all: graphBuildLog,
        exitCode: shouldPass ? 0 : 1
      }
    }
  })
}

/**
 * A helper for mocking OTP server startups. This will create a mock of spawn
 * arguments and will write mock startup logs.
 *
 * @param  {String} [customLogs] If provided, these will be written to the mock
 *   server startup log file, instead of the mock logs that this mock generates.
 * @param  {Integer} exitCode the exit code to simulare
 * @param  {Boolean} graphLoad  if true, writes a log entry that
 *  simulates a successful graph load.
 * @param  {Boolean} serverStarts if set to true, a mock OTP run will be
 *  setup that successfully "starts" by writing a mock log file that indicates
 *  success
 */
function mockOTPServerStart ({
  customLogs,
  exitCode,
  graphLoad,
  serverStarts
}) {
  addCustomSpawnMock({
    args: [
      'java',
      [
        '-jar',
        '-Xmx7902848k',
        './temp-test-files/ok.jar',
        '--server',
        '--graphs',
        './temp-test-files/',
        '--router',
        'default'
      ]
    ],
    fn: () => {
      const logs = []
      if (graphLoad) {
        logs.push('22:10:49.222 INFO (Graph.java:731) Main graph read. |V|=156146 |E|=397357')
      }
      if (serverStarts) {
        logs.push('22:10:53.765 INFO (GrizzlyServer.java:153) Grizzly server running.')
      }

      fs.writeFileSync(
        './temp-test-files/otp-server.log',
        customLogs || logs.join('\n')
      )
      return {
        exitCode,
        kill: () => {},
        pid: 'mock-server',
        unref: () => {}
      }
    }
  })
}

/**
 * A helper for mocking the zipping up of the graph build report
 */
function mockZippingGraphBuildReport () {
  addCustomExecaMock({
    args: [
      'zip',
      [
        '-r',
        'report.zip',
        'report'
      ],
      {
        cwd: 'temp-test-files/default'
      }
    ],
    fn: async () => {
      await fs.writeFile(
        './temp-test-files/default/report.zip',
        await fs.readFile('./temp-test-files/default/report')
      )
    }
  })
}

/**
 * Resets all mock data.
 */
function resetCliMockConfig () {
  s3uploads = {}
}

module.exports = {
  getS3Uploads,
  mockOTPGraphBuild,
  mockOTPServerStart,
  mockS3Transfer,
  mockZippingGraphBuildReport,
  resetCliMockConfig
}
