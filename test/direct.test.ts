// Proxmox VE and PBS reached directly, and several connections as one estate. Example data only.
import { assert, test } from 'orca/testing'
import { EstateService } from '../src/estate'
import { estateMarkdown } from '../src/features/insights'
import { DEFAULT_SETTINGS, estateScope, type ConnectionConfig, type Guest } from '../src/model'
import { attachBackups } from '../src/proxmox/backups'
import { ProxmoxClient } from '../src/proxmox/client'
import { CompositeSource, directRemoteIds, type FailedPart, type Part } from '../src/proxmox/composite'
import { createSource, type BackupScan, type EstateSource, type Inventory } from '../src/proxmox/source'
import { pbsRoutes, pveRoutes } from './fixtures/direct'
import { mockTransport, pdmRoutes } from './fixtures/pdm'

const NOW = Date.UTC(2026, 10, 25, 12, 0, 0)
const GiB = 1024 ** 3
const pve: ConnectionConfig = { id: 'c-pve', kind: 'pve', name: 'lab', baseUrl: 'https://pve.example.test:8006', tokenId: 'monitor@pve!orca', fingerprint: '', revision: 'r1' }
const pbs: ConnectionConfig = { id: 'c-pbs', kind: 'pbs', baseUrl: 'https://pbs.example.test:8007', tokenId: 'monitor@pbs!orca', fingerprint: '', revision: 'r2' }
const pdm: ConnectionConfig = { id: 'default', kind: 'pdm', baseUrl: 'https://pdm.example.test:8443', tokenId: 'monitor@pdm!orca', fingerprint: '', revision: 'r0' }

function sourceOf(connection: ConnectionConfig, routes: Record<string, unknown>) {
  const transport = mockTransport(routes as never)
  const client = new ProxmoxClient({ connection, secret: 'example-secret', transport, probe: async () => null })
  return { transport, source: createSource(connection.kind, client, connection) }
}

test('a PVE cluster reached directly: nodes, guests, storages, history, tasks, updates, addresses', async () => {
  const { source, transport } = sourceOf(pve, pveRoutes(NOW))
  assert.deepEqual(await source.checkAccess(), { version: '9.1.2', remotes: 2, unit: 'nodes' })
  const inv = await source.fetchInventory({ maxAgeSeconds: 30 })
  assert.deepEqual(inv.remotes, [{ id: 'lab', type: 'pve', online: true, webUrl: 'https://pve.example.test:8006', direct: true }])
  assert.deepEqual(inv.hosts.map((h) => [h.key, h.version, h.online]), [['lab/pve-x1', '9.1.2', true], ['lab/pve-x2', '9.1.1', true]])
  assert.deepEqual(inv.guests.map((g) => [g.key, g.type, g.status]), [['lab/501', 'qemu', 'running'], ['lab/502', 'qemu', 'running'], ['lab/503', 'lxc', 'running'], ['lab/504', 'qemu', 'stopped']])
  assert.deepEqual(inv.guests[0].tags, ['prod', 'web'])
  assert.deepEqual(inv.hosts[0].storages!.map((s) => [s.name, s.content]), [['local', ['iso', 'vztmpl', 'backup']], ['local-lvm', ['images', 'rootdir']]])
  // The PVE token header, with "=" between id and secret.
  assert.equal(transport.requests[0].headers.Authorization, 'PVEAPIToken=monitor@pve!orca=example-secret')
  const metrics = await source.fetchMetrics(inv)
  assert.equal(metrics.hosts['lab/pve-x1'].cpu.length, 60)
  assert.ok(metrics.guests['lab/501'].mem.every((m) => m === 0.375))
  const tasks = await source.fetchTasks()
  assert.deepEqual(tasks.map((t) => [t.remote, t.type, t.id, t.state]), [['lab', 'qmstart', '501', 'running'], ['lab', 'vzstart', '503', 'ok'], ['lab', 'vzdump', '502', 'failed'], ['lab', 'vzdump', '501', 'ok']])
  assert.deepEqual((await source.fetchUpdates(inv)).hosts, { 'lab/pve-x1': 2, 'lab/pve-x2': 0 })
  const net = await source.fetchNetwork(inv)
  assert.deepEqual(net.nodes['lab/pve-x1'], ['198.51.100.21'])
  assert.deepEqual(net.guests['lab/501'].addresses, ['10.20.0.11'])
  assert.equal(net.nodeNotes['lab/pve-x1'], 'Lab node one.')
  // Unnamed, the remote is named after the URL's host, never after the answer; the cluster's own
  // name stays as an alias (for backups named after it).
  const unnamed = await sourceOf({ ...pve, name: undefined }, pveRoutes(NOW)).source.fetchInventory({ maxAgeSeconds: 30 })
  assert.deepEqual([unnamed.remotes[0].id, unnamed.remotes[0].alias, unnamed.hosts[0].key], ['pve.example.test', 'lab', 'pve.example.test/pve-x1'])
})

test('a PBS reached directly: the server, its datastores, snapshots, history and tasks', async () => {
  const { source, transport } = sourceOf(pbs, pbsRoutes(NOW))
  assert.deepEqual(await source.checkAccess(), { version: '4.1.2', remotes: 1, unit: 'datastores' })
  const inv = await source.fetchInventory({ maxAgeSeconds: 30 })
  assert.equal(inv.remotes[0].id, 'pbs.example.test')
  assert.deepEqual(inv.hosts.map((h) => [h.key, h.remoteType, h.version, h.maxdisk]), [['pbs.example.test/pbs.example.test', 'pbs', '4.1.2', 60 * GiB]])
  assert.deepEqual(inv.datastores.map((d) => [d.key, d.usage]), [['pbs.example.test/store-x', 0.6]])
  assert.equal(transport.requests[0].headers.Authorization, 'PBSAPIToken=monitor@pbs!orca:example-secret')
  const backups = await source.fetchBackups(inv)
  assert.equal(backups.records.length, 4)
  assert.equal(backups.complete, true)
  assert.equal((await source.fetchMetrics(inv)).datastores['pbs.example.test/store-x'].length, 48)
  assert.deepEqual((await source.fetchTasks()).map((t) => [t.type, t.state]), [['backup', 'failed']])
})

test('PVE and PBS together: backups matched, VM disk use from the guest agent, unknown where none', async () => {
  const parts = [pve, { ...pbs, name: 'backup-x' }].map((c) => ({ connection: c, source: sourceOf(c, c.kind === 'pve' ? pveRoutes(NOW) : pbsRoutes(NOW)).source }))
  const composite = new CompositeSource(parts)
  const scope = { id: estateScope([pve, pbs]), kind: 'pve' as const, baseUrl: 'x', tokenId: '', fingerprint: '' }
  const snap = await new EstateService(() => NOW).get(composite, scope, DEFAULT_SETTINGS, { maxAgeMs: 0 })
  assert.deepEqual(snap.remotes.map((r) => r.id), ['lab', 'backup-x'])
  const g = new Map(snap.guests.map((x) => [x.key, x]))
  assert.equal(g.get('lab/501')!.backupState, 'ok')
  assert.equal(g.get('lab/502')!.backupState, 'stale')
  assert.equal(g.get('lab/503')!.backupState, 'ok')
  assert.deepEqual(snap.backups.orphans.map((o) => o.vmid), [599])
  assert.equal(snap.backups.incomplete, undefined)
  assert.deepEqual(g.get('lab/501')!.diskUsage, { used: 21 * GiB, total: 60 * GiB, from: 'agent' })
  assert.equal(g.get('lab/502')!.diskUnknown, 'no-agent')
  assert.equal(g.get('lab/504')!.diskUnknown, 'stopped')
  assert.deepEqual(g.get('lab/503')!.diskUsage, { used: 3.6 * GiB, total: 4 * GiB, from: 'container' })
  assert.deepEqual(snap.tasks!.filter((t) => t.state === 'failed').map((t) => t.remote).sort(), ['backup-x', 'lab'])
  assert.equal(snap.hosts.find((h) => h.key === 'lab/pve-x1')!.pendingUpdates, 2)
})

test('PDM plus a direct PVE of the same name: stable ids, native names in requests, any order, through outages', async () => {
  const named = { ...pve, name: 'pve-fsn' } // the same name as one of PDM's remotes
  const pdmSide = () => sourceOf(pdm, pdmRoutes(NOW))
  const pveSide = () => sourceOf(named, pveRoutes(NOW))
  const scope = { id: estateScope([pdm, named]), kind: 'pdm' as const, baseUrl: 'x', tokenId: '', fingerprint: '' }
  const read = (parts: Part[], failed: FailedPart[] = []) => new EstateService(() => NOW).get(new CompositeSource(parts, failed), scope, DEFAULT_SETTINGS, { maxAgeMs: 0 })

  const a = pdmSide()
  const b = pveSide()
  const snap = await read([
    { connection: pdm, source: a.source },
    { connection: named, source: b.source }
  ])
  const ids = snap.remotes.map((r) => r.id)
  // PDM keeps its ids; the direct one is labelled, whatever the order or the answers.
  assert.ok(ids.includes('pve-fsn') && ids.includes('pve-fsn (direct)'), ids.join(','))
  assert.ok(snap.guests.some((g) => g.key === 'pve-fsn (direct)/501' && g.node === 'pve-x1'))
  assert.ok(snap.hosts.some((h) => h.key === 'pve-fsn (direct)/pve-x1' && h.node === 'pve-x1'))
  assert.equal(snap.remotes.find((r) => r.id === 'pve-fsn (direct)')!.alias, 'lab', 'the cluster’s own name, for backup hints')
  // Every request still uses the servers' own names: the node, and PDM's remote.
  const paths = (t: ReturnType<typeof mockTransport>) => t.requests.map((r) => decodeURIComponent(r.url.pathname))
  assert.ok(paths(b.transport).some((p) => p.endsWith('/nodes/pve-x1/status')))
  assert.ok(paths(b.transport).every((p) => !p.includes('direct') && !p.includes('pve-fsn')), paths(b.transport).join(' '))
  assert.ok(paths(a.transport).every((p) => !p.includes('direct')))
  // History and updates land on the renamed keys.
  assert.equal(snap.hosts.find((h) => h.key === 'pve-fsn (direct)/pve-x1')!.pendingUpdates, 2)
  assert.ok(snap.guests.find((g) => g.key === 'pve-fsn (direct)/501')!.metrics)

  // The other order gives the same ids.
  const reversed = await read([
    { connection: named, source: pveSide().source },
    { connection: pdm, source: pdmSide().source }
  ])
  assert.deepEqual(reversed.remotes.map((r) => r.id).sort(), [...ids].sort())

  // PDM down: the direct cluster keeps its id (no shift to a freed name); PDM is one unreachable remote.
  const pdmDown = await read([{ connection: named, source: pveSide().source }], [{ connection: pdm, reason: 'No token secret is stored for this connection.' }])
  assert.ok(pdmDown.guests.some((g) => g.key === 'pve-fsn (direct)/501'))
  assert.ok(!pdmDown.guests.some((g) => g.key === 'pve-fsn/501'))
  // The direct one down: it is unreachable under the same id, and PDM's remote is untouched.
  const pveDown = await read([{ connection: pdm, source: pdmSide().source }], [{ connection: named, reason: 'No token secret is stored for this connection.' }])
  const down = pveDown.remotes.find((r) => r.id === 'pve-fsn (direct)')!
  assert.equal(down.online, false)
  // Neither a direct nor an unreadable connection is one of PDM's remotes: no PDM link for them.
  assert.equal(down.direct, true)
  assert.equal(pveDown.remotes.find((r) => r.id === 'pve-fsn')!.direct, undefined)
  assert.ok(pveDown.warnings.some((w) => /pve-fsn could not be read/.test(w)))

  // Every part failing is the whole refresh failing, as with one connection.
  const broken = new CompositeSource([{ connection: pve, source: sourceOf(pve, {}).source }])
  await assert.rejects(broken.fetchInventory({ maxAgeSeconds: 30 }))
})

test('two direct connections of the same name: told apart by connection id, not by who answered', () => {
  const one = { ...pve, id: 'c-1', name: 'lab' }
  const two = { ...pbs, id: 'c-2', name: 'lab' }
  assert.deepEqual([...directRemoteIds([two, one])], [['c-1', 'lab'], ['c-2', 'lab-2']])
  assert.deepEqual([...directRemoteIds([one, two, pdm])], [['c-1', 'lab (direct)'], ['c-2', 'lab-2 (direct)']])
})

/** A source that answers with fixed data, to set up backup coverage cases. */
function stub(kind: 'pdm' | 'pbs' | 'pve', inventory: Inventory, scan: BackupScan | Error): EstateSource {
  const none = { hosts: {}, guests: {}, datastores: {}, nodes: {}, nodeNotes: {}, warnings: [] }
  return {
    kind,
    checkAccess: async () => ({ version: '1', remotes: 1 }),
    fetchInventory: async () => structuredClone(inventory),
    fetchBackups: async () => {
      if (scan instanceof Error) throw scan
      return scan
    },
    fetchNetwork: async () => none,
    fetchMetrics: async () => none,
    fetchTasks: async () => [],
    fetchUpdates: async () => ({ hosts: {}, warnings: [] })
  }
}

const vm = (remote: string, vmid: number): Guest =>
  ({ key: `${remote}/${vmid}`, remote, node: 'n1', vmid, type: 'qemu', name: `vm-${vmid}`, status: 'running', template: false, tags: [], cpu: 0, maxcpu: 1, mem: 0, maxmem: 1, disk: 0, maxdisk: 1, uptime: 1, backupState: 'unknown' }) as Guest
const pbsInventory = (id: string): Inventory => ({
  remotes: [{ id, type: 'pbs', online: true }],
  hosts: [],
  guests: [],
  datastores: [{ key: `${id}/store`, remote: id, name: 'store', used: 1, total: 2, usage: 0.5 }],
  warnings: []
})
const fullScan = (remote: string, vmids: number[]): BackupScan => ({
  records: vmids.map((id) => ({ remote, datastore: 'store', ns: '', type: 'vm' as const, id: String(id), time: NOW - 3600_000 })),
  available: true,
  complete: true,
  gaps: [],
  warnings: []
})

test('backup coverage over several sources: a PBS that is down keeps "never" from being claimed', async () => {
  const cluster: Inventory = { remotes: [{ id: 'pve-y', type: 'pve', online: true }], hosts: [], guests: [vm('pve-y', 700), vm('pve-y', 701)], datastores: [], warnings: [] }
  const pdmNoPbs = { ...pdm, id: 'p' }
  const pbs1 = { ...pbs, id: 'b1', name: 'pbs-1', baseUrl: 'https://pbs1.example.test:8007' }
  const pbs2 = { ...pbs, id: 'b2', name: 'pbs-2', baseUrl: 'https://pbs2.example.test:8007' }
  const read = (parts: Part[], failed: FailedPart[] = []) =>
    new EstateService(() => NOW).get(new CompositeSource(parts, failed), { id: 'mix', kind: 'pdm', baseUrl: 'x', tokenId: '', fingerprint: '' }, DEFAULT_SETTINGS, { maxAgeMs: 0 })
  const state = (snap: Awaited<ReturnType<typeof read>>, vmid: number) => snap.guests.find((g) => g.vmid === vmid)!.backupState

  // A healthy PDM without PBS says nothing about backups: the direct PBS, fully read, decides.
  const pdmPart = { connection: pdmNoPbs, source: stub('pdm', cluster, { records: [], available: false, complete: false, gaps: [], warnings: [] }) }
  const healthy = await read([pdmPart, { connection: pbs1, source: stub('pbs', pbsInventory('pbs1'), fullScan('pbs1', [700])) }])
  assert.equal(state(healthy, 700), 'ok')
  assert.equal(state(healthy, 701), 'none', 'definite: every PBS was read')

  // A second PBS that cannot be read may hold 701's backup: unknown, not never.
  const secondDown = await read([pdmPart, { connection: pbs1, source: stub('pbs', pbsInventory('pbs1'), fullScan('pbs1', [700])) }], [{ connection: pbs2, reason: 'No token secret is stored for this connection.' }])
  assert.equal(state(secondDown, 701), 'unknown')
  assert.ok(secondDown.backups.incomplete)
  // The same when it answered its inventory but its snapshot lists failed.
  const scanFails = await read([
    pdmPart,
    { connection: pbs1, source: stub('pbs', pbsInventory('pbs1'), fullScan('pbs1', [700])) },
    { connection: pbs2, source: stub('pbs', pbsInventory('pbs2'), new Error('timed out')) }
  ])
  assert.equal(state(scanFails, 701), 'unknown')
  // And when its inventory could not be read at all.
  const failing: EstateSource = { ...stub('pbs', pbsInventory('pbs2'), fullScan('pbs2', [])), fetchInventory: async () => Promise.reject(new Error('refused')) }
  const invFails = await read([pdmPart, { connection: pbs1, source: stub('pbs', pbsInventory('pbs1'), fullScan('pbs1', [700])) }, { connection: pbs2, source: failing }])
  assert.equal(state(invFails, 701), 'unknown')
  // A PDM that cannot be read may hold PBS remotes too.
  const pdmDown = await read([{ connection: pbs1, source: stub('pbs', pbsInventory('pbs1'), fullScan('pbs1', [700])) }, { connection: { ...pve, id: 'v', name: 'pve-y' }, source: stub('pve', cluster, fullScan('x', [])) }], [{ connection: pdmNoPbs, reason: 'No token secret is stored for this connection.' }])
  assert.equal(state(pdmDown, 701), 'unknown')
})

test('the harness estate: PDM, a direct PVE and a direct PBS together', async () => {
  const { mixedEstate } = await import('./fixtures/estate')
  const { snapshot, config } = await mixedEstate()
  assert.equal(snapshot.connectionId, estateScope(config.connections))
  const ids = snapshot.remotes.map((r) => r.id)
  assert.ok(['pve-a', 'pve-b', 'lab (direct)', 'backup-x (direct)'].every((id) => ids.includes(id)), ids.join(','))
  const vm = (key: string) => snapshot.guests.find((g) => g.key === key)!
  assert.equal(vm('lab (direct)/501').diskUsage?.from, 'agent')
  // Through PDM the agent call is not offered (404): unknown, not 0 %.
  assert.ok(snapshot.guests.filter((g) => g.remote === 'pve-a' && g.type === 'qemu' && g.status === 'running').every((g) => g.diskUnknown === 'unsupported'))
  // Copy for AI names both ways in and carries disk use, known or not.
  const md = estateMarkdown(snapshot, { mode: 'full', now: snapshot.fetchedAt })
  assert.ok(md.includes('through Proxmox Datacenter Manager and Proxmox servers connected directly.'))
  // Names are escaped Markdown text: the parentheses of "(direct)" too.
  assert.ok(md.includes('| web-x | 501 | VM | lab \\(direct\\)/pve-x1 | running | 35% of 60.0 GiB |'), md)
  assert.match(md, /\| db-x \| 502 \| VM \| lab \\\(direct\\\)\/pve-x1 \| running \| [\d.]+ GiB allocated, use unknown \|/)
})

test('with "Disk use inside VMs" off, the guest agent is never asked', async () => {
  const { source, transport } = sourceOf(pve, pveRoutes(NOW))
  const scope = { ...pve, id: 'off' }
  const snap = await new EstateService(() => NOW).get(source, scope, { ...DEFAULT_SETTINGS, guestAgentDisk: false }, { maxAgeMs: 0 })
  assert.ok(transport.requests.every((r) => !r.url.pathname.includes('/agent/')))
  assert.equal(snap.guests.find((g) => g.vmid === 501)!.diskUnknown, 'off')
  assert.ok(snap.guests.find((g) => g.vmid === 503)!.diskUsage, 'containers still show their use')
})

test('a refusal names the right role for the product', async () => {
  const forbidden = { '/version': { status: 403, body: '{"data":null}' } }
  const hint = async (c: ConnectionConfig) => sourceOf(c, forbidden).source.checkAccess().then(() => '', (e: { info: { hint?: string } }) => e.info.hint ?? '')
  assert.match(await hint(pve), /PVEAuditor role on \//)
  assert.match(await hint(pbs), /Audit role on \//)
  assert.match(await hint(pdm), /Auditor role on \/resource/)
})

test('a backup hint shared by two remotes with the same VMID proves neither: unknown, flagged', () => {
  // PDM's remote "lab" and a cluster reached directly whose own name is also "lab": both have VM 501.
  const both = [vm('lab', 501), vm('lab (direct)', 501), vm('lab (direct)', 502)]
  const record = (id: number, ns: string) => ({ remote: 'backup-x', datastore: 'store', ns, type: 'vm' as const, id: String(id), time: NOW - 3600_000 })
  const options = { now: NOW, staleHours: 26, available: true, complete: true, aliases: { 'lab (direct)': 'lab' } }
  const out = attachBackups(both, [record(501, 'lab'), record(502, 'lab')], options).guests
  const state = (remote: string, vmid: number) => out.find((g) => g.remote === remote && g.vmid === vmid)!
  assert.equal(state('lab', 501).backupState, 'unknown')
  assert.equal(state('lab', 501).backupAmbiguous, true)
  assert.equal(state('lab (direct)', 501).backupState, 'unknown')
  // Where only one of them has the VMID, the hint is enough.
  assert.equal(state('lab (direct)', 502).backupState, 'ok')
  // A hint naming one remote only still decides, alias or id.
  const solo = attachBackups([vm('lab (direct)', 501), vm('pve-z', 501)], [record(501, 'lab')], options).guests
  assert.deepEqual(solo.map((g) => g.backupState), ['ok', 'none'])
})
