const path = require('path')
const stream = require('stream')
const {promisify} = require('util')

const execa = require('execa')
const fs = require('fs-extra')
const got = require('got')

const pipeline = promisify(stream.pipeline)

let config
const defaultConfig = {
  jarFolder: '/opt',
  jarName: 'otp-1.4.0-shaded.jar',
  jarUrl: 'https://repo1.maven.org/maven2/org/opentripplanner/otp/1.4.0/otp-1.4.0-shaded.jar',
  statusFileLocation: 'status.json'
}

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
  await fs.writeFile(config.statusFileLocation, JSON.stringify(status))
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
      await fail(`Failed to download file from url: ${url}`)
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
      await fail(`Failed to download file from s3: ${url}`)
    }
  }
  await updateDownloadStatus(url)
}

function makeDownloadTask ({ dest, url }) {
  if ((new URL(url)).protocol === 's3') {
    return downloadFileFromS3IfNeeded({ dest, url })
  } else {
    return downloadFileFromUrlIfNeeded({ dest, url })
  }
}

async function main () {
  // read json config file
  if (!(await fs.pathExists('config.json'))) {
    config = defaultConfig
    await fail('config.json file does not exist!')
  }
  config = require('./config.json')

  // determine what files need to be downloaded
  const downloadTasks = []

  // add OTP jar
  downloadTasks.push(makeDownloadTask({
    dest: path.join(config.jarFolder, config.jarName),
    url: config.jarUrl
  }))

  // download files asynchronously
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
