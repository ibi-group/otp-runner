/**
 * This script will automate common tasks with OpenTripPlanner such as
 * downloading needed OSM and GTFS files, builing a graph and running a graph.
 */

const { spawn } = require('child_process')
const os = require('os')
const path = require('path')
const stream = require('stream')
const {promisify} = require('util')

const Ajv = require('ajv')
const CircularBuffer = require('circular-buffer')
const execa = require('execa')
const fs = require('fs-extra')
const got = require('got')
const SimpleNodeLogger = require('simple-node-logger')

const manifestJsonSchema = require('./manifest-json-schema.json')

const pipeline = promisify(stream.pipeline)

module.exports = class OtpRunner {
  constructor (manifest) {
    this.log = SimpleNodeLogger.createSimpleLogger(
      manifest.otpRunnerLogFile || './otp-runner.log'
    )
    this.downloadTasks = []
    this.manifest = manifest
    this.status = {
      error: false,
      graphBuilt: false,
      graphUploaded: false,
      serverStarted: false,
      message: 'Inintializing...',
      numFilesDownloaded: 0,
      pctProgress: 0,
      totalFilesToDownload: 0
    }
    // print some startup messages
    this.log.info('otp-runner has started!')
    this.log.info('Received a manifest:')
    this.log.info(JSON.stringify(manifest, null, 2))
  }

  async fail (message) {
    this.log.error(message)
    this.status.error = true
    this.status.message = message
    // wait 1 second for error logging to write to file
    await this.waitOneSecond()
    await Promise.all([
      this.uploadOtpRunnerLogs(),
      this.updateStatus()
    ])
    throw new Error(message)
  }

  /**
   * Updates the status file with the overall progress.
   *
   * @param  {string} [message]     If provided, a new message to update the
   *  status with before writing to file.
   * @param  {number} [pctProgress] If provided, a new percent progress to set
   */
  async updateStatus (message, pctProgress) {
    if (message) {
      this.log.info(message)
      this.status.message = message
    }
    if (pctProgress) {
      this.status.pctProgress = pctProgress
    }
    await fs.writeFile(
      (this.manifest && this.manifest.statusFileLocation)
        ? this.manifest.statusFileLocation
        : './status.json',
      JSON.stringify(this.status)
    )
  }

  /**
   * Updates the overall status after each file is downloaded.
   */
  async updateDownloadStatus (urlDownloaded) {
    // increment number of files downloaded and create string component for the
    // progress.
    this.status.numFilesDownloaded++
    const { numFilesDownloaded, totalFilesToDownload } = this.status
    const progressString = `(${numFilesDownloaded} / ${totalFilesToDownload} files)`

    // calculate the contribution to the overall otp-runner progress based on
    // what is in the manifest
    let downloadProgressComponent
    if (this.manifest.buildGraph && this.manifest.runServer) {
      // building graph and starting server
      // goes from 10% to 30%
      downloadProgressComponent = 20
    } else if (this.manifest.buildGraph) {
      // just building graph
      // goes from 10% to 50%
      downloadProgressComponent = 40
    } else {
      // just starting server
      // goes from 10% to 40%
      downloadProgressComponent = 30
    }
    await this.updateStatus(
      `Downloaded ${urlDownloaded} ${progressString}`,
      // update overall progress given whether
      10 + downloadProgressComponent * numFilesDownloaded / totalFilesToDownload
    )
  }

  /**
   * Downloads a file using a sreaming API if it doesn't already exist. Updates
   * the status after each download.
   *
   * @param  {string} dest The path to save the downloaded file to
   * @param  {string} url  The url to download the file from
   */
  async downloadFileFromUrlIfNeeded ({ dest, url }) {
    if (!(await fs.pathExists(dest))) {
      try {
        await pipeline(got.stream(url), fs.createWriteStream(dest))
      } catch (e) {
        this.log.error(e)
        await this.fail(`Failed to download file from url: ${url}. Error: ${e}`)
      }
    }
    await this.updateDownloadStatus(url)
  }

  /**
   * Downloads a file by executing the aws s3 command if it doesn't already exist.
   * Updates the status after each download.
   *
   * @param  {string} dest The path to save the downloaded file to
   * @param  {string} url  The url to download the file from
   */
  async downloadFileFromS3IfNeeded ({ dest, url }) {
    if (!(await fs.pathExists(dest))) {
      try {
        await execa('aws', ['s3', 'cp', url, dest])
      } catch (e) {
        this.log.error(e)
        await this.fail(`Failed to download file from s3: ${url}. Error: ${e}`)
      }
    }
    await this.updateDownloadStatus(url)
  }

  addDownloadTask ({ dest, url }) {
    this.status.totalFilesToDownload++
    if ((new URL(url)).protocol === 's3:') {
      this.downloadTasks.push(this.downloadFileFromS3IfNeeded({ dest, url }))
    } else {
      this.downloadTasks.push(this.downloadFileFromUrlIfNeeded({ dest, url }))
    }
  }

  /**
   * Validate the manifest to make sure all of the necessary items are configured
   * for the actions that need to be taken.
   */
  async validateManifest () {
    // first validate using the manifest's JSON schema. This will also add in all
    // of the default values to the manifest variable
    const ajv = new Ajv({ allErrors: true, useDefaults: true })
    const validator = ajv.compile(manifestJsonSchema)
    const isValid = validator(this.manifest)
    if (!isValid) {
      await this.fail(ajv.errorsText(validator.errors))
    }

    // accumulate all other errors and return them all at once at the end
    const errors = []

    if (!this.manifest.buildGraph && !this.manifest.runServer) {
      errors.push('At least one of `buildGraph` or `runServer` must be set')
    }

    // if build is set to true, then gtfsAndOsmUrls needs to be defined
    if (this.manifest.buildGraph && !this.manifest.gtfsAndOsmUrls) {
      errors.push('`gtfsAndOsmUrls` must be populated for graph build')
    }

    // if build is set to true, then the graphObjUrl must be an s3 url
    if (
      this.manifest.uploadGraph &&
      (
        !this.manifest.graphObjUrl ||
          (new URL(this.manifest.graphObjUrl).protocol !== 's3:')
      )
    ) {
      errors.push('`graphObjUrl` must be an s3 url in order to upload Graph.obj file')
    }

    // if build is set to false, then the graphObjUrl must be defined
    if (!this.manifest.buildGraph && !this.manifest.graphObjUrl) {
      errors.push('`graphObjUrl` must be defined in run-server-only mode')
    }

    // make sure the s3UploadBucket is defined if some uploads are supposed to
    // happen
    if (!this.manifest.s3UploadBucket) {
      const uploads = [
        'uploadGraphBuildLogs',
        'uploadGraphBuildReport',
        'uploadOtpRunnerLogs',
        'uploadServerStartupLogs'
      ]
      uploads.forEach(upload => {
        if (this.manifest[upload]) {
          errors.push(`\`s3UploadBucket\` must be defined if \`${upload}\` is set to true`)
          // immediately set uploadOtpRunnerLogs to false so it doesn't get
          // activated by the fail method
          if (upload === 'uploadOtpRunnerLogs') {
            this.manifest.uploadOtpRunnerLogs = false
          }
        }
      })
    }

    // finally, fail with errors if there were any
    if (errors.length > 0) {
      await this.fail(`The following errors were found in the manifest.json file:

      ${errors.join('\n')}`)
    }

    // if this point is reached, the manfiest.json file is valid!
    this.log.info('manifest is valid!')
    this.log.info(JSON.stringify(this.manifest, null, 2))
  }

  async waitOneSecond () {
    return new Promise((resolve, reject) => setTimeout(resolve, 1000))
  }

  getBaseOTPArgs () {
    // Use potentially all available memory minus 2GB for the OS, but use a
    // minimum of 1.5GB to run OTP.
    const memoryToUse = Math.max(
      Math.round(os.totalmem() / 1000 - 2097152),
      1500000
    )
    return [
      '-jar',
      `-Xmx${memoryToUse}k`,
      this.manifest.jarFile
    ]
  }

  /**
   * Builds a graph using OTP
   */
  async buildGraph () {
    // in build mode, use execa which simplifies a few things
    // The execa options argument creates a combined stdout and stderr output
    // stream via setting the `all` flag to true.
    const args = this.getBaseOTPArgs()
    args.push('--build')
    args.push(path.join(this.manifest.graphsFolder, this.manifest.routerName))
    const subprocess = execa('java', args, { all: true })

    // keep the last 100 logs to stdout/stderr in memory
    const last100Logs = new CircularBuffer(100)

    // Pipe all output to a logfile
    subprocess.all.pipe(fs.createWriteStream(this.manifest.buildLogFile))
    // Analyze the OTP stdout and stderr, storing logs into the CircularBuffer.
    subprocess.all.on('data', (data) => {
      const lastMessage = data.toString().trim()
      if (lastMessage !== '') {
        last100Logs.push(lastMessage)
      }
    })

    // wait 1 second prior to entering loop. This is mainly just to let the
    // subprocess stream logging catch up when testing.
    await this.waitOneSecond()

    // Check on OTP as it starts up. Wait until graph building is complete. Update
    // the status as graph build progresses.
    while (subprocess.exitCode === null) {
      await this.waitOneSecond()
      // Update status with the latest message from the OTP logs
      const lastLog = last100Logs.size() > 1
        ? (
          last100Logs
            .get(last100Logs.size() - 1) // get the most recent entry
            .replace(/^\d\d:\d\d:.*\(.*\)\s*/, '') // strip java timestamp and class
            .substring(0, 60)
        )
        : ''
      await this.updateStatus(`Building graph... ${lastLog !== '' ? ` (${lastLog})` : ''}`)
    }

    // OTP exited, check if it was successful and do something if not
    if (subprocess.exitCode > 0) {
      this.log.error(last100Logs.toarray().join('\n'))
      // immediately upload logs
      await this.uploadBuildLogs()
      await this.fail('Build graph failed! Please see logs.')
    }
    this.status.graphBuilt = true
  }

  /**
   * Starts OTP as a server
   */
  async startServer () {
    const args = this.getBaseOTPArgs()
    args.push('--server')
    args.push('--graphs')
    args.push(this.manifest.graphsFolder)
    args.push('--router')
    args.push(this.manifest.routerName)

    // if running as a server, use native child_process library instead of
    // execa because it does not seem possible to keep writing output to logs
    // while running detached processes with execa.
    const out = fs.openSync(this.manifest.serverLogFile, 'w')
    const otpServerProcess = spawn(
      'java',
      args,
      { detached: true, stdio: [ 'ignore', out, out ] }
    )
    otpServerProcess.unref()
    await this.updateStatus('Starting OTP server...')
    this.log.info(`java ${args.join(' ')} running as pid ${otpServerProcess.pid}`)

    let foundSuccessfulServerStartMessage = false
    let graphRead = false
    const serverStartTime = (new Date()).getTime()
    while (!foundSuccessfulServerStartMessage || !graphRead) {
      // Make sure server process is still running
      if (otpServerProcess.exitCode !== null) {
        // Server process has exited!
        this.log.error(
          await fs.readFile(this.manifest.serverLogFile, { encoding: 'UTF-8' })
        )
        await this.uploadServerLogs()
        await this.fail(`Server failed to start and exited with code ${otpServerProcess.exitCode}`)
      }

      // wait one second before reading the logs
      await this.waitOneSecond()

      // read logs and check if the graph was read and the server started
      const data = await fs.readFile(
        this.manifest.serverLogFile,
        { encoding: 'UTF-8' }
      )
      // check for server startup
      if (data.includes('Grizzly server running')) {
        foundSuccessfulServerStartMessage = true
      }
      // make sure the graph was read
      if (data.includes('Main graph read.')) {
        graphRead = true
      }
      // make sure there are no graph register errors
      if (
        data.includes(
          `Can't register router ID '${this.manifest.routerName}', no graph.`
        )
      ) {
        // A problem occurred such that the router with the graph was unable to
        // be registered.
        otpServerProcess.kill()
        await this.uploadServerLogs()
        await this.fail('An error occurred while trying to start the OTP Server!')
      }

      // Fail this script if it has taken took long for the server to startup
      if ((new Date()).getTime() - serverStartTime > this.manifest.serverStartupTimeoutSeconds * 1000) {
        // Server startup timeout occurred! Kill the process, upload logs if
        // needed and fail.
        otpServerProcess.kill()
        await this.uploadServerLogs()
        await this.fail(`Server took longer than ${this.manifest.serverStartupTimeoutSeconds} seconds to start!`)
      }
    }

    await this.uploadServerLogs()
    this.status.serverStarted = true
    await this.updateStatus('Server successfully started!', 100)
  }

  /**
   * Gets the ec2 instance ID
   */
  async getInstanceId () {
    if (!this.instanceId) {
      // calculate instance ID
      try {
        const response = await got('http://169.254.169.254/latest/meta-data/instance-id')
        this.instanceId = response.body
      } catch (e) {
        await this.fail(`Failed to get instanceId. Error: ${e}`)
      }
    }
    return this.instanceId
  }

  /**
   * If configured, will generate a prefix on the server and otp-runner log
   * files to differentiate when uploading.
   */
  async getLogUploadPrefix () {
    if (!this.manifest.prefixLogUploadsWithInstanceId) return ''
    return `${await this.getInstanceId()}-`
  }

  /**
   * Uploads a file to AWS S3 using the command line. Returns true if successful.
   */
  async uploadFileToS3 ({ filePath, s3Path }) {
    try {
      this.log.info(`uploading ${filePath} to ${s3Path}`)
      await execa('aws', ['s3', 'cp', filePath, s3Path])
      this.log.info(`Successfully uploaded ${filePath} to ${s3Path}!`)
      return true
    } catch (e) {
      this.log.error(`Failed to upload ${filePath} to ${s3Path}! See error:`)
      this.log.error(e)
      return false
    }
  }

  /**
   * If needed, will upload the graph build logs to s3
   */
  async uploadBuildLogs () {
    if (this.manifest.uploadGraphBuildLogs) {
      await this.uploadFileToS3({
        filePath: this.manifest.buildLogFile,
        s3Path: `${this.manifest.s3UploadBucket}/otp-build.log`
      })
    }
  }

  /**
   * If needed will upload the graph object to s3.
   *
   * Note: if uploading the graph is set to true in the manifest, and uploading
   * the graph failed, then the script will be failed.
   */
  async uploadGraphObj () {
    if (this.manifest.uploadGraph) {
      if (
        await this.uploadFileToS3({
          filePath: path.join(
            this.manifest.graphsFolder,
            this.manifest.routerName,
            'Graph.obj'
          ),
          s3Path: this.manifest.graphObjUrl
        })
      ) {
        // successfully uploaded graph!
        this.status.graphUploaded = true
        await this.updateStatus('Graph uploaded!', this.manifest.runServer ? 80 : 100)
      } else {
        await this.fail('Failed to upload graph!')
      }
    }
  }

  async createAndUploadBundle () {
    // TODO
  }

  /**
   * If needed, will upload the server startup logs to s3
   */
  async uploadServerLogs () {
    if (this.manifest.uploadServerStartupLogs) {
      await this.uploadFileToS3({
        filePath: this.manifest.serverLogFile,
        s3Path: `${this.manifest.s3UploadBucket}/${await this.getLogUploadPrefix()}otp-server.log`
      })
    }
  }

  /**
   * If needed and if the report was generated, zips up the graph build report and
   * then uploads.
   */
  async uploadGraphBuildReport () {
    if (this.manifest.uploadGraphBuildReport) {
      const reportDir = path.join(
        this.manifest.graphsFolder,
        this.manifest.routerName,
        'report'
      )
      if (!(await fs.pathExists(reportDir))) {
        this.log.warn('Upload of graph build report requested, but report not found!')
        return
      }
      try {
        await execa(
          'zip',
          ['-r', 'report.zip', 'report'],
          { cwd: path.join(this.manifest.graphsFolder, this.manifest.routerName) }
        )
      } catch (e) {
        this.log.error('Failed to zip up graph build report! See error:')
        this.log.error(e)
        return
      }
      await this.uploadFileToS3({
        filePath: path.join(
          this.manifest.graphsFolder,
          this.manifest.routerName,
          'report.zip'
        ),
        s3Path: `${this.manifest.s3UploadBucket}/graph-build-report.zip`
      })
    }
  }

  /**
   * If needed, will upload the otp-runner logs to s3
   */
  async uploadOtpRunnerLogs () {
    if (this.manifest && this.manifest.uploadOtpRunnerLogs) {
      await this.uploadFileToS3({
        filePath: this.manifest.otpRunnerLogFile,
        s3Path: `${this.manifest.s3UploadBucket}/${await this.getLogUploadPrefix()}otp-runner.log`
      })
    }
  }

  async run () {
    await this.validateManifest()

    // ensure certain directories exist
    await fs.mkdirp(
      path.join(this.manifest.graphsFolder, this.manifest.routerName)
    )

    // add task to download OTP jar
    this.addDownloadTask({
      dest: this.manifest.jarFile,
      url: this.manifest.jarUrl
    })

    if (this.manifest.buildGraph) {
      // add tasks to download GTFS and OSM files
      this.manifest.gtfsAndOsmUrls.forEach(url => {
        const splitUrl = url.split('/')
        this.addDownloadTask({
          dest: path.join(
            this.manifest.graphsFolder,
            this.manifest.routerName,
            splitUrl[splitUrl.length - 1]
          ),
          url
        })
      })
    } else if (this.manifest.runServer) {
      // this.manifest says to run the server without building a graph. Therefore,
      // download a Graph.obj file.
      this.addDownloadTask({
        dest: path.join(this.manifest.graphsFolder, this.manifest.routerName, 'Graph.obj'),
        url: this.manifest.graphObjUrl
      })
    }

    // download files asynchronously
    await this.updateStatus(`Downloading ${this.status.totalFilesToDownload} files...`, 10)
    await Promise.all(this.downloadTasks)

    // Create an array of tasks that can be ran asynchronously after graph build
    // if that occurs. This allows an OTP server to be started right away without
    // having to wait for other tasks that need to occur after graph builds.
    let postBuildTasks = []

    // build graph if needed
    if (this.manifest.buildGraph) {
      // write build-config.json file if contents are supplied in this.manifest
      if (this.manifest.buildConfigJSON) {
        await fs.writeFile(
          path.join(this.manifest.graphsFolder, this.manifest.routerName, 'build-config.json'),
          this.manifest.buildConfigJSON
        )
      }

      // build graph
      await this.updateStatus('Building graph', this.manifest.runServer ? 30 : 50)
      await this.buildGraph()
      await this.updateStatus('Graph built successfully!', this.manifest.runServer ? 70 : 90)

      // add various follow-up tasks that can occur independently of the server
      // startup
      postBuildTasks.push(this.uploadGraphObj())
      postBuildTasks.push(this.uploadBuildLogs())
      postBuildTasks.push(this.createAndUploadBundle())
      postBuildTasks.push(this.uploadGraphBuildReport())
    }

    // start server if needed
    if (this.manifest.runServer) {
      await this.updateStatus(
        'Starting OTP server',
        this.manifest.buildGraph ? 70 : 40
      )
      // write build-config.json file if contents are supplied in this.manifest
      if (this.manifest.routerConfigJSON) {
        await fs.writeFile(
          path.join(this.manifest.graphsFolder, this.manifest.routerName, 'router-config.json'),
          this.manifest.routerConfigJSON
        )
      }

      // run server
      postBuildTasks = [this.startServer()].concat(postBuildTasks)
    }

    await Promise.all(postBuildTasks)

    await this.uploadOtpRunnerLogs()

    // If runServer is true, the execa subprocess hangs for unkown reasons that
    // seem to be related to reading the stdout/stderr stream. Therefore, manually
    // exit this script at this point.
    process.exit(0)
  }
}
