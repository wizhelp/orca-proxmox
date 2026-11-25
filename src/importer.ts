// A one-shot import file, so an agent (or a script) can hand the plugin its connection without the
// panel: Orca's CLI has no way to call an installed plugin's worker or write its secrets. The
// producer writes the file privately and publishes it with an atomic rename (docs/AGENT_SETUP.md);
// the worker reads it when it starts (`orca plugin restart <key>` + opening the panel), on the
// palette command and on the panel's button.
//
// Consuming it, the worker works on one file only:
//   1. checks the folder (POSIX: a real directory, owned by this user, not writable by others);
//   2. claims the file by renaming it to a unique name in the same folder (atomic: of several
//      workers only one gets it, and a later replacement of the published name is not touched);
//   3. opens the claimed name once, without following links where the OS allows it, and checks
//      that handle: a regular file with one link, owned by this user and private (POSIX), small;
//   4. reads at most a bounded number of bytes from that handle;
//   5. overwrites the file through the same handle and unlinks the claimed name only if it still
//      is that same file (device and inode), and reports whether that worked.
// Nothing of the file's content is ever part of a result or a log.
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

/** What became of the file: removed, left for the person to fix, or found impossible to remove. */
export type Cleanup = 'deleted' | 'kept' | 'not-deleted'

export type ImportResult =
  | { state: 'none' }
  | { state: 'imported'; connection: ImportedConnection; cleanup: Cleanup }
  | { state: 'refused'; reason: string; cleanup: Cleanup }

/** Larger than any real connection file: anything bigger is not one. */
export const MAX_BYTES = 16 * 1024
const FIELDS = new Set(['baseUrl', 'tokenId', 'fingerprint', 'secret'])

type Env = { platform: NodeJS.Platform; uid: number | undefined }
const here = (): Env => ({ platform: process.platform, uid: typeof process.getuid === 'function' ? process.getuid() : undefined })

/** A sentence on what happened to the file, for the status; never its content. */
export function cleanupText(cleanup: Cleanup, code?: string): string {
  if (cleanup === 'deleted') return 'The file was overwritten and deleted.'
  if (cleanup === 'kept') return 'The file was left in place.'
  return `The file could NOT be deleted${code ? ` (${code})` : ''}: delete it by hand, it holds the token secret.`
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

/** Puts a refused file back under its published name when that name is free; else leaves it claimed. */
async function giveBack(claimed: string, path: string): Promise<Cleanup> {
  try {
    await lstat(path)
    return 'kept' // a new file was published meanwhile: leave both, the person sees ours under the claimed name
  } catch {
    await rename(claimed, path).catch(() => undefined)
    return 'kept'
  }
}

/** Overwrites through the open handle, then unlinks `claimed` only if it is still that file. */
async function destroy(handle: FileHandle, claimed: string, dev: number, ino: number, size: number): Promise<{ cleanup: Cleanup; code?: string }> {
  try {
    if (size > 0) await handle.write(Buffer.alloc(size), 0, size, 0)
    await handle.sync()
  } catch {
    // Unwritable: still try to remove it.
  }
  await handle.close().catch(() => undefined)
  try {
    const now = await lstat(claimed)
    if (now.dev !== dev || now.ino !== ino) return { cleanup: 'not-deleted', code: 'replaced' }
    await unlink(claimed)
    return { cleanup: 'deleted' }
  } catch (error) {
    return { cleanup: 'not-deleted', code: (error as NodeJS.ErrnoException).code ?? 'error' }
  }
}

/**
 * Takes the import file, if there is one (see the steps at the top). A file whose type, owner,
 * permissions, links or size are wrong is refused and left in place; one that was read is always
 * overwritten and deleted, whether its content is usable or not.
 */
export async function takeImport(path = importFile(), env: Env = here()): Promise<ImportResult> {
  const folder = await folderProblem(dirname(path), env)
  if (folder) return { state: 'refused', reason: folder, cleanup: 'kept' }
  try {
    await lstat(path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? { state: 'none' } : { state: 'refused', reason: `The import file cannot be checked (${code ?? 'error'}).`, cleanup: 'kept' }
  }
  // 2. Claim it: one atomic rename; whoever loses finds nothing.
  const claimed = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.claimed`)
  try {
    await rename(path, claimed)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // Another taker got it first (Windows may say EPERM rather than ENOENT while it moves).
    if (code === 'ENOENT' || !(await lstat(path).then(() => true, () => false))) return { state: 'none' }
    return { state: 'refused', reason: `The import file cannot be taken (${code ?? 'error'}); it may be open in another program.`, cleanup: 'kept' }
  }
  // 3. One open, without following a link where the OS can refuse it.
  const nofollow = env.platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0)
  let handle: FileHandle
  try {
    if (env.platform === 'win32' && (await lstat(claimed)).isSymbolicLink()) {
      return { state: 'refused', reason: 'The import file is a link; it was not read.', cleanup: await giveBack(claimed, path) }
    }
    handle = await open(claimed, constants.O_RDWR | nofollow)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // Gone under our claimed name: a concurrent taker got it (Windows can report both renames as done).
    if (code === 'ENOENT') return { state: 'none' }
    const reason = code === 'ELOOP' || code === 'EMLINK' ? 'The import file is a link; it was not read.' : `The import file cannot be opened (${code ?? 'error'}).`
    return { state: 'refused', reason, cleanup: await giveBack(claimed, path) }
  }
  const info = await handle.stat()
  const refuse = async (reason: string): Promise<ImportResult> => {
    await handle.close().catch(() => undefined)
    return { state: 'refused', reason, cleanup: await giveBack(claimed, path) }
  }
  if (!info.isFile()) return refuse('The import file is not a regular file; it was not read.')
  if (info.nlink !== 1) return refuse('The import file has other hard links; it was not read.')
  if (env.platform !== 'win32') {
    if (env.uid !== undefined && info.uid !== env.uid) return refuse('The import file belongs to another user; it was not read.')
    if ((info.mode & 0o077) !== 0) return refuse('The import file can be read by other users; it was not read. Make it private (chmod 600) and import again.')
  }
  if (info.size > MAX_BYTES) return refuse('The import file is too large to be a connection; it was not read.')
  // 4. A bounded read from the handle that was checked.
  const buffer = Buffer.alloc(MAX_BYTES + 1)
  let length = 0
  try {
    length = (await handle.read(buffer, 0, buffer.length, 0)).bytesRead
  } catch (error) {
    const done = await destroy(handle, claimed, info.dev, info.ino, info.size)
    return { state: 'refused', reason: `The import file cannot be read (${(error as NodeJS.ErrnoException).code ?? 'error'}). ${cleanupText(done.cleanup, done.code)}`, cleanup: done.cleanup }
  }
  const done = await destroy(handle, claimed, info.dev, info.ino, Math.max(info.size, length))
  const bytes = buffer.subarray(0, length)
  buffer.fill(0, length)
  if (length > MAX_BYTES) return { state: 'refused', reason: `The import file is too large to be a connection. ${cleanupText(done.cleanup, done.code)}`, cleanup: done.cleanup }
  let raw: unknown
  try {
    raw = JSON.parse(decodeImport(bytes))
  } catch {
    return { state: 'refused', reason: `The import file is not valid JSON (write it completely to a temporary name, then rename it). ${cleanupText(done.cleanup, done.code)}`, cleanup: done.cleanup }
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
  if (!ok) {
    return { state: 'refused', reason: `The import file must be a JSON object with baseUrl, tokenId, secret and optionally fingerprint, all strings. ${cleanupText(done.cleanup, done.code)}`, cleanup: done.cleanup }
  }
  const r = raw as Record<string, string>
  return { state: 'imported', connection: { baseUrl: r.baseUrl, tokenId: r.tokenId, fingerprint: r.fingerprint ?? '', secret: r.secret }, cleanup: done.cleanup }
}
