// Orca awareness over recorded data: the orca CLI's answers (test/fixtures/orca-cli.ts) and the
// estate after the server rename (test/fixtures/recorded-pdm-renamed.ts). No CLI or server runs.
import { afterEach, assert, mockHost, mountWorker, test, type TestWorker } from 'orca/testing'
import type { EstateSnapshot, Guest, Host, OrcaHost } from '../src/model'
import { mergePairedServers, readOrcaInventory } from '../src/orca/inventory'
import { normalizeName, placeOrcaHosts } from '../src/orca/match'
import { guestNetwork, nodeAddress } from '../src/proxmox/pdm'
import { backupRollup, orcaByPlace, orcaElsewhere, presenceLabel } from '../src/presence'
import * as main from '../src/worker'
import { assertPlainJson, FIXTURE_PIN, recordedCli, renamedEstate } from './fixtures/estate'
import { mockTransport } from './fixtures/pdm'
import { RENAMED_AT, renamedRoutes } from './fixtures/recorded-pdm-renamed'

const SSH = {
  backups: 'ssh:ssh-example-a01',
  main1: 'ssh:ssh-example-b72',
  lab: 'ssh:ssh-example-ce3',
  main2: 'ssh:ssh-example-d54'
}
const ENV = {
  backup: 'env:c9a3be10-310f-4497-89a2-2ca29828a0b7',
  alpha: 'env:3a713d00-a608-489a-8b3f-1bfd2e06f0d0',
  delta: 'env:f5613273-66af-43ff-8449-d496f19ff80e',
  beta: 'env:b4fa9e5c-40bf-470f-89a9-d49922fb998b'
}

function placement(hosts: OrcaHost[]): Record<string, string> {
  return Object.fromEntries(hosts.map((h) => [h.name, h.runsOn ? `${h.runsOn.kind}:${h.runsOn.key} (${h.match})` : h.match ?? '-']))
}

test('one Orca per machine: each SSH target and the server paired over it are one host', async () => {
  // The renamed case: the SSH targets were renamed (pve-a …), the paired servers keep the
  // names they got at pairing (server-a …); environments[].orcadDeployment.sshTargetId ties
  // each server to its SSH target.
  const cli = recordedCli()
  const inventory = await readOrcaInventory(cli)
  assert.deepEqual(
    inventory.hosts.map((h) => `${h.kind}:${h.name}${h.paired ? ` (paired as ${h.paired.name})` : ''}`),
    [
      'local:DESKTOP-EXAMPLE',
      'ssh:pve-backups (paired as 203.0.113.3)',
      'ssh:pve-a (paired as server-a)',
      'ssh:pve-lab (paired as server-lab)',
      'ssh:pve-b (paired as server-b)'
    ]
  )
  assert.deepEqual(inventory.hosts.find((h) => h.key === SSH.main2)!.paired, { key: ENV.alpha, name: 'server-b' })
  // The server's bots and workspaces now belong to its machine, each counted once.
  assert.deepEqual(
    inventory.bots.map((b) => `${b.name}@${b.hostKey}`),
    ['Ops@local', 'Builder@local', `Runner@${SSH.main1}`]
  )
  assert.equal(inventory.workspaces.length, 13)
  assert.equal(inventory.workspaces.filter((w) => w.hostKey === SSH.main1).length, 2, '/root and Runner’s home')
  for (const key of [SSH.main2, SSH.lab, SSH.backups]) assert.equal(inventory.workspaces.filter((w) => w.hostKey === key).length, 1, '/root')
  assert.ok(inventory.workspaces.every((w) => !w.hostKey.startsWith('env:')))
  const working = inventory.workspaces.find((w) => w.agents.some((a) => a.state === 'working'))!
  assert.equal(working.hostKey, 'local')
  assert.equal(working.bot, 'Ops')
  assert.deepEqual(inventory.warnings, [])
  // One call per paired server, after the four local ones.
  assert.equal(cli.calls.length, 8)
})

test('an SSH target without a server, or a server not deployed over a known target, stays single', () => {
  const inventory = mergePairedServers({
    hosts: [
      { key: 'local', kind: 'local', name: 'laptop' },
      { key: 'ssh:a', kind: 'ssh', name: 'box-a' },
      { key: 'ssh:b', kind: 'ssh', name: 'box-b' },
      { key: 'env:1', kind: 'environment', name: 'paired-a', viaSsh: 'ssh:a' },
      { key: 'env:2', kind: 'environment', name: 'cloud-runtime' },
      { key: 'env:3', kind: 'environment', name: 'gone', viaSsh: 'ssh:removed' }
    ],
    workspaces: [
      { key: 'env:1|w', hostKey: 'env:1', name: 'w', repo: 'r', status: 'inactive', agents: [] },
      { key: 'env:2|w', hostKey: 'env:2', name: 'w', repo: 'r', status: 'inactive', agents: [] }
    ],
    bots: [{ id: 'b', name: 'Bot', agent: 'claude', paused: false, hostKey: 'env:1' }],
    warnings: []
  })
  assert.deepEqual(
    inventory.hosts.map((h) => `${h.key}${h.paired ? `+${h.paired.key}` : ''}`),
    ['local', 'ssh:a+env:1', 'ssh:b', 'env:2', 'env:3']
  )
  assert.deepEqual(inventory.workspaces.map((w) => w.hostKey), ['ssh:a', 'env:2'])
  assert.deepEqual(inventory.bots.map((b) => b.hostKey), ['ssh:a'])
})

test('a link set on a paired server before the merge still places its machine', async () => {
  const snap = await renamedEstate({ [ENV.alpha]: 'guest:pve-b/332' })
  assert.deepEqual(snap.orca!.hosts.find((h) => h.key === SSH.main2)!.runsOn, { kind: 'guest', key: 'pve-b/332' })
})

test('a paired server that does not answer is a warning, not a failure', async () => {
  const inventory = await readOrcaInventory(
    recordedCli({ 'worktree ps --environment server-lab': new Error('environment unreachable'), 'bot list': new Error('timed out') })
  )
  assert.deepEqual(inventory.warnings, ['orca bot list: timed out', 'Workspaces on server-lab: environment unreachable'])
  assert.equal(inventory.bots.length, 0)
  assert.equal(inventory.workspaces.length, 12)
  await assert.rejects(readOrcaInventory(recordedCli({ 'host list': new Error('runtime_unavailable') })), /orca host list/)
})

test('places every Orca host on the renamed estate', async () => {
  const snap = await renamedEstate()
  assert.deepEqual(placement(snap.orca!.hosts), {
    'DESKTOP-EXAMPLE': '-',
    // `pve-backups` names the node `pve-backup`: a plural is tolerated.
    'pve-backups': 'node:pve-backup/pve-backup (name)',
    'pve-a': 'node:pve-a/pve-a (name)',
    'pve-lab': 'node:pve-lab/pve-lab (name)',
    'pve-b': 'node:pve-b/pve-b (name)'
  })
  // One Orca on each of the four nodes, never two.
  const places = [...orcaByPlace(snap.orca).values()]
  assert.equal(places.length, 4)
  assert.ok(places.every((p) => p.hosts.length === 1))
  const main1 = orcaByPlace(snap.orca).get('node:pve-a/pve-a')!
  assert.deepEqual(main1.bots.map((b) => b.name), ['Runner'])
  assert.equal(main1.workspaces.length, 2)
  assert.equal(presenceLabel(main1), 'Orca · 1 bot · 2 workspaces')
  assert.deepEqual(orcaElsewhere(snap.orca).map((h) => h.key), ['local'])
  assertPlainJson(snap)
})

test('addresses and hostnames come from node networks and guest configs', async () => {
  const snap = await renamedEstate()
  const node = (key: string) => snap.hosts.find((h) => h.key === key)!
  assert.deepEqual(node('pve-backup/pve-backup').addresses, ['10.0.0.2', '203.0.113.3'])
  assert.deepEqual(node('pve-a/pve-a').addresses, ['10.0.10.1', '203.0.113.1'])
  const guest = (key: string) => snap.guests.find((g) => g.key === key)!
  assert.deepEqual(guest('pve-a/430').addresses, ['10.0.10.20'])
  assert.equal(guest('pve-a/430').hostname, 'ct-pve-a-430')
  assert.deepEqual(guest('pve-b/350').addresses, ['10.0.10.10', '10.0.20.254', '10.0.40.254'])
  assert.equal(guest('pve-b/310').addresses, undefined, 'DHCP guests have no static address')
  assert.deepEqual(snap.warnings, [])
})

test('placing by address, by guest name, and by hand', async () => {
  const snap = await renamedEstate()
  const host = (name: string, extra: Partial<OrcaHost> = {}): OrcaHost => ({ key: `ssh:${name}`, kind: 'ssh', name, ...extra })
  const placed = placeOrcaHosts(
    [
      host('203.0.113.3'), // a node's public address
      host('10.0.10.30'), // the PDM VM's address, unique
      host('10.0.10.10'), // used on two remotes: places nothing
      host('ct-pve-a-431.lan'), // a guest's hostname, domain dropped
      host('somewhere-else'),
      host('pve-b', { key: 'ssh:manual' })
    ],
    snap,
    { 'ssh:manual': 'guest:pve-b/332', 'ssh:somewhere-else': 'node:does/not-exist' }
  )
  assert.deepEqual(placement(placed), {
    '203.0.113.3': 'node:pve-backup/pve-backup (address)',
    '10.0.10.30': 'guest:pve-a/320 (address)',
    '10.0.10.10': '-',
    'ct-pve-a-431.lan': 'guest:pve-a/431 (name)',
    'somewhere-else': '-',
    'pve-b': 'guest:pve-b/332 (manual)'
  })
  // "Not on Proxmox" wins over a name that would match.
  const none = placeOrcaHosts([host('pve-lab')], snap, { 'ssh:pve-lab': 'none' })
  assert.deepEqual(placement(none), { 'pve-lab': 'manual' })
  assert.equal(normalizeName('PVE-A.example.com'), 'pve-a')
})

test('a name shared by two nodes places nothing', () => {
  const node = (remote: string, name: string): Host => ({
    key: `${remote}/${name}`, remote, remoteType: 'pve', node: name, online: true, status: 'online'
  })
  const placed = placeOrcaHosts([{ key: 'ssh:x', kind: 'ssh', name: 'pve' }], { hosts: [node('a', 'pve'), node('b', 'pve')], guests: [] as Guest[] })
  assert.equal(placed[0].runsOn, undefined)
})

test('config and address parsing', () => {
  assert.equal(nodeAddress('10.0.10.1:8006,fingerprint=AA'), '10.0.10.1')
  assert.equal(nodeAddress('hostname=pve1.example.com,fingerprint=AA'), 'pve1.example.com')
  assert.equal(nodeAddress('[2001:db8::1]:8006'), '2001:db8::1')
  assert.deepEqual(
    guestNetwork({
      hostname: 'web',
      net0: 'name=eth0,bridge=vmbr0,ip=10.0.0.5/24,ip6=dhcp,type=veth',
      ipconfig0: 'ip=dhcp',
      ipconfig1: 'ip=192.168.1.9/24,gw=192.168.1.1',
      sshkeys: 'ssh-ed25519%20AAAA',
      description: '  Web server, see runbook.  '
    }),
    // SSH keys and the like are never kept; notes (the description) are.
    { hostname: 'web', addresses: ['10.0.0.5', '192.168.1.9'], notes: 'Web server, see runbook.' }
  )
})

test('backup rollup per host ignores templates', () => {
  const g = (state: Guest['backupState'], template = false, lastBackup?: number) =>
    ({ backupState: state, template, lastBackup }) as Guest
  assert.deepEqual(backupRollup([g('ok', false, 5), g('stale', false, 2), g('none', true)]), {
    needing: 1,
    unknown: false,
    newest: 5,
    oldest: 2
  })
  assert.deepEqual(backupRollup([g('none', true)]), { needing: 0, unknown: false })
})

// ---- through the worker ----

let worker: TestWorker | undefined
afterEach(async () => {
  await worker?.deactivate()
  worker = undefined
})

async function connected(host = mockHost(), cli = recordedCli()) {
  main.useTestDoubles({ transport: mockTransport(renamedRoutes), probe: async () => null, now: () => RENAMED_AT, orcaCli: cli })
  worker = await mountWorker(main, { host })
  await worker.request('config.save', {
    baseUrl: 'https://pdm.example.test:8443',
    tokenId: 'monitor@pdm!orca',
    fingerprint: FIXTURE_PIN,
    secret: 'recorded-secret'
  })
  return worker
}

async function estate(w: TestWorker, force = false): Promise<EstateSnapshot> {
  const answer = await w.request('estate.get', { force })
  assertPlainJson(answer)
  assert.equal(answer.state, 'ok')
  return (answer as { snapshot: EstateSnapshot }).snapshot
}

test('the worker answers the estate with Orca placed on it, and keeps manual links', async () => {
  const w = await connected()
  const snap = await estate(w)
  assert.equal(snap.orca!.hosts.filter((h) => h.runsOn).length, 4)

  const scope = snap.connectionId
  const answer = await w.request('orca.link', { hostKey: 'local', link: 'guest:pve-a/314', scope })
  assert.deepEqual(answer.links, { local: 'guest:pve-a/314' })
  const linked = await estate(w)
  assert.deepEqual(linked.orca!.hosts.find((h) => h.key === 'local')!.runsOn, { kind: 'guest', key: 'pve-a/314' })

  await w.request('orca.link', { hostKey: 'local', link: null, scope })
  assert.equal((await estate(w)).orca!.hosts.find((h) => h.key === 'local')!.runsOn, undefined)
  await assert.rejects(w.request('orca.link', { hostKey: 'local', link: 'somewhere', scope }), (e: unknown) => (e as { code?: string }).code === 'invalid_params')
  // An action from a view of another (older) configuration is refused, not applied to this one.
  await assert.rejects(w.request('orca.link', { hostKey: 'local', link: 'guest:pve-a/314', scope: 'default@old' }), /connection changed/)
  await assert.rejects(w.request('orca.terminal', { hostKey: 'local', scope: 'default@old' }), /connection changed/)
  assert.deepEqual(w.refusals, [])
})

test('placements from before estates kept their own go to the first estate only', async () => {
  const host = mockHost({ storage: { orcaLinks: { local: 'guest:pve-a/314' } } })
  const w = await connected(host)
  const snap = await estate(w)
  assert.deepEqual(snap.orca!.hosts.find((h) => h.key === 'local')!.runsOn, { kind: 'guest', key: 'pve-a/314' })
  assert.equal(host.data().storage.orcaLinks, null, 'moved, not shared')
  assert.deepEqual((host.data().storage['orcaLinks.byEstate'] as Record<string, unknown>)['https://pdm.example.test:8443'], { local: 'guest:pve-a/314' })
})

test('Orca inventory is read again only every 20 s, unless forced', async () => {
  const cli = recordedCli()
  const w = await connected(mockHost(), cli)
  await estate(w)
  const first = cli.calls.length
  await estate(w)
  assert.equal(cli.calls.length, first)
  await estate(w, true)
  assert.equal(cli.calls.length, first * 2)
})

test('without the orca CLI the estate still loads, with the reason', async () => {
  const w = await connected(mockHost(), recordedCli({ 'host list': new Error('APPDATA is not set') }))
  const snap = await estate(w)
  assert.equal(snap.guests.length, 19)
  assert.match(snap.orca!.error ?? '', /APPDATA is not set/)
  assert.deepEqual(snap.orca!.hosts, [])
})

test('Orca awareness can be turned off', async () => {
  const cli = recordedCli()
  main.useTestDoubles({ transport: mockTransport(renamedRoutes), probe: async () => null, now: () => RENAMED_AT, orcaCli: cli })
  worker = await mountWorker(main, { host: mockHost({ settings: { orcaAwareness: false } }) })
  await worker.request('config.save', { baseUrl: 'https://pdm.example.test:8443', tokenId: 'monitor@pdm!orca', fingerprint: '', secret: 's' })
  const snap = await estate(worker)
  assert.equal(snap.orca, undefined)
  assert.equal(cli.calls.length, 0)
  assert.equal(snap.guests[0].addresses, undefined, 'no configs read either')
})
