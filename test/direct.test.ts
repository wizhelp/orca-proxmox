// Proxmox VE and PBS reached directly, and several connections as one estate. Example data only.
import { assert, test } from 'orca/testing'
import { EstateService } from '../src/estate'
import { DEFAULT_SETTINGS, estateScope, type ConnectionConfig } from '../src/model'
import { ProxmoxClient } from '../src/proxmox/client'
import { CompositeSource } from '../src/proxmox/composite'
import { createSource } from '../src/proxmox/source'
import { pbsRoutes, pveRoutes } from './fixtures/direct'
import { mockTransport, pdmRoutes } from './fixtures/pdm'

const NOW = Date.UTC(2026, 10, 25, 12, 0, 0)
const GiB = 1024 ** 3
const pve: ConnectionConfig = { id: 'c-pve', kind: 'pve', baseUrl: 'https://pve.example.test:8006', tokenId: 'monitor@pve!orca', fingerprint: '', revision: 'r1' }
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

test('PDM plus a direct PVE: names kept apart, and a failing connection is one unreachable remote', async () => {
  const named = { ...pve, name: 'pve-fsn' } // the same name as one of PDM's remotes
  const parts = [
    { connection: pdm, source: sourceOf(pdm, pdmRoutes(NOW)).source },
    { connection: named, source: sourceOf(named, pveRoutes(NOW)).source }
  ]
  const composite = new CompositeSource(parts, [{ connection: { ...pbs, name: 'backup-y' }, reason: 'No token secret is stored for this connection.' }])
  const scope = { id: estateScope([pdm, named]), kind: 'pdm' as const, baseUrl: 'x', tokenId: '', fingerprint: '' }
  const snap = await new EstateService(() => NOW).get(composite, scope, DEFAULT_SETTINGS, { maxAgeMs: 0 })
  const ids = snap.remotes.map((r) => r.id)
  assert.ok(ids.includes('pve-fsn') && ids.includes('pve-fsn-2'), ids.join(','))
  assert.ok(snap.guests.some((g) => g.key === 'pve-fsn-2/501'), 'the direct cluster rekeyed')
  assert.ok(snap.hosts.some((h) => h.key === 'pve-fsn-2/pve-x1'))
  const down = snap.remotes.find((r) => r.id === 'backup-y')!
  assert.equal(down.online, false)
  // Neither a direct nor an unreadable connection is one of PDM's remotes: no PDM link for them.
  assert.equal(down.direct, true)
  assert.equal(snap.remotes.find((r) => r.id === 'pve-fsn')!.direct, undefined)
  assert.equal(snap.remotes.find((r) => r.id === 'pve-fsn-2')!.direct, true)
  assert.ok(snap.warnings.some((w) => /backup-y could not be read/.test(w)))
  // Every part failing is the whole refresh failing, as with one connection.
  const broken = new CompositeSource([{ connection: pve, source: sourceOf(pve, {}).source }])
  await assert.rejects(broken.fetchInventory({ maxAgeSeconds: 30 }))
})

test('the harness estate: PDM, a direct PVE and a direct PBS together', async () => {
  const { mixedEstate } = await import('./fixtures/estate')
  const { snapshot, config } = await mixedEstate()
  assert.equal(snapshot.connectionId, estateScope(config.connections))
  const ids = snapshot.remotes.map((r) => r.id)
  assert.ok(['pve-a', 'pve-b', 'lab', 'backup-x'].every((id) => ids.includes(id)), ids.join(','))
  const vm = (key: string) => snapshot.guests.find((g) => g.key === key)!
  assert.equal(vm('lab/501').diskUsage?.from, 'agent')
  // Through PDM the agent call is not offered (404): unknown, not 0 %.
  assert.ok(snapshot.guests.filter((g) => g.remote === 'pve-a' && g.type === 'qemu' && g.status === 'running').every((g) => g.diskUnknown === 'unsupported'))
})
