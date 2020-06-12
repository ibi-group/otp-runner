const fs = require('fs-extra')
const markdownTable = require('markdown-table')

/**
 * Return a new string with an updated README.md file contents that includes an
 * auto-generated markdown table listing all of the top level keys that can be
 * defined in the manifest.json file. This section is expected to have a
 * specific title and to be at the very end of the REAMDE.md file.
 */
module.exports.generateNewReadme = async function () {
  const jsonSchema = require('../manifest-json-schema.json')
  const tableData = [
    [ 'Key', 'Type', 'Required', 'Default', 'Description' ]
  ]

  Object.keys(jsonSchema.properties).forEach(key => {
    const keyData = jsonSchema.properties[key]
    tableData.push([
      key,
      keyData.type,
      (jsonSchema.required || []).includes(key) ? 'Required' : 'Optional',
      keyData.default,
      keyData.description
    ])
  })

  let readmeContent = await fs.readFile('README.md', { encoding: 'UTF-8' })
  const manifestTitleIndex = readmeContent.indexOf('### Manifest.json values')
  if (manifestTitleIndex === -1) {
    throw new Error('Could not find Manifest.json values header!')
  }
  readmeContent = readmeContent.substring(0, manifestTitleIndex + 26)
  return readmeContent.concat(
    `*The rest of this README contains auto-generated contents via the \`yarn update-docs\` script and should not be directly edited!*

${markdownTable(tableData, { alignDelimiters: false })}`
  )
}
