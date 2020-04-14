/**
 * This script will automate common tasks with OpenTripPlanner such as
 * downloading needed OSM and GTFS files, builing a graph and running a graph.
 */

const os = require('os')
const path = require('path')
const stream = require('stream')
const {promisify} = require('util')

const Ajv = require('ajv')
const CircularBuffer = require('circular-buffer')
const execa = require('execa')
const fs = require('fs-extra')
const got = require('got')

const manifestJsonSchema = require('./manifest-json-schema.json')

const pipeline = promisify(stream.pipeline)

let manifest
const downloadTasks = []

async function fail (message) {
  console.error(message)
  status.error = true
  status.message = message
  await updateStatus()
  process.exit(1)
}

const status = {
  error: false,
  message: 'Inintializing...',
  numFilesDownloaded: 0,
  pctProgress: 0,
  totalFilesToDownload: 0
}

/**
 * Updates the status file with the overall progress.
 *
 * @param  {string} [message]     If provided, a new message to update the
 *  status with before writing to file.
 * @param  {number} [pctProgress] If provided, a new percent progress to set
 */
async function updateStatus (message, pctProgress) {
  if (message) {
    console.log(message)
    status.message = message
  }
  if (pctProgress) {
    status.pctProgress = pctProgress
  }
  await fs.writeFile(
    (manifest && manifest.statusFileLocation)
      ? manifest.statusFileLocation
      : './status.json',
    JSON.stringify(status)
  )
}

async function updateDownloadStatus (urlDownloaded) {
  status.numFilesDownloaded++
  await updateStatus(
    `Downloaded ${urlDownloaded} (${status.numFilesDownloaded} / ${status.totalFilesToDownload} files)`
  )
}

/**
 * Downloads a file using a sreaming API if it doesn't already exist. Updates
 * the status after each download.
 *
 * @param  {string} dest The path to save the downloaded file to
 * @param  {string} url  The url to download the file from
 */
async function downloadFileFromUrlIfNeeded ({ dest, url }) {
  if (!(await fs.pathExists(dest))) {
    try {
      await pipeline(got.stream(url), fs.createWriteStream(dest))
    } catch (e) {
      console.error(e)
      await fail(`Failed to download file from url: ${url}. Error: ${e}`)
    }
  }
  await updateDownloadStatus(url)
}

/**
 * Downloads a file by executing the aws s3 command if it doesn't already exist.
 * Updates the status after each download.
 *
 * @param  {string} dest The path to save the downloaded file to
 * @param  {string} url  The url to download the file from
 */
async function downloadFileFromS3IfNeeded ({ dest, url }) {
  if (!(await fs.pathExists(dest))) {
    try {
      await execa('aws', ['s3', 'cp', url, dest])
    } catch (e) {
      console.error(e)
      await fail(`Failed to download file from s3: ${url}. Error: ${e}`)
    }
  }
  await updateDownloadStatus(url)
}

function addDownloadTask ({ dest, url }) {
  status.totalFilesToDownload++
  if ((new URL(url)).protocol === 's3') {
    downloadTasks.push(downloadFileFromS3IfNeeded({ dest, url }))
  } else {
    downloadTasks.push(downloadFileFromUrlIfNeeded({ dest, url }))
  }
}

/**
 * Validate the manifest to make sure all of the necessary items are configured
 * for the actions that need to be taken.
 */
async function validateManifest () {
  // first validate using the manifest's JSON schema. This will also add in all
  // of the default values to the manifest variable
  const ajv = new Ajv({ allErrors: true, useDefaults: true })
  const validator = ajv.compile(manifestJsonSchema)
  const isValid = validator(manifest)
  if (!isValid) {
    await fail(ajv.errorsText(validator.errors))
  }

  // if build is set to true, then gtfsAndOsmUrls needs to be defined
  if (manifest.buildGraph && !manifest.gtfsAndOsmUrls) {
    await fail('gtfsUrls or osmUrls must be populated for graph build')
  }

  // if build is set to true, then the graphObjUrl must be an s3 url
  if (
    manifest.uploadGraph &&
    (new URL(manifest.graphObjUrl).protocol !== 's3')
  ) {
    await fail('graphObjUrl must be an s3 url in order to upload graph.obj file')
  }

  // if build is set to false, then the graphObjUrl must be defined
  if (!manifest.buildGraph && !manifest.graphObjUrl) {
    await fail('graphObjUrl must be defined in run-server-only mode')
  }
}

async function waitOneSecond () {
  return new Promise((resolve, reject) => setTimeout(resolve, 1000))
}

/**
 * Executes an OTP command and tracks the progress by reading the output from
 * the OTP process.
 *
 * @param  {string} command Must be either `build` or `server`
 */
async function runOtpCommand (command) {
  if (!['build', 'server'].includes(command)) {
    await fail(`Unsupported OTP command: ${command}`)
  }

  // prepare execa options. In all cases, create a combined stdout and stderr
  // output stream via setting the all flag to true.
  const execaOptions = {
    all: true
  }
  // Create a detached process if running as a server is desired.
  if (command === 'server') {
    execaOptions.detached = true
  }

  // Use potentially all available memory minus 2GB for the OS, but use a
  // minimum of 1.5GB to run OTP.
  const memoryToUse = Math.max(
    Math.round(os.totalmem() / 1000 - 2097152),
    1500000
  )
  // TODO make sure logs are written to a file also
  const args = [
    '-jar',
    `-Xmx${memoryToUse}k`,
    manifest.jarFile,
    `--${command}`
  ]
  if (command === 'build') {
    args.push(path.join(manifest.graphsFolder, manifest.routerName))
  } else {
    args.push('--basePath')
    args.push(manifest.graphsFolder)
  }
  const subprocess = execa('java', args, execaOptions)

  // keep the last 100 logs to stdout/stderr in memory
  const last100Logs = new CircularBuffer(100)

  let foundSuccessfulServerStartMessage = false

  // Analyze the OTP stdout and stderr, storing logs into the CircularBuffer and
  // checking for a successful server start.
  subprocess.all.on('data', (data) => {
    const lastMessage = data.toString().trim()
    if (lastMessage.includes('Grizzly server running')) {
      foundSuccessfulServerStartMessage = true
    }
    if (lastMessage !== '') {
      last100Logs.push(lastMessage)
    }
  })

  // Check on OTP as it starts up. If graph building, wait until graph building
  // is complete. If in server mode check if the successful server start message
  // was found. Either way, update the status as graph build progresses.
  while (subprocess.exitCode === null && !foundSuccessfulServerStartMessage) {
    await waitOneSecond()
    // Update status with the latest message from the OTP logs
    const updatePrefix = command === 'build'
      ? 'Building graph...'
      : 'Starting server...'
    const lastLog = last100Logs.size() > 1
      ? last100Logs
          .get(last100Logs.size() - 1) // get the most recent entry
          .replace(/^\d\d\:\d\d\:.*\(.*\)\s*/, '') // strip java timestamp and class
          .substring(0, 60)
      : ''
    await updateStatus(`${updatePrefix} (${lastLog})`)
  }

  // OTP exited, check if it was successful and do something if not
  if (subprocess.exitCode > 0) {
    console.error(last100Logs.toarray().join('\n'))
    // immediately upload logs
    if (command === 'build') {
      await uploadBuildLogs()
      await fail('Build graph failed! Please see logs.')
    } else {
      // TODO upload logs
      await fail('Server failed to start! Please see logs.')
    }
  }

  // Do some extra things if the server successfully started
  if (foundSuccessfulServerStartMessage) {
    // TODO upload server start logs?
    // TODO verify that server logs continue to get written after script stops
    await updateStatus('Server successfully started!', 100)
  }
}

async function uploadBuildLogs () {
  // TODO
}

async function uploadGraphObj () {
  // TODO
}

async function createAndUploadBundle () {
  // TODO
}

async function main () {
  // read json manifest file
  if (!(await fs.pathExists('manifest.json'))) {
    await fail('manifest.json file does not exist!')
  }
  manifest = require('./manifest.json')

  await validateManifest()

  // ensure certain directories exist
  await fs.mkdirp(path.join(manifest.graphsFolder, manifest.routerName))

  // add task to download OTP jar
  addDownloadTask({
    dest: manifest.jarFile,
    url: manifest.jarUrl
  })

  if (manifest.buildGraph) {
    // add tasks to download GTFS and OSM files
    manifest.gtfsAndOsmUrls.forEach(url => {
      const splitUrl = url.split('/')
      addDownloadTask({
        dest: path.join(
          manifest.graphsFolder,
          manifest.routerName,
          splitUrl[splitUrl.length - 1]
        ),
        url
      })
    })
  } else if (manifest.runServer) {
    // manifest says to run the server without building a graph. Therefore,
    // download a graph.obj file.
    addDownloadTask({
      dest: path.join(manifest.graphsFolder, manifest.routerName, 'graph.obj'),
      url: manifest.graphObjUrl
    })
  }

  // download files asynchronously
  await updateStatus(`Downloading ${status.totalFilesToDownload} files...`, 10)
  try {
    await Promise.all(downloadTasks)
  } catch (e) {
    fail(e)
  }

  // Create an array of tasks that can be ran asynchronously after graph build
  // if that occurs. This allows an OTP server to be started right away without
  // having to wait for other tasks that need to occur after graph builds.
  let postBuildTasks = []

  // build graph if needed
  if (manifest.buildGraph) {
    // write build-config.json file if contents are supplied in manifest
    if (manifest.buildConfigJSON) {
      await fs.writeFile(
        path.join(graphsFolder, routerName, 'build-config.json'),
        manifest.buildConfigJSON
      )
    }

    // build graph
    await updateStatus('Building graph', manifest.runServer ? 30 : 50)
    await runOtpCommand('build')
    await updateStatus('Graph built successfully!', manifest.runServer ? 70 : 90)

    // upload build logs if needed
    postBuildTasks.push(uploadBuildLogs)

    // upload graph.obj if needed
    postBuildTasks.push(uploadGraphObj)

    // create and upload bundle if needed
    postBuildTasks.push(createAndUploadBundle)
  }

  // start server if needed
  if (manifest.runServer) {
    // write build-config.json file if contents are supplied in manifest
    if (manifest.routerConfigJSON) {
      await fs.writeFile(
        path.join(graphsFolder, routerName, 'router-config.json'),
        manifest.routerConfigJSON
      )
    }

    // run server
    postBuildTasks = [runOtpCommand('server')].concat(postBuildTasks)
  }

  await Promise.all(postBuildTasks)

  // If runServer is true, the execa subprocess hangs for unkown reasons that
  // seem to be related to reading the stdout/stderr stream. Therefore, manually
  // exit this script at this point.
  process.exit(0)
}

main()
