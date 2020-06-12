const fs = require('fs-extra')

const { generateNewReadme } = require('./readme-utils')

async function main () {
  try {
    const currentContents = await fs.readFile('README.md', { encoding: 'UTF-8' })
    const expectedContents = await generateNewReadme()
    if (currentContents !== expectedContents) {
      throw new Error('REAMDE.md appears to be out of sync with manifest-json-schema.json file!')
    }
  } catch (e) {
    console.error(e)
    process.exit(1)
  }
}

main()
