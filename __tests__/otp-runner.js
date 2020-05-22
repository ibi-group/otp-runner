const { Readable } = require('stream')

const fs = require('fs-extra')
const isEqual = require('lodash.isequal')

// mock execa and create a registry of functions to call in case the arguments
// match.
// Each execa mock must be defined with an object with the keys `args` and `fn`.
//
// NOTE: in order to make jest happy with some out-of-scope variables, prefix
// the variable name with `mock` as needed
let mockExecaCommands = []
const mockIsEqual = isEqual
const MockReadable = Readable
jest.mock('execa', () => {
  return jest.fn((...args) => {
    for (let i = 0; i < mockExecaCommands.length; i++) {
      const curMock = mockExecaCommands[i]
      if (mockIsEqual(curMock.args, args)) {
        return curMock.fn()
      }
    }
    console.error('No mock found for execa args!', args)

    // if the command to mock is `java`, and a mock implementation isn't found,
    // it is assumed that a OTP build command hasn't been mocked. Since in this
    // case, otp-runner will not simply await the returned execa promise, a fake
    // run of java with errors written to the output stream is created.
    if (args[0] === 'java') {
      console.error('Unmocked java command!')
      // create a readable stream to simulate output from java running OTP
      const all = new MockReadable({
        read () {}
      })
      all.push(`No mock found for execa args! ${args.join(' ')}`)

      return {
        all,
        exitCode: 2
      }
    }

    // found an unmocked execa command that is assumed to not use the subprocess
    // items that execa returns
    throw new Error('No mock found for execa args!')
  })
})

// mock child_process.spawn and create a registry of functions to call in case
// the arguments match.
// Each spawn mock must be defined with an object with the keys `args` and `fn`.
//
// NOTE: in order to make jest happy with some out-of-scope variables, prefix
// the variable name with `mock` as needed
let mockSpawnCommands = []
jest.mock('child_process', () => {
  return {
    spawn: (...args) => {
      const processArgs = args.slice(0, 2)
      const spawnOptions = args[2]
      for (let i = 0; i < mockSpawnCommands.length; i++) {
        const curMock = mockSpawnCommands[i]
        if (mockIsEqual(curMock.args, processArgs)) {
          return curMock.fn(spawnOptions)
        }
      }
      console.error('No mock found for spawn args!', processArgs)

      return {
        pid: 'mock',
        exitCode: 2,
        unref: () => {
          throw new Error(`No mock found for spawn args: ${processArgs}`)
        }
      }
    }
  }
})

// mock os to get same os memory value
jest.mock('os', () => {
  return {
    totalmem: () => 10000000000
  }
})

// mock process.exit so jest doesn't exit prematurely on successful server
// startups
jest.spyOn(process, 'exit').mockImplementation(
  (code) => {
    if (code > 0) {
      throw new Error(`Process.exit(${code})`)
    }
  }
)

// import this after mocking modules above
const OtpRunner = require('../')

let s3uploads = {}
function mockS3Transfer (src, dst) {
  mockExecaCommands.push({
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
 * A helper for mocking OTP graph builds
 * @param  {Boolean} [shouldPass=false] if set to true, a mock OTP run will be
 *  setup that successfully "runs" by writing a Graph.obj file, a graph report
 *  and mock logging success
 */
function mockOTPGraphBuild (shouldPass = false) {
  mockExecaCommands.push({
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
 * A helper for mocking OTP server startups
 * @param  {Integer} exitCode the exit code to simulare
 * @param  {Boolean} graphLoad  if true, writes a log entry that
 *  simulates a successful graph load.
 * @param  {Boolean} serverStarts if set to true, a mock OTP run will be
 *  setup that successfully "starts" by writing a mock log file that indicates
 *  success
 */
function mockOTPServerStart ({
  exitCode,
  graphLoad,
  serverStarts
}) {
  mockSpawnCommands.push({
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

      fs.writeFileSync('./temp-test-files/otp-server.log', logs.join('\n'))
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
  mockExecaCommands.push({
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
 * Helper that asserts the status.json file matches a snapshot
 */
async function expectStatusToMatchSnapshot (statusFileLocation) {
  const status = JSON.parse(await fs.readFile(statusFileLocation))
  expect(status).toMatchSnapshot()
}

/**
 * Runs otp-runner and performs an assertion that the expected exit code was
 * encountered.
 *
 * @param  {string} pathToManifestJson path to manifest JSON file to use
 * @param  {Boolean} [shouldThrowError=false] If true, will expect an error to
 *  be thrown from otp-runner
 */
async function runOtpRunner (pathToManifestJson, shouldThrowError = false) {
  const manifest = require(pathToManifestJson)
  const runner = new OtpRunner(manifest)
  if (shouldThrowError) {
    await expect(runner.run()).rejects.toThrow()
  } else {
    await runner.run()
  }

  await expectStatusToMatchSnapshot(manifest.statusFileLocation)
}

const mockS3UploadDir = './temp-mock-s3-uploads'
const tempFileDir = './temp-test-files'

describe('otp-runner', () => {
  afterEach(async () => {
    // remove temp directories for files
    await fs.remove(mockS3UploadDir)
    await fs.remove(tempFileDir)
  })

  beforeEach(async () => {
    // reset execa and spawn mock registries before each test
    mockExecaCommands = []
    mockSpawnCommands = []

    // reset s3 uploads
    s3uploads = {}

    // recreate temp directories for files
    await fs.remove(mockS3UploadDir)
    await fs.remove(tempFileDir)
    await fs.ensureDir(mockS3UploadDir)
    await fs.ensureDir(tempFileDir)
  })

  describe('successes', () => {
    it('should build a graph only', async () => {
      // add to mocked commands to achieve desired return

      // simulate successful download of jar from s3
      mockS3Transfer(
        's3://mock-bucket/ok.jar',
        './temp-test-files/ok.jar'
      )

      // simulate successful graph build and write a few items to build log
      mockOTPGraphBuild(true)

      // simulate zipping up of graph build report
      mockZippingGraphBuildReport()

      // simulate s3 upload of build logs
      mockS3Transfer(
        './temp-test-files/otp-build.log',
        's3://mock-bucket/otp-build.log'
      )

      // simulate s3 upload of Graph.obj
      mockS3Transfer(
        'temp-test-files/default/Graph.obj',
        's3://mock-bucket/Graph.obj'
      )

      // simulate s3 upload of graph build report
      mockS3Transfer(
        'temp-test-files/default/report.zip',
        's3://mock-bucket/graph-build-report.zip'
      )

      // simulate s3 upload of otp-runner.log
      mockS3Transfer(
        './temp-test-files/otp-runner.log',
        's3://mock-bucket/otp-runner.log'
      )

      // run otp-runner
      await runOtpRunner('./fixtures/build-only-manifest.json')

      // verify that build config json was written
      expect(
        await fs.readFile('./temp-test-files/default/build-config.json', 'UTF-8')
      ).toMatchSnapshot()

      // verify that various files were mock-uploaded to s3
      await expect(s3uploads['s3://mock-bucket/otp-build.log']).toMatchSnapshot()
      await expect(s3uploads['s3://mock-bucket/Graph.obj']).toMatchSnapshot()
      await expect(s3uploads['s3://mock-bucket/graph-build-report.zip']).toMatchSnapshot()
      // don't snapshot otp-runner due to differing timestamps
      await expect(s3uploads['s3://mock-bucket/otp-runner.log']).toContain('INFO  Graph uploaded!')
    })

    it('should build a graph and start a server', async () => {
      // add to mocked commands to achieve desired return

      // simulate successful download of jar from s3
      mockS3Transfer(
        's3://mock-bucket/ok.jar',
        './temp-test-files/ok.jar'
      )

      // simulate successful graph build and write a few items to build log
      mockOTPGraphBuild(true)

      // simulate zipping up of graph build report
      mockZippingGraphBuildReport()

      // simulate successful server startup
      mockOTPServerStart({
        exitCode: null,
        graphLoad: true,
        serverStarts: true
      })

      // simulate s3 upload of build logs
      mockS3Transfer(
        './temp-test-files/otp-build.log',
        's3://mock-bucket/otp-build.log'
      )

      // simulate s3 upload of server logs
      mockS3Transfer(
        './temp-test-files/otp-server.log',
        's3://mock-bucket/otp-server.log'
      )

      // simulate s3 upload of Graph.obj
      mockS3Transfer(
        'temp-test-files/default/Graph.obj',
        's3://mock-bucket/Graph.obj'
      )

      // simulate s3 upload of graph build report
      mockS3Transfer(
        'temp-test-files/default/report.zip',
        's3://mock-bucket/graph-build-report.zip'
      )

      // simulate s3 upload of otp-runner.log
      mockS3Transfer(
        './temp-test-files/otp-runner.log',
        's3://mock-bucket/otp-runner.log'
      )

      // run otp-runner
      await runOtpRunner('./fixtures/build-and-server-manifest.json')

      // verify that build config json was written
      expect(
        await fs.readFile('./temp-test-files/default/build-config.json', 'UTF-8')
      ).toMatchSnapshot()
      // verify that router config json was written
      expect(
        await fs.readFile('./temp-test-files/default/router-config.json', 'UTF-8')
      ).toMatchSnapshot()

      // verify that various files were mock-uploaded to s3
      await expect(s3uploads['s3://mock-bucket/otp-build.log']).toMatchSnapshot()
      await expect(s3uploads['s3://mock-bucket/otp-server.log']).toMatchSnapshot()
      await expect(s3uploads['s3://mock-bucket/Graph.obj']).toMatchSnapshot()
      await expect(s3uploads['s3://mock-bucket/graph-build-report.zip']).toMatchSnapshot()
      // don't snapshot otp-runner due to differing timestamps
      await expect(s3uploads['s3://mock-bucket/otp-runner.log']).toContain('INFO  Server successfully started!')
    })

    it('should download a graph and start OTP server', async () => {
      // simulate successful download of jar from s3
      mockS3Transfer(
        's3://mock-bucket/ok.jar',
        './temp-test-files/ok.jar'
      )

      // simulate successful download of Graph.obj from s3
      mockS3Transfer(
        's3://mock-bucket/Graph.obj',
        'temp-test-files/default/Graph.obj'
      )

      // simulate successful server startup
      mockOTPServerStart({
        exitCode: null,
        graphLoad: true,
        serverStarts: true
      })

      // simulate s3 upload of server logs
      mockS3Transfer(
        './temp-test-files/otp-server.log',
        's3://mock-bucket/otp-server.log'
      )

      // simulate s3 upload of otp-runner.log
      mockS3Transfer(
        './temp-test-files/otp-runner.log',
        's3://mock-bucket/otp-runner.log'
      )

      // run otp-runner
      await runOtpRunner('./fixtures/server-only-manifest.json')

      // verify that router config json was written
      expect(
        await fs.readFile('./temp-test-files/default/router-config.json', 'UTF-8')
      ).toMatchSnapshot()

      // verify that various files were mock-uploaded to s3
      await expect(s3uploads['s3://mock-bucket/otp-server.log']).toMatchSnapshot()
      // don't snapshot otp-runner due to differing timestamps
      await expect(s3uploads['s3://mock-bucket/otp-runner.log']).toContain('INFO  Server successfully started!')
    })
  })

  describe('failures', () => {
    it('should fail with invalid manifest.json', async () => {
      await runOtpRunner('./fixtures/invalid-manifest.json', true)
    })

    it('should fail with ok JSON schema, but improper config', async () => {
      await runOtpRunner('./fixtures/misconfigured-manifest.json', true)
    })

    it('should fail if a download fails', async () => {
      mockExecaCommands.push({
        args: [
          'aws',
          [
            's3',
            'cp',
            's3://mock-bucket/failme.jar',
            './temp-test-files/failme.jar'
          ]
        ],
        fn: async () => {
          throw new Error('mock download failure')
        }
      })

      await runOtpRunner('./fixtures/bad-jar-download.json', true)
    })

    it('should fail if the graph build fails', async () => {
      // simulate successful download of jar from s3
      mockS3Transfer(
        's3://mock-bucket/ok.jar',
        './temp-test-files/ok.jar'
      )

      // simulate successful graph build and write a few items to build log
      mockOTPGraphBuild(false)

      // simulate s3 upload of build logs
      mockS3Transfer(
        './temp-test-files/otp-build.log',
        's3://mock-bucket/otp-build.log'
      )

      // simulate s3 upload of otp-runner.log
      mockS3Transfer(
        './temp-test-files/otp-runner.log',
        's3://mock-bucket/otp-runner.log'
      )

      // run otp-runner
      await runOtpRunner('./fixtures/build-and-server-manifest.json', true)

      // verify that various files were mock-uploaded to s3
      await expect(s3uploads['s3://mock-bucket/otp-build.log']).toMatchSnapshot()
      // don't snapshot otp-runner due to differing timestamps
      await expect(s3uploads['s3://mock-bucket/otp-runner.log']).toContain('Build graph failed! Please see logs.')
    })

    it('should fail if graph build succeeds, but graph upload fails', async () => {
      // add to mocked commands to achieve desired return

      // simulate successful download of jar from s3
      mockS3Transfer(
        's3://mock-bucket/ok.jar',
        './temp-test-files/ok.jar'
      )

      // simulate successful graph build and write a few items to build log
      mockOTPGraphBuild(true)

      // simulate zipping up of graph build report
      mockZippingGraphBuildReport()

      // simulate s3 upload of build logs
      mockS3Transfer(
        './temp-test-files/otp-build.log',
        's3://mock-bucket/otp-build.log'
      )

      // simulate s3 upload of graph build report
      mockS3Transfer(
        'temp-test-files/default/report.zip',
        's3://mock-bucket/graph-build-report.zip'
      )

      // simulate s3 upload of otp-runner.log
      mockS3Transfer(
        './temp-test-files/otp-runner.log',
        's3://mock-bucket/otp-runner.log'
      )

      // simulate failure of graph upload
      mockExecaCommands.push({
        args: [
          'aws',
          [
            's3',
            'cp',
            'temp-test-files/default/Graph.obj',
            's3://mock-bucket/Graph.obj'
          ]
        ],
        fn: async () => {
          throw new Error('mock upload failure')
        }
      })

      // run otp-runner
      await runOtpRunner('./fixtures/build-only-manifest.json', true)

      // verify that build config json was written
      expect(
        await fs.readFile('./temp-test-files/default/build-config.json', 'UTF-8')
      ).toMatchSnapshot()

      // verify that various files were mock-uploaded to s3
      await expect(s3uploads['s3://mock-bucket/otp-build.log']).toMatchSnapshot()
      await expect(s3uploads['s3://mock-bucket/Graph.obj']).not.toBeDefined()
      await expect(s3uploads['s3://mock-bucket/graph-build-report.zip']).toMatchSnapshot()
      // don't snapshot otp-runner due to differing timestamps
      await expect(s3uploads['s3://mock-bucket/otp-runner.log']).toContain('ERROR Failed to upload temp-test-files/default/Graph.obj to s3://mock-bucket/Graph.obj!')
    })

    it('should fail if OTP server starts without loading a graph', async () => {
      // simulate successful download of jar from s3
      mockS3Transfer(
        's3://mock-bucket/ok.jar',
        './temp-test-files/ok.jar'
      )

      // simulate successful download of Graph.obj from s3
      mockS3Transfer(
        's3://mock-bucket/Graph.obj',
        'temp-test-files/default/Graph.obj'
      )

      // simulate successful server startup
      mockOTPServerStart({
        exitCode: null,
        graphLoad: false,
        serverStarts: true
      })

      // simulate s3 upload of server logs
      mockS3Transfer(
        './temp-test-files/otp-server.log',
        's3://mock-bucket/otp-server.log'
      )

      // simulate s3 upload of otp-runner.log
      mockS3Transfer(
        './temp-test-files/otp-runner.log',
        's3://mock-bucket/otp-runner.log'
      )

      // run otp-runner
      await runOtpRunner('./fixtures/server-only-manifest.json', true)

      // verify that router config json was written
      expect(
        await fs.readFile('./temp-test-files/default/router-config.json', 'UTF-8')
      ).toMatchSnapshot()

      // verify that various files were mock-uploaded to s3
      await expect(s3uploads['s3://mock-bucket/otp-server.log']).toMatchSnapshot()
      // don't snapshot otp-runner due to differing timestamps
      await expect(s3uploads['s3://mock-bucket/otp-runner.log']).toContain('ERROR Server took longer than 2 seconds to start!')
    })

    it('should fail if OTP server fails to start', async () => {
      // simulate successful download of jar from s3
      mockS3Transfer(
        's3://mock-bucket/ok.jar',
        './temp-test-files/ok.jar'
      )

      // simulate successful download of Graph.obj from s3
      mockS3Transfer(
        's3://mock-bucket/Graph.obj',
        'temp-test-files/default/Graph.obj'
      )

      // simulate successful server startup
      mockOTPServerStart({
        exitCode: 1,
        graphLoad: true,
        serverStarts: false
      })

      // simulate s3 upload of server logs
      mockS3Transfer(
        './temp-test-files/otp-server.log',
        's3://mock-bucket/otp-server.log'
      )

      // simulate s3 upload of otp-runner.log
      mockS3Transfer(
        './temp-test-files/otp-runner.log',
        's3://mock-bucket/otp-runner.log'
      )

      // run otp-runner
      await runOtpRunner('./fixtures/server-only-manifest.json', true)

      // verify that router config json was written
      expect(
        await fs.readFile('./temp-test-files/default/router-config.json', 'UTF-8')
      ).toMatchSnapshot()

      // verify that various files were mock-uploaded to s3
      await expect(s3uploads['s3://mock-bucket/otp-server.log']).toMatchSnapshot()
      // don't snapshot otp-runner due to differing timestamps
      await expect(s3uploads['s3://mock-bucket/otp-runner.log']).toContain('ERROR Server failed to start and exited with code 1')
    })

    it('should fail if OTP server takes too long to start', async () => {
      // simulate successful download of jar from s3
      mockS3Transfer(
        's3://mock-bucket/ok.jar',
        './temp-test-files/ok.jar'
      )

      // simulate successful download of Graph.obj from s3
      mockS3Transfer(
        's3://mock-bucket/Graph.obj',
        'temp-test-files/default/Graph.obj'
      )

      // simulate successful server startup
      mockOTPServerStart({
        exitCode: null,
        graphLoad: true,
        serverStarts: false
      })

      // simulate s3 upload of server logs
      mockS3Transfer(
        './temp-test-files/otp-server.log',
        's3://mock-bucket/otp-server.log'
      )

      // simulate s3 upload of otp-runner.log
      mockS3Transfer(
        './temp-test-files/otp-runner.log',
        's3://mock-bucket/otp-runner.log'
      )

      // run otp-runner
      await runOtpRunner('./fixtures/server-only-manifest.json', true)

      // verify that router config json was written
      expect(
        await fs.readFile('./temp-test-files/default/router-config.json', 'UTF-8')
      ).toMatchSnapshot()

      // verify that various files were mock-uploaded to s3
      await expect(s3uploads['s3://mock-bucket/otp-server.log']).toMatchSnapshot()
      // don't snapshot otp-runner due to differing timestamps
      await expect(s3uploads['s3://mock-bucket/otp-runner.log']).toContain('ERROR Server took longer than 2 seconds to start!')
    })
  })
})
