// Keeps the token secret out of the panel's reach and bound to the endpoint it was entered for.
// Orca hands `secrets:own` and `storage:own` to the plugin's HTML frame as well as to its worker,
// so panel code could read a secret stored as is, or rewrite the connection settings the worker
// reads. The worker therefore stores the secret sealed (AES-256-GCM) with a key only its Node
// process can read (the frame has no file access), and authenticates the endpoint with it: the
// connection's id, revision, kind, canonical base URL, token ID and pinned fingerprint are the
// associated data. A sealed secret opens only for exactly the settings it was sealed with, so
// settings changed behind the worker's back make it unusable rather than redirect it.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** What a sealed secret is bound to. */
/** `route`: how the endpoint is reached when not directly (an SSH tunnel), absent otherwise. */
export type Binding = { id: string; revision?: string; kind: string; baseUrl: string; tokenId: string; fingerprint: string; route?: string }

export type Vault = {
  /** The text to store for `plain`, bound to `binding`. */
  seal(plain: string, binding: Binding): Promise<string>
  /**
   * The secret a stored value holds, or null: lost or other key, settings that differ from the
   * ones it was sealed for, or a value stored before binding (which is never trusted: the
   * settings it would be bound to could have been changed meanwhile).
   */
  open(stored: string, binding: Binding): Promise<string | null>
}

const PREFIX = 'sealed:v2:'

/** The associated data: every field that decides where the secret goes, in a fixed order. */
export function bindingData(b: Binding): Buffer {
  // A route is appended only when there is one, so secrets sealed before tunnels still open.
  return Buffer.from(JSON.stringify(['orca-proxmox token v2', b.id, b.revision ?? '', b.kind, b.baseUrl, b.tokenId, b.fingerprint, ...(b.route ? [b.route] : [])]))
}

/** The per-user folder for the worker's key, by platform convention. */
export function keyFile(): string {
  const home = homedir()
  const base =
    process.platform === 'win32'
      ? join(home, 'AppData', 'Local')
      : process.platform === 'darwin'
        ? join(home, 'Library', 'Application Support')
        : (process.env.XDG_CONFIG_HOME ?? join(home, '.config'))
  return join(base, 'orca-proxmox-visualizer', 'worker.key')
}

/** A vault over a 32-byte key: `loadKey(true)` creates one when there is none. */
export function keyVault(loadKey: (create: boolean) => Promise<Buffer | null>): Vault {
  return {
    async seal(plain, binding) {
      const key = await loadKey(true)
      if (!key) throw new Error('The worker could not create its key file.')
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      cipher.setAAD(bindingData(binding))
      const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
      return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')
    },
    async open(stored, binding) {
      if (!stored.startsWith(PREFIX)) return null
      const key = await loadKey(false)
      if (!key) return null
      try {
        const raw = Buffer.from(stored.slice(PREFIX.length), 'base64')
        const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12))
        decipher.setAAD(bindingData(binding))
        decipher.setAuthTag(raw.subarray(12, 28))
        return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')
      } catch {
        return null
      }
    }
  }
}

/** The key in a file only this user can read (0600 in a 0700 folder where the OS honours it). */
export function fileVault(path = keyFile()): Vault {
  let cached: Buffer | undefined
  return keyVault(async (create) => {
    if (cached) return cached
    try {
      const key = await readFile(path)
      if (key.length === 32) return (cached = key)
    } catch {
      // No key yet.
    }
    if (!create) return null
    await mkdir(join(path, '..'), { recursive: true, mode: 0o700 })
    const key = randomBytes(32)
    try {
      await writeFile(path, key, { mode: 0o600, flag: 'wx' })
      return (cached = key)
    } catch {
      // Another worker wrote one first: use that.
      const existing = await readFile(path).catch(() => null)
      return existing && existing.length === 32 ? (cached = existing) : null
    }
  })
}

/** A vault with its key in memory, for tests. */
export function memoryVault(key = randomBytes(32)): Vault {
  return keyVault(async () => key)
}
