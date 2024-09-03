/**
 * This script will automate common tasks with OpenTripPlanner such as
 * downloading needed OSM and GTFS files, building a graph and running a graph.
 */

const { spawn } = require('child_process')
const path = require('path')

const JSONSchemaValidator = require('ajv')
const CircularBuffer = require('circular-buffer')
const execa = require('execa')
const fs = require('fs-extra')
const got = require('got')
const SimpleNodeLogger = require('simple-node-logger')

const {
  downloadFileIfNeeded,
  getBaseOTPArgs,
  waitOneSecond
} = require('./util')

const manifestJsonSchema = require('../manifest-json-schema.json')

module.exports = class OtpRunner {
  constructor (manifest) {
    this.log = SimpleNodeLogger.createSimpleLogger(
      manifest.otpRunnerLogFile || './otp-runner.log'
    )
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
    if (manifest.nonce) {
      this.status.nonce = manifest.nonce
    }
    // print some startup messages
    this.log.info(`
      __
     /\\ \\__
  ___\\ \\ ,_\\  _____            _ __   __  __    ___     ___      __   _ __
 / __\`\\ \\ \\/ /\\ '__\`\\  _______/\\\`'__\\/\\ \\/\\ \\ /' _ \`\\ /' _ \`\\  /'__\`\\/\\\`'__\\
/\\ \\ \\ \\ \\ \\_\\ \\ \\ \\ \\/\\______\\ \\ \\/ \\ \\ \\_\\ \\/\\ \\/\\ \\/\\ \\/\\ \\/\\  __/\\ \\ \\/
\\ \\____/\\ \\__\\\\ \\ ,__/\\/______/\\ \\_\\  \\ \\____/\\ \\_\\ \\_\\ \\_\\ \\_\\ \\____\\\\ \\_\\
 \\/___/  \\/__/ \\ \\ \\/           \\/_/   \\/___/  \\/_/\\/_/\\/_/\\/_/\\/____/ \\/_/
                \\ \\_\\
                 \\/_/
`)
    this.log.info('Received a manifest:')
    this.log.info(JSON.stringify(manifest, null, 2))
  }

  /**
   * Fail the script by throwing an error with the given message. Before
   * exiting, the error will be logged, and the logs and status will be uploaded
   * as needed.
   */
  async fail (message) {
    this.log.error(message)
    this.status.error = true
    this.status.message = message
    // wait 1 second for error logging to write to file
    await waitOneSecond()
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
    // update message if it is different than the last message
    if (message && message !== this.status.message) {
      this.log.info(message)
      // don't update the status if an error has occurred. This prevents
      // asynchronous writes to this variable in the event that a message is
      // attempted to be written over the error message
      if (!this.status.error) {
        this.status.message = message
      }
    }
    if (pctProgress) {
      this.status.pctProgress = pctProgress
    }
    await fs.writeFile(
      // it is possible that the manifest has invalid JSON and is unparsable,
      // so in that case we want to write to the default statusFileLocation that
      // is defined in the manifest JSON schema file
      (this.manifest && this.manifest.statusFileLocation)
        ? this.manifest.statusFileLocation
        : manifestJsonSchema.properties.statusFileLocation.default,
      JSON.stringify(this.status, null, 2)
    )
  }

  /**
   * Returns a promise that attempts to download a file and then update the
   * overall status based on how many downloads have completed.
   *
   * @param  {string} dest The path to save the downloaded file to
   * @param  {string} uri  The uri to download the file from
   */
  async makeDownloadTask ({ dest, uri }) {
    try {
      await downloadFileIfNeeded({ dest, uri })
    } catch (e) {
      this.log.error(e)
      await this.fail(`Failed to download file: ${uri}. Error: ${e}`)
    }
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
      `Downloaded ${uri} ${progressString}`,
      // update overall progress given whether
      10 + downloadProgressComponent * numFilesDownloaded / totalFilesToDownload
    )
  }

  /**
   * Returns true if OTP 2.x is being used.
   */
  isUsingOtp2x () {
    return this.manifest.otpVersion === '2.x'
  }

  /**
   * Returns the appropriate folder to use for writing both downloaded files and
   * the Graph.obj file.
   */
  getTargetFolder () {
    if (this.isUsingOtp2x()) {
      return this.manifest.baseFolder
    } else {
      return path.join(this.manifest.baseFolder, this.manifest.routerName)
    }
  }

  /**
   * Validate the manifest to make sure all of the necessary items are
   * configured for the actions that need to be taken. Calling this method will
   * also populate default values in the manifest if they are not provided in
   * the input manifest.
   */
  async validateManifest () {
    // first validate using the manifest's JSON schema. This will also add in all
    // of the default values to the manifest variable
    const ajv = new JSONSchemaValidator({ allErrors: true, useDefaults: true })
    const validator = ajv.compile(manifestJsonSchema)
    const isValid = validator(this.manifest)
    if (!isValid) {
      await this.fail(ajv.errorsText(validator.errors))
    }

    const {
      baseFolderDownloads,
      buildGraph,
      graphObjUri,
      runServer,
      s3UploadPath,
      uploadGraph
    } = this.manifest

    // accumulate all other errors and return them all at once at the end
    const errors = []

    if (!buildGraph && !runServer) {
      errors.push(
        'At least one of `buildGraph` or `runServer` must be set to true'
      )
    }

    // if build is set to true, then baseFolderDownloads needs to be defined
    const hasBaseFolderDownloads = baseFolderDownloads &&
      baseFolderDownloads.length
    if (buildGraph && !hasBaseFolderDownloads) {
      errors.push(
        '`baseFolderDownloads` must be populated for graph build (need inputs)'
      )
    }

    // validate that each item in baseFolderDownloads is downloadable
    if (hasBaseFolderDownloads) {
      baseFolderDownloads.forEach(downloadItem => {
        const url = new URL(downloadItem.uri)
        const validSchemes = ['http:', 'https:', 's3:']
        if (validSchemes.indexOf(url.protocol.toLowerCase()) === -1) {
          errors.push(
            `The URI \`${downloadItem.uri}\` is unsupported. Supported schemes are: ${validSchemes.map(s => `\`${s}\``).join(', ')}. Provided scheme: \`${url.protocol}\``
          )
        }
      })
    }

    // if build is set to false, then the graphObjUri must be defined
    if (!buildGraph && !graphObjUri) {
      errors.push('`graphObjUri` must be defined in run-server-only mode')
    }

    // if Graph.obj is to be uploaded, then the graphObjUri must be a valid AWS
    // S3 URI
    if (
      uploadGraph &&
        (!graphObjUri || (new URL(graphObjUri).protocol !== 's3:'))
    ) {
      errors.push('`graphObjUri` must be an AWS S3 URI in order to upload Graph.obj file')
    }

    // make sure the s3UploadPath is defined for uploads that are dependent on
    // the s3UploadPath being defined
    if (!s3UploadPath) {
      Object.keys(this.manifest).forEach(key => {
        if (
          key.startsWith('upload') &&
            // the uploadGraph setting uses the graphObjUri, so does not need
            // the s3UploadPath to be defined
            key !== 'uploadGraph' &&
            this.manifest[key]
        ) {
          errors.push(`\`s3UploadPath\` must be defined if \`${key}\` is set to true`)
          // If the `uploadOtpRunnerLogs` is set to true, we must immediately
          // set `uploadOtpRunnerLogs` to false so an invetiable failed upload
          // to S3 doesn't occur in the fail method
          if (key === 'uploadOtpRunnerLogs') {
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

  /**
   * Recreate certain directories to make sure we're starting fresh
   */
  async clearFoldersAndFiles () {
    try {
      await fs.remove(this.getTargetFolder())
      await fs.mkdirp(this.getTargetFolder())
    } catch (e) {
      this.log.error(e)
      await this.fail('Failed to recreate graph router folder')
    }
  }

  /**
   * Returns the appropriate Graph.obj filename that OTP outputs after building
   * a graph.
   */
  getGraphObjName () {
    return this.isUsingOtp2x() ? 'graph.obj' : 'Graph.obj'
  }

  /**
   * Downloads all needed files as specified in the manifest.
   */
  async downloadFiles () {
    const downloadTasks = []

    // add task to download OTP jar
    downloadTasks.push({
      dest: this.manifest.jarFile,
      uri: this.manifest.jarUri
    })

    // add tasks to download files to the base folder
    if (
      this.manifest.baseFolderDownloads &&
        this.manifest.baseFolderDownloads.length > 0
    ) {
      this.manifest.baseFolderDownloads.forEach(downloadItem => {
        const downloadTask = {
          uri: downloadItem.uri
        }

        // check whether download task should have a specific name
        if (downloadItem.name) {
          // download as a file with the given name
          downloadTask.dest = path.join(
            this.getTargetFolder(),
            downloadItem.name
          )
        } else {
          // download as a file with the name equal to whatever is after the
          // final forward slash of the URL.
          const splitUri = downloadItem.uri.split('/')
          downloadTask.dest = path.join(
            this.getTargetFolder(),
            splitUri[splitUri.length - 1]
          )
        }

        downloadTasks.push(downloadTask)
      })
    }

    if (!this.manifest.buildGraph && this.manifest.runServer) {
      // Manifest says to run the server without building a graph.
      // Therefore, download a Graph.obj file.
      downloadTasks.push({
        dest: path.join(this.getTargetFolder(), this.getGraphObjName()),
        uri: this.manifest.graphObjUri
      })
    }

    // download files asynchronously
    this.status.totalFilesToDownload = downloadTasks.length
    await this.updateStatus(
      `Downloading ${this.status.totalFilesToDownload} files...`,
      10
    )
    await Promise.all(
      downloadTasks.map(download => this.makeDownloadTask(download))
    )
  }

  /**
   * Make OTP build arguments according to the specified OTP version
   */
  makeBuildArgs () {
    const args = getBaseOTPArgs(this.manifest.jarFile)
    args.push('--build')
    if (this.isUsingOtp2x()) {
      args.push('--save')
      args.push('--abortOnUnknownConfig')
    }
    args.push(this.getTargetFolder())
    return args
  }

  /**
   * Builds a graph using OTP if needed.
   */
  async buildGraph () {
    // skip graph build if not needed
    if (!this.manifest.buildGraph) return

    await this.updateStatus(
      'Building graph',
      this.manifest.runServer ? 30 : 50
    )

    // write build-config.json file if contents are supplied in this.manifest
    if (this.manifest.buildConfigJSON) {
      await fs.writeFile(
        path.join(this.getTargetFolder(), 'build-config.json'),
        this.manifest.buildConfigJSON
      )
    }

    // in build mode, use execa which simplifies a few things
    // The execa options argument creates a combined stdout and stderr output
    // stream via setting the `all` flag to true.
    const buildArgs = this.makeBuildArgs()
    this.log.info(`Running command: \`java ${buildArgs.join(' ')}`)
    const subprocess = execa('java', buildArgs, { all: true })

    // keep the last 100 logs to stdout/stderr in memory
    const last100Logs = new CircularBuffer(100)

    // Pipe all output to a logfile
    subprocess.all.pipe(fs.createWriteStream(this.manifest.buildLogFile))
    // Analyze the OTP stdout and stderr, storing logs into the CircularBuffer.
    subprocess.all.on('data', (data) => {
      const lastMessage = data.toString().trim()
      if (lastMessage !== '') {
        lastMessage.split('\n').forEach(line => {
          last100Logs.push(line)
        })
      }
    })

    // wait 1 second prior to entering loop. This is mainly just to let the
    // subprocess stream logging catch up when testing.
    await waitOneSecond()

    // Check on OTP as it starts up. Wait until graph building is complete. Update
    // the status as graph build progresses.
    while (subprocess.exitCode === null) {
      await waitOneSecond()
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

    await this.updateStatus(
      'Graph built successfully!',
      this.manifest.runServer ? 70 : 90
    )
  }

  /**
   * Make OTP server arguments according to the specified OTP version
   */
  makeServeArgs () {
    const args = getBaseOTPArgs(this.manifest.jarFile)
    if (this.isUsingOtp2x()) {
      args.push('--load')
      args.push(this.getTargetFolder())
    } else {
      args.push('--server')
      args.push('--graphs')
      args.push(this.manifest.baseFolder)
      args.push('--router')
      args.push(this.manifest.routerName)
    }
    return args
  }

  /**
   * Run various tasks in parallel after completing the graph build step of this
   * script.
   */
  async runPostBuildTasks () {
    // Create an array of tasks that can be ran asynchronously after graph build
    // if that occurs. This allows an OTP server to be started right away
    // without having to wait for other tasks that need to occur after graph
    // builds.
    const postBuildTasks = []

    // start server if needed
    if (this.manifest.runServer) {
      // make running the server the very first post build task
      postBuildTasks.push(this.startServer())
    }

    // add various follow-up tasks to graph building that can occur
    // independently of the server startup
    if (this.manifest.buildGraph) {
      postBuildTasks.push(this.uploadGraphObj())
      postBuildTasks.push(this.uploadBuildLogs())
      postBuildTasks.push(this.createAndUploadBundle())
      postBuildTasks.push(this.uploadGraphBuildReport())
    }

    await Promise.all(postBuildTasks)
  }

  /**
   * Starts OTP as a server
   */
  async startServer () {
    await this.updateStatus(
      'Starting OTP server',
      this.manifest.buildGraph ? 70 : 40
    )

    // write build-config.json file if contents are supplied in this.manifest
    if (this.manifest.routerConfigJSON) {
      await fs.writeFile(
        path.join(this.getTargetFolder(), 'router-config.json'),
        this.manifest.routerConfigJSON
      )
    }

    // if running as a server, use native child_process library instead of
    // execa because it does not seem possible to keep writing output to logs
    // while running detached processes with execa.
    const out = fs.openSync(this.manifest.serverLogFile, 'w')
    const args = this.makeServeArgs()
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
      await waitOneSecond()

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
      if (
        data.includes(
          this.isUsingOtp2x()
            ? 'Transit loaded.'
            : 'Main graph read.'
        )
      ) {
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
        await this.fail(
          'An error occurred while trying to start the OTP Server!'
        )
      }

      // Fail this script if it has taken took long for the server to startup
      if (
        (new Date()).getTime() - serverStartTime >
          this.manifest.serverStartupTimeoutSeconds * 1000
      ) {
        // Server startup timeout occurred! Kill the process, upload logs if
        // needed and fail.
        otpServerProcess.kill()
        await this.uploadServerLogs()
        await this.fail(
          `Server took longer than ${this.manifest.serverStartupTimeoutSeconds} seconds to start!`
        )
      }
    }

    await this.uploadServerLogs()
    this.status.serverStarted = true
    // Set pctProgress to 90 in case other post graph build tasks are still
    // running
    await this.updateStatus('Server successfully started!', 90)
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
   * Uploads a file to AWS S3 using the command line. Returns true if successful
   * or false if a problem occurred.
   */
  async uploadFileToS3 ({ filePath, s3Uri }) {
    try {
      this.log.info(`uploading ${filePath} to ${s3Uri}`)
      await execa('aws', ['s3', 'cp', filePath, s3Uri])
      this.log.info(`Successfully uploaded ${filePath} to ${s3Uri}!`)
      return true
    } catch (e) {
      this.log.error(`Failed to upload ${filePath} to ${s3Uri}! See error:`)
      this.log.error(e)
      return false
    }
  }

  /**
   * If needed, will upload the graph build logs to AWS S3
   */
  async uploadBuildLogs () {
    if (this.manifest.uploadGraphBuildLogs) {
      await this.uploadFileToS3({
        filePath: this.manifest.buildLogFile,
        s3Uri: `${this.manifest.s3UploadPath}/otp-build.log`
      })
    }
  }

  /**
   * If needed will upload the graph object to AWS S3.
   *
   * Note: if uploading the graph is set to true in the manifest, and uploading
   * the graph failed, then the script will be failed.
   */
  async uploadGraphObj () {
    if (this.manifest.uploadGraph) {
      if (
        await this.uploadFileToS3({
          filePath: path.join(this.getTargetFolder(), this.getGraphObjName()),
          s3Uri: this.manifest.graphObjUri
        })
      ) {
        // successfully uploaded graph!
        this.status.graphUploaded = true
        await this.updateStatus(
          'Graph uploaded!',
          this.manifest.runServer ? 80 : 100
        )
      } else {
        await this.fail('Failed to upload graph!')
      }
    }
  }

  /**
   * This is a stub for creating and uploading a bundle if such functionality is
   * desired to be implemented. Prior to the creation of otp-runner,
   * datatools-server would create a bundle with all of the needed files for
   * building a graph and then upload it to the server. Since otp-runner now
   * downloads all of these files on it's own, the bundle may not be necessary
   * anymore.
   */
  async createAndUploadBundle () {
    // implement if needed
  }

  /**
   * If needed, will upload the server startup logs to s3
   */
  async uploadServerLogs () {
    if (this.manifest.uploadServerStartupLogs) {
      await this.uploadFileToS3({
        filePath: this.manifest.serverLogFile,
        s3Uri: `${this.manifest.s3UploadPath}/${await this.getLogUploadPrefix()}otp-server.log`
      })
    }
  }

  /**
   * If needed and if the report was generated, zips up the graph build report and
   * then uploads.
   */
  async uploadGraphBuildReport () {
    if (this.manifest.uploadGraphBuildReport) {
      const reportDir = path.join(this.getTargetFolder(), 'report')
      if (!(await fs.pathExists(reportDir))) {
        this.log.warn(
          'Upload of graph build report requested, but report not found!'
        )
        return
      }
      try {
        await execa(
          'zip',
          ['-r', 'report.zip', 'report'],
          { cwd: this.getTargetFolder() }
        )
      } catch (e) {
        this.log.error('Failed to zip up graph build report! See error:')
        this.log.error(e)
        return
      }
      await this.uploadFileToS3({
        filePath: path.join(this.getTargetFolder(), 'report.zip'),
        s3Uri: `${this.manifest.s3UploadPath}/graph-build-report.zip`
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
        s3Uri: `${this.manifest.s3UploadPath}/${await this.getLogUploadPrefix()}otp-runner.log`
      })
    }
  }

  /**
   * The main entry point for the otp-runner script. Does the following:
   * - validates the manifest
   * - deletes and then recreates an empty router folder
   * - downloads needed files
   * - builds an OTP graph if needed
   * - starts an OTP server if needed
   * - uploads the built Graph.obj file if needed
   * - uploads a bundle if needed
   * - uploads various logs as needed
   */
  async run () {
    await this.validateManifest()
    await this.clearFoldersAndFiles()
    await this.downloadFiles()
    await this.buildGraph()
    await this.runPostBuildTasks()
    await this.uploadOtpRunnerLogs()

    // If runServer is true, the execa subprocess hangs for unknown reasons that
    // seem to be related to reading the stdout/stderr stream. Therefore,
    // manually exit this script at this point.
    process.exit(0)
  }
}
