#!/usr/bin/env node

const path = require('path')

const fs = require('fs-extra')

const OtpRunner = require('../lib')

async function main () {
  const pathToManifestJson = process.argv[2]
  if (pathToManifestJson && pathToManifestJson.endsWith('.json')) {
    // read json manifest file
    const manifestExists = await fs.pathExists(pathToManifestJson)
    if (!manifestExists) {
      throw new Error(`manifest.json file does not exist at path: ${pathToManifestJson}!`)
    }
    const manifestFile = path.resolve(pathToManifestJson)
    const runner = new OtpRunner(
      require(manifestFile)
    )
    await runner.run()
  } else {
    throw new Error('Must specify path to a JSON manifest file!')
  }
}

main()
