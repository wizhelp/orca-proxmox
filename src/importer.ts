// A one-shot import file, so an agent (or a script) can hand the plugin its connection without the
// panel: Orca's CLI has no way to call an installed plugin's worker or write its secrets. The
// file lives next to the worker's key file, readable by the user only; the worker reads it when
// it starts (`orca plugin restart <key>`), on the palette command and on the panel's button, saves
// the connection exactly as the Settings form would (sealed, bound to its endpoint), and then
// overwrites and deletes the file. Nothing of its content is logged or kept.
import { lstat, open, readFile, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { keyFile } from './vault'

/** `<the worker's folder>/connection-import.json` (see keyFile for the folder per platform). */
export function importFile(): string {
  return join(dirname(keyFile()), 'connection-import.json')
}

/** What the file holds: the Settings form's fields. */
export type ImportedConnection = { baseUrl: string; tokenId: string; fingerprint: string; secret: string }

export type ImportResult =
  | { state: 'none' }
  | { state: 'imported'; connection: ImportedConnection }
  /** Not imported. `kept`: the file was left in place (fix it and import again); else it was deleted. */
  | { state: 'refused'; reason: string; kept: boolean }

/** Larger than any real connection file: anything bigger is not one. */
const MAX_BYTES = 16 * 1024
const FIELDS = new Set(['baseUrl', 'tokenId', 'fingerprint', 'secret'])

/** Overwrites the file's bytes before unlinking it, so the secret is not left in the freed blocks
 *  of a simple file system (copy-on-write file systems and SSDs may still keep old blocks). */
export async function shred(path: string): Promise<void> {
  try {
    const handle = await open(path, 'r+')
    try {
      const { size } = await handle.stat()
      if (size > 0) await handle.write(Buffer.alloc(Math.min(size, MAX_BYTES * 4)), 0, Math.min(size, MAX_BYTES * 4), 0)
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // Unwritable: still try to remove it.
  }
  await unlink(path).catch(() => undefined)
}

/**
 * Reads and consumes the import file. Refused and left in place: a symlink or not a regular
 * file, a file group or others may read (POSIX), or one that is too large. Refused and deleted:
 * anything that is not exactly a JSON object of the four string fields (it may hold a secret).
 */
export async function takeImport(path = importFile(), platform: NodeJS.Platform = process.platform): Promise<ImportResult> {
  let info
  try {
    info = await lstat(path)
  } catch {
    return { state: 'none' }
  }
  if (info.isSymbolicLink() || !info.isFile()) return { state: 'refused', reason: 'The import file is not a regular file (a link or a folder); it was not read.', kept: true }
  if (platform !== 'win32' && (info.mode & 0o077) !== 0) {
    return { state: 'refused', reason: 'The import file can be read by other users; it was not read. Make it private (chmod 600) and import again.', kept: true }
  }
  if (info.size > MAX_BYTES) return { state: 'refused', reason: 'The import file is too large to be a connection; it was not read.', kept: true }
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    await shred(path)
    return { state: 'refused', reason: 'The import file is not valid JSON; it was deleted.', kept: false }
  }
  await shred(path)
  const ok =
    !!raw &&
    typeof raw === 'object' &&
    !Array.isArray(raw) &&
    Object.keys(raw).every((k) => FIELDS.has(k)) &&
    ['baseUrl', 'tokenId', 'secret'].every((k) => typeof (raw as Record<string, unknown>)[k] === 'string') &&
    ['undefined', 'string'].includes(typeof (raw as Record<string, unknown>).fingerprint)
  if (!ok) return { state: 'refused', reason: 'The import file must be a JSON object with baseUrl, tokenId, secret and optionally fingerprint, all strings; it was deleted.', kept: false }
  const r = raw as Record<string, string>
  return { state: 'imported', connection: { baseUrl: r.baseUrl, tokenId: r.tokenId, fingerprint: r.fingerprint ?? '', secret: r.secret } }
}
