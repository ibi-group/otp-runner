const os = require('os')
const stream = require('stream')
const {promisify} = require('util')

const execa = require('execa')
const fs = require('fs-extra')
const got = require('got')

/**
 * Downloads a file if it doesn't already exist on the filesystem. If the file
 * appears to be a file on AWS S3, the AWS CLI will be used to download the
 * file, otherwise it will be attempted to be downloaded via HTTP/HTTPS.
 *
 * @param  {string} dest The path to save the downloaded file to
 * @param  {string} uri  The uri to download the file from
 */
module.exports.downloadFileIfNeeded = async function ({ dest, uri }) {
  if ((await fs.pathExists(dest))) return
  if ((new URL(uri)).protocol === 's3:') {
    await execa('aws', ['s3', 'cp', uri, dest])
  } else {
    // create a promisified pipeline to download a file using streamed
    // writing to the destination file
    const pipeline = promisify(stream.pipeline)
    await pipeline(got.stream(uri), fs.createWriteStream(dest))
  }
}

/**
 * Gets the base java arguments for running OTP based off of system memory and
 * the given jar file.
 */
module.exports.getBaseOTPArgs = function (jarFile) {
  // Use potentially 80% of available memory, but use a
  // minimum of 1.5GB to run OTP.
  const memoryToUse = Math.max(
    Math.round((os.totalmem() / 1000) * 0.8),
    1500000
  )
  return ['-jar', `-Xmx${memoryToUse}k`, jarFile]
}

module.exports.waitOneSecond = async function () {
  return new Promise((resolve, reject) => setTimeout(resolve, 1000))
}
