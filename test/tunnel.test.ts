// SSH tunnels with a fake ssh: the arguments, the pinned host key, learning a key in a test,
// restarts with a pause, and stopping. No ssh is run and nothing leaves this machine.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after } from 'node:test'
import { assert, test } from 'orca/testing'
import type { SshTunnel } from '../src/model'
import { ApiError } from '../src/proxmox/client'
import { findSsh, hostKeyFingerprint, sshArgs, sshFailure, TunnelManager, type TunnelChild } from '../src/proxmox/tunnel'

/** An example host key (32 bytes 1..32), and its fingerprint as ssh-keygen -l prints it. */
const HOST_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8g'
const HOST_KEY_FP = 'SHA256:mKqU+0K8OhKmA8bBQi9Rz0Q5l7/g160hIP+rJYSTNj4'
const TUNNEL: SshTunnel = { host: 'pve-x1.example.test', port: 2222, user: 'orca-tunnel', identityFile: '/home/example/.ssh/orca-proxmox', target: '127.0.0.1:8006', hostKey: HOST_KEY }

const dir = mkdtempSync(join(tmpdir(), 'orca-tunnel-test-'))
after(() => rmSync(dir, { recursive: true, force: true }))

/** A fake ssh: records each start; `behave` decides what this start does. */
function fakeSsh(behave: (args: string[], child: FakeChild) => void) {
  const starts: { args: string[]; child: FakeChild }[] = []
  const spawn = (_cmd: string, args: string[]): TunnelChild => {
    const child = new FakeChild()
    starts.push({ args, child })
    // Like a real process: what it does happens after spawn returns.
    setImmediate(() => behave(args, child))
    return child
  }
  return { starts, spawn }
}

class FakeChild implements TunnelChild {
  killed = false
  private exitListeners: ((code: number | null, signal: string | null) => void)[] = []
  private errListeners: ((chunk: string) => void)[] = []
  readonly stderr = { on: (_e: 'data', l: (chunk: string) => void) => this.errListeners.push(l) }
  on(_event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown {
    this.exitListeners.push(listener)
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
    const listeners = this.exitListeners
    this.exitListeners = []
    for (const l of listeners) l(code, null)
  }
}

function manager(behave: (args: string[], child: FakeChild) => void, clock = { now: 1_000 }, opts: { ssh?: string | null } = {}) {
  const ssh = fakeSsh(behave)
  let nextPort = 40000
  const exited = new Set<FakeChild>()
  const m = new TunnelManager({
    spawn: ssh.spawn,
    sshPath: () => (opts.ssh === undefined ? '/usr/bin/ssh' : opts.ssh),
    dir,
    freePort: async () => nextPort++,
    // Ready unless the fake ssh exited at once.
    waitForPort: async (_port, _ms, gaveUp) => {
      await new Promise((r) => setTimeout(r, 5))
      return !gaveUp()
    },
    now: () => clock.now
  })
  return { m, ssh, clock, exited }
}

const option = (args: string[], name: string) => args.find((a, i) => args[i - 1] === '-o' && a.startsWith(`${name}=`))?.slice(name.length + 1)

test('ssh runs without the person’s config, without prompts, with this key and a pinned host key only', async () => {
  const { m, ssh } = manager(() => undefined)
  const to = await m.ensure('c-1@r1', TUNNEL)
  assert.deepEqual(to, { host: '127.0.0.1', port: 40000 })
  const args = ssh.starts[0].args
  assert.deepEqual(args.slice(0, 4), ['-F', 'none', '-N', '-T'])
  for (const [name, value] of [['BatchMode', 'yes'], ['IdentitiesOnly', 'yes'], ['ExitOnForwardFailure', 'yes'], ['StrictHostKeyChecking', 'yes'], ['PasswordAuthentication', 'no'], ['GlobalKnownHostsFile', 'none'], ['UpdateHostKeys', 'no']]) {
    assert.equal(option(args, name), value, name)
  }
  assert.ok(option(args, 'ServerAliveInterval'))
  assert.deepEqual(args.slice(-10), ['-i', TUNNEL.identityFile, '-p', '2222', '-l', 'orca-tunnel', '-L', '127.0.0.1:40000:127.0.0.1:8006', '--', 'pve-x1.example.test'])
  // The known_hosts file holds exactly the pinned key, under [host]:port.
  assert.equal(readFileSync(option(args, 'UserKnownHostsFile')!, 'utf8'), `[pve-x1.example.test]:2222 ${HOST_KEY}\n`)
  // Running: the same tunnel again, nothing new started.
  assert.deepEqual(await m.ensure('c-1@r1', TUNNEL), to)
  assert.equal(ssh.starts.length, 1)
  m.stopAll()
  assert.ok(ssh.starts[0].child.killed)
  assert.equal(m.running(), 0)
})

test('without a pinned host key a tunnel is refused; a test learns the key and shows its fingerprint', async () => {
  const learning = manager((args, child) => {
    // Like ssh with accept-new: the new key is written to the known_hosts file it was given.
    assert.equal(option(args, 'StrictHostKeyChecking'), 'accept-new')
    writeFileSync(option(args, 'UserKnownHostsFile')!, `[pve-x1.example.test]:2222 ${HOST_KEY}\n`)
    void child
  })
  await assert.rejects(learning.m.ensure('c-1@r1', { ...TUNNEL, hostKey: '' }), /No SSH host key is pinned/)
  assert.equal(learning.ssh.starts.length, 0)
  const probe = await learning.m.probe({ ...TUNNEL, hostKey: '' })
  assert.equal(probe.hostKey, HOST_KEY)
  assert.equal(hostKeyFingerprint(probe.hostKey), HOST_KEY_FP)
  probe.stop()
  assert.ok(learning.ssh.starts[0].child.killed)
  // A test with a key pinned checks it strictly, as the running tunnel does.
  const strict = manager((args) => assert.equal(option(args, 'StrictHostKeyChecking'), 'yes'))
  ;(await strict.m.probe(TUNNEL)).stop()
})

test('a tunnel that fails says why, waits a growing pause, then starts again', async () => {
  let fail = true
  const { m, ssh, clock } = manager((_args, child) => {
    if (fail) {
      child.say('Permission denied (publickey).\r\n')
      child.exit(255)
    }
  })
  const first = await m.ensure('c-1@r1', TUNNEL).catch((e: ApiError) => e)
  assert.ok(first instanceof ApiError)
  assert.equal(first.info.kind, 'auth')
  assert.match(first.message, /SSH refused the key for orca-tunnel@pve-x1.example.test:2222/)
  // Within the pause: no new ssh, the same reason.
  await assert.rejects(m.ensure('c-1@r1', TUNNEL), /next try in 1 s/)
  assert.equal(ssh.starts.length, 1)
  clock.now += 1_001
  await assert.rejects(m.ensure('c-1@r1', TUNNEL))
  assert.equal(ssh.starts.length, 2)
  await assert.rejects(m.ensure('c-1@r1', TUNNEL), /next try in 2 s/)
  // Fixed on the server: after the pause it comes up, and a later exit is noticed.
  fail = false
  clock.now += 2_001
  const up = await m.ensure('c-1@r1', TUNNEL)
  assert.equal(ssh.starts.length, 3)
  ssh.starts[2].child.say('Connection to pve-x1.example.test closed by remote host.\n')
  ssh.starts[2].child.exit(255)
  assert.equal(m.running(), 0)
  clock.now += 1_001
  const again = await m.ensure('c-1@r1', TUNNEL)
  assert.notEqual(again.port, up.port)
  assert.equal(ssh.starts.length, 4)
})

test('a changed configuration stops the old tunnel; retain keeps only the current ones', async () => {
  const { m, ssh } = manager(() => undefined)
  await m.ensure('c-1@r1', TUNNEL)
  await m.ensure('c-2@r1', { ...TUNNEL, host: 'pve-x2.example.test' })
  // The same connection with other tunnel settings: the old ssh is stopped first.
  await m.ensure('c-1@r1', { ...TUNNEL, target: '127.0.0.1:8007' })
  assert.ok(ssh.starts[0].child.killed)
  assert.equal(m.running(), 2)
  m.retain(new Set(['c-2@r1']))
  assert.ok(ssh.starts[2].child.killed)
  assert.ok(!ssh.starts[1].child.killed)
  assert.equal(m.running(), 1)
})

test('no ssh on the machine is a clear error; ssh’s own words become the reason', async () => {
  const { m } = manager(() => undefined, { now: 0 }, { ssh: null })
  await assert.rejects(m.ensure('c-1@r1', TUNNEL), /No OpenSSH client \(ssh\) was found/)
  assert.equal(sshFailure(TUNNEL, 'Host key verification failed.').info.kind, 'fingerprint-mismatch')
  assert.match(sshFailure(TUNNEL, 'channel 2: open failed: administratively prohibited: open failed').message, /would not forward to 127.0.0.1:8006/)
  assert.match(sshFailure(TUNNEL, 'ssh: Could not resolve hostname pve-x1.example.test').message, /did not come up/)
  assert.equal(findSsh('win32', { SystemRoot: 'C:\\Windows' }, (p) => p === 'C:\\Windows\\System32\\OpenSSH\\ssh.exe'), 'C:\\Windows\\System32\\OpenSSH\\ssh.exe')
  assert.equal(findSsh('linux', {}, (p) => p === '/usr/bin/ssh'), '/usr/bin/ssh')
  assert.equal(findSsh('darwin', {}, () => false), null)
  assert.equal(hostKeyFingerprint('not a key'), null)
  // The forward and the host stay separate arguments; a host can never become an option.
  assert.equal(sshArgs(TUNNEL, 1, 'k', false).at(-2), '--')
})
