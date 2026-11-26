// SSH tunnels to direct PVE or PBS connections whose API is only reachable from the server itself
// (only SSH open). The worker runs the system's OpenSSH client, without a shell and without the
// person's ~/.ssh/config (`-F none`, every option explicit), as `ssh -N -L 127.0.0.1:<port>:<target>`,
// and the HTTP client then talks to https://127.0.0.1:<port> while still checking the server's
// certificate pin and name (http.ts `connectTo`).
//
// The SSH server's host key is pinned like the TLS certificate: stored with the connection and
// written to a known_hosts file of the worker's own, with StrictHostKeyChecking=yes. Only an
// explicit test in Settings (`mode: 'learn'`) accepts a new key, and hands it back to be shown
// and saved. A tunnel that exits is started again on the next request, after a growing pause.
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import * as net from 'node:net'
import { join } from 'node:path'
import type { SshTunnel } from '../model'
import { ApiError } from './client'
import type { ConnectTo } from './http'

/** What the worker needs of a child process; tests pass a fake one. */
export type TunnelChild = {
  readonly stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
}
export type SpawnSsh = (command: string, args: string[]) => TunnelChild

export type TunnelDeps = {
  spawn: SpawnSsh
  /** The ssh executable, or null when there is none. */
  sshPath: () => string | null
  /** A private folder for the known_hosts files. */
  dir: string
  /** A free local TCP port. */
  freePort: () => Promise<number>
  /** Resolves once something accepts connections on 127.0.0.1:port. */
  waitForPort: (port: number, timeoutMs: number, gaveUp: () => boolean) => Promise<boolean>
  now: () => number
}

/** How long a new tunnel may take to come up (connect, key exchange, auth, forward). */
const READY_MS = 20_000
const MAX_BACKOFF_MS = 60_000

/** Where OpenSSH usually is: Windows' built-in client, else the system one. */
export function findSsh(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, exists: (path: string) => boolean = existsSync): string | null {
  const candidates =
    platform === 'win32'
      ? [join(env.SystemRoot ?? env.windir ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe')]
      : ['/usr/bin/ssh', '/usr/local/bin/ssh', '/opt/homebrew/bin/ssh']
  return candidates.find((p) => exists(p)) ?? null
}

/** `ssh-ed25519 AAAA…` -> `SHA256:…` as `ssh-keygen -l` prints it; null if it is not a key. */
export function hostKeyFingerprint(hostKey: string): string | null {
  const parts = hostKey.trim().split(/\s+/)
  if (parts.length < 2 || !/^(ssh-|ecdsa-|sk-)/.test(parts[0]) || !/^[A-Za-z0-9+/]+={0,2}$/.test(parts[1])) return null
  const blob = Buffer.from(parts[1], 'base64')
  if (blob.length < 16) return null
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`
}

/** The known_hosts name of the SSH server: `host`, or `[host]:port` off port 22. */
function knownHostsName(t: SshTunnel): string {
  return t.port === 22 ? t.host : `[${t.host}]:${t.port}`
}

/** The first key (`type base64`) in a known_hosts file's text, or null. */
export function firstHostKey(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/)
    if (parts.length >= 3 && !line.trim().startsWith('#')) {
      const key = `${parts[1]} ${parts[2]}`
      if (hostKeyFingerprint(key)) return key
    }
  }
  return null
}

/** The ssh arguments: no config file, no prompts, only this key, only this forward. */
export function sshArgs(t: SshTunnel, localPort: number, knownHostsFile: string, learn: boolean): string[] {
  const o = (option: string) => ['-o', option]
  return [
    '-F', 'none',
    '-N', '-T',
    ...o('BatchMode=yes'),
    ...o('IdentitiesOnly=yes'),
    ...o('PasswordAuthentication=no'),
    ...o('KbdInteractiveAuthentication=no'),
    ...o('ExitOnForwardFailure=yes'),
    ...o('ServerAliveInterval=15'),
    ...o('ServerAliveCountMax=3'),
    ...o('ConnectTimeout=10'),
    ...o(`StrictHostKeyChecking=${learn ? 'accept-new' : 'yes'}`),
    ...o(`UserKnownHostsFile=${knownHostsFile}`),
    ...o('GlobalKnownHostsFile=none'),
    ...o('CheckHostIP=no'),
    ...o('HashKnownHosts=no'),
    ...o('UpdateHostKeys=no'),
    ...o('ClearAllForwardings=no'),
    '-i', t.identityFile,
    '-p', String(t.port),
    '-l', t.user,
    '-L', `127.0.0.1:${localPort}:${t.target}`,
    '--', t.host
  ]
}

/** An ssh failure, from its last words on stderr, as an error the panel can explain. */
export function sshFailure(t: SshTunnel, stderr: string): ApiError {
  const at = `${t.user}@${t.host}:${t.port}`
  if (/host key verification failed|remote host identification has changed|host key for .* has changed/i.test(stderr)) {
    return new ApiError({ kind: 'fingerprint-mismatch', message: `The SSH host key of ${t.host} does not match the pinned one`, hint: 'If the server was reinstalled on purpose, test the connection again in Settings and compare the new SSH host key before saving it; otherwise do not connect.' })
  }
  if (/permission denied|no more authentication methods|too many authentication failures/i.test(stderr)) {
    return new ApiError({ kind: 'auth', message: `SSH refused the key for ${at}`, hint: 'Check the user, the identity file (a key without a passphrase, readable by you only) and that its public key is in that user’s authorized_keys on the server.' })
  }
  if (/load key|no such identity|identity file .* not accessible|bad permissions|unprotected private key/i.test(stderr)) {
    return new ApiError({ kind: 'invalid-config', message: `SSH cannot use the identity file ${t.identityFile}`, hint: 'The key file must exist and be readable by you only.' })
  }
  if (/forwarding failed|open failed|administratively prohibited|port forwarding is disabled|could not request local forwarding/i.test(stderr)) {
    return new ApiError({ kind: 'unreachable', message: `SSH on ${t.host} would not forward to ${t.target}`, hint: 'The key’s permitopen= (or the server’s AllowTcpForwarding) must allow exactly this target.' })
  }
  const last = stderr.trim().split(/\r?\n/).filter(Boolean).pop() ?? ''
  return new ApiError({ kind: 'unreachable', message: `The SSH tunnel to ${at} did not come up${last ? `: ${last.slice(0, 160)}` : ''}`, hint: 'Check the SSH host, port and that this machine can reach it.' })
}

type Entry = {
  tunnel: SshTunnel
  fingerprint: string
  child?: TunnelChild
  port?: number
  /** Its known_hosts file, removed with it. */
  file?: string
  starting?: Promise<ConnectTo>
  failures: number
  retryAt: number
  lastError?: ApiError
  wanted: boolean
}

export class TunnelManager {
  private entries = new Map<string, Entry>()

  constructor(private readonly deps: TunnelDeps) {}

  /** The local end of the tunnel `key` (one per connection revision), started if need be. */
  ensure(key: string, tunnel: SshTunnel): Promise<ConnectTo> {
    const fingerprint = JSON.stringify(tunnel)
    let entry = this.entries.get(key)
    if (entry && entry.fingerprint !== fingerprint) {
      this.stop(key)
      entry = undefined
    }
    if (!entry) {
      entry = { tunnel, fingerprint, failures: 0, retryAt: 0, wanted: true }
      this.entries.set(key, entry)
    }
    if (entry.child && entry.port !== undefined) return Promise.resolve({ host: '127.0.0.1', port: entry.port })
    if (entry.starting) return entry.starting
    const now = this.deps.now()
    if (entry.retryAt > now && entry.lastError) {
      const wait = Math.ceil((entry.retryAt - now) / 1000)
      return Promise.reject(new ApiError({ ...entry.lastError.info, message: `${entry.lastError.info.message} (next try in ${wait} s)` }))
    }
    const current = entry
    current.starting = this.start(current, false)
      .then(({ connectTo }) => connectTo)
      .finally(() => {
        current.starting = undefined
      })
    return current.starting
  }

  /**
   * A tunnel for a test in Settings: started apart from the running ones, with a new host key
   * accepted (when none is pinned yet) and handed back; the caller stops it with the returned stop.
   */
  async probe(tunnel: SshTunnel): Promise<{ connectTo: ConnectTo; hostKey: string; stop: () => void }> {
    const entry: Entry = { tunnel, fingerprint: '', failures: 0, retryAt: 0, wanted: true }
    const { connectTo, hostKey } = await this.start(entry, !tunnel.hostKey)
    return { connectTo, hostKey, stop: () => this.kill(entry) }
  }

  /** Stops every tunnel whose key is not in `keep` (a configuration changed or a connection went). */
  retain(keep: ReadonlySet<string>): void {
    for (const key of [...this.entries.keys()]) if (!keep.has(key)) this.stop(key)
  }

  stop(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    this.kill(entry)
    this.entries.delete(key)
  }

  stopAll(): void {
    for (const key of [...this.entries.keys()]) this.stop(key)
  }

  /** How many tunnels are running (for tests and diagnostics). */
  running(): number {
    return [...this.entries.values()].filter((e) => e.child).length
  }

  private kill(entry: Entry): void {
    entry.wanted = false
    entry.child?.kill()
    entry.child = undefined
    entry.port = undefined
    if (entry.file) void rm(entry.file, { force: true }).catch(() => undefined)
    entry.file = undefined
  }

  private async start(entry: Entry, learn: boolean): Promise<{ connectTo: ConnectTo; hostKey: string }> {
    const t = entry.tunnel
    const ssh = this.deps.sshPath()
    if (!ssh) {
      throw new ApiError({ kind: 'invalid-config', message: 'No OpenSSH client (ssh) was found on this machine', hint: 'On Windows, add the optional feature “OpenSSH Client”; on macOS and Linux, install openssh-client. Then test the connection again.' })
    }
    if (!learn && !hostKeyFingerprint(t.hostKey)) {
      throw new ApiError({ kind: 'invalid-config', message: `No SSH host key is pinned for ${t.host}`, hint: 'Test the connection in Settings, compare the SSH host key it shows, and save.' })
    }
    await mkdir(this.deps.dir, { recursive: true, mode: 0o700 })
    const knownHosts = join(this.deps.dir, `${createHash('sha256').update(`${t.host}|${t.port}|${learn ? 'learn' : t.hostKey}|${this.deps.now()}|${Math.random()}`).digest('hex').slice(0, 16)}.known_hosts`)
    await writeFile(knownHosts, learn ? '' : `${knownHostsName(t)} ${t.hostKey.trim()}\n`, { mode: 0o600 })
    await chmod(knownHosts, 0o600).catch(() => undefined)
    const port = await this.deps.freePort()
    let stderr = ''
    let exited = false
    const child = this.deps.spawn(ssh, sshArgs(t, port, knownHosts, learn))
    child.stderr?.on('data', (chunk) => {
      stderr = (stderr + String(chunk)).slice(-4000)
    })
    child.on('exit', () => {
      exited = true
      if (entry.child === child) {
        entry.child = undefined
        entry.port = undefined
        // Gone while in use: the next request starts it again, after a pause that grows.
        if (entry.wanted) this.failed(entry, sshFailure(t, stderr || 'ssh exited'))
      }
    })
    const ready = await this.deps.waitForPort(port, READY_MS, () => exited)
    if (!ready || exited) {
      child.kill()
      await rm(knownHosts, { force: true }).catch(() => undefined)
      const error = exited ? sshFailure(t, stderr) : new ApiError({ kind: 'timeout', message: `The SSH tunnel to ${t.host} did not come up within ${READY_MS / 1000} s` })
      this.failed(entry, error)
      throw error
    }
    let hostKey = t.hostKey
    if (learn) hostKey = firstHostKey(await readFile(knownHosts, 'utf8').catch(() => '')) ?? ''
    if (!entry.wanted) {
      child.kill()
      await rm(knownHosts, { force: true }).catch(() => undefined)
      throw new ApiError({ kind: 'unreachable', message: 'The connection changed while its SSH tunnel started' })
    }
    entry.child = child
    entry.port = port
    entry.file = knownHosts
    entry.failures = 0
    entry.lastError = undefined
    return { connectTo: { host: '127.0.0.1', port }, hostKey }
  }

  private failed(entry: Entry, error: ApiError): void {
    entry.failures += 1
    entry.lastError = error
    entry.retryAt = this.deps.now() + Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (entry.failures - 1))
  }
}

/** A free TCP port on 127.0.0.1 (the OS picks it; a race with another program is caught by ssh's ExitOnForwardFailure). */
export function freeLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port
      server.close(() => resolve(port))
    })
  })
}

/** Polls 127.0.0.1:port until it accepts a connection, the process gave up, or the time is out. */
export async function waitForLocalPort(port: number, timeoutMs: number, gaveUp: () => boolean): Promise<boolean> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until && !gaveUp()) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port })
      socket.once('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.once('error', () => resolve(false))
    })
    if (open) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}
