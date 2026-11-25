// Finding Orca's own CLI: an absolute path per platform, never the GNOME screen reader.
import { assert, test } from 'orca/testing'
import { CliMissingError, findOrcaCli } from '../src/orca/cli'

const has = (...paths: string[]) => (path: string) => paths.includes(path)

test('the CLI bundled with the running app, per platform', () => {
  assert.equal(
    findOrcaCli({ platform: 'win32', env: {}, home: 'C:\\Users\\a', execPath: 'C:\\Users\\a\\AppData\\Local\\Programs\\Orca\\Orca.exe', resourcesPath: undefined, exists: has('C:\\Users\\a\\AppData\\Local\\Programs\\Orca\\resources\\bin\\orca.exe') }),
    'C:\\Users\\a\\AppData\\Local\\Programs\\Orca\\resources\\bin\\orca.exe'
  )
  // macOS without Electron's resourcesPath: Contents/MacOS/Orca -> Contents/Resources/bin/orca.
  assert.equal(
    findOrcaCli({ platform: 'darwin', env: {}, home: '/Users/a', execPath: '/Applications/Orca.app/Contents/MacOS/Orca', resourcesPath: undefined, exists: has('/Applications/Orca.app/Contents/Resources/bin/orca') }),
    '/Applications/Orca.app/Contents/Resources/bin/orca'
  )
  assert.equal(
    findOrcaCli({ platform: 'linux', env: { PATH: '/usr/local/bin:/usr/bin' }, home: '/home/a', execPath: '/usr/bin/node', resourcesPath: undefined, exists: has('/usr/bin/orca-ide') }),
    '/usr/bin/orca-ide'
  )
})

test('never the screen reader, never a bare name', () => {
  // On Linux /usr/bin/orca is GNOME Orca: not a candidate, even when it exists.
  assert.throws(
    () => findOrcaCli({ platform: 'linux', env: { PATH: '/usr/bin', ORCA_CLI: '/usr/bin/orca' }, home: '/home/a', execPath: '/usr/bin/node', resourcesPath: undefined, exists: has('/usr/bin/orca') }),
    (error: unknown) => error instanceof CliMissingError && /orca-ide/.test(error.message)
  )
  assert.throws(
    () => findOrcaCli({ platform: 'win32', env: { ORCA_CLI: 'orca' }, home: 'C:\\Users\\a', execPath: 'C:\\node.exe', resourcesPath: undefined, exists: () => false }),
    (error: unknown) => error instanceof CliMissingError
  )
})
