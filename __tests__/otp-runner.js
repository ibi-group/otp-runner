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
      console.log('Unmocked java command!')
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
    it.only('should build a graph and start a server', async () => {
      // add to mocked commands to achieve desired return

      // simulate successful download of jar from s3
      mockS3Transfer(
        's3://mock-download-bucket/ok.jar',
        './temp-test-files/ok.jar'
      )

      // simulate successful graph build and write a few items to build log
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
          // write a mock graph to file
          fs.writeFileSync('./temp-test-files/default/graph.obj', 'mock graph')

          // write a mock graph build report to file
          fs.writeFileSync(
            './temp-test-files/default/report',
            'mock graph build report'
          )

          // create a readable stream that otp-runner can read from in order to
          // write and analyze build logs
          const graphBuildLog = new Readable({
            read () {}
          })
          graphBuildLog.push('Mock building completed successfully!')
          return {
            all: graphBuildLog,
            exitCode: 0
          }
        }
      })

      // simulate zipping up of graph build report
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

      // simulate successful server startup
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
          fs.writeFileSync('./temp-test-files/otp-server.log', `
          22:10:49.222 INFO (Graph.java:731) Main graph read. |V|=156146 |E|=397357
          22:10:53.765 INFO (GrizzlyServer.java:153) Grizzly server running.
          `)
          return {
            exitCode: null,
            pid: 'mock-server',
            unref: () => {}
          }
        }
      })

      // simulate s3 upload of build logs
      mockS3Transfer(
        './temp-test-files/otp-build.log',
        's3://mock-upload-bucket/otp-build.log'
      )

      // simulate s3 upload of server logs
      mockS3Transfer(
        './temp-test-files/otp-server.log',
        's3://mock-upload-bucket/otp-server.log'
      )

      // simulate s3 upload of graph.obj
      mockS3Transfer(
        'temp-test-files/default/graph.obj',
        's3://mock-upload-bucket/graph.obj'
      )

      // simulate s3 upload of graph build report
      mockS3Transfer(
        'temp-test-files/default/report.zip',
        's3://mock-upload-bucket/graph-build-report.zip'
      )

      // simulate s3 upload of otp-runner.log
      mockS3Transfer(
        './temp-test-files/otp-runner.log',
        's3://mock-upload-bucket/otp-runner.log'
      )

      // run otp-runner
      await runOtpRunner('./fixtures/ok-manifest.json')

      // verify that build config json was written
      expect(
        await fs.readFile('./temp-test-files/default/build-config.json', 'UTF-8')
      ).toMatchSnapshot()
      // verify that router config json was written
      expect(
        await fs.readFile('./temp-test-files/default/router-config.json', 'UTF-8')
      ).toMatchSnapshot()

      // verify that various files were mock-uploaded to s3
      await expect(s3uploads['s3://mock-upload-bucket/otp-build.log']).toMatchSnapshot()
      await expect(s3uploads['s3://mock-upload-bucket/otp-server.log']).toMatchSnapshot()
      await expect(s3uploads['s3://mock-upload-bucket/graph.obj']).toMatchSnapshot()
      await expect(s3uploads['s3://mock-upload-bucket/graph-build-report.zip']).toMatchSnapshot()
      // don't snapshot otp-runner due to differing timestamps
      await expect(s3uploads['s3://mock-upload-bucket/otp-runner.log']).toContain('INFO  Server successfully started!')
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
            's3://mock-download-bucket/failme.jar',
            './temp-test-files/failme.jar'
          ]
        ],
        fn: async () => {
          throw new Error('mock download failure')
        }
      })

      await runOtpRunner('./fixtures/bad-jar-download.json', true)
    })
  })
})
