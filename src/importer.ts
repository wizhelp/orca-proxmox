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
//      it may touch is first wiped through the same handle, and the claimed name is unlinked
//      only while it still is that file (device and inode). Every error after the claim goes
//      through this cleanup too.
// What the status says about the file comes from its actual final state, kept apart from the
// reason: wiped completely (every byte written and synced), in part or not at all, and whether
// the claimed name still exists, then with that exact path. Nothing of the file's content is ever
// part of a result or a log.
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
export type ImportedConnection = {
  baseUrl: string
  tokenId: string
  fingerprint: string
  secret: string
  kind?: string
  name?: string
  /** Checked field by field by the worker's validation. */
  tunnel?: Record<string, string | number>
  enrichOnly?: boolean
  nodeMap?: Record<string, string>
}

/**
 * The file's final state. `untouched`: never taken, still under the public name at `path`.
 * Else the claimed copy was `removed` or is still at `remaining`; before that it was `wiped`
 * completely (every byte overwritten through the checked handle, and synced), only in part, or
 * not at all (a link or a file that is not ours is never written).
 */
export type Cleanup =
  | { untouched: true; path: string }
  | { untouched?: false; wiped: 'all' | 'part' | 'none'; removed: boolean; remaining?: string; code?: string }

export type ImportResult =
  | { state: 'none' }
  | { state: 'imported'; connection: ImportedConnection; cleanup: Cleanup }
  | { state: 'refused'; reason: string; cleanup: Cleanup }

/** Larger than any real connection file: anything bigger is not one. */
export const MAX_BYTES = 16 * 1024
/** Wiped in pieces of this size, up to WIPE_LIMIT; a larger file is only wiped in part. */
const WIPE_CHUNK = 64 * 1024
const WIPE_LIMIT = 64 * 1024 * 1024
const FIELDS = new Set(['baseUrl', 'tokenId', 'fingerprint', 'secret', 'kind', 'name', 'tunnel', 'enrichOnly', 'nodeMap'])
const TUNNEL_FIELDS = new Set(['host', 'port', 'user', 'identityFile', 'target', 'hostKey'])
const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

type Env = { platform: NodeJS.Platform; uid: number | undefined }
const here = (): Env => ({ platform: process.platform, uid: typeof process.getuid === 'function' ? process.getuid() : undefined })

/**
 * What became of the file, from its final state, never its content. Whenever plaintext may remain
 * under a name, that exact path is in the sentence; "wiped" only means a complete, synced overwrite.
 */
export function cleanupText(c: Cleanup): string {
  if (c.untouched) return `The file was not taken: it is still at ${c.path}.`
  if (c.removed) {
    if (c.wiped === 'all') return 'The file was wiped and deleted.'
    if (c.wiped === 'part') return 'The file was deleted; only part of it could be wiped first.'
    return 'The file was deleted without being wiped first.'
  }
  const content = c.wiped === 'all' ? 'its content was wiped' : 'it may still hold the token secret'
  return `The file could NOT be deleted${c.code ? ` (${c.code})` : ''}: it is still at ${c.remaining} and ${content}; delete it by hand.`
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

/**
 * A unique name for the claimed file next to `path`. It cannot look like a credential (a time and 16
 * hex digits: no UUID, no words), so no scrubbing can change it in a status or a log.
 */
export function claimedName(path: string): string {
  return join(dirname(path), `.${basename(path)}.${Date.now()}-${randomBytes(8).toString('hex')}.claimed`)
}

/** The claimed name's final state: gone, or still there (with its path). */
async function finalState(claimed: string, wiped: 'all' | 'part' | 'none', code?: string): Promise<Cleanup> {
  const gone = await lstat(claimed).then(
    () => false,
    (error: NodeJS.ErrnoException) => error.code === 'ENOENT'
  )
  return gone ? { wiped, removed: true } : { wiped, removed: false, remaining: claimed, ...(code ? { code } : {}) }
}

/** Overwrites `size` bytes through the handle, then syncs: 'all' only when both fully succeeded. */
async function wipe(handle: FileHandle, size: number): Promise<'all' | 'part' | 'none'> {
  const target = Math.min(size, WIPE_LIMIT)
  const zeros = Buffer.alloc(Math.min(WIPE_CHUNK, Math.max(target, 1)))
  let written = 0
  try {
    while (written < target) {
      const length = Math.min(zeros.length, target - written)
      const { bytesWritten } = await handle.write(zeros, 0, length, written)
      if (bytesWritten <= 0) break
      written += bytesWritten
    }
    await handle.sync()
  } catch {
    return written > 0 ? 'part' : 'none'
  }
  return written === size ? 'all' : written > 0 ? 'part' : 'none'
}

/**
 * Removes the claimed file. With `handle` and `size`, wipes it through that handle first. Unlinks
 * the claimed name only while it is still the file that was checked (`dev`/`ino`); a link or a
 * foreign file is unlinked, never written.
 */
async function removeClaimed(claimed: string, id: { dev: number; ino: number } | undefined, handle?: FileHandle, size = 0): Promise<Cleanup> {
  let wiped: 'all' | 'part' | 'none' = 'none'
  if (handle) {
    if (size > 0) wiped = await wipe(handle, size)
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
  return finalState(claimed, wiped, code)
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
  let published
  try {
    published = await lstat(path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? { state: 'none' } : { state: 'refused', reason: `The import file cannot be checked (${code ?? 'error'}).`, cleanup: untouched }
  }
  // A folder (or anything but a file or a link) is not taken at all.
  if (!published.isFile() && !published.isSymbolicLink()) return { state: 'refused', reason: 'The import file is not a file; it was not taken.', cleanup: untouched }
  // 2. Claim it: one atomic rename; whoever loses finds nothing.
  const claimed = claimedName(path)
  try {
    await rename(path, claimed)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // Another taker got it first (Windows may say EPERM rather than ENOENT while it moves).
    if (code === 'ENOENT' || !(await lstat(path).then(() => true, () => false))) return { state: 'none' }
    return { state: 'refused', reason: `The import file cannot be taken (${code ?? 'error'}); it may be open in another program.`, cleanup: untouched }
  }
  // From here on the claimed file is ours to remove, whatever happens: every error goes through cleanup.
  let handle: FileHandle | undefined
  let id: { dev: number; ino: number } | undefined
  try {
    return await consume(claimed, env, (h, i) => ((handle = h), (id = i)))
  } catch (error) {
    const reason = `The import file could not be processed (${(error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.name : 'error')}).`
    return { state: 'refused', reason, cleanup: await removeClaimed(claimed, id, handle, 0) }
  }
}

/** Steps 3 to 5 on the claimed name; `track` hands the open handle to the caller for cleanup on errors. */
async function consume(claimed: string, env: Env, track: (handle: FileHandle, id: { dev: number; ino: number }) => void): Promise<ImportResult> {
  const refuse = (reason: string, cleanup: Cleanup): ImportResult => ({ state: 'refused', reason, cleanup })
  let before
  try {
    before = await lstat(claimed)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'none' } // a concurrent taker (Windows)
    throw error
  }
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
  const info = await handle.stat().catch(async (error) => {
    track(handle, { dev: before.dev, ino: before.ino })
    throw error
  })
  const id = { dev: info.dev, ino: info.ino }
  track(handle, id)
  // Not a plain file of ours: unlinked, never written (writing could reach another file).
  const foreign = async (reason: string) => refuse(reason, await removeClaimed(claimed, id, handle))
  if (!info.isFile()) return foreign('The import file is not a regular file; it was not read.')
  if (info.nlink !== 1) return foreign('The import file has other hard links; it was not read.')
  if (env.platform !== 'win32' && env.uid !== undefined && info.uid !== env.uid) return foreign('The import file belongs to another user; it was not read.')
  // Ours but unsafe or too large: wiped and removed, as it may hold a secret others could read.
  if (env.platform !== 'win32' && (info.mode & 0o077) !== 0) {
    return refuse('The import file could be read by other users; it was not used. Write it private (chmod 600) and import again.', await removeClaimed(claimed, id, handle, info.size))
  }
  if (info.size > MAX_BYTES) return refuse('The import file is too large to be a connection; it was not read.', await removeClaimed(claimed, id, handle, info.size))
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
    ['fingerprint', 'kind', 'name'].every((k) => ['undefined', 'string'].includes(typeof (raw as Record<string, unknown>)[k])) &&
    ['undefined', 'boolean'].includes(typeof (raw as Record<string, unknown>).enrichOnly) &&
    ((raw as Record<string, unknown>).tunnel === undefined || (isPlain((raw as Record<string, unknown>).tunnel) && Object.entries((raw as { tunnel: Record<string, unknown> }).tunnel).every(([k, v]) => TUNNEL_FIELDS.has(k) && (typeof v === 'string' || (k === 'port' && typeof v === 'number'))))) &&
    ((raw as Record<string, unknown>).nodeMap === undefined || (isPlain((raw as Record<string, unknown>).nodeMap) && Object.values((raw as { nodeMap: Record<string, unknown> }).nodeMap).every((v) => typeof v === 'string')))
  if (!ok) return refuse('The import file must be a JSON object with baseUrl, tokenId, secret and optionally fingerprint, kind and name (strings), tunnel (host, port, user, identityFile, target, hostKey), enrichOnly (true or false) and nodeMap (names to names).', cleanup)
  const r = raw as Record<string, string> & { tunnel?: Record<string, string | number>; enrichOnly?: boolean; nodeMap?: Record<string, string> }
  return {
    state: 'imported',
    connection: {
      baseUrl: r.baseUrl,
      tokenId: r.tokenId,
      fingerprint: r.fingerprint ?? '',
      secret: r.secret,
      ...(r.kind !== undefined ? { kind: r.kind } : {}),
      ...(r.name !== undefined ? { name: r.name } : {}),
      ...(r.tunnel !== undefined ? { tunnel: r.tunnel } : {}),
      ...(r.enrichOnly !== undefined ? { enrichOnly: r.enrichOnly } : {}),
      ...(r.nodeMap !== undefined ? { nodeMap: r.nodeMap } : {})
    },
    cleanup
  }
}
