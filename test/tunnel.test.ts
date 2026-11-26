// SSH tunnels with a fake ssh: the arguments, the pinned host key, learning a key in a test,
// readiness from ssh itself, a taken port, restarts with a pause, and stopping everything that was
// spawned. The real OpenSSH client, where there is one, only parses options (`ssh -G`); nothing
// leaves this machine.
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after } from 'node:test'
import { assert, test } from 'orca/testing'
import type { SshTunnel } from '../src/model'
import { ApiError } from '../src/proxmox/client'
import { findSsh, hostKeyFingerprint, sshArgs, sshConfigPath, sshEnvironment, sshFailure, TunnelManager, type TunnelChild } from '../src/proxmox/tunnel'

/** An example host key (32 bytes 1..32), and its fingerprint as ssh-keygen -l prints it. */
const HOST_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8g'
const HOST_KEY_FP = 'SHA256:mKqU+0K8OhKmA8bBQi9Rz0Q5l7/g160hIP+rJYSTNj4'
const TUNNEL: SshTunnel = { host: 'pve-x1.example.test', port: 2222, user: 'orca-tunnel', identityFile: '/home/example/.ssh/orca-proxmox', target: '127.0.0.1:8006', hostKey: HOST_KEY }

const dir = mkdtempSync(join(tmpdir(), 'orca tunnel test %d '))
after(() => rmSync(dir, { recursive: true, force: true }))

class FakeChild implements TunnelChild {
  killed = false
  /** Its forward is bound: a connection to its port is taken (and said, as ssh -v does). */
  accepting = false
  private listeners = { exit: [] as ((code: number | null, signal: string | null) => void)[], error: [] as ((error: Error) => void)[] }
  private errListeners: ((chunk: string) => void)[] = []
  readonly stderr = { on: (_e: 'data', l: (chunk: string) => void) => this.errListeners.push(l) }
  on(event: 'exit' | 'error', listener: never): unknown {
    ;(this.listeners[event] as unknown[]).push(listener)
    return this
  }
  kill(): boolean {
    this.killed = true
    this.exit(null)
    return true
  }
  say(text: string): void {
    for (const l of this.errListeners) l(text)
  }
  exit(code: number | null): void {
    for (const l of this.listeners.exit.splice(0)) l(code, null)
  }
  fail(error: Error): void {
    for (const l of this.listeners.error.splice(0)) l(error)
  }
}

const option = (args: string[], name: string) => args.find((a, i) => args[i - 1] === '-o' && a.startsWith(`${name}=`))?.slice(name.length + 1)
/** The known_hosts file name back from its ssh config form. */
const knownHosts = (args: string[]) => option(args, 'UserKnownHostsFile')!.slice(1, -1).replace(/%%/g, '%').replace(/\\(["\\])/g, '$1')
const forwardPort = (args: string[]) => Number(args[args.indexOf('-L') + 1].split(':')[1])
/** What ssh -v says once its forward listens. */
const listen = (args: string[], child: FakeChild) => {
  child.say(`debug1: Authenticated to pve-x1.example.test ([203.0.113.9]:2222) using "publickey".\r\ndebug1: Local connections to 127.0.0.1:${forwardPort(args)} forwarded to remote address 127.0.0.1:8006\r\ndebug1: Local forwarding listening on 127.0.0.1 port ${forwardPort(args)}.\r\n`)
  child.accepting = true
}

/** A fake ssh: records each start; `behave` decides what this start does (by default: listen). */
function manager(behave: (args: string[], child: FakeChild, n: number) => void = listen, clock = { now: 1_000 }, opts: { ssh?: string | null; readyMs?: number; spawnThrows?: boolean; freePort?: () => Promise<number> } = {}) {
  const starts: { args: string[]; child: FakeChild }[] = []
  let nextPort = 40000
  const m = new TunnelManager({
    spawn: (_cmd, args) => {
      if (opts.spawnThrows) throw new Error('spawn EACCES')
      const child = new FakeChild()
      starts.push({ args, child })
      const n = starts.length
      // Like a real process: what it does happens after spawn returns.
      setImmediate(() => behave(args, child, n))
      return child
    },
    sshPath: () => (opts.ssh === undefined ? '/usr/bin/ssh' : opts.ssh),
    dir,
    freePort: opts.freePort ?? (async () => nextPort++),
    now: () => clock.now,
    readyMs: opts.readyMs ?? 2000,
    // A connection to the port: the fake ssh that has bound it takes it and says so.
    touch: async (port) => {
      const owner = starts.find((x) => forwardPort(x.args) === port && x.child.accepting && !x.child.killed)
      owner?.child.say(`debug1: Connection to port ${port} forwarding to 127.0.0.1 port 8006 requested.\r\n`)
    },
    identityReadable: async () => true
  })
  return { m, starts, clock }
}

test('ssh runs without the person’s config, without prompts, with this key and a pinned host key only', async () => {
  const { m, starts } = manager()
  const to = await m.ensure('c-1@r1', TUNNEL)
  assert.deepEqual(to, { host: '127.0.0.1', port: 40000 })
  const args = starts[0].args
  assert.deepEqual(args.slice(0, 5), ['-F', 'none', '-N', '-T', '-v'])
  for (const [name, value] of [['BatchMode', 'yes'], ['IdentitiesOnly', 'yes'], ['ExitOnForwardFailure', 'yes'], ['StrictHostKeyChecking', 'yes'], ['PasswordAuthentication', 'no'], ['GlobalKnownHostsFile', 'none'], ['UpdateHostKeys', 'no']]) {
    assert.equal(option(args, name), value, name)
  }
  assert.ok(option(args, 'ServerAliveInterval'))
  assert.deepEqual(args.slice(-8), ['-p', '2222', '-l', 'orca-tunnel', '-L', '127.0.0.1:40000:127.0.0.1:8006', '--', 'pve-x1.example.test'])
  assert.ok(!args.includes('-i'))
  assert.equal(option(args, 'IdentityFile'), '"/home/example/.ssh/orca-proxmox"')
  assert.equal(option(args, 'IdentityAgent'), 'none')
  // The known_hosts file (in a folder whose name has spaces and a %) holds exactly the pinned key.
  assert.equal(readFileSync(knownHosts(args), 'utf8'), `[pve-x1.example.test]:2222 ${HOST_KEY}\n`)
  // Running: the same tunnel again, nothing new started.
  assert.deepEqual(await m.ensure('c-1@r1', TUNNEL), to)
  assert.equal(starts.length, 1)
  m.stopAll()
  assert.ok(starts[0].child.killed)
  assert.equal(m.running(), 0)
})

test('paths reach ssh as one file each: spaces, quotes, backslashes and % stay literal', () => {
  assert.equal(sshConfigPath(String.raw`C:\Users\A B\k%dh`), String.raw`"C:\\Users\\A B\\k%%dh"`)
  assert.equal(sshConfigPath('/Users/x/Library/Application Support/a"b'), '"/Users/x/Library/Application Support/a\\"b"')
  assert.throws(() => sshConfigPath('/tmp/${HOME}/kh'), /cannot be given to ssh/)
  // The real OpenSSH client, where there is one, reads them back exactly (parsing only, no connection).
  const ssh = findSsh(process.platform, process.env)
  if (!ssh) return
  for (const path of [String.raw`C:\Users\A   B\k%dh`, '/Users/x/Library/Application Support/orca %h/t.kh', String.raw`C:\a b"c\d`]) {
    const r: SpawnSyncReturns<string> = spawnSync(ssh, ['-G', '-F', 'none', '-o', `UserKnownHostsFile=${sshConfigPath(path)}`, 'example.test'], { encoding: 'utf8' })
    const line: string | undefined = (r.stdout ?? '').split(/\r?\n/).find((l: string) => l.startsWith('userknownhostsfile '))
    assert.equal(line, `userknownhostsfile ${path}`, `${path}: ${r.stderr}`)
  }
})

test('without a pinned host key a tunnel is refused; a test learns the key and shows its fingerprint', async () => {
  const learning = manager((args, child) => {
    // Like ssh with accept-new: the new key is written to the known_hosts file it was given.
    assert.equal(option(args, 'StrictHostKeyChecking'), 'accept-new')
    writeFileSync(knownHosts(args), `[pve-x1.example.test]:2222 ${HOST_KEY}\n`)
    listen(args, child)
  })
  await assert.rejects(learning.m.ensure('c-1@r1', { ...TUNNEL, hostKey: '' }), /No SSH host key is pinned/)
  assert.equal(learning.starts.length, 0)
  const probe = await learning.m.probe({ ...TUNNEL, hostKey: '' })
  assert.equal(probe.hostKey, HOST_KEY)
  assert.equal(hostKeyFingerprint(probe.hostKey), HOST_KEY_FP)
  probe.stop()
  assert.ok(learning.starts[0].child.killed)
  // A test with a key pinned checks it strictly, as the running tunnel does.
  const strict = manager((args, child) => {
    assert.equal(option(args, 'StrictHostKeyChecking'), 'yes')
    listen(args, child)
  })
  ;(await strict.m.probe(TUNNEL)).stop()
})

test('ready only when this ssh took a connection on its forward: another listener on the port never counts', async () => {
  // Another program holds the port picked for the tunnel and accepts connections on it.
  let squatterConnections = 0
  const squatter = net.createServer((s) => {
    squatterConnections += 1
    s.destroy()
  })
  await new Promise<void>((r) => squatter.listen(0, '127.0.0.1', r))
  const taken = (squatter.address() as net.AddressInfo).port
  const starts: { args: string[]; child: FakeChild }[] = []
  const ports = [taken, 40100]
  const m = new TunnelManager({
    spawn: (_cmd, args) => {
      const child = new FakeChild()
      starts.push({ args, child })
      const n = starts.length
      setImmediate(() => {
        // Like OpenSSH: "listening" is said before the bind.
        child.say(`debug1: Local forwarding listening on 127.0.0.1 port ${forwardPort(args)}.\r\n`)
        if (n === 1) {
          // The bind fails (the port is taken); it says so a little later and exits.
          setTimeout(() => {
            child.say(`bind [127.0.0.1]:${forwardPort(args)}: Address already in use\r\nchannel_setup_fwd_listener_tcpip: cannot listen to port: ${forwardPort(args)}\r\nCould not request local forwarding.\r\n`)
            child.exit(255)
          }, 300)
        } else child.accepting = true
      })
      return child
    },
    sshPath: () => '/usr/bin/ssh',
    dir,
    freePort: async () => ports.shift()!,
    now: () => 0,
    readyMs: 3000,
    identityReadable: async () => true,
    // A real connection; a fake ssh that has bound the port also says it took it.
    touch: async (port) => {
      await new Promise<void>((resolve) => {
        const socket = net.connect({ host: '127.0.0.1', port }, () => (socket.destroy(), resolve()))
        socket.once('error', () => resolve())
      })
      const owner = starts.find((x) => forwardPort(x.args) === port && x.child.accepting && !x.child.killed)
      owner?.child.say(`debug1: Connection to port ${port} forwarding to 127.0.0.1 port 8006 requested.\r\n`)
    }
  })
  // The other program answered the check, yet the tunnel was not ready until the second ssh took a connection.
  assert.deepEqual(await m.ensure('c-1@r1', TUNNEL), { host: '127.0.0.1', port: 40100 })
  assert.ok(squatterConnections > 0, 'the check reached the other listener')
  assert.equal(starts.length, 2)
  m.stopAll()
  squatter.close()
  // An ssh that never takes a connection is never ready.
  const silent = new TunnelManager({ spawn: () => new FakeChild(), sshPath: () => '/usr/bin/ssh', dir, freePort: async () => 40200, now: () => 0, readyMs: 300, identityReadable: async () => true, touch: async () => undefined })
  await assert.rejects(silent.ensure('c-1@r1', TUNNEL), /did not come up within/)
})

test('a stop while a tunnel is being set up means no ssh is spawned at all', async () => {
  let release: () => void = () => undefined
  const gate = new Promise<void>((r) => (release = r))
  const { m, starts } = manager(listen, { now: 0 }, { freePort: async () => (await gate, 40300) })
  const probing = m.probe(TUNNEL).then(() => 'started', (e: Error) => e.message)
  const starting = m.ensure('c-9@r1', TUNNEL).then(() => 'started', (e: Error) => e.message)
  await new Promise((r) => setTimeout(r, 20))
  m.stopAll()
  release()
  assert.match(await probing, /changed|stopping/)
  assert.match(await starting, /changed|stopping/)
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(starts.length, 0)
})

test('the identity file: only that key, and a missing one stops before ssh runs', async () => {
  const missing = new TunnelManager({ spawn: () => assert.fail('no ssh may run'), sshPath: () => '/usr/bin/ssh', dir, freePort: async () => 40400, now: () => 0, identityReadable: async () => false })
  await assert.rejects(missing.ensure('c-1@r1', TUNNEL), /The identity file \/home\/example\/\.ssh\/orca-proxmox cannot be read/)
  // The real client, where there is one (parsing only): exactly this identity, no default keys, no agent.
  const ssh = findSsh(process.platform, process.env)
  if (!ssh) return
  for (const path of [join(dir, 'key %h with space'), join(dir, 'not there')]) {
    const args = sshArgs({ ...TUNNEL, identityFile: path }, 40500, join(dir, 'kh'), false)
    const options = args.flatMap((a, i) => (args[i - 1] === '-o' ? ['-o', a] : []))
    const r: SpawnSyncReturns<string> = spawnSync(ssh, ['-G', '-F', 'none', ...options, 'example.test'], { encoding: 'utf8' })
    const lines: string[] = (r.stdout ?? '').split(/\r?\n/)
    assert.deepEqual(lines.filter((l: string) => l.startsWith('identityfile ')), [`identityfile ${path.replace(/%/g, '%%')}`], r.stderr)
    assert.ok(lines.includes('identityagent none'))
    assert.ok(lines.includes('identitiesonly yes'))
  }
})

test('a tunnel that fails says why, waits a growing pause, then starts again', async () => {
  let fail = true
  const { m, starts, clock } = manager((args, child) => {
    if (fail) {
      child.say('debug1: Offering public key: /home/example/.ssh/orca-proxmox\r\nPermission denied (publickey).\r\n')
      child.exit(255)
    } else listen(args, child)
  })
  const first = await m.ensure('c-1@r1', TUNNEL).catch((e: ApiError) => e)
  assert.ok(first instanceof ApiError)
  assert.equal(first.info.kind, 'auth')
  assert.match(first.message, /SSH refused the key for orca-tunnel@pve-x1.example.test:2222/)
  // Within the pause: no new ssh, the same reason.
  await assert.rejects(m.ensure('c-1@r1', TUNNEL), /next try in 1 s/)
  assert.equal(starts.length, 1)
  clock.now += 1_001
  await assert.rejects(m.ensure('c-1@r1', TUNNEL))
  assert.equal(starts.length, 2)
  await assert.rejects(m.ensure('c-1@r1', TUNNEL), /next try in 2 s/)
  // Fixed on the server: after the pause it comes up, and a later exit is noticed.
  fail = false
  clock.now += 2_001
  const up = await m.ensure('c-1@r1', TUNNEL)
  assert.equal(starts.length, 3)
  starts[2].child.say('Connection to pve-x1.example.test closed by remote host.\n')
  starts[2].child.exit(255)
  assert.equal(m.running(), 0)
  clock.now += 1_001
  const again = await m.ensure('c-1@r1', TUNNEL)
  assert.notEqual(again.port, up.port)
  assert.equal(starts.length, 4)
  m.stopAll()
})

test('a changed configuration stops the old tunnel; a stale route cannot start a removed one', async () => {
  const { m, starts } = manager()
  await m.ensure('c-1@r1', TUNNEL)
  await m.ensure('c-2@r1', { ...TUNNEL, host: 'pve-x2.example.test' })
  // The same connection with other tunnel settings: the old ssh is stopped first.
  await m.ensure('c-1@r1', { ...TUNNEL, target: '127.0.0.1:8007' })
  assert.ok(starts[0].child.killed)
  assert.equal(m.running(), 2)
  m.retain(new Set(['c-2@r1']))
  assert.ok(starts[2].child.killed)
  assert.ok(!starts[1].child.killed)
  assert.equal(m.running(), 1)
  // A client of the old configuration asks for its tunnel again: refused, nothing spawned.
  await assert.rejects(m.ensure('c-1@r1', TUNNEL), /connection changed/)
  assert.equal(starts.length, 3)
  m.stopAll()
})

test('everything spawned is stopped: a tunnel still starting, a test’s tunnel, and after stopAll nothing starts', async () => {
  // ssh that never comes up (authentication hanging).
  const { m, starts } = manager(() => undefined)
  const starting = m.ensure('c-1@r1', TUNNEL)
  const probing = m.probe({ ...TUNNEL, host: 'pve-x2.example.test' })
  for (let i = 0; i < 100 && starts.length < 2; i += 1) await new Promise((r) => setTimeout(r, 10))
  assert.equal(starts.length, 2)
  // Removed while starting: its ssh is killed at once, not left behind.
  const byHost = (host: string) => starts.find((x) => x.args.at(-1) === host)!.child
  m.stop('c-1@r1')
  assert.ok(byHost('pve-x1.example.test').killed)
  assert.ok(!byHost('pve-x2.example.test').killed)
  await assert.rejects(starting)
  // Deactivated while a test's tunnel starts: that one too.
  m.stopAll()
  assert.ok(byHost('pve-x2.example.test').killed)
  await assert.rejects(probing)
  assert.equal(m.running(), 0)
  await assert.rejects(m.ensure('c-1@r1', TUNNEL), /stopping/)
  await assert.rejects(m.probe(TUNNEL), /stopping/)
  assert.equal(starts.length, 2)
})

test('ssh that cannot be run is an error, never a crash', async () => {
  // The executable vanished after it was found: ChildProcess emits 'error'.
  const { m } = manager((_args, child) => child.fail(Object.assign(new Error('spawn /usr/bin/ssh ENOENT'), { code: 'ENOENT' })))
  await assert.rejects(m.ensure('c-1@r1', TUNNEL), /ssh could not be run: spawn \/usr\/bin\/ssh ENOENT/)
  assert.equal(m.running(), 0)
  const thrown = manager(listen, { now: 0 }, { spawnThrows: true })
  await assert.rejects(thrown.m.ensure('c-1@r1', TUNNEL), /ssh could not be started/)
})

test('no ssh on the machine is a clear error; ssh’s own words become the reason', async () => {
  const { m } = manager(listen, { now: 0 }, { ssh: null })
  await assert.rejects(m.ensure('c-1@r1', TUNNEL), /No OpenSSH client \(ssh\) was found/)
  assert.equal(sshFailure(TUNNEL, 'Host key verification failed.').info.kind, 'fingerprint-mismatch')
  assert.match(sshFailure(TUNNEL, 'channel 2: open failed: administratively prohibited: open failed').message, /would not forward to 127.0.0.1:8006/)
  assert.match(sshFailure(TUNNEL, 'debug1: Connecting to pve-x1.example.test\r\nssh: Could not resolve hostname pve-x1.example.test').message, /did not come up: ssh: Could not resolve/)
  assert.equal(findSsh('win32', { SystemRoot: 'C:\\Windows' }, (p) => p === 'C:\\Windows\\System32\\OpenSSH\\ssh.exe'), 'C:\\Windows\\System32\\OpenSSH\\ssh.exe')
  assert.equal(findSsh('linux', {}, (p) => p === '/usr/bin/ssh'), '/usr/bin/ssh')
  assert.equal(findSsh('darwin', {}, () => false), null)
  assert.equal(hostKeyFingerprint('not a key'), null)
  // The forward and the host stay separate arguments; a host can never become an option.
  assert.equal(sshArgs(TUNNEL, 1, 'k', false).at(-2), '--')
})

test('Windows OpenSSH gets the environment it needs; a silent exit says its code', async () => {
  // Orca's reduced worker environment: no ProgramData, so ssh.exe would exit 255 without a word.
  const env = sshEnvironment({ HOME: 'C:\\Users\\example', USERPROFILE: 'C:\\Users\\example', SystemRoot: 'D:\\Windows' }, 'win32')
  assert.equal(env.ProgramData, 'D:\\ProgramData')
  assert.equal(env.SystemDrive, 'D:')
  assert.equal(env.windir, 'D:\\Windows')
  assert.equal(env.USERPROFILE, 'C:\\Users\\example')
  // What is there is kept (whatever its case), and other systems are left alone.
  assert.equal(sshEnvironment({ PROGRAMDATA: 'E:\\Data', SystemRoot: 'C:\\Windows' }, 'win32').PROGRAMDATA, 'E:\\Data')
  assert.equal(sshEnvironment({ PROGRAMDATA: 'E:\\Data', SystemRoot: 'C:\\Windows' }, 'win32').ProgramData, undefined)
  assert.deepEqual(sshEnvironment({ HOME: '/home/x' }, 'linux'), { HOME: '/home/x' })
  // ssh that exits without a word: the error says how it exited.
  const { m } = manager((_args, child) => child.exit(255))
  await assert.rejects(m.ensure('c-1@r1', TUNNEL), /did not come up: ssh exited with code 255 and said nothing/)
  // Its last words otherwise, without debug lines.
  assert.match(sshFailure(TUNNEL, 'debug1: x\r\nkex_exchange_identification: read: Connection reset\r\nConnection reset by 203.0.113.9 port 22\r\n').message, /kex_exchange_identification: read: Connection reset \/ Connection reset by 203\.0\.113\.9 port 22/)
})
