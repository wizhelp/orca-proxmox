// A one-shot import file, so an agent (or a script) can hand the plugin its connection without the
// panel: Orca's CLI has no way to call an installed plugin's worker or write its secrets. The
// producer writes the file to a unique, exclusively created name in the same folder and publishes
// it with a rename (docs/AGENT_SETUP.md); the worker reads it when it starts (`orca plugin restart
// <key>` + opening the panel), on the palette command and on the panel's button.
//
// Consuming it, the worker works on one file only:
//   1. checks the folder (POSIX: a real directory, owned by this user, not writable by others);
//   2. claims the file by renaming it to a unique name in the same folder (atomic: of several
//      workers only one gets it, and a later publication under the public name is not touched);
//   3. opens the claimed name once, without following links where the OS allows it, and checks
//      that handle: a regular file with one link, owned by this user and private (POSIX), small;
//   4. reads at most a bounded number of bytes from that handle;
//   5. removes the claimed file whatever the outcome (a claimed file is never put back): a file
//      it may touch is first overwritten through the same handle, and the claimed name is
//      unlinked only while it still is that file (device and inode).
// What the status says about the file comes from its actual final state: overwritten or not,
// and whether the claimed name still exists (then with that exact path). Nothing of the file's
// content is ever part of a result or a log.
import { constants } from 'node:fs'
import { lstat, open, rename, unlink, type FileHandle } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { keyFile } from './vault'

/** `<the worker's folder>/connection-import.json` (see keyFile for the folder per platform). */
export function importFile(): string {
  return join(dirname(keyFile()), 'connection-import.json')
}

/** What the file holds: the Settings form's fields. */
export type ImportedConnection = { baseUrl: string; tokenId: string; fingerprint: string; secret: string }

/**
 * The file's final state. `untouched`: never claimed, still under the public name (`path`);
 * else the claimed copy was `removed` or not (then still at `remaining`), after being
 * `overwritten` first or not.
 */
export type Cleanup =
  | { untouched: true; path: string }
  | { untouched?: false; overwritten: boolean; removed: boolean; remaining?: string; code?: string }

export type ImportResult =
  | { state: 'none' }
  | { state: 'imported'; connection: ImportedConnection; cleanup: Cleanup }
  | { state: 'refused'; reason: string; cleanup: Cleanup }

/** Larger than any real connection file: anything bigger is not one. */
export const MAX_BYTES = 16 * 1024
const FIELDS = new Set(['baseUrl', 'tokenId', 'fingerprint', 'secret'])

type Env = { platform: NodeJS.Platform; uid: number | undefined }
const here = (): Env => ({ platform: process.platform, uid: typeof process.getuid === 'function' ? process.getuid() : undefined })

/** A sentence on what became of the file, from its final state; never its content. */
export function cleanupText(c: Cleanup): string {
  if (c.untouched) return `The file was left as it is at ${c.path}.`
  if (c.removed) return c.overwritten ? 'The file was overwritten and deleted.' : 'The file was deleted, but could not be overwritten first.'
  return `The file could NOT be deleted${c.code ? ` (${c.code})` : ''}: it is still at ${c.remaining} and holds the token secret; delete it by hand.`
}

/** The text of the file: UTF-8 (a byte-order mark, as Windows PowerShell 5.1 writes, is accepted) or UTF-16 with a byte-order mark. */
export function decodeImport(bytes: Buffer): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return bytes.subarray(3).toString('utf8')
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le')
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return Buffer.from(bytes.subarray(2)).swap16().toString('utf16le')
  return bytes.toString('utf8')
}

/** Checks the folder the file is in: a real directory, on POSIX owned by us and not writable by others. */
async function folderProblem(dir: string, env: Env): Promise<string | undefined> {
  let info
  try {
    info = await lstat(dir)
  } catch {
    return undefined // no folder: no file either
  }
  if (info.isSymbolicLink() || !info.isDirectory()) return 'The import folder is not a plain folder (a link?); nothing was read.'
  if (env.platform === 'win32') return undefined
  if (env.uid !== undefined && info.uid !== env.uid) return 'The import folder belongs to another user; nothing was read.'
  if ((info.mode & 0o022) !== 0) return 'Other users can write to the import folder; nothing was read. Make it private (chmod 700) and import again.'
  return undefined
}

/** The claimed name's final state: gone, or still there (with its path). */
async function finalState(claimed: string, overwritten: boolean, code?: string): Promise<Cleanup> {
  const gone = await lstat(claimed).then(
    () => false,
    (error: NodeJS.ErrnoException) => error.code === 'ENOENT'
  )
  return gone ? { overwritten, removed: true } : { overwritten, removed: false, remaining: claimed, ...(code ? { code } : {}) }
}

/**
 * Removes the claimed file. With `handle` and `wipe`, overwrites it through that handle first and
 * checks every byte was written and synced. Unlinks the claimed name only while it is still the
 * file that was checked (`dev`/`ino`); a link or a foreign file is unlinked, never written.
 */
async function removeClaimed(claimed: string, id: { dev: number; ino: number } | undefined, handle?: FileHandle, wipe = 0): Promise<Cleanup> {
  let overwritten = false
  if (handle) {
    if (wipe > 0) {
      try {
        const { bytesWritten } = await handle.write(Buffer.alloc(wipe), 0, wipe, 0)
        await handle.sync()
        overwritten = bytesWritten === wipe
      } catch {
        overwritten = false
      }
    }
    await handle.close().catch(() => undefined)
  }
  let code: string | undefined
  try {
    const now = await lstat(claimed)
    if (id && (now.dev !== id.dev || now.ino !== id.ino)) code = 'replaced'
    else await unlink(claimed)
  } catch (error) {
    code = (error as NodeJS.ErrnoException).code ?? 'error'
  }
  return finalState(claimed, overwritten, code)
}

/**
 * Takes the import file, if there is one (see the steps at the top). Before the claim, a problem
 * leaves the file untouched under its public name; after it, the claimed file is always removed
 * (overwritten first when it is a plain private file of ours), whether it is used or refused.
 */
export async function takeImport(path = importFile(), env: Env = here()): Promise<ImportResult> {
  const untouched: Cleanup = { untouched: true, path }
  const folder = await folderProblem(dirname(path), env)
  if (folder) return { state: 'refused', reason: folder, cleanup: untouched }
  try {
    await lstat(path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? { state: 'none' } : { state: 'refused', reason: `The import file cannot be checked (${code ?? 'error'}).`, cleanup: untouched }
  }
  // 2. Claim it: one atomic rename; whoever loses finds nothing.
  const claimed = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.claimed`)
  try {
    await rename(path, claimed)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // Another taker got it first (Windows may say EPERM rather than ENOENT while it moves).
    if (code === 'ENOENT' || !(await lstat(path).then(() => true, () => false))) return { state: 'none' }
    return { state: 'refused', reason: `The import file cannot be taken (${code ?? 'error'}); it may be open in another program.`, cleanup: untouched }
  }
  // From here on the claimed file is ours to remove, whatever happens.
  let before
  try {
    before = await lstat(claimed)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'none' } // a concurrent taker (Windows)
    throw error
  }
  const refuse = async (reason: string, cleanup: Cleanup): Promise<ImportResult> => ({ state: 'refused', reason: `${reason} ${cleanupText(cleanup)}`, cleanup })
  if (before.isSymbolicLink()) return refuse('The import file is a link; it was not read.', await removeClaimed(claimed, before))
  // 3. One open, without following a link where the OS can refuse it.
  const nofollow = env.platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0)
  let handle: FileHandle
  try {
    handle = await open(claimed, constants.O_RDWR | nofollow)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { state: 'none' }
    const reason = code === 'ELOOP' || code === 'EMLINK' ? 'The import file is a link; it was not read.' : `The import file cannot be opened (${code ?? 'error'}).`
    return refuse(reason, await removeClaimed(claimed, before))
  }
  const info = await handle.stat()
  const id = { dev: info.dev, ino: info.ino }
  // Not a plain file of ours: unlinked, never written (writing could reach another file).
  const foreign = async (reason: string) => refuse(reason, await removeClaimed(claimed, id, handle))
  if (!info.isFile()) return foreign('The import file is not a regular file; it was not read.')
  if (info.nlink !== 1) return foreign('The import file has other hard links; it was not read.')
  if (env.platform !== 'win32' && env.uid !== undefined && info.uid !== env.uid) return foreign('The import file belongs to another user; it was not read.')
  // Ours but unsafe or too large: overwritten and removed, as it may hold a secret others could read.
  const wipeSize = Math.min(info.size, MAX_BYTES * 4)
  if (env.platform !== 'win32' && (info.mode & 0o077) !== 0) {
    return refuse('The import file could be read by other users; it was not used. Write it private (chmod 600) and import again.', await removeClaimed(claimed, id, handle, wipeSize))
  }
  if (info.size > MAX_BYTES) return refuse('The import file is too large to be a connection; it was not read.', await removeClaimed(claimed, id, handle, wipeSize))
  // 4. A bounded read from the handle that was checked.
  const buffer = Buffer.alloc(MAX_BYTES + 1)
  let length = 0
  try {
    length = (await handle.read(buffer, 0, buffer.length, 0)).bytesRead
  } catch (error) {
    return refuse(`The import file cannot be read (${(error as NodeJS.ErrnoException).code ?? 'error'}).`, await removeClaimed(claimed, id, handle, info.size))
  }
  // 5. Gone before its content is even parsed.
  const cleanup = await removeClaimed(claimed, id, handle, Math.max(info.size, length))
  const bytes = buffer.subarray(0, length)
  buffer.fill(0, length)
  if (length > MAX_BYTES) return refuse('The import file is too large to be a connection.', cleanup)
  let raw: unknown
  try {
    raw = JSON.parse(decodeImport(bytes))
  } catch {
    return refuse('The import file is not valid JSON (write it completely to a temporary name, then rename it).', cleanup)
  } finally {
    bytes.fill(0)
  }
  const ok =
    !!raw &&
    typeof raw === 'object' &&
    !Array.isArray(raw) &&
    Object.keys(raw).every((k) => FIELDS.has(k)) &&
    ['baseUrl', 'tokenId', 'secret'].every((k) => typeof (raw as Record<string, unknown>)[k] === 'string') &&
    ['undefined', 'string'].includes(typeof (raw as Record<string, unknown>).fingerprint)
  if (!ok) return refuse('The import file must be a JSON object with baseUrl, tokenId, secret and optionally fingerprint, all strings.', cleanup)
  const r = raw as Record<string, string>
  return { state: 'imported', connection: { baseUrl: r.baseUrl, tokenId: r.tokenId, fingerprint: r.fingerprint ?? '', secret: r.secret }, cleanup }
}
