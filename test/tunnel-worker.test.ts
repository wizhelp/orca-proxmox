// A direct PVE through an SSH tunnel, in the worker, with a fake ssh that really listens on the
// forwarded local port: the test learns and shows the host key, saving pins it, reads go through
// the tunnel, and removing the connection stops it. Example data only.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after } from 'node:test'
import { afterEach, assert, mockHost, mountWorker, test, type TestWorker } from 'orca/testing'
import type { HttpRequest } from '../src/proxmox/http'
import type { TunnelChild } from '../src/proxmox/tunnel'
import { memoryVault } from '../src/vault'
import * as main from '../src/worker'
import { pveRoutes } from './fixtures/direct'
import { mockTransport } from './fixtures/pdm'

const NOW = Date.UTC(2026, 10, 25, 12, 0, 0)
const PIN = 'EC:7A:EF:38:FF:F7:59:92:C1:E3:B0:4C:1D:22:FF:C9:67:C6:91:C8:74:48:53:13:12:1A:C0:42:D1:5B:37:05'
const HOST_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8g'
const PVE_BASE = { id: 'new', kind: 'pve' as const, name: 'lab', baseUrl: 'https://pve.example.test:8006', tokenId: 'monitor@pve!orca', fingerprint: PIN, secret: '22222222-2222-4222-8222-222222222222' }

const dir = mkdtempSync(join(tmpdir(), 'orca-tunnel-worker-'))
// A synthetic private key file: the plugin only checks that it can be read before ssh runs.
const KEY = join(dir, 'orca-proxmox-tunnel')
writeFileSync(KEY, 'not a real key\n', { mode: 0o600 })
const TUNNEL = { host: 'pve-x1.example.test', port: 22, user: 'orca-tunnel', identityFile: KEY, target: '127.0.0.1:8006', hostKey: '' }
const PVE = { ...PVE_BASE, tunnel: TUNNEL }
after(() => rmSync(dir, { recursive: true, force: true }))

let worker: TestWorker | undefined
afterEach(async () => {
  await worker?.deactivate()
  worker = undefined
})

/** A fake ssh: listens on the -L port like a forward would; with accept-new, writes the host key. */
function fakeSsh() {
  const runs: { args: string[]; killed: boolean }[] = []
  const spawn = (_cmd: string, args: string[]): TunnelChild => {
    const run = { args, killed: false }
    runs.push(run)
    const exit: ((code: number | null, signal: string | null) => void)[] = []
    const say: ((chunk: string) => void)[] = []
    const opt = (name: string) => args.find((a, i) => args[i - 1] === '-o' && a.startsWith(`${name}=`))?.slice(name.length + 1)
    const knownHosts = () => opt('UserKnownHostsFile')!.slice(1, -1).replace(/%%/g, '%').replace(/\\(["\\])/g, '$1')
    const port = Number(args[args.indexOf('-L') + 1].split(':')[1])
    // Like ssh -v: each connection it takes on its forward is said.
    const server = net.createServer((s) => {
      for (const l of say) l(`debug1: Connection to port ${port} forwarding to 127.0.0.1 port 8006 requested.\r\n`)
      s.destroy()
    })
    setImmediate(() => {
      if (opt('StrictHostKeyChecking') === 'accept-new') writeFileSync(knownHosts(), `pve-x1.example.test ${HOST_KEY}
`)
      // Like ssh -v: it binds the forward, then says so.
      server.listen(port, '127.0.0.1', () => {
        for (const l of say) l(`debug1: Local forwarding listening on 127.0.0.1 port ${port}.
`)
      })
    })
    return {
      stderr: { on: (_e: 'data', l: (chunk: string) => void) => say.push(l) },
      on: (event: 'exit' | 'error', l: never) => (event === 'exit' ? exit.push(l) : 0),
      kill: () => {
        run.killed = true
        server.close()
        for (const l of exit.splice(0)) l(null, 'SIGTERM')
        return true
      }
    } as TunnelChild
  }
  return { runs, spawn }
}

async function mounted(importPath?: string) {
  const ssh = fakeSsh()
  const requests: HttpRequest[] = []
  const pve = mockTransport(pveRoutes(NOW) as never)
  const transport = async (request: HttpRequest) => {
    requests.push(request)
    return pve(request)
  }
  main.useTestDoubles({ transport, probe: async () => PIN, now: () => NOW, vault: memoryVault(), spawnSsh: ssh.spawn, sshPath: '/usr/bin/ssh', tunnelDir: dir, ...(importPath ? { importPath, importPlatform: 'win32' as const } : {}) })
  const host = mockHost()
  worker = await mountWorker(main, { host })
  return { ssh, requests, host }
}

test('a tunnelled PVE: the test shows the SSH host key, saving pins it, reads go through the tunnel', async () => {
  const { ssh, requests } = await mounted()
  // Saving before a test showed the host key is refused.
  await assert.rejects(worker!.request('config.save', PVE), /Test the connection first/)
  const tested = await worker!.request('connection.test', PVE)
  assert.equal(tested.ok, true)
  assert.deepEqual(tested.sshHostKey, { key: HOST_KEY, fingerprint: 'SHA256:mKqU+0K8OhKmA8bBQi9Rz0Q5l7/g160hIP+rJYSTNj4', for: 'pve-x1.example.test:22' })
  assert.equal(ssh.runs.length, 1)
  assert.ok(ssh.runs[0].killed, 'the test tunnel is stopped after the test')
  // Every API request of the test went to the tunnel's local end, with the server's own URL and pin.
  assert.ok(requests.length > 0 && requests.every((r) => r.connectTo?.host === '127.0.0.1' && r.url.host === 'pve.example.test:8006' && r.fingerprint))
  // Saved with the key the person compared: from then on only that key is accepted.
  const saved = await worker!.request('config.save', { ...PVE, tunnel: { ...TUNNEL, hostKey: HOST_KEY } })
  assert.equal(saved.connections[0].tunnel?.hostKey, HOST_KEY)
  requests.length = 0
  const answer = await worker!.request('estate.get', {})
  assert.equal(answer.state, 'ok')
  assert.ok(requests.length > 0 && requests.every((r) => r.connectTo?.host === '127.0.0.1'))
  const running = ssh.runs.filter((r) => !r.killed)
  assert.equal(running.length, 1)
  const args = running[0].args
  assert.equal(args[args.indexOf('StrictHostKeyChecking=yes')], 'StrictHostKeyChecking=yes')
  // Removed: the next read stops its tunnel.
  const pve = saved.connections[0]
  await worker!.request('config.clear', { id: pve.id, revision: pve.revision! })
  await worker!.request('estate.get', {})
  assert.ok(ssh.runs.every((r) => r.killed))
})

test('a tunnel is checked field by field, and an import must bring a verified host key', async () => {
  const importPath = join(dir, 'connection-import.json')
  const { ssh } = await mounted(importPath)
  const bad = async (tunnel: Record<string, unknown>, re: RegExp) => assert.rejects(worker!.request('config.save', { ...PVE, tunnel: { ...TUNNEL, hostKey: HOST_KEY, ...tunnel } as never }), re)
  await bad({ host: '-oProxyCommand=x' }, /SSH host must be a DNS name/)
  await bad({ user: 'root; rm' }, /plain user name/)
  await bad({ identityFile: 'relative/key' }, /absolute path/)
  await bad({ target: 'evil host:8006' }, /host:port/)
  await bad({ port: 70000 }, /from 1 to 65535/)
  await bad({ hostKey: 'not-a-key' }, /one public key/)
  await assert.rejects(worker!.request('config.save', { ...PVE, kind: 'pdm', name: undefined, baseUrl: 'https://pdm.example.test:8443', tunnel: { ...TUNNEL, hostKey: HOST_KEY } } as never), /direct PVE or PBS/)
  // The default target follows the product.
  await worker!.request('connection.test', { ...PVE, kind: 'pbs', name: 'backup-x', baseUrl: 'https://pbs.example.test:8007', tokenId: 'monitor@pbs!orca', tunnel: { ...TUNNEL, target: '' } })
  assert.ok(ssh.runs.at(-1)!.args.includes(`127.0.0.1:${ssh.runs.at(-1)!.args[ssh.runs.at(-1)!.args.indexOf('-L') + 1].split(':')[1]}:127.0.0.1:8007`))
  // An import cannot show anyone a host key: without one it is refused, nothing changes, no ssh runs.
  const before = ssh.runs.length
  writeFileSync(importPath, JSON.stringify({ ...PVE, id: undefined, tunnel: TUNNEL }))
  const config = await worker!.request('config.import')
  assert.equal(config.importStatus?.ok, false)
  assert.match(config.importStatus!.message, /The tunnel has no hostKey/)
  assert.equal(config.connections.length, 0)
  assert.equal(ssh.runs.length, before)
})

test('once the worker is stopping, no tunnel manager is created and no ssh starts, even the first', async () => {
  const ssh = fakeSsh()
  main.useTestDoubles({ transport: mockTransport(pveRoutes(NOW) as never), probe: async () => PIN, now: () => NOW, vault: memoryVault(), spawnSsh: ssh.spawn, sshPath: '/usr/bin/ssh', tunnelDir: dir })
  worker = await mountWorker(main, { host: mockHost() })
  // Saved with the key already verified: saving starts no tunnel, so no manager exists yet.
  await worker.request('config.save', { ...PVE, tunnel: { ...TUNNEL, hostKey: HOST_KEY } })
  assert.equal(ssh.runs.length, 0)
  // Orca stops the worker while requests are still arriving (a refresh, a test from Settings).
  main.deactivate()
  const read = await worker.request('estate.get', {})
  const tested = await worker.request('connection.test', { ...PVE, tunnel: { ...TUNNEL, hostKey: HOST_KEY } })
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(ssh.runs.length, 0, 'no ssh after the worker stopped')
  assert.equal(read.state, 'error')
  assert.equal(tested.ok, false)
})

test('a Windows key path with backslashes is accepted; one that lost them says what it got', async () => {
  await mounted()
  if (process.platform === 'win32') {
    const answer = await worker!.request('connection.test', { ...PVE, tunnel: { ...TUNNEL, identityFile: 'C:\\Users\\example\\.ssh\\orca_proxmox_tunnel' } })
    // Past validation: the next check is whether the file can be read.
    assert.ok(!answer.ok && /cannot be read/.test(answer.error.message), JSON.stringify(answer))
  }
  await assert.rejects(
    worker!.request('config.save', { ...PVE, tunnel: { ...TUNNEL, hostKey: HOST_KEY, identityFile: 'C:Usersexample.sshorca_proxmox_tunnel' } }),
    /given as "C:Usersexample\.sshorca_proxmox_tunnel" \(backslashes lost/
  )
})
