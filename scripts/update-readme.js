const fs = require('fs-extra')

const { generateNewReadme } = require('./readme-utils')

async function main () {
  await fs.writeFile('README.md', await generateNewReadme())
}

main()
