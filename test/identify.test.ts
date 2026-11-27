// Paired Orca servers that Orca does not identify (no SSH target, an endpoint on loopback): the
// endpoint's host when it names the machine, else the server's own names and addresses, asked
// once per runtime in a workspace the server runs itself (fake Orca CLI here), then used for
// placement only, never as a root SSH destination. Every probe's terminal is closed, whatever
// happens. Example data only.
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { assert, test } from 'orca/testing'
import type { EstateSnapshot, Guest, Host, OrcaHost, OrcaView, OrcaWorkspace } from '../src/model'
import { identityOf, ServerIdentities } from '../src/orca/identify'
import { endpointHost } from '../src/orca/inventory'
import type { CliRunner } from '../src/orca/inventory'
import { placeOrcaHosts } from '../src/orca/match'
import { terminalPlan } from '../src/orca/terminal'

const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex')
function frame(runId: string, pairs: [string, string][]): string[] {
  const lines = pairs.map(([k, v], i) => `ORCA-SETUP-${runId} ${i + 1} ${k} ${v}`)
  return [...lines, `ORCA-SETUP-${runId} ${pairs.length + 1} end ok ${sha(pairs.map(([k, v]) => `${k} ${v}\n`).join(''))}`, '']
}

const node = (name: string, addresses: string[]): Host => ({ key: `lab/${name}`, remote: 'lab', remoteType: 'pve', node: name, online: true, status: 'online', addresses }) as Host
const estate = { hosts: [node('pve-x1', ['198.51.100.21']), node('pve-x2', ['198.51.100.22'])], guests: [] as Guest[] }
const server = (over: Partial<OrcaHost> = {}): OrcaHost => ({ key: 'env:server-x', kind: 'environment', name: 'server-x', runtimeId: 'runtime-1', ...over })
const ws = (over: Partial<OrcaWorkspace>): OrcaWorkspace => ({ key: 'env:server-x|w', hostKey: 'env:server-x', name: 'work', repo: 'work', status: 'active', agents: [], worktreeId: 'repo::/srv/work', environment: 'server-x', serverName: 'server-x', ...over })
/** The server's own workspace, and a newer one it reaches over an SSH target of its own. */
const own = ws({ ownRuntime: true, lastActivityAt: 1 })
const nested = ws({ key: 'env:server-x|n', worktreeId: 'repo::/nested', lastActivityAt: 9 })

test('an endpoint names the machine only when it is not loopback', () => {
  const env = (endpoint: string) => ({ id: 'e', endpoints: [{ id: 'a', endpoint }], preferredEndpointId: 'a' })
  for (const loop of ['ws://127.0.0.1:53939/', 'ws://localhost:53939/', 'ws://localhost.:53939/', 'ws://[::1]:53939/', 'ws://[::ffff:127.0.0.1]:1/', 'ws://0.0.0.0:1/']) assert.equal(endpointHost(env(loop)), undefined, loop)
  assert.equal(endpointHost(env('wss://198.51.100.21:7443/')), '198.51.100.21')
  assert.equal(endpointHost(env('wss://Orca-X.example.test./')), 'orca-x.example.test')
  assert.equal(endpointHost(env('not a url')), undefined)
  // The preferred endpoint counts, not the first.
  assert.equal(endpointHost({ endpoints: [{ id: 'a', endpoint: 'ws://127.0.0.1:1/' }, { id: 'b', endpoint: 'wss://198.51.100.22:7443/' }], preferredEndpointId: 'b' }), '198.51.100.22')
})

test('a paired server is placed by its own addresses or names only when they all agree; never hidden', () => {
  const placed = (h: OrcaHost) => placeOrcaHosts([h], estate)[0]
  assert.equal(placed(server()).runsOn, undefined)
  assert.deepEqual(placed(server({ identity: { names: [], addresses: ['198.51.100.22'], from: 'server' } })).runsOn, { kind: 'node', key: 'lab/pve-x2' })
  const byName = placed(server({ identity: { names: ['pve-x1', 'pve-x1.example.test'], addresses: ['203.0.113.9'], from: 'server' } }))
  assert.deepEqual([byName.runsOn, byName.match], [{ kind: 'node', key: 'lab/pve-x1' }, 'identified'])
  // Claims that point to two machines place nothing.
  assert.equal(placed(server({ identity: { names: ['pve-x1'], addresses: ['198.51.100.22'], from: 'server' } })).runsOn, undefined)
  // A manual "not on Proxmox" still wins.
  assert.equal(placeOrcaHosts([server({ identity: { names: ['pve-x1'], addresses: [], from: 'server' } })], estate, { 'env:server-x': 'none' })[0].runsOn, undefined)
})

test('a place known only from what a server reported never opens a root SSH session', () => {
  const snap = { hosts: [{ ...node('pve-x1', ['198.51.100.21']), addresses: ['198.51.100.21'] }], guests: [] } as unknown as EstateSnapshot
  const view = (h: OrcaHost, workspaces: OrcaWorkspace[] = []): OrcaView => ({ fetchedAt: 0, hosts: [h], workspaces, bots: [], warnings: [] })
  const identified = placeOrcaHosts([server({ identity: { names: ['pve-x1'], addresses: [], from: 'server' } })], estate)[0]
  assert.equal(identified.match, 'identified')
  const plan = terminalPlan(identified.key, view(identified), snap)
  assert.ok('error' in plan && /not enough to open a root SSH session/.test(plan.error), JSON.stringify(plan))
  // Through the server's own Orca workspace it still works: that is Orca's connection, not ssh root@.
  const viaOrca = terminalPlan(identified.key, view(identified, [own]), snap)
  assert.ok(!('error' in viaOrca) && viaOrca.how === 'workspace')
  // Placed by hand (confirmed): the SSH fallback is allowed as for any placed host.
  const manual = placeOrcaHosts([server()], estate, { 'env:server-x': 'node:lab/pve-x1' })[0]
  const confirmed = terminalPlan(manual.key, view(manual), snap)
  assert.ok(!('error' in confirmed) && confirmed.how === 'ssh' && /root@198\.51\.100\.21/.test(confirmed.args.join(' ')), JSON.stringify(confirmed))
})

test('what the server says is kept only in its strict form', () => {
  const answer = (pairs: [string, string][]) => ({ end: 'ok', pairs })
  const id = identityOf(answer([['hostname', 'pve-x1'], ['fqdn', 'pve-x1.example.test'], ['addr', '198.51.100.21'], ['addr', '127.0.1.1'], ['addr', 'fe80::1'], ['addr', '2001:db8::21'], ['addr', 'x; reboot']]), 'runtime-1', 1)
  assert.deepEqual(id, { runtimeId: 'runtime-1', at: 1, names: ['pve-x1', 'pve-x1.example.test'], addresses: ['198.51.100.21', '2001:db8::21'] })
  assert.equal(identityOf(answer([['hostname', '$(reboot)']]), 'runtime-1', 1), null)
  assert.equal(identityOf({ pairs: [['hostname', 'pve-x1']] }, 'runtime-1', 1), null, 'only a complete answer')
})

type Fail = { create?: 'lost' | 'throw'; read?: boolean; close?: number; slow?: boolean }

/** A fake Orca CLI: terminals on the server answer the identify script with `pairs`. */
function fakeCli(pairs: [string, string][] | null, fail: Fail = {}) {
  const typed: { worktree: string; environment?: string; command: string; title: string }[] = []
  const open = new Map<string, string>()
  const closed: string[] = []
  let closeFailures = fail.close ?? 0
  let runId = ''
  const run: CliRunner = async (args) => {
    const cmd = args.slice(0, 2).join(' ')
    const arg = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
    if (cmd === 'terminal create') {
      typed.push({ worktree: arg('worktree')!, environment: arg('environment'), command: arg('command')!, title: arg('title')! })
      const script = gunzipSync(Buffer.from(/printf %s ([A-Za-z0-9+/=]+) \|/.exec(arg('command')!)![1], 'base64')).toString()
      runId = /^R=([0-9a-f]{16})$/m.exec(script)![1]
      const handle = `term_${typed.length}`
      open.set(handle, arg('title')!)
      if (fail.create === 'lost') return {}
      if (fail.create === 'throw') throw new Error('timed out')
      return { terminal: { handle } }
    }
    if (cmd === 'terminal list') return { terminals: [...open].map(([handle, title]) => ({ handle, title })) }
    if (cmd === 'terminal read') {
      if (fail.read || !pairs) throw new Error('gone')
      if (fail.slow) return { terminal: { status: 'running', tail: ['$'] } }
      return { terminal: { status: 'running', tail: ['$', ...frame(runId, pairs)] } }
    }
    if (cmd === 'terminal close') {
      if (closeFailures > 0) {
        closeFailures -= 1
        throw new Error('busy')
      }
      open.delete(arg('terminal')!)
      closed.push(arg('terminal')!)
      return {}
    }
    throw new Error(`unexpected ${args.join(' ')}`)
  }
  return { run, typed, open, closed }
}

function identities(cli: ReturnType<typeof fakeCli>, clock: { now: number }, store: Record<string, unknown> = {}, logs: string[] = []) {
  return new ServerIdentities(() => ({ run: cli.run, sleep: async () => undefined, now: () => clock.now, log: (t) => logs.push(t), storage: { get: async (k) => store[k] ?? null, set: async (k, v) => void (store[k] = v) } }))
}

async function settle(ids: ServerIdentities, hosts: OrcaHost[], workspaces: OrcaWorkspace[] = [own, nested]) {
  ids.ask(placeOrcaHosts(await ids.apply(hosts), estate), workspaces)
  for (let i = 0; i < 60; i += 1) await new Promise((r) => setTimeout(r, 2))
}

test('asked only in a workspace the server runs itself, once per runtime, read-only, not as root', async () => {
  const cli = fakeCli([['hostname', 'pve-x2'], ['fqdn', 'pve-x2.example.test'], ['addr', '198.51.100.22']])
  const clock = { now: 1000 }
  const ids = identities(cli, clock)
  await settle(ids, [server()])
  // The server's own workspace, not the newer one it reaches over SSH; by its exact route.
  assert.deepEqual([cli.typed.length, cli.typed[0].worktree, cli.typed[0].environment], [1, 'id:repo::/srv/work', 'server-x'])
  const script = gunzipSync(Buffer.from(/printf %s ([A-Za-z0-9+/=]+) \|/.exec(cli.typed[0].command)![1], 'base64')).toString()
  assert.ok(!/sudo|pveum|useradd|rm |>>/.test(script.replace(/^#.*$/gm, '')), 'read-only, nothing else')
  assert.ok(!cli.typed[0].command.includes('sudo'), 'not as root')
  assert.deepEqual(cli.closed, ['term_1'])
  const hosts = await ids.apply([server()])
  assert.deepEqual(hosts[0].identity, { names: ['pve-x2', 'pve-x2.example.test'], addresses: ['198.51.100.22'], from: 'server' })
  assert.deepEqual(placeOrcaHosts(hosts, estate)[0].runsOn, { kind: 'node', key: 'lab/pve-x2' })
  // Placed now: not asked again. A new runtime (a reconnect) is asked again.
  await settle(ids, [server()])
  assert.equal(cli.typed.length, 1)
  await settle(ids, [server({ runtimeId: 'runtime-2' })])
  assert.equal(cli.typed.length, 2)
  // Never for a server Orca places itself (its SSH target), or one already identified.
  await settle(ids, [server({ key: 'env:other', viaSsh: 'ssh:t', runtimeId: 'r' })])
  await settle(ids, [server({ key: 'env:other2', runtimeId: 'r', identity: { names: ['pve-x1'], addresses: [], from: 'endpoint' } })])
  assert.equal(cli.typed.length, 2)
})

test('a server with only workspaces it reaches over SSH is never asked', async () => {
  const cli = fakeCli([['hostname', 'pve-x2']])
  const logs: string[] = []
  const ids = identities(cli, { now: 1 }, {}, logs)
  await settle(ids, [server()], [nested])
  assert.equal(cli.typed.length, 0)
  assert.ok(logs.some((l) => /no workspace it runs itself/.test(l)))
})

test('a failed probe is retried after an hour, per runtime; what is kept for a server no longer listed is dropped', async () => {
  const cli = fakeCli(null)
  const clock = { now: 1000 }
  const store: Record<string, unknown> = { 'orca.identities': { 'env:gone': { runtimeId: 'r', at: 1, names: ['pve-x1'], addresses: [] } } }
  const ids = identities(cli, clock, store)
  await settle(ids, [server()])
  assert.deepEqual(Object.keys(store['orca.identities'] as object), [], 'the unpaired server’s entry is gone')
  await settle(ids, [server()])
  assert.equal(cli.typed.length, 1)
  assert.deepEqual(cli.closed, ['term_1'])
  // Another runtime of the same server is not held back by the failed one.
  await settle(ids, [server({ runtimeId: 'runtime-2' })])
  assert.equal(cli.typed.length, 2)
  clock.now += 60 * 60_000 + 1
  await settle(ids, [server()])
  assert.equal(cli.typed.length, 3)
})

test('every probe terminal is closed: a lost or failed create, a failed close (retried and reported), a stop', async () => {
  // Orca opened the terminal but its answer was lost: found by its unique title and closed.
  for (const create of ['lost', 'throw'] as const) {
    const cli = fakeCli([['hostname', 'pve-x2']], { create })
    await settle(identities(cli, { now: 1 }), [server()])
    assert.equal(cli.typed.length, 1)
    assert.match(cli.typed[0].title, /#[0-9a-f]{8}$/)
    assert.deepEqual([cli.closed, cli.open.size], [['term_1'], 0], create)
  }
  // Closing fails three times: the identity is kept, the terminal is reported and closed later.
  const cli = fakeCli([['hostname', 'pve-x2']], { close: 3 })
  const clock = { now: 1 }
  const ids = identities(cli, clock)
  await settle(ids, [server()])
  assert.equal(cli.open.size, 1)
  assert.equal(ids.warnings().length, 1)
  assert.match(ids.warnings()[0], /could not be closed; close it in Orca/)
  await settle(ids, [server({ runtimeId: 'runtime-2' })], [])
  assert.deepEqual([cli.open.size, ids.warnings().length], [0, 0], 'retried before anything else')
  // Stopping the worker ends a running probe early and closes its terminal before stop() settles.
  const slow = fakeCli([['hostname', 'pve-x2']], { slow: true })
  const stopping = identities(slow, { now: 1 })
  stopping.ask(placeOrcaHosts(await stopping.apply([server()]), estate), [own])
  for (let i = 0; i < 20 && !slow.typed.length; i += 1) await new Promise((r) => setTimeout(r, 2))
  assert.equal(slow.typed.length, 1)
  await stopping.stop()
  assert.deepEqual([slow.closed, slow.open.size], [['term_1'], 0])
  stopping.ask(placeOrcaHosts(await stopping.apply([server({ runtimeId: 'runtime-9' })]), estate), [own])
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(slow.typed.length, 1, 'nothing starts after a stop')
})
