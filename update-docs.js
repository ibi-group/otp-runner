const fs = require('fs-extra')
const markdownTable = require('markdown-table')

/**
 * This script will update a section of the README.md file with an auto-
 * generated markdown table listing all of the top level keys that can be
 * defined in the manifest.json file.
 */
async function main () {
  const jsonSchema = require('./manifest-json-schema.json')
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

  let readmeContent = await fs.readFile('./README.md', { encoding: 'UTF-8' })
  readmeContent = readmeContent.substring(0, readmeContent.indexOf('### Manifest.json values') + 26)
  readmeContent = readmeContent.concat(
    `*The rest of this README contains auto-generated contents via the \`yarn update-docs\` script and should not be directly edited!*

${markdownTable(tableData, { alignDelimiters: false })}`
  )
  await fs.writeFile('./README.md', readmeContent)
}

main()
