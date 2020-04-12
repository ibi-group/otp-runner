/**
 * This script will automate common tasks with OpenTripPlanner such as
 * downloading needed OSM and GTFS files, builing a graph and running a graph.
 */

const path = require('path')
const stream = require('stream')
const {promisify} = require('util')

const Ajv = require('ajv')
const execa = require('execa')
const fs = require('fs-extra')
const got = require('got')

const manifestJsonSchema = require('./manifest-json-schema.json')

const pipeline = promisify(stream.pipeline)

let manifest

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
 * Updates a status file with the overall progress.
 */
async function updateStatus () {
  await fs.writeFile(
    (manifest && manifest.statusFileLocation)
      ? manifest.statusFileLocation
      : './status.json',
    JSON.stringify(status)
  )
}

async function updateDownloadStatus (urlDownloaded) {
  status.numFilesDownloaded++
  console.log(`Downloaded ${urlDownloaded} (${status.numFilesDownloaded} / ${status.totalFilesToDownload} files)`)
  await updateStatus()
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

function makeDownloadTask ({ dest, url }) {
  status.totalFilesToDownload++
  if ((new URL(url)).protocol === 's3') {
    return downloadFileFromS3IfNeeded({ dest, url })
  } else {
    return downloadFileFromUrlIfNeeded({ dest, url })
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

  if (
    (manifest.downloadGraph || manifest.uploadGraph) &&
      !manifest.graphObjUrl
  ) {
    await fail('graphObjUrl must be defined if `downloadGraph` or `uploadGraph` is set to true')
  }
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

  // determine what files need to be downloaded
  const downloadTasks = []

  // add task to download OTP jar
  downloadTasks.push(makeDownloadTask({
    dest: manifest.jarFile,
    url: manifest.jarUrl
  }))

  // add tasks to download GTFS and OSM files
  manifest.gtfsAndOsmUrls.forEach(url => {
    const splitUrl = url.split('/')
    downloadTasks.push(
      makeDownloadTask({
        dest: path.join(
          manifest.graphsFolder,
          manifest.routerName,
          splitUrl[splitUrl.length - 1]
        ),
        url
      })
    )
  })

  // download files asynchronously
  console.log(`Downloading ${status.totalFilesToDownload} files...`)
  try {
    await Promise.all(downloadTasks)
  } catch (e) {
    fail(e)
  }

  // build graph if needed

  // upload graph.obj if needed

  // start server if needed
}

main()
