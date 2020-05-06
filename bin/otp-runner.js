const path = require('path')

const fs = require('fs-extra')

const OtpRunner = require('../')

async function main () {
  const pathToManifestJson = process.argv[2]
  if (pathToManifestJson && pathToManifestJson.endsWith('.json')) {
    // read json manifest file
    if (!(await fs.pathExists(pathToManifestJson))) {
      throw new Error(`manifest.json file does not exist at path: ${pathToManifestJson}!`)
    }
    const runner = new OtpRunner(
      await fs.readFile(path.resolve(pathToManifestJson))
    )
    await runner.run()
  } else {
    throw new Error('Must specify path to a JSON manifest file!')
  }
}

main()
