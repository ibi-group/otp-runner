const fs = require('fs-extra')
const nock = require('nock')

const OtpRunner = require('../lib')

const { TEMP_TEST_FOLDER } = require('./test-utils/constants')
const {
  addCustomExecaMock,
  resetModuleMockConfig
} = require('./test-utils/mocks/modules')
const {
  getS3Uploads,
  mockLocalToS3Transfer,
  mockOTPGraphBuild,
  mockOTPServerStart,
  mockS3ToLocalTransfer,
  mockS3Transfer,
  mockZippingGraphBuildReport,
  resetCliMockConfig
} = require('./test-utils/mocks/cli-processes')

// IMPORTANT: import this after mocking modules

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

// Each of the mocked runner tests in this test suite follow a general pattern
// of setting up mock behaviors, running otp-runner and then verifying that the
// expected output and result of otp-runner occurred.
//
// The tests are organized into successful runs on otp-runner and other runs
// where a problem is simulated wherein it is expected that otp-runner will
// gracefully fail.
//
// Each mock behavior that is defined will be one of the following:
// - simulating a file transfer using AWS S3
// - simulating an OTP graph build (with failure or success)
// - simulating an OTP server start (with failure or success)
// - simulating the zipping up of the OTP graph build report
// - getting the instance ID of an AWS EC2 instance
// - a custom mock of the invocation of the execa module (typically to model a
//     failed AWS S3 transfer)
//
// otp-runner is ran with the given manifest and either an assertion is made for
// whether the script is expected to succeed or fail. Also, the status file is
// snapshotted after otp-runner finishes to make sure it matches expectations.
//
// After otp-runner is ran, assertions are made that include the following:
// - asserting that either or both the build-config or router-config files
//     were written
// - asserting that various files were mock-uploaded to S3 with the expected
//     contents
describe('otp-runner', () => {
  const tempFileDir = `./${TEMP_TEST_FOLDER}`
  afterEach(async () => {
    // remove temp directories for files
    await fs.remove(mockS3UploadDir)
    await fs.remove(tempFileDir)
  })

  beforeEach(async () => {
    // reset mock module config
    resetModuleMockConfig()

    // reset cli mock config
    resetCliMockConfig()

    // recreate temp directories for files
    await fs.remove(mockS3UploadDir)
    await fs.remove(tempFileDir)
    await fs.ensureDir(mockS3UploadDir)
    await fs.ensureDir(tempFileDir)
  })

  describe('unit tests', () => {
    const buildOnlyManifest = require('./fixtures/build-only-manifest.json')
    const serveOnlyManifest = require('./fixtures/server-only-manifest.json')
    it('should generate 1.x build cli arguments', () => {
      const runner = new OtpRunner(buildOnlyManifest)
      runner.validateManifest()
      expect(runner.makeBuildArgs()).toMatchSnapshot()
    })

    it('should generate 2.x build cli arguments', () => {
      const runner = new OtpRunner({
        ...buildOnlyManifest,
        otpVersion: '2.x'
      })
      runner.validateManifest()
      expect(runner.makeBuildArgs()).toMatchSnapshot()
    })

    it('should generate 1.x serve cli arguments', () => {
      const runner = new OtpRunner(serveOnlyManifest)
      runner.validateManifest()
      expect(runner.makeServeArgs()).toMatchSnapshot()
    })

    it('should generate 2.x serve cli arguments', () => {
      const runner = new OtpRunner({
        ...serveOnlyManifest,
        otpVersion: '2.x'
      })
      runner.validateManifest()
      expect(runner.makeServeArgs()).toMatchSnapshot()
    })
  })

  describe('mocked runner tests', () => {
    describe('successes', () => {
      it('should build a graph only', async () => {
        // add to mocked commands to achieve desired return

        // simulate successful download of jar from AWS S3
        mockS3ToLocalTransfer('ok.jar')

        // simulate successful download of GTFS zip file from AWS S3
        mockS3ToLocalTransfer('gtfs.zip', `${TEMP_TEST_FOLDER}/default/gtfs.zip`)

        // simulate successful graph build and write a few items to build log
        mockOTPGraphBuild(true)

        // simulate zipping up of graph build report
        mockZippingGraphBuildReport()

        // simulate AWS S3 upload of build logs
        mockLocalToS3Transfer('otp-build.log')

        // simulate AWS S3 upload of Graph.obj
        mockLocalToS3Transfer('Graph.obj', `${TEMP_TEST_FOLDER}/default/Graph.obj`)

        // simulate AWS S3 upload of graph build report
        mockLocalToS3Transfer(
          'graph-build-report.zip',
          `${TEMP_TEST_FOLDER}/default/report.zip`
        )

        // simulate AWS S3 upload of otp-runner.log
        mockLocalToS3Transfer('otp-runner.log')

        // run otp-runner
        await runOtpRunner('./fixtures/build-only-manifest.json')

        // verify that build config json was written
        expect(
          await fs.readFile(`./${TEMP_TEST_FOLDER}/default/build-config.json`, 'UTF-8')
        ).toMatchSnapshot()

        // verify that various files were mock-uploaded to AWS S3
        const s3uploads = getS3Uploads()
        await expect(s3uploads['s3://mock-bucket/otp-build.log']).toMatchSnapshot()
        await expect(s3uploads['s3://mock-bucket/Graph.obj']).toMatchSnapshot()
        await expect(s3uploads['s3://mock-bucket/graph-build-report.zip']).toMatchSnapshot()
        // don't snapshot otp-runner due to differing timestamps
        await expect(s3uploads['s3://mock-bucket/otp-runner.log']).toContain('INFO  Graph uploaded!')
      })

      it('should build a graph and start a server', async () => {
        // add to mocked commands to achieve desired return

        // simulate successful download of jar from AWS S3
        mockS3ToLocalTransfer('ok.jar')

        // simulate successful download of GTFS zip file from AWS S3
        mockS3ToLocalTransfer('gtfs.zip', `${TEMP_TEST_FOLDER}/default/gtfs.zip`)

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

        // simulate AWS S3 upload of build logs
        mockLocalToS3Transfer('otp-build.log')

        // simulate AWS S3 upload of server logs
        mockLocalToS3Transfer('otp-server.log')

        // simulate AWS S3 upload of Graph.obj
        mockLocalToS3Transfer(
          'Graph.obj',
          `${TEMP_TEST_FOLDER}/default/Graph.obj`
        )

        // simulate AWS S3 upload of graph build report)
        mockLocalToS3Transfer(
          'graph-build-report.zip',
          `${TEMP_TEST_FOLDER}/default/report.zip`
        )

        // simulate AWS S3 upload of otp-runner.log
        mockLocalToS3Transfer('otp-runner.log')

        // run otp-runner
        await runOtpRunner('./fixtures/build-and-server-manifest.json')

        // verify that build config json was written
        expect(
          await fs.readFile(
            `./${TEMP_TEST_FOLDER}/default/build-config.json`,
            'UTF-8'
          )
        ).toMatchSnapshot()
        // verify that router config json was written
        expect(
          await fs.readFile(
            `./${TEMP_TEST_FOLDER}/default/router-config.json`,
            'UTF-8'
          )
        ).toMatchSnapshot()

        // verify that various files were mock-uploaded to AWS S3
        const s3uploads = getS3Uploads()
        await expect(s3uploads['s3://mock-bucket/otp-build.log']).toMatchSnapshot()
        await expect(s3uploads['s3://mock-bucket/otp-server.log']).toMatchSnapshot()
        await expect(s3uploads['s3://mock-bucket/Graph.obj']).toMatchSnapshot()
        await expect(
          s3uploads['s3://mock-bucket/graph-build-report.zip']
        ).toMatchSnapshot()
        // don't snapshot otp-runner due to differing timestamps
        await expect(
          s3uploads['s3://mock-bucket/otp-runner.log']
        ).toContain('INFO  Server successfully started!')
      })

      it('should use otp 2.x to build a graph and start a server', async () => {
        // add to mocked commands to achieve desired return

        // simulate successful download of jar from AWS S3
        mockS3ToLocalTransfer('ok-otp-2.jar')

        // simulate successful download of GTFS zip file from AWS S3
        mockS3ToLocalTransfer(
          'gtfs.zip',
          `${TEMP_TEST_FOLDER}/otp2-base-folder/gtfs.zip`
        )

        // simulate successful graph build and write a few items to build log
        mockOTPGraphBuild(true, true)

        // simulate zipping up of graph build report
        mockZippingGraphBuildReport(true)

        // simulate successful server startup
        mockOTPServerStart({
          exitCode: null,
          graphLoad: true,
          otpV2: true,
          serverStarts: true
        })

        // simulate AWS S3 upload of build logs
        mockLocalToS3Transfer('otp-build.log')

        // simulate AWS S3 upload of server logs
        mockLocalToS3Transfer('otp-server.log')

        // simulate AWS S3 upload of Graph.obj
        mockLocalToS3Transfer(
          'graph.obj',
          `${TEMP_TEST_FOLDER}/otp2-base-folder/graph.obj`
        )

        // simulate AWS S3 upload of graph build report
        mockLocalToS3Transfer(
          'graph-build-report.zip',
          `${TEMP_TEST_FOLDER}/otp2-base-folder/report.zip`
        )

        // simulate AWS S3 upload of otp-runner.log
        mockLocalToS3Transfer('otp-runner.log')

        // run otp-runner
        await runOtpRunner('./fixtures/otp-2-build-and-server-manifest.json')

        // verify that build config json was written
        expect(
          await fs.readFile(
            `./${TEMP_TEST_FOLDER}/otp2-base-folder/build-config.json`,
            'UTF-8'
          )
        ).toMatchSnapshot()
        // verify that router config json was written
        expect(
          await fs.readFile(
            `./${TEMP_TEST_FOLDER}/otp2-base-folder/router-config.json`,
            'UTF-8'
          )
        ).toMatchSnapshot()

        // verify that various files were mock-uploaded to AWS S3
        const s3uploads = getS3Uploads()
        await expect(s3uploads['s3://mock-bucket/otp-build.log']).toMatchSnapshot()
        await expect(s3uploads['s3://mock-bucket/otp-server.log']).toMatchSnapshot()
        await expect(s3uploads['s3://mock-bucket/graph.obj']).toMatchSnapshot()
        await expect(s3uploads['s3://mock-bucket/graph-build-report.zip']).toMatchSnapshot()
        // don't snapshot otp-runner due to differing timestamps
        await expect(s3uploads['s3://mock-bucket/otp-runner.log']).toContain('INFO  Server successfully started!')
      })

      it('should download a graph and start OTP server', async () => {
        // simulate successful download of jar from AWS S3
        mockS3ToLocalTransfer('ok.jar')

        // simulate successful download of Graph.obj from AWS S3
        mockS3ToLocalTransfer('Graph.obj', `${TEMP_TEST_FOLDER}/default/Graph.obj`)

        // simulate successful server startup
        mockOTPServerStart({
          exitCode: null,
          graphLoad: true,
          serverStarts: true
        })

        const mockInstanceId = 'i-123456'

        // simulate AWS S3 upload of server logs
        mockS3Transfer(
          `./${TEMP_TEST_FOLDER}/otp-server.log`,
          `s3://mock-bucket/${mockInstanceId}-otp-server.log`
        )

        // simulate AWS S3 upload of otp-runner.log
        mockS3Transfer(
          `./${TEMP_TEST_FOLDER}/otp-runner.log`,
          `s3://mock-bucket/${mockInstanceId}-otp-runner.log`
        )

        // simulate aws ec2 instance ID http request
        nock('http://169.254.169.254')
          .get('/latest/meta-data/instance-id')
          .reply(200, mockInstanceId)

        // run otp-runner
        await runOtpRunner(
          './fixtures/server-only-manifest-with-log-prefixing.json'
        )

        // verify that router config json was written
        expect(
          await fs.readFile(
            `./${TEMP_TEST_FOLDER}/default/router-config.json`,
            'UTF-8'
          )
        ).toMatchSnapshot()

        // verify that various files were mock-uploaded to AWS S3
        const s3uploads = getS3Uploads()
        await expect(
          s3uploads[`s3://mock-bucket/${mockInstanceId}-otp-server.log`]
        ).toMatchSnapshot()
        // don't snapshot otp-runner due to differing timestamps
        await expect(
          s3uploads[`s3://mock-bucket/${mockInstanceId}-otp-runner.log`]
        ).toContain('INFO  Server successfully started!')
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
        addCustomExecaMock({
          args: [
            'aws',
            [
              's3',
              'cp',
              's3://mock-bucket/failme.jar',
              `./${TEMP_TEST_FOLDER}/failme.jar`
            ]
          ],
          fn: async () => {
            throw new Error('mock download failure')
          }
        })

        // simulate successful download of GTFS zip file from AWS S3
        mockS3ToLocalTransfer(
          'gtfs.zip',
          `${TEMP_TEST_FOLDER}/default/gtfs.zip`
        )

        await runOtpRunner('./fixtures/bad-jar-download.json', true)
      })

      it('should fail if the graph build fails', async () => {
        // simulate successful download of jar from AWS S3
        mockS3ToLocalTransfer('ok.jar')

        // simulate successful download of GTFS zip file from AWS S3
        mockS3ToLocalTransfer(
          'gtfs.zip',
          `${TEMP_TEST_FOLDER}/default/gtfs.zip`
        )

        // simulate successful graph build and write a few items to build log
        mockOTPGraphBuild(false)

        // simulate AWS S3 upload of build logs
        mockLocalToS3Transfer('otp-build.log')

        // simulate AWS S3 upload of otp-runner.log
        mockLocalToS3Transfer('otp-runner.log')

        // run otp-runner
        await runOtpRunner('./fixtures/build-and-server-manifest.json', true)

        // verify that various files were mock-uploaded to AWS S3
        const s3uploads = getS3Uploads()
        await expect(
          s3uploads['s3://mock-bucket/otp-build.log']
        ).toMatchSnapshot()
        // don't snapshot otp-runner due to differing timestamps
        await expect(
          s3uploads['s3://mock-bucket/otp-runner.log']
        ).toContain('Build graph failed! Please see logs.')
      })

      it('should fail if graph build succeeds, but graph upload fails', async () => {
        // add to mocked commands to achieve desired return

        // simulate successful download of jar from AWS S3
        mockS3ToLocalTransfer('ok.jar')

        // simulate successful download of GTFS zip file from AWS S3
        mockS3ToLocalTransfer(
          'gtfs.zip',
          `${TEMP_TEST_FOLDER}/default/gtfs.zip`
        )

        // simulate successful graph build and write a few items to build log
        mockOTPGraphBuild(true)

        // simulate zipping up of graph build report
        mockZippingGraphBuildReport()

        // simulate AWS S3 upload of build logs
        mockLocalToS3Transfer('otp-build.log')

        // simulate AWS S3 upload of graph build report
        mockLocalToS3Transfer(
          'graph-build-report.zip',
          `${TEMP_TEST_FOLDER}/default/report.zip`
        )

        // simulate AWS S3 upload of otp-runner.log
        mockLocalToS3Transfer('otp-runner.log')

        // simulate failure of graph upload
        addCustomExecaMock({
          args: [
            'aws',
            [
              's3',
              'cp',
              `${TEMP_TEST_FOLDER}/default/Graph.obj`,
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
          await fs.readFile(
            `./${TEMP_TEST_FOLDER}/default/build-config.json`,
            'UTF-8'
          )
        ).toMatchSnapshot()

        // verify that various files were mock-uploaded to AWS S3
        const s3uploads = getS3Uploads()
        await expect(
          s3uploads['s3://mock-bucket/otp-build.log']
        ).toMatchSnapshot()
        await expect(s3uploads['s3://mock-bucket/Graph.obj']).not.toBeDefined()
        await expect(
          s3uploads['s3://mock-bucket/graph-build-report.zip']
        ).toMatchSnapshot()
        // don't snapshot otp-runner due to differing timestamps
        await expect(
          s3uploads['s3://mock-bucket/otp-runner.log']
        ).toContain(
          'ERROR Failed to upload temp-test-files/default/Graph.obj to s3://mock-bucket/Graph.obj!'
        )
      })

      it('should fail if OTP server starts without loading a graph', async () => {
        // simulate successful download of jar from AWS S3
        mockS3ToLocalTransfer('ok.jar')

        // simulate successful download of Graph.obj from AWS S3
        mockS3ToLocalTransfer(
          'Graph.obj',
          `${TEMP_TEST_FOLDER}/default/Graph.obj`
        )

        // simulate successful server startup
        mockOTPServerStart({
          exitCode: null,
          graphLoad: false,
          serverStarts: true
        })

        // simulate AWS S3 upload of server logs
        mockLocalToS3Transfer('otp-server.log')

        // simulate AWS S3 upload of otp-runner.log
        mockLocalToS3Transfer('otp-runner.log')

        // run otp-runner
        await runOtpRunner('./fixtures/server-only-manifest.json', true)

        // verify that router config json was written
        expect(
          await fs.readFile(
            `./${TEMP_TEST_FOLDER}/default/router-config.json`,
            'UTF-8'
          )
        ).toMatchSnapshot()

        // verify that various files were mock-uploaded to AWS S3
        const s3uploads = getS3Uploads()
        await expect(
          s3uploads['s3://mock-bucket/otp-server.log']
        ).toMatchSnapshot()
        // don't snapshot otp-runner due to differing timestamps
        await expect(
          s3uploads['s3://mock-bucket/otp-runner.log']
        ).toContain('ERROR Server took longer than 2 seconds to start!')
      })

      it('should fail if OTP server fails to start', async () => {
        // simulate successful download of jar from AWS S3
        mockS3ToLocalTransfer('ok.jar')

        // simulate successful download of Graph.obj from AWS S3
        mockS3ToLocalTransfer(
          'Graph.obj',
          `${TEMP_TEST_FOLDER}/default/Graph.obj`
        )

        // simulate successful server startup
        mockOTPServerStart({
          exitCode: 1,
          graphLoad: true,
          serverStarts: false
        })

        // simulate AWS S3 upload of server logs
        mockLocalToS3Transfer('otp-server.log')

        // simulate AWS S3 upload of otp-runner.log
        mockLocalToS3Transfer('otp-runner.log')

        // run otp-runner
        await runOtpRunner('./fixtures/server-only-manifest.json', true)

        // verify that router config json was written
        expect(
          await fs.readFile(
            `./${TEMP_TEST_FOLDER}/default/router-config.json`,
            'UTF-8'
          )
        ).toMatchSnapshot()

        // verify that various files were mock-uploaded to AWS S3
        const s3uploads = getS3Uploads()
        await expect(
          s3uploads['s3://mock-bucket/otp-server.log']
        ).toMatchSnapshot()
        // don't snapshot otp-runner due to differing timestamps
        await expect(
          s3uploads['s3://mock-bucket/otp-runner.log']
        ).toContain('ERROR Server failed to start and exited with code 1')
      })

      it('should fail if OTP server takes too long to start', async () => {
        // simulate successful download of jar from AWS S3
        mockS3ToLocalTransfer('ok.jar')

        // simulate successful download of Graph.obj from AWS S3
        mockS3ToLocalTransfer(
          'Graph.obj',
          `${TEMP_TEST_FOLDER}/default/Graph.obj`
        )

        // simulate successful server startup
        mockOTPServerStart({
          exitCode: null,
          graphLoad: true,
          serverStarts: false
        })

        // simulate AWS S3 upload of server logs
        mockLocalToS3Transfer('otp-server.log')

        // simulate AWS S3 upload of otp-runner.log
        mockLocalToS3Transfer('otp-runner.log')

        // run otp-runner
        await runOtpRunner('./fixtures/server-only-manifest.json', true)

        // verify that router config json was written
        expect(
          await fs.readFile(
            `./${TEMP_TEST_FOLDER}/default/router-config.json`,
            'UTF-8'
          )
        ).toMatchSnapshot()

        // verify that various files were mock-uploaded to AWS S3
        const s3uploads = getS3Uploads()
        await expect(
          s3uploads['s3://mock-bucket/otp-server.log']
        ).toMatchSnapshot()
        // don't snapshot otp-runner due to differing timestamps
        await expect(
          s3uploads['s3://mock-bucket/otp-runner.log']
        ).toContain('ERROR Server took longer than 2 seconds to start!')
      })

      it('should fail if OTP server fails to read graph', async () => {
        // simulate successful download of jar from AWS S3
        mockS3ToLocalTransfer('ok.jar')

        // simulate successful download of Graph.obj from AWS S3
        mockS3ToLocalTransfer(
          'Graph.obj',
          `${TEMP_TEST_FOLDER}/default/Graph.obj`
        )

        // simulate successful server startup, but with failed graph read
        const logs = []
        logs.push('16:59:42.029 INFO (InputStreamGraphSource.java:177) Loading graph...')
        logs.push('16:59:42.493 ERROR (InputStreamGraphSource.java:181) Exception while loading graph \'default\'.')
        logs.push('com.esotericsoftware.kryo.KryoException: Encountered unregistered class ID: 13994')
        logs.push('        at com.esotericsoftware.kryo.util.DefaultClassResolver.readClass(DefaultClassResolver.java:137) ~[otp-latest-ibi-dev:1.1]')
        logs.push('16:59:42.494 WARN (InputStreamGraphSource.java:114) Unable to load data for router \'default\'.')
        logs.push('16:59:42.494 WARN (GraphService.java:185) Can\'t register router ID \'default\', no graph.')
        logs.push('16:59:42.499 INFO (GrizzlyServer.java:72) Starting OTP Grizzly server on ports 8080 (HTTP) and 8081 (HTTPS) of interface 0.0.0.0')
        logs.push('16:59:45.811 INFO (GrizzlyServer.java:153) Grizzly server running.')

        mockOTPServerStart({
          customLogs: logs.join('\n'),
          exitCode: null
        })

        // simulate AWS S3 upload of server logs
        mockLocalToS3Transfer('otp-server.log')

        // simulate AWS S3 upload of otp-runner.log
        mockLocalToS3Transfer('otp-runner.log')

        // run otp-runner
        await runOtpRunner('./fixtures/server-only-manifest.json', true)

        // verify that router config json was written
        expect(
          await fs.readFile(
            `./${TEMP_TEST_FOLDER}/default/router-config.json`,
            'UTF-8'
          )
        ).toMatchSnapshot()

        // verify that various files were mock-uploaded to AWS S3
        const s3uploads = getS3Uploads()
        await expect(
          s3uploads['s3://mock-bucket/otp-server.log']
        ).toMatchSnapshot()
        // don't snapshot otp-runner due to differing timestamps
        await expect(
          s3uploads['s3://mock-bucket/otp-runner.log']
        ).toContain('ERROR An error occurred while trying to start the OTP Server!')
      })
    })
  })
})
