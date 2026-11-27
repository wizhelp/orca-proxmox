// Paired Orca servers that Orca does not identify (no SSH target, an endpoint on loopback): the
// endpoint's host when it names the machine, else the server's own names and addresses, asked
// once per runtime through a terminal of one of its workspaces (fake Orca CLI here), then placed
// like an SSH target. Example data only.
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { assert, test } from 'orca/testing'
import type { Guest, Host, OrcaHost, OrcaWorkspace } from '../src/model'
import { identityOf, ServerIdentities } from '../src/orca/identify'
import { endpointHost } from '../src/orca/inventory'
import type { CliRunner } from '../src/orca/inventory'
import { placeOrcaHosts } from '../src/orca/match'

const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex')
function frame(runId: string, pairs: [string, string][]): string[] {
  const lines = pairs.map(([k, v], i) => `ORCA-SETUP-${runId} ${i + 1} ${k} ${v}`)
  return [...lines, `ORCA-SETUP-${runId} ${pairs.length + 1} end ok ${sha(pairs.map(([k, v]) => `${k} ${v}\n`).join(''))}`, '']
}

const node = (name: string, addresses: string[]): Host => ({ key: `lab/${name}`, remote: 'lab', remoteType: 'pve', node: name, online: true, status: 'online', addresses }) as Host
const estate = { hosts: [node('pve-x1', ['198.51.100.21']), node('pve-x2', ['198.51.100.22'])], guests: [] as Guest[] }
const server = (over: Partial<OrcaHost> = {}): OrcaHost => ({ key: 'env:server-x', kind: 'environment', name: 'server-x', runtimeId: 'runtime-1', ...over })

test('an endpoint names the machine only when it is not loopback', () => {
  const env = (endpoint: string, extra = {}) => ({ id: 'e', endpoints: [{ id: 'a', endpoint }], preferredEndpointId: 'a', ...extra })
  assert.equal(endpointHost(env('ws://127.0.0.1:53939/')), undefined)
  assert.equal(endpointHost(env('ws://localhost:53939/')), undefined)
  assert.equal(endpointHost(env('ws://[::1]:53939/')), undefined)
  assert.equal(endpointHost(env('wss://198.51.100.21:7443/')), '198.51.100.21')
  assert.equal(endpointHost(env('wss://Orca-X.example.test/')), 'orca-x.example.test')
  assert.equal(endpointHost(env('not a url')), undefined)
  // The preferred endpoint counts, not the first.
  assert.equal(endpointHost({ endpoints: [{ id: 'a', endpoint: 'ws://127.0.0.1:1/' }, { id: 'b', endpoint: 'wss://198.51.100.22:7443/' }], preferredEndpointId: 'b' }), '198.51.100.22')
})

test('a paired server is placed by its own addresses or names; an unknown one stays unplaced, never hidden', () => {
  const placed = (h: OrcaHost) => placeOrcaHosts([h], estate)[0]
  // Its label matches nothing: unplaced (the panel lists it under "Not placed yet").
  assert.equal(placed(server()).runsOn, undefined)
  assert.deepEqual(placed(server({ identity: { names: [], addresses: ['198.51.100.22'], from: 'server' } })).runsOn, { kind: 'node', key: 'lab/pve-x2' })
  const byName = placed(server({ identity: { names: ['pve-x1', 'pve-x1.example.test'], addresses: [], from: 'server' } }))
  assert.deepEqual([byName.runsOn, byName.match], [{ kind: 'node', key: 'lab/pve-x1' }, 'identified'])
  assert.deepEqual(placed(server({ identity: { names: ['198.51.100.21'], addresses: [], from: 'endpoint' } })).runsOn, { kind: 'node', key: 'lab/pve-x1' })
  // A manual "not on Proxmox" still wins.
  assert.equal(placeOrcaHosts([server({ identity: { names: ['pve-x1'], addresses: [], from: 'server' } })], estate, { 'env:server-x': 'none' })[0].runsOn, undefined)
})

test('what the server says is kept only in its strict form', () => {
  const answer = (pairs: [string, string][]) => ({ end: 'ok', pairs })
  const id = identityOf(answer([['hostname', 'pve-x1'], ['fqdn', 'pve-x1.example.test'], ['addr', '198.51.100.21'], ['addr', '127.0.1.1'], ['addr', 'fe80::1'], ['addr', '2001:db8::21'], ['addr', 'x; reboot']]), 'runtime-1', 1)
  assert.deepEqual(id, { runtimeId: 'runtime-1', at: 1, names: ['pve-x1', 'pve-x1.example.test'], addresses: ['198.51.100.21', '2001:db8::21'] })
  assert.equal(identityOf(answer([['hostname', '$(reboot)']]), 'runtime-1', 1), null)
  assert.equal(identityOf({ pairs: [['hostname', 'pve-x1']] }, 'runtime-1', 1), null, 'only a complete answer')
})

/** A fake Orca CLI: terminals on the server answer the identify script with `pairs`. */
function fakeCli(pairs: [string, string][] | null) {
  const typed: string[] = []
  const closed: string[] = []
  let runId = ''
  const run: CliRunner = async (args) => {
    const cmd = args.slice(0, 2).join(' ')
    const arg = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
    if (cmd === 'terminal create') {
      typed.push(arg('command')!)
      const script = gunzipSync(Buffer.from(/printf %s ([A-Za-z0-9+/=]+) \|/.exec(arg('command')!)![1], 'base64')).toString()
      runId = /^R=([0-9a-f]{16})$/m.exec(script)![1]
      return { terminal: { handle: 'term_1' } }
    }
    if (cmd === 'terminal read') {
      if (!pairs) throw new Error('gone')
      return { terminal: { status: 'running', tail: ['$', ...frame(runId, pairs)] } }
    }
    if (cmd === 'terminal close') {
      closed.push(arg('terminal')!)
      return {}
    }
    throw new Error(`unexpected ${args.join(' ')}`)
  }
  return { run, typed, closed }
}

const workspaces: OrcaWorkspace[] = [{ key: 'env:server-x|w', hostKey: 'env:server-x', name: 'work', repo: 'work', status: 'active', agents: [], worktreeId: 'repo::/srv/work', environment: 'server-x', serverName: 'server-x' }]

async function settle(ids: ServerIdentities, hosts: OrcaHost[]) {
  ids.ask(placeOrcaHosts(await ids.apply(hosts), estate), workspaces)
  for (let i = 0; i < 50; i += 1) await new Promise((r) => setTimeout(r, 2))
}

test('an unplaced paired server is asked once per runtime, read-only, not as root; the answer places it', async () => {
  const cli = fakeCli([['hostname', 'pve-x2'], ['fqdn', 'pve-x2.example.test'], ['addr', '198.51.100.22']])
  const store: Record<string, unknown> = {}
  const logs: string[] = []
  let now = 1000
  const ids = new ServerIdentities(() => ({ run: cli.run, sleep: async () => undefined, now: () => now, log: (t) => logs.push(t), storage: { get: async (k) => store[k] ?? null, set: async (k, v) => void (store[k] = v) } }))
  await settle(ids, [server()])
  assert.equal(cli.typed.length, 1)
  const script = gunzipSync(Buffer.from(/printf %s ([A-Za-z0-9+/=]+) \|/.exec(cli.typed[0])![1], 'base64')).toString()
  assert.match(script, /say hostname "\$\(hostname\)"/)
  assert.ok(!/sudo|pveum|useradd|rm |>>/.test(script.replace(/^#.*$/gm, '')), 'read-only, nothing else')
  assert.ok(!cli.typed[0].includes('sudo'), 'not as root')
  assert.deepEqual(cli.closed, ['term_1'], 'the terminal is closed')
  // Kept, and used: the server is placed on the node it reported.
  const hosts = await ids.apply([server()])
  assert.deepEqual(hosts[0].identity, { names: ['pve-x2', 'pve-x2.example.test'], addresses: ['198.51.100.22'], from: 'server' })
  assert.deepEqual(placeOrcaHosts(hosts, estate)[0].runsOn, { kind: 'node', key: 'lab/pve-x2' })
  // Placed now: not asked again. A new runtime (a reconnect) is asked again.
  await settle(ids, [server()])
  assert.equal(cli.typed.length, 1)
  assert.equal((await ids.apply([server({ runtimeId: 'runtime-2' })]))[0].identity, undefined)
  await settle(ids, [server({ runtimeId: 'runtime-2' })])
  assert.equal(cli.typed.length, 2)
  // Never for a server Orca places itself (its SSH target), one set by hand, or one already placed.
  await settle(ids, [server({ key: 'env:other', viaSsh: 'ssh:t', runtimeId: 'r' })])
  await settle(ids, [server({ key: 'env:other2', runtimeId: 'r', identity: { names: ['pve-x1'], addresses: [], from: 'endpoint' } })])
  assert.equal(cli.typed.length, 2)
  void now
})

test('a server that gives no answer is asked again only after an hour', async () => {
  const cli = fakeCli(null)
  let now = 1000
  const ids = new ServerIdentities(() => ({ run: cli.run, sleep: async () => undefined, now: () => now, log: () => undefined, storage: { get: async () => null, set: async () => undefined } }))
  await settle(ids, [server()])
  await settle(ids, [server()])
  assert.equal(cli.typed.length, 1)
  assert.deepEqual(cli.closed, ['term_1'])
  now += 60 * 60_000 + 1
  await settle(ids, [server()])
  assert.equal(cli.typed.length, 2)
})
