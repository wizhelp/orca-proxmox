// SSH tunnels to direct PVE or PBS connections whose API is only reachable from the server itself
// (only SSH open). The worker runs the system's OpenSSH client, without a shell and without the
// person's ~/.ssh/config (`-F none`, every option explicit), as `ssh -N -L 127.0.0.1:<port>:<target>`,
// and the HTTP client then talks to https://127.0.0.1:<port> while still checking the server's
// certificate pin and name (http.ts `connectTo`).
//
// The SSH server's host key is pinned like the TLS certificate: stored with the connection and
// written to a known_hosts file of the worker's own, with StrictHostKeyChecking=yes. Only an
// explicit test in Settings accepts a new key, and hands it back to be shown and saved.
//
// A tunnel is ready only when that very ssh process says it listens on the port (`-v`: "Local
// forwarding listening on 127.0.0.1 port N"), never because something answers on the port; with
// ExitOnForwardFailure a port taken meanwhile makes it exit, and it is tried again on another.
// Every ssh child, persistent or for a test, is tracked from the moment it is spawned and goes
// through one cleanup; a tunnel that exits is started again on the next request, after a growing
// pause.
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
  on(event: 'error', listener: (error: Error) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
}
export type SpawnSsh = (command: string, args: string[]) => TunnelChild

export type TunnelDeps = {
  spawn: SpawnSsh
  /** The ssh executable, or null when there is none. */
  sshPath: () => string | null
  /** A private folder for the known_hosts files. */
  dir: string
  /** A free local TCP port (a suggestion: ssh's own bind decides). */
  freePort: () => Promise<number>
  now: () => number
  /** How long a new tunnel may take to come up; 20 s by default. */
  readyMs?: number
}

const READY_MS = 20_000
const MAX_BACKOFF_MS = 60_000
/** Tries with another local port when the one picked was taken before ssh bound it. */
const PORT_TRIES = 3

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

/**
 * A file name as one value of an ssh `-o` option: ssh's config parser splits on whitespace unless
 * quoted, unescapes `\\` and `\"` in quotes, and expands `%` tokens; `${…}` cannot be escaped.
 */
export function sshConfigPath(path: string): string {
  if (path.includes('${')) throw new ApiError({ kind: 'invalid-config', message: `The path ${path} cannot be given to ssh (it contains "\${")` })
  return `"${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`
}

/** An identity file for `-i`, which ssh does not split but does expand `%` tokens in. */
export function sshIdentityPath(path: string): string {
  if (path.includes('${')) throw new ApiError({ kind: 'invalid-config', message: `The identity file ${path} cannot be given to ssh (it contains "\${")` })
  return path.replace(/%/g, '%%')
}

/** The ssh arguments: no config file, no prompts, only this key, only this forward. */
export function sshArgs(t: SshTunnel, localPort: number, knownHostsFile: string, learn: boolean): string[] {
  const o = (option: string) => ['-o', option]
  return [
    '-F', 'none',
    '-N', '-T',
    // Debug level 1, only to learn from ssh itself when its forward listens (see waitReady).
    '-v',
    ...o('BatchMode=yes'),
    ...o('IdentitiesOnly=yes'),
    ...o('PasswordAuthentication=no'),
    ...o('KbdInteractiveAuthentication=no'),
    ...o('ExitOnForwardFailure=yes'),
    ...o('ServerAliveInterval=15'),
    ...o('ServerAliveCountMax=3'),
    ...o('ConnectTimeout=10'),
    ...o(`StrictHostKeyChecking=${learn ? 'accept-new' : 'yes'}`),
    ...o(`UserKnownHostsFile=${sshConfigPath(knownHostsFile)}`),
    ...o('GlobalKnownHostsFile=none'),
    ...o('CheckHostIP=no'),
    ...o('HashKnownHosts=no'),
    ...o('UpdateHostKeys=no'),
    ...o('ClearAllForwardings=no'),
    '-i', sshIdentityPath(t.identityFile),
    '-p', String(t.port),
    '-l', t.user,
    '-L', `127.0.0.1:${localPort}:${t.target}`,
    '--', t.host
  ]
}

/** ssh's own words, without its debug lines. */
const said = (stderr: string) => stderr.split(/\r?\n/).filter((l) => l.trim() && !/^debug\d?:/.test(l.trim())).join('\n')

/** The forward's port was taken before ssh bound it. */
export function portTaken(stderr: string, port: number): boolean {
  return new RegExp(`bind \\[?127\\.0\\.0\\.1\\]?:${port}: |cannot listen to port: ${port}\\b`, 'i').test(said(stderr))
}

/** ssh says its forward listens, on exactly this port. */
export function forwardListening(stderr: string, port: number): boolean {
  return new RegExp(`Local forwarding listening on 127\\.0\\.0\\.1 port ${port}\\b`).test(stderr)
}

/** An ssh failure, from its last words on stderr, as an error the panel can explain. */
export function sshFailure(t: SshTunnel, stderr: string): ApiError {
  const words = said(stderr)
  const at = `${t.user}@${t.host}:${t.port}`
  if (/host key verification failed|remote host identification has changed|host key for .* has changed/i.test(words)) {
    return new ApiError({ kind: 'fingerprint-mismatch', message: `The SSH host key of ${t.host} does not match the pinned one`, hint: 'If the server was reinstalled on purpose, test the connection again in Settings and compare the new SSH host key before saving it; otherwise do not connect.' })
  }
  if (/permission denied|no more authentication methods|too many authentication failures/i.test(words)) {
    return new ApiError({ kind: 'auth', message: `SSH refused the key for ${at}`, hint: 'Check the user, the identity file (a key without a passphrase, readable by you only) and that its public key is in that user’s authorized_keys on the server.' })
  }
  if (/load key|no such identity|identity file .* not accessible|bad permissions|unprotected private key/i.test(words)) {
    return new ApiError({ kind: 'invalid-config', message: `SSH cannot use the identity file ${t.identityFile}`, hint: 'The key file must exist and be readable by you only.' })
  }
  if (/forwarding failed|open failed|administratively prohibited|port forwarding is disabled|could not request local forwarding/i.test(words)) {
    return new ApiError({ kind: 'unreachable', message: `SSH on ${t.host} would not forward to ${t.target}`, hint: 'The account’s forwarding rules (permitopen= on the key, PermitOpen in sshd’s Match block) must allow exactly this target.' })
  }
  const last = words.split('\n').pop() ?? ''
  return new ApiError({ kind: 'unreachable', message: `The SSH tunnel to ${at} did not come up${last ? `: ${last.slice(0, 160)}` : ''}`, hint: 'Check the SSH host, port and that this machine can reach it.' })
}

/** One ssh process: tracked from spawn to its end. */
type Run = {
  child?: TunnelChild
  port: number
  file: string
  stderr: string
  ready: boolean
  done: boolean
  /** Called once if it ends by itself after it was ready. */
  onLost?: () => void
}

type Entry = {
  tunnel: SshTunnel
  fingerprint: string
  run?: Run
  starting?: Promise<ConnectTo>
  failures: number
  retryAt: number
  lastError?: ApiError
  removed: boolean
}

export class TunnelManager {
  private entries = new Map<string, Entry>()
  /** Tunnels started for a test in Settings. */
  private probes = new Set<Run>()
  /** The keys of the current configuration, once known: a stale route cannot start another. */
  private allowed: Set<string> | null = null
  private closed = false

  constructor(private readonly deps: TunnelDeps) {}

  /** The local end of the tunnel `key` (one per connection revision), started if need be. */
  ensure(key: string, tunnel: SshTunnel): Promise<ConnectTo> {
    if (this.closed) return Promise.reject(new ApiError({ kind: 'unreachable', message: 'The plugin is stopping; no SSH tunnel is started' }))
    if (this.allowed && !this.allowed.has(key)) return Promise.reject(new ApiError({ kind: 'unreachable', message: 'The connection changed; its SSH tunnel is not started' }))
    const fingerprint = JSON.stringify(tunnel)
    let entry = this.entries.get(key)
    if (entry && entry.fingerprint !== fingerprint) {
      this.stop(key)
      entry = undefined
    }
    if (!entry) {
      entry = { tunnel, fingerprint, failures: 0, retryAt: 0, removed: false }
      this.entries.set(key, entry)
    }
    if (entry.run?.ready && !entry.run.done) return Promise.resolve({ host: '127.0.0.1', port: entry.run.port })
    if (entry.starting) return entry.starting
    const now = this.deps.now()
    if (entry.retryAt > now && entry.lastError) {
      const wait = Math.ceil((entry.retryAt - now) / 1000)
      return Promise.reject(new ApiError({ ...entry.lastError.info, message: `${entry.lastError.info.message} (next try in ${wait} s)` }))
    }
    const current = entry
    current.starting = this.launch(tunnel, false, (run) => {
      if (current.removed || this.closed) return false
      current.run = run
      return true
    })
      .then(({ run }) => {
        run.onLost = () => {
          if (current.run !== run) return
          current.run = undefined
          // Gone while in use: the next request starts it again, after a pause that grows.
          this.failed(current, sshFailure(tunnel, run.stderr || 'ssh exited'))
        }
        current.failures = 0
        current.lastError = undefined
        return { host: '127.0.0.1', port: run.port }
      })
      .catch((error: unknown) => {
        if (current.run?.done) current.run = undefined
        if (!current.removed) this.failed(current, error instanceof ApiError ? error : new ApiError({ kind: 'unreachable', message: String(error) }))
        throw error
      })
      .finally(() => {
        current.starting = undefined
      })
    return current.starting
  }

  /**
   * A tunnel for a test in Settings: started apart from the running ones, with a new host key
   * accepted (when none is pinned yet) and handed back; the caller stops it with the returned
   * stop, and stopAll() stops it too.
   */
  async probe(tunnel: SshTunnel): Promise<{ connectTo: ConnectTo; hostKey: string; stop: () => void }> {
    if (this.closed) throw new ApiError({ kind: 'unreachable', message: 'The plugin is stopping; no SSH tunnel is started' })
    const { run, hostKey } = await this.launch(tunnel, !tunnel.hostKey, (r) => {
      if (this.closed) return false
      this.probes.add(r)
      return true
    })
    return { connectTo: { host: '127.0.0.1', port: run.port }, hostKey, stop: () => this.end(run) }
  }

  /** Only these keys may run (the current configuration): every other tunnel is stopped. */
  retain(keep: ReadonlySet<string>): void {
    this.allowed = new Set(keep)
    for (const key of [...this.entries.keys()]) if (!keep.has(key)) this.stop(key)
  }

  stop(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    entry.removed = true
    if (entry.run) this.end(entry.run)
    entry.run = undefined
    this.entries.delete(key)
  }

  /** Everything, tests' tunnels and ones still starting included; nothing starts afterwards. */
  stopAll(): void {
    this.closed = true
    for (const key of [...this.entries.keys()]) this.stop(key)
    for (const run of [...this.probes]) this.end(run)
  }

  /** How many ssh processes are alive (for tests and diagnostics). */
  running(): number {
    return [...this.entries.values()].filter((e) => e.run && !e.run.done).length + this.probes.size
  }

  /** The one way an ssh process ends from here: killed once, its file removed, untracked. */
  private end(run: Run): void {
    this.probes.delete(run)
    if (!run.done) {
      run.done = true
      try {
        run.child?.kill()
      } catch {
        // Already gone.
      }
    }
    void rm(run.file, { force: true }).catch(() => undefined)
  }

  /** The private folder for known_hosts files. */
  private async folder(): Promise<string> {
    await mkdir(this.deps.dir, { recursive: true, mode: 0o700 })
    // mkdir's mode does not apply to a folder that already existed.
    await chmod(this.deps.dir, 0o700).catch(() => undefined)
    return this.deps.dir
  }

  /**
   * Starts ssh and waits until it says its forward listens. `track` registers the process the
   * moment it is spawned (false: not wanted any more, it is ended at once).
   */
  private async launch(t: SshTunnel, learn: boolean, track: (run: Run) => boolean): Promise<{ run: Run; hostKey: string }> {
    const ssh = this.deps.sshPath()
    if (!ssh) {
      throw new ApiError({ kind: 'invalid-config', message: 'No OpenSSH client (ssh) was found on this machine', hint: 'On Windows, add the optional feature “OpenSSH Client”; on macOS and Linux, install openssh-client. Then test the connection again.' })
    }
    if (!learn && !hostKeyFingerprint(t.hostKey)) {
      throw new ApiError({ kind: 'invalid-config', message: `No SSH host key is pinned for ${t.host}`, hint: 'Test the connection in Settings, compare the SSH host key it shows, and save.' })
    }
    const dir = await this.folder()
    for (let attempt = 1; ; attempt += 1) {
      const port = await this.deps.freePort()
      const file = join(dir, `${createHash('sha256').update(`${t.host}|${t.port}|${this.deps.now()}|${Math.random()}`).digest('hex').slice(0, 16)}.known_hosts`)
      await writeFile(file, learn ? '' : `${knownHostsName(t)} ${t.hostKey.trim()}\n`, { mode: 0o600 })
      await chmod(file, 0o600).catch(() => undefined)
      const run: Run = { port, file, stderr: '', ready: false, done: false }
      const args = sshArgs(t, port, file, learn)
      let child: TunnelChild
      try {
        child = this.deps.spawn(ssh, args)
      } catch (error) {
        this.end(run)
        throw new ApiError({ kind: 'invalid-config', message: `ssh could not be started: ${error instanceof Error ? error.message : String(error)}` })
      }
      run.child = child
      const outcome = this.waitReady(run, child, t)
      if (!track(run)) {
        this.end(run)
        await outcome.catch(() => undefined)
        throw new ApiError({ kind: 'unreachable', message: 'The connection changed while its SSH tunnel started' })
      }
      const result = await outcome
      if (result === 'ready') {
        const hostKey = learn ? (firstHostKey(await readFile(file, 'utf8').catch(() => '')) ?? '') : t.hostKey
        if (run.done) throw sshFailure(t, run.stderr || 'ssh exited')
        return { run, hostKey }
      }
      this.end(run)
      if (result === 'port-taken' && attempt < PORT_TRIES) continue
      throw result === 'port-taken' ? new ApiError({ kind: 'unreachable', message: 'No free local port for the SSH tunnel' }) : result
    }
  }

  /** Resolves when this ssh says its forward listens, or why it will not. */
  private waitReady(run: Run, child: TunnelChild, t: SshTunnel): Promise<'ready' | 'port-taken' | ApiError> {
    return new Promise((resolve) => {
      let settled = false
      const settle = (value: 'ready' | 'port-taken' | ApiError) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      }
      const timer = setTimeout(() => settle(new ApiError({ kind: 'timeout', message: `The SSH tunnel to ${t.host} did not come up within ${(this.deps.readyMs ?? READY_MS) / 1000} s` })), this.deps.readyMs ?? READY_MS)
      child.stderr?.on('data', (chunk) => {
        run.stderr = (run.stderr + String(chunk)).slice(-16_000)
        if (!run.ready && !run.done && forwardListening(run.stderr, run.port)) {
          run.ready = true
          settle('ready')
        }
      })
      child.on('error', (error) => {
        const wasDone = run.done
        run.done = true
        this.probes.delete(run)
        void rm(run.file, { force: true }).catch(() => undefined)
        settle(new ApiError({ kind: 'invalid-config', message: `ssh could not be run: ${error.message}` }))
        if (run.ready && !wasDone) run.onLost?.()
      })
      child.on('exit', () => {
        const wasDone = run.done
        run.done = true
        this.probes.delete(run)
        void rm(run.file, { force: true }).catch(() => undefined)
        if (!run.ready) settle(portTaken(run.stderr, run.port) ? 'port-taken' : sshFailure(t, run.stderr || 'ssh exited'))
        else if (!wasDone) run.onLost?.()
      })
    })
  }

  private failed(entry: Entry, error: ApiError): void {
    entry.failures += 1
    entry.lastError = error
    entry.retryAt = this.deps.now() + Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (entry.failures - 1))
  }
}

/** A port the OS calls free on 127.0.0.1; ssh binds it itself, and a race makes it exit and retry. */
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
