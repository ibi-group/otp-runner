const { Readable } = require('stream')

const isEqual = require('lodash.isequal')

// mock execa and create a registry of functions to call in case the arguments
// match.
// Each execa mock must be defined with an object with the keys `args` and `fn`.
//
// NOTE: in order to make jest happy with some out-of-scope variables, prefix
// the variable name with `mock` as needed
let mockExecaCommands = []
const mockIsEqual = isEqual
const MockReadable = Readable
jest.mock('execa', () => {
  return jest.fn((...args) => {
    for (let i = 0; i < mockExecaCommands.length; i++) {
      const curMock = mockExecaCommands[i]
      if (mockIsEqual(curMock.args, args)) {
        return curMock.fn()
      }
    }
    console.error('No mock found for execa args!', args)

    // if the command to mock is `java`, and a mock implementation isn't found,
    // it is assumed that a OTP build command hasn't been mocked. Since in this
    // case, otp-runner will not simply await the returned execa promise, a fake
    // run of java with errors written to the output stream is created.
    if (args[0] === 'java') {
      console.error('Unmocked java command!')
      // create a readable stream to simulate output from java running OTP
      const all = new MockReadable({
        read () {}
      })
      all.push(`No mock found for execa args! ${args.join(' ')}`)

      return {
        all,
        exitCode: 2
      }
    }

    // found an unmocked execa command that is assumed to not use the subprocess
    // items that execa returns
    throw new Error('No mock found for execa args!')
  })
})

/**
 * Add a new configuration for a custom execa process to be mocked.
 * @param {object} mock an object with the keys `args` and `fn`.
 */
function addCustomExecaMock (mock) {
  mockExecaCommands.push(mock)
}

// mock child_process.spawn and create a registry of functions to call in case
// the arguments match.
// Each spawn mock must be defined with an object with the keys `args` and `fn`.
//
// NOTE: in order to make jest happy with some out-of-scope variables, prefix
// the variable name with `mock` as needed
let mockSpawnCommands = []
jest.mock('child_process', () => {
  return {
    spawn: (...args) => {
      const processArgs = args.slice(0, 2)
      const spawnOptions = args[2]
      for (let i = 0; i < mockSpawnCommands.length; i++) {
        const curMock = mockSpawnCommands[i]
        if (mockIsEqual(curMock.args, processArgs)) {
          return curMock.fn(spawnOptions)
        }
      }
      console.error('No mock found for spawn args!', processArgs)

      return {
        pid: 'mock',
        exitCode: 2,
        unref: () => {
          throw new Error(`No mock found for spawn args: ${processArgs}`)
        }
      }
    }
  }
})

/**
 * Add a new configuration for a custom spawn process to be mocked.
 * @param {object} mock an object with the keys `args` and `fn`.
 */
function addCustomSpawnMock (mock) {
  mockSpawnCommands.push(mock)
}

// mock os to get same os memory value
jest.mock('os', () => {
  return {
    totalmem: () => 10000000000
  }
})

// mock process.exit so jest doesn't exit prematurely on successful server
// startups
jest.spyOn(process, 'exit').mockImplementation(
  (code) => {
    if (code > 0) {
      throw new Error(`Process.exit(${code})`)
    }
  }
)

function resetModuleMockConfig () {
  mockExecaCommands = []
  mockSpawnCommands = []
}

module.exports = {
  addCustomExecaMock,
  addCustomSpawnMock,
  resetModuleMockConfig
}
