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
 * @param  {string} dst the destination of where to write the source file to
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
 * Shorthand function to create a mock for an aws s3 cp operation that transfers
 * a file from the local machine to s3. This assumes the default s3 bucket and
 * default local temp test files location are used, unless the localPath
 * argument is also provided.
 *
 * @param  {String} filename The filename without paths to transfer. It is
 *    assumed that this filename is present in the ./temp-test-files folder and
 *    that the file should be uploaded to the s3://mock-bucket s3 bucket.
 * @param  {String} [localPath] If provided, use this path instead of just the
 *    temp-test-files folder plus the filename.
 */
function mockLocalToS3Transfer (filename, localPath) {
  const src = localPath || `./temp-test-files/${filename}`
  const dst = `s3://mock-bucket/${filename}`
  mockS3Transfer(src, dst)
}

/**
 * Shorthand function to create a mock for an aws s3 cp operation that transfers
 * a file from s3 to the local machine. This assumes the default s3 bucket and
 * default local temp test files location are used, unless the localPath
 * argument is also provided.
 *
 * @param  {String} filename The filename without paths to transfer. It is
 *    assumed that this filename is present in the s3://mock-bucket s3 bucket
 *    and that the file should be downloaded into the ./temp-test-files folder.
 * @param  {String} [localPath] If provided, use this path instead of just the
 *    temp-test-files folder plus the filename.
 */
function mockS3ToLocalTransfer (filename, localPath) {
  mockS3Transfer(
    `s3://mock-bucket/${filename}`,
    localPath || `./temp-test-files/${filename}`
  )
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
function mockOTPGraphBuild (shouldPass = false, otpV2 = false) {
  const javaArgs = [
    '-jar',
    '-Xmx7902848k'
  ]
  const baseFolder = otpV2
    ? 'temp-test-files/otp2-base-folder'
    : 'temp-test-files/default'
  if (otpV2) {
    javaArgs.push('./temp-test-files/ok-otp-2.jar')
    javaArgs.push('--build')
    javaArgs.push('--save')
    javaArgs.push(`./${baseFolder}`)
  } else {
    javaArgs.push('./temp-test-files/ok.jar')
    javaArgs.push('--build')
    javaArgs.push(baseFolder)
  }
  addCustomExecaMock({
    args: ['java', javaArgs, { all: true }],
    fn: () => {
      if (shouldPass) {
        // write a mock graph to file
        fs.writeFileSync(
          `./${baseFolder}/${otpV2 ? 'graph.obj' : 'Graph.obj'}`,
          'mock graph'
        )

        // write a mock graph build report to file
        fs.writeFileSync(
          `./${baseFolder}/report`,
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
 * @param  {Integer} exitCode the exit code to simulate
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
  otpV2,
  serverStarts
}) {
  const javaArgs = [
    '-jar',
    '-Xmx7902848k'
  ]
  if (otpV2) {
    javaArgs.push('./temp-test-files/ok-otp-2.jar')
    javaArgs.push('--load')
    javaArgs.push('./temp-test-files/otp2-base-folder')
  } else {
    javaArgs.push('./temp-test-files/ok.jar')
    javaArgs.push('--server')
    javaArgs.push('--graphs')
    javaArgs.push('./temp-test-files/')
    javaArgs.push('--router')
    javaArgs.push('default')
  }
  addCustomSpawnMock({
    args: ['java', javaArgs],
    fn: () => {
      const logs = []
      if (graphLoad) {
        if (otpV2) {
          logs.push('22:10:49.222 INFO (Graph.java:731) Graph read. |V|=156146 |E|=397357')
        } else {
          logs.push('22:10:49.222 INFO (Graph.java:731) Main graph read. |V|=156146 |E|=397357')
        }
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
function mockZippingGraphBuildReport (otpV2 = false) {
  let baseFolder, cwd
  if (otpV2) {
    baseFolder = './temp-test-files/otp2-base-folder/'
    cwd = './temp-test-files/otp2-base-folder'
  } else {
    baseFolder = './temp-test-files/default/'
    cwd = 'temp-test-files/default'
  }
  addCustomExecaMock({
    args: ['zip', ['-r', 'report.zip', 'report'], { cwd }],
    fn: async () => {
      await fs.writeFile(
        `${baseFolder}report.zip`,
        await fs.readFile(`${baseFolder}report`)
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
  mockLocalToS3Transfer,
  mockOTPGraphBuild,
  mockOTPServerStart,
  mockS3ToLocalTransfer,
  mockS3Transfer,
  mockZippingGraphBuildReport,
  resetCliMockConfig
}
