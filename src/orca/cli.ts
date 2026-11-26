// Runs the `orca` CLI from the plugin worker. Orca starts plugin workers with a reduced
// environment (no APPDATA on Windows, for one), so the variables the CLI needs to find its
// runtime are filled in from the user's home directory.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import type { CliRunner } from './inventory'

export type CliLookup = {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  home: string
  execPath: string
  resourcesPath?: string
  exists: (path: string) => boolean
}

/** Where Orca's own CLI can be, most specific first; all absolute. */
export function cliCandidates(l: CliLookup): string[] {
  const win = l.platform === 'win32'
  const p = win ? win32 : posix
  const exe = win ? 'orca.exe' : 'orca'
  const out: (string | undefined)[] = [l.env.ORCA_CLI]
  // Bundled with the running app: Electron's resources folder, or found from the executable.
  if (l.resourcesPath) out.push(p.join(l.resourcesPath, 'bin', exe))
  const appDir = p.dirname(l.execPath)
  if (l.platform === 'darwin') out.push(p.join(appDir, '..', 'Resources', 'bin', exe))
  else out.push(p.join(appDir, 'resources', 'bin', exe))
  if (win) {
    const local = l.env.LOCALAPPDATA ?? p.join(l.home, 'AppData', 'Local')
    out.push(p.join(local, 'Programs', 'Orca', 'resources', 'bin', exe), p.join(local, 'Programs', 'orca', 'resources', 'bin', exe))
  } else if (l.platform === 'darwin') {
    out.push('/Applications/Orca.app/Contents/Resources/bin/orca', p.join(l.home, 'Applications', 'Orca.app', 'Contents', 'Resources', 'bin', 'orca'))
  } else {
    // Linux: `orca` on PATH is usually the GNOME screen reader. Orca's CLI is `orca-ide` there,
    // so only that name is looked up on PATH, plus the usual install folders.
    for (const dir of (l.env.PATH ?? '').split(':').filter((d) => d.startsWith('/'))) out.push(p.join(dir, 'orca-ide'))
    out.push(p.join(l.home, '.local', 'bin', 'orca-ide'), '/opt/Orca/resources/bin/orca', '/opt/orca/resources/bin/orca', '/usr/lib/orca-ide/resources/bin/orca')
  }
  return out.filter((path): path is string => !!path && p.isAbsolute(path))
}

/** True for a path that is the GNOME screen reader rather than Orca's CLI. */
export function isScreenReader(path: string): boolean {
  return /^\/usr(\/local)?\/bin\/orca$/.test(path) || /\/share\/orca\//.test(path)
}

export class CliMissingError extends Error {
  constructor() {
    super(
      "Orca's command-line tool was not found next to Orca or in its usual install folders (on Linux it is the `orca-ide` command). Reinstall Orca or install its command-line tool, then restart Orca; until then Orca awareness, terminals and opening the panel from the status bar are off."
    )
  }
}

/** The absolute path of Orca's CLI; never a bare `orca`, which on Linux can start the screen reader. */
export function findOrcaCli(lookup: Partial<CliLookup> = {}): string {
  const l: CliLookup = {
    platform: process.platform,
    env: process.env,
    home: homedir(),
    execPath: process.execPath,
    resourcesPath: (process as { resourcesPath?: string }).resourcesPath,
    exists: existsSync,
    ...lookup
  }
  const found = cliCandidates(l).find((path) => !isScreenReader(path) && l.exists(path))
  if (!found) throw new CliMissingError()
  return found
}

/** The worker's environment with what Orca leaves out of it filled in (home folders), for child processes. */
export function cliEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const home = homedir()
  env.HOME ??= home
  if (process.platform === 'win32') {
    env.USERPROFILE ??= home
    env.APPDATA ??= join(home, 'AppData', 'Roaming')
    env.LOCALAPPDATA ??= join(home, 'AppData', 'Local')
  }
  return env
}

export function nodeCliRunner(binary?: string): CliRunner {
  const env = cliEnvironment()
  return (args, timeoutMs) =>
    new Promise((resolve, reject) => {
      let path: string
      try {
        path = binary ?? findOrcaCli()
      } catch (error) {
        return reject(error)
      }
      execFile(
        path,
        [...args, '--json'],
        { env, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
        (error, stdout) => {
          let parsed: { ok?: boolean; result?: unknown; error?: { message?: string } } | undefined
          try {
            parsed = JSON.parse(stdout)
          } catch {
            // Not JSON: report the process error below.
          }
          if (parsed?.ok) return resolve(parsed.result)
          if (parsed?.error?.message) return reject(new Error(parsed.error.message))
          reject(new Error(error ? (error.killed ? 'timed out' : `exited with ${error.code ?? 'an error'}`) : 'no answer'))
        }
      )
    })
}
