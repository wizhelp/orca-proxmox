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
//
// A tunnel set up by "Connect via Orca" uses the plugin's own key (`keyRef`), kept sealed with
// the token secrets: it is written to a file of the private folder, closed to others, only for the
// ssh that starts, and removed as soon as that ssh says it has authenticated (or ends).
import { createHash } from 'node:crypto'
import { constants, existsSync } from 'node:fs'
import { access, chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
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
  /** Opens and closes a connection to 127.0.0.1:port (readiness check); real TCP by default. */
  touch?: (port: number) => Promise<void>
  /** Whether the identity file can be read; the real file system by default. */
  identityReadable?: (path: string) => Promise<boolean>
  /** The plugin's own private key for `keyRef` (opened from its sealed store), or null. */
  identityKey?: (keyRef: string) => Promise<string | null>
  /** Makes a new, still empty key file readable by this user only (Windows: its ACL). */
  protectKeyFile?: (path: string) => Promise<void>
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

/**
 * The environment for ssh: the worker's, with what Windows OpenSSH cannot start without filled in.
 * Orca starts workers with a reduced environment, and ssh.exe exits at once (255, no message)
 * without %ProgramData% (where it keeps its own settings); SystemRoot and its relatives too.
 */
export function sshEnvironment(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  if (platform !== 'win32') return env
  const out: NodeJS.ProcessEnv = { ...env }
  const get = (name: string) => Object.entries(out).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1]
  const systemRoot = get('SystemRoot') ?? get('windir') ?? 'C:\\Windows'
  const systemDrive = get('SystemDrive') ?? systemRoot.slice(0, 2)
  const programData = get('ProgramData') ?? get('ALLUSERSPROFILE') ?? `${systemDrive}\\ProgramData`
  if (!get('SystemRoot')) out.SystemRoot = systemRoot
  if (!get('windir')) out.windir = systemRoot
  if (!get('SystemDrive')) out.SystemDrive = systemDrive
  if (!get('ProgramData')) out.ProgramData = programData
  if (!get('ALLUSERSPROFILE')) out.ALLUSERSPROFILE = programData
  return out
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

/** The ssh arguments: no config file, no prompts, only this key, only this forward. */
export function sshArgs(t: SshTunnel, localPort: number, knownHostsFile: string, learn: boolean, identityFile = t.identityFile): string[] {
  const o = (option: string) => ['-o', option]
  return [
    '-F', 'none',
    '-N', '-T',
    // Debug level 1, only to learn from ssh itself when its forward listens (see waitReady).
    '-v',
    ...o('BatchMode=yes'),
    // Only this key, from the configuration: -i is checked before its % tokens are expanded, and a
    // missing one would fall back to the default keys; no agent's keys either.
    ...o('IdentitiesOnly=yes'),
    ...o(`IdentityFile=${sshConfigPath(identityFile)}`),
    ...o('IdentityAgent=none'),
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

/** How many connections this ssh says it took on its forward's port. */
export function acceptedCount(stderr: string, port: number): number {
  return stderr.match(new RegExp(`Connection to port ${port} forwarding to `, 'g'))?.length ?? 0
}

/** ssh says it is about to listen on exactly this port (it binds right after). */
export function forwardListening(stderr: string, port: number): boolean {
  return new RegExp(`Local forwarding listening on 127\\.0\\.0\\.1 port ${port}\\b`).test(stderr)
}

/** An ssh failure, from its last words on stderr, as an error the panel can explain. */
export function sshFailure(t: SshTunnel, stderr: string, exit?: { code: number | null; signal: string | null }): ApiError {
  const words = said(stderr)
  const at = `${t.user}@${t.host}:${t.port}`
  if (/host key verification failed|remote host identification has changed|host key for .* has changed/i.test(words)) {
    return new ApiError({ kind: 'fingerprint-mismatch', message: `The SSH host key of ${t.host} does not match the pinned one`, hint: 'If the server was reinstalled on purpose, test the connection again in Settings and compare the new SSH host key before saving it; otherwise do not connect.' })
  }
  if (/permission denied|no more authentication methods|too many authentication failures/i.test(words)) {
    return new ApiError({ kind: 'auth', message: `SSH refused the key for ${at}`, hint: 'Check the user, the identity file (a key without a passphrase, readable by you only) and that its public key is in that user’s authorized_keys on the server.' })
  }
  if (/load key|no such identity|identity file .* not accessible|bad permissions|unprotected private key/i.test(words)) {
    return new ApiError({ kind: 'invalid-config', message: t.keyRef ? 'SSH cannot use the plugin’s own key for this connection' : `SSH cannot use the identity file ${t.identityFile}`, hint: 'The key file must exist and be readable by you only.' })
  }
  if (/forwarding failed|open failed|administratively prohibited|port forwarding is disabled|could not request local forwarding/i.test(words)) {
    return new ApiError({ kind: 'unreachable', message: `SSH on ${t.host} would not forward to ${t.target}`, hint: 'The account’s forwarding rules (permitopen= on the key, PermitOpen in sshd’s Match block) must allow exactly this target.' })
  }
  // Never ssh's own text: it can carry a server's login banner, or anything else. Only what it
  // amounts to, from a fixed list, and how ssh exited.
  const reason = /could not resolve hostname|name or service not known|no such host/i.test(words)
    ? `the name ${t.host} could not be resolved`
    : /connection refused/i.test(words)
      ? `port ${t.port} refused the connection`
      : /timed out|timeout/i.test(words)
        ? 'the connection timed out'
        : /no route to host|network is unreachable|host is unreachable/i.test(words)
          ? 'there is no route to the host'
          : /connection (reset|closed)|kex_exchange_identification|broken pipe|connection lost/i.test(words)
            ? 'the server closed the connection'
            : exit
              ? `ssh exited with ${exit.code !== null ? `code ${exit.code}` : `signal ${exit.signal}`}${words.trim() ? '' : ' and said nothing'}`
              : 'ssh exited'
  return new ApiError({ kind: 'unreachable', message: `The SSH tunnel to ${at} did not come up: ${reason}`, hint: 'Check the SSH host, port and that this machine can reach it.' })
}

/** One ssh process: tracked from spawn to its end. */
type Run = {
  child?: TunnelChild
  port: number
  file: string
  /** The plugin's own key, written for this ssh only until it has authenticated. */
  keyFile?: string
  stderr: string
  /** How it exited, once it did. */
  exit?: { code: number | null; signal: string | null }
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
          this.failed(current, sshFailure(tunnel, run.stderr, run.exit))
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
    if (run.file) void rm(run.file, { force: true }).catch(() => undefined)
    dropKey(run)
  }

  /** The private folder for known_hosts files. */
  private async folder(): Promise<string> {
    await mkdir(this.deps.dir, { recursive: true, mode: 0o700 })
    // mkdir's mode does not apply to a folder that already existed.
    await chmod(this.deps.dir, 0o700).catch(() => undefined)
    return this.deps.dir
  }

  /**
   * Starts ssh and waits until this ssh has accepted a connection on its forward. The run is
   * registered with `track` before anything is awaited (false: not wanted, nothing is started),
   * and a stop meanwhile is checked again right before ssh is spawned, so no process can be
   * started after stop() or stopAll().
   */
  private async launch(t: SshTunnel, learn: boolean, track: (run: Run) => boolean): Promise<{ run: Run; hostKey: string }> {
    const ssh = this.deps.sshPath()
    if (!ssh) {
      throw new ApiError({ kind: 'invalid-config', message: 'No OpenSSH client (ssh) was found on this machine', hint: 'On Windows, add the optional feature “OpenSSH Client”; on macOS and Linux, install openssh-client. Then test the connection again.' })
    }
    if (!learn && !hostKeyFingerprint(t.hostKey)) {
      throw new ApiError({ kind: 'invalid-config', message: `No SSH host key is pinned for ${t.host}`, hint: 'Test the connection in Settings, compare the SSH host key it shows, and save.' })
    }
    const changed = () => new ApiError({ kind: 'unreachable', message: 'The connection changed while its SSH tunnel started' })
    for (let attempt = 1; ; attempt += 1) {
      const run: Run = { port: 0, file: '', stderr: '', ready: false, done: false }
      if (this.closed || !track(run)) throw changed()
      // Only the configured key: ssh would otherwise fall back to the default ones.
      if (!t.keyRef && !(await (this.deps.identityReadable ?? identityReadable)(t.identityFile))) {
        this.end(run)
        throw new ApiError({ kind: 'invalid-config', message: `The identity file ${t.identityFile} cannot be read`, hint: 'Give the path of the tunnel’s private key on this machine (readable by you only).' })
      }
      const dir = await this.folder()
      run.port = await this.deps.freePort()
      run.file = join(dir, `${createHash('sha256').update(`${t.host}|${t.port}|${this.deps.now()}|${Math.random()}`).digest('hex').slice(0, 16)}.known_hosts`)
      await writeFile(run.file, learn ? '' : `${knownHostsName(t)} ${t.hostKey.trim()}\n`, { mode: 0o600 })
      await chmod(run.file, 0o600).catch(() => undefined)
      if (t.keyRef) {
        const pem = await this.deps.identityKey?.(t.keyRef).catch(() => null)
        if (!pem) {
          this.end(run)
          throw new ApiError({ kind: 'invalid-config', message: 'The plugin’s own SSH key for this connection is missing', hint: 'Connect the host again from Settings (Connect via Orca), or remove this connection.' })
        }
        // Created empty and closed to others first, only then the key; removed once ssh is in.
        run.keyFile = run.file.replace(/.known_hosts$/, '.key')
        await writeFile(run.keyFile, '', { mode: 0o600 })
        await chmod(run.keyFile, 0o600).catch(() => undefined)
        await this.deps.protectKeyFile?.(run.keyFile)
        await writeFile(run.keyFile, pem, { mode: 0o600 })
      }
      // The last moment before a process exists: stopped meanwhile, nothing is spawned.
      if (run.done || this.closed) {
        this.end(run)
        throw changed()
      }
      let child: TunnelChild
      try {
        child = this.deps.spawn(ssh, sshArgs(t, run.port, run.file, learn, run.keyFile ?? t.identityFile))
      } catch (error) {
        this.end(run)
        throw new ApiError({ kind: 'invalid-config', message: `ssh could not be started: ${error instanceof Error ? error.message : String(error)}` })
      }
      run.child = child
      const result = await this.waitReady(run, child, t)
      if (result === 'ready') {
        const hostKey = learn ? (firstHostKey(await readFile(run.file, 'utf8').catch(() => '')) ?? '') : t.hostKey
        if (run.done) throw sshFailure(t, run.stderr, run.exit)
        return { run, hostKey }
      }
      this.end(run)
      if (result === 'port-taken' && attempt < PORT_TRIES) continue
      throw result === 'port-taken' ? new ApiError({ kind: 'unreachable', message: 'No free local port for the SSH tunnel' }) : result
    }
  }

  /**
   * Resolves when this very ssh has accepted a connection on its forward, or why it will not. Its
   * "listening" line comes before it binds, so it only starts the check: a connection is made to
   * the port, and only this ssh saying it took it ("Connection to port N forwarding to …") counts.
   * Something else listening there never says that; this ssh then fails to bind and exits.
   */
  private waitReady(run: Run, child: TunnelChild, t: SshTunnel): Promise<'ready' | 'port-taken' | ApiError> {
    return new Promise((resolve) => {
      let settled = false
      let checking = false
      const settle = (value: 'ready' | 'port-taken' | ApiError) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      }
      const readyMs = this.deps.readyMs ?? READY_MS
      const timer = setTimeout(() => settle(new ApiError({ kind: 'timeout', message: `The SSH tunnel to ${t.host} did not come up within ${readyMs / 1000} s` })), readyMs)
      const touch = this.deps.touch ?? touchLocalPort
      const confirm = async () => {
        while (!settled && !run.done) {
          const before = acceptedCount(run.stderr, run.port)
          await touch(run.port)
          for (let i = 0; i < 20 && !settled && !run.done; i += 1) {
            if (acceptedCount(run.stderr, run.port) > before) {
              run.ready = true
              settle('ready')
              return
            }
            await new Promise((r) => setTimeout(r, 25))
          }
        }
      }
      child.stderr?.on('data', (chunk) => {
        run.stderr = (run.stderr + String(chunk)).slice(-16_000)
        // Authenticated: the key is not read again by this ssh.
        if (run.keyFile && /Authenticated to /.test(run.stderr)) dropKey(run)
        if (!checking && !run.done && forwardListening(run.stderr, run.port)) {
          checking = true
          void confirm()
        }
      })
      child.on('error', (error) => {
        const wasDone = run.done
        run.done = true
        this.probes.delete(run)
        if (run.file) void rm(run.file, { force: true }).catch(() => undefined)
        dropKey(run)
        settle(new ApiError({ kind: 'invalid-config', message: `ssh could not be run: ${error.message}` }))
        if (run.ready && !wasDone) run.onLost?.()
      })
      child.on('exit', (code, signal) => {
        const wasDone = run.done
        run.done = true
        this.probes.delete(run)
        if (run.file) void rm(run.file, { force: true }).catch(() => undefined)
        dropKey(run)
        run.exit = { code, signal }
        if (!run.ready) settle(portTaken(run.stderr, run.port) ? 'port-taken' : sshFailure(t, run.stderr, run.exit))
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

/** Removes a run's copy of the plugin's key, once. */
function dropKey(run: Run): void {
  if (!run.keyFile) return
  const file = run.keyFile
  run.keyFile = undefined
  void rm(file, { force: true }).catch(() => undefined)
}

/** Connects to 127.0.0.1:port and closes again shortly after (time for ssh to take it). */
export function touchLocalPort(port: number): Promise<void> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const done = () => {
      socket.destroy()
      resolve()
    }
    socket.once('connect', () => setTimeout(done, 150))
    socket.once('error', done)
    socket.setTimeout(2000, done)
  })
}

async function identityReadable(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK)
    return true
  } catch {
    return false
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
