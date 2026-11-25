// The PDM source and backup matching over recorded answers (test/fixtures/pdm.ts).
import { assert, test } from 'orca/testing'
import { EstateService } from '../src/estate'
import { DEFAULT_SETTINGS, formatBytes, formatUptime, normalizeFingerprint, type ConnectionConfig, type Guest } from '../src/model'
import { attachBackups, type BackupRecord } from '../src/proxmox/backups'
import { ApiError, normalizeBaseUrl, parseData, ProxmoxClient } from '../src/proxmox/client'
import { formatVersion, pveVersion } from '../src/proxmox/pdm'
import { createSource } from '../src/proxmox/source'
import { mockTransport, pdmRoutes } from './fixtures/pdm'

const NOW = Date.UTC(2026, 10, 25, 12, 0, 0)
const HOUR = 3600 * 1000

const connection: ConnectionConfig = {
  id: 'default',
  kind: 'pdm',
  baseUrl: 'https://pdm.example.test:8443',
  tokenId: 'monitor@pdm!orca',
  fingerprint: ''
}

function setup(routes = pdmRoutes(NOW)) {
  const transport = mockTransport(routes)
  const client = new ProxmoxClient({ connection, secret: 's3cret-uuid', transport, probe: async () => null })
  return { transport, client, source: createSource('pdm', client) }
}

test('reads remotes, hosts, guests and datastores from PDM', async () => {
  const { source, transport } = setup()
  const inventory = await source.fetchInventory({ maxAgeSeconds: 30 })

  assert.deepEqual(
    inventory.remotes.map((r) => [r.id, r.type, r.online]),
    [
      ['pve-fsn', 'pve', true],
      ['pve-hel', 'pve', true],
      ['pve-lab', 'pve', false],
      ['pbs-main', 'pbs', true]
    ]
  )
  const fsn1 = inventory.hosts.find((h) => h.key === 'pve-fsn/fsn-pve1')!
  assert.equal(fsn1.version, '8.3.2')
  assert.equal(fsn1.maxdisk, 94 * 1024 ** 3)
  assert.equal(fsn1.uptime, 3456100)
  assert.equal(fsn1.online, true)

  const lab = inventory.hosts.find((h) => h.remote === 'pve-lab')!
  assert.equal(lab.status, 'unreachable')
  assert.match(lab.detailError ?? '', /deadline has elapsed/)

  const hel = inventory.hosts.find((h) => h.key === 'pve-hel/hel-pve1')!
  // The plugin's own words, never the server's body (a proxy may echo the token in it).
  assert.match(hel.detailError ?? '', /answered HTTP 500 \(internal error\)$/)
  assert.ok(!/proxy loop detected/.test(hel.detailError ?? ''))
  assert.equal(hel.online, true)

  const pbs = inventory.hosts.find((h) => h.remoteType === 'pbs')!
  assert.equal(pbs.node, 'pbs-main')
  assert.equal(pbs.version, '3.3.2')
  assert.equal(pbs.maxdisk, 60 * 1024 ** 3)

  assert.equal(inventory.guests.length, 7)
  const mail = inventory.guests.find((g) => g.key === 'pve-fsn/102')!
  assert.equal(mail.type, 'lxc')
  assert.equal(mail.node, 'fsn-pve2')
  assert.deepEqual(inventory.guests.find((g) => g.key === 'pve-hel/200')!.tags, ['infra', 'metrics'])
  assert.equal(inventory.guests.find((g) => g.vmid === 9000)!.template, true)

  assert.deepEqual(
    inventory.datastores.map((d) => [d.key, d.usage]),
    [
      ['pbs-main/store1', 0.71],
      ['pbs-main/offsite', 0.9]
    ]
  )
  // Every call is a read with the PDM token header; no write method exists in the client.
  assert.ok(transport.requests.every((r) => r.method === 'GET'))
  assert.ok(transport.requests.every((r) => r.headers.Authorization === 'PDMAPIToken=monitor@pdm!orca:s3cret-uuid'))
  assert.ok(transport.requests.every((r) => r.url.origin === 'https://pdm.example.test:8443'))
})

test('builds an estate with each guest’s last backup and flags the stale ones', async () => {
  const { source } = setup()
  const service = new EstateService(() => NOW)
  const snap = await service.get(source, connection, DEFAULT_SETTINGS, { maxAgeMs: 15000 })
  const byKey = new Map(snap.guests.map((g) => [g.key, g]))

  // VMID 100 exists on two remotes; namespaces named after them keep their backups apart.
  assert.equal(byKey.get('pve-fsn/100')!.lastBackup, NOW - 2 * HOUR)
  assert.equal(byKey.get('pve-fsn/100')!.lastBackupWhere, 'pbs-main/store1/pve-fsn')
  assert.equal(byKey.get('pve-fsn/100')!.backupAmbiguous, undefined)
  assert.equal(byKey.get('pve-hel/100')!.lastBackup, NOW - 4 * HOUR)
  // The newest of several datastores wins (store1 3 h ago beats offsite 30 h ago).
  assert.equal(byKey.get('pve-fsn/101')!.lastBackup, NOW - 3 * HOUR)
  assert.equal(byKey.get('pve-fsn/102')!.backupState, 'ok')
  assert.equal(byKey.get('pve-fsn/103')!.backupState, 'none')
  assert.equal(byKey.get('pve-hel/200')!.backupState, 'stale')
  // Templates are listed but not counted as missing a backup.
  assert.equal(byKey.get('pve-fsn/9000')!.backupState, 'none')
  assert.equal(snap.backups.missing, 2)
  assert.equal(snap.backups.error, undefined)
  assert.equal(snap.backups.staleHours, 26)
  assert.ok(snap.warnings.some((w) => /proxy loop/.test(w)) === false, 'host detail errors stay on the host row')
})

test('reuses a fresh snapshot and rescans backups only on their own cadence', async () => {
  let now = NOW
  const { source, transport } = setup()
  const service = new EstateService(() => now)
  const settings = { ...DEFAULT_SETTINGS, backupRefreshMinutes: 5 }
  await service.get(source, connection, settings, { maxAgeMs: 15000 })
  const first = transport.requests.length
  await service.get(source, connection, settings, { maxAgeMs: 15000 })
  assert.equal(transport.requests.length, first, 'served from cache')

  now += 60 * 1000
  await service.get(source, connection, settings, { maxAgeMs: 15000 })
  const snapshotCalls = transport.requests.slice(first).filter((r) => r.url.pathname.endsWith('/snapshots'))
  assert.equal(snapshotCalls.length, 0, 'inventory refreshed, backups not yet due')

  now += 5 * 60 * 1000
  const before = transport.requests.length
  await service.get(source, connection, settings, { maxAgeMs: 15000 })
  assert.ok(transport.requests.slice(before).some((r) => r.url.pathname.endsWith('/snapshots')))
})

test('maps a rejected token, missing permission and a bad answer to clear errors', async () => {
  const cases: [number, string, string][] = [
    [401, 'authentication failed', 'auth'],
    [403, '{"data":null,"message":"permission check failed"}', 'forbidden'],
    [500, '{"data":null,"message":"internal"}', 'http'],
    [200, '<html>login</html>', 'protocol']
  ]
  for (const [status, body, kind] of cases) {
    const { source } = setup({ '/remotes/remote': { status, body }, '/resources/list?max-age=30': [] })
    try {
      await source.fetchInventory({ maxAgeSeconds: 30 })
      assert.fail(`expected ${kind}`)
    } catch (error) {
      assert.ok(error instanceof ApiError)
      assert.equal(error.info.kind, kind)
      assert.ok(!error.message.includes('s3cret-uuid'))
    }
  }
})

test('a remote PDM lists but /resources/list leaves out becomes a warning', async () => {
  const routes = pdmRoutes(NOW)
  routes['/resources/list?max-age=30'] = (routes['/resources/list?max-age=30'] as { remote: string }[]).filter(
    (r) => r.remote !== 'pve-hel'
  )
  const { source } = setup(routes)
  const inventory = await source.fetchInventory({ maxAgeSeconds: 30 })
  assert.ok(inventory.warnings.some((w) => w.includes('pve-hel')))
})

test('without a readable PBS every guest’s backup is unknown, not missing', async () => {
  const routes = pdmRoutes(NOW)
  for (const key of Object.keys(routes)) if (key.includes('/snapshots')) routes[key] = { status: 403, body: 'forbidden' }
  const { source } = setup(routes)
  const snap = await new EstateService(() => NOW).get(source, connection, DEFAULT_SETTINGS, { maxAgeMs: 1 })
  assert.ok(snap.guests.every((g) => g.backupState === 'unknown'))
  assert.equal(snap.backups.missing, 0)
  assert.equal(snap.backups.error, 'No PBS datastore could be read.')
})

test('a shared VMID without namespaces is matched but flagged ambiguous', () => {
  const guest = (remote: string): Guest => ({
    key: `${remote}/100`, remote, node: 'n', vmid: 100, type: 'qemu', name: 'x', status: 'running', template: false,
    tags: [], cpu: 0, maxcpu: 1, mem: 0, maxmem: 1, disk: 0, maxdisk: 1, uptime: 0, backupState: 'unknown'
  })
  const records: BackupRecord[] = [{ remote: 'pbs', datastore: 'ds', ns: '', type: 'vm', id: '100', time: NOW - HOUR }]
  const { guests, missing } = attachBackups([guest('a'), guest('b')], records, { now: NOW, staleHours: 26, available: true })
  assert.deepEqual(guests.map((g) => [g.backupState, g.backupAmbiguous]), [['ok', true], ['ok', true]])
  assert.equal(missing, 0)
  // A single owner of the VMID is never ambiguous.
  assert.equal(attachBackups([guest('a')], records, { now: NOW, staleHours: 26, available: true }).guests[0].backupAmbiguous, undefined)
  // A stale backup counts as missing; exactly at the limit it is still fine.
  const edge = attachBackups([guest('a')], [{ ...records[0], time: NOW - 26 * HOUR }], { now: NOW, staleHours: 26, available: true })
  assert.equal(edge.guests[0].backupState, 'ok')
})

test('helpers: base URL, fingerprint, versions, units', () => {
  assert.equal(normalizeBaseUrl('https://pdm:8443/'), 'https://pdm:8443')
  assert.equal(normalizeBaseUrl('https://pdm:8443/api2/json/'), 'https://pdm:8443')
  assert.throws(() => normalizeBaseUrl('http://pdm:8443'))
  assert.throws(() => normalizeBaseUrl('https://user:pw@pdm:8443'))
  assert.equal(normalizeFingerprint('ab'.repeat(32)), Array(32).fill('AB').join(':'))
  assert.equal(normalizeFingerprint('AB:CD'), null)
  assert.equal(pveVersion('pve-manager/8.3.2/3e76eec21c4a14a7'), '8.3.2')
  assert.equal(formatVersion({ version: '3.3', release: '2' }), '3.3.2')
  assert.equal(formatVersion({ version: '8.2.4', release: '8.2' }), '8.2.4')
  assert.equal(formatBytes(1536), '1.5 KiB')
  assert.equal(formatUptime(90061), '1d 1h')
  assert.deepEqual(parseData('\x1e{"a":1}\n\x1e{"a":2}\n', 'application/json-seq', '/x'), [{ a: 1 }, { a: 2 }])
})

test('the owner user names the remote a snapshot came from', () => {
  const guest = (remote: string): Guest => ({
    key: `${remote}/100`, remote, node: 'n', vmid: 100, type: 'qemu', name: 'x', status: 'running', template: false,
    tags: [], cpu: 0, maxcpu: 1, mem: 0, maxmem: 1, disk: 0, maxdisk: 1, uptime: 0, backupState: 'unknown'
  })
  const records: BackupRecord[] = [
    { remote: 'pbs', datastore: 'ds', ns: '', type: 'vm', id: '100', time: NOW - 2 * HOUR, owner: 'a@pbs!pve' },
    { remote: 'pbs', datastore: 'ds', ns: '', type: 'vm', id: '100', time: NOW - HOUR, owner: 'b@pbs' }
  ]
  const { guests } = attachBackups([guest('a'), guest('b'), guest('c')], records, { now: NOW, staleHours: 26, available: true })
  assert.equal(guests[0].lastBackup, NOW - 2 * HOUR)
  assert.equal(guests[1].lastBackup, NOW - HOUR)
  // c has no snapshot of its own: a's and b's are theirs, not c's.
  assert.equal(guests[2].backupState, 'none')
  assert.ok(guests.every((g) => !g.backupAmbiguous && !('backupAmbiguous' in g)))
})

test('snapshots no guest can claim are orphans', () => {
  const guest = (remote: string, vmid: number): Guest => ({
    key: `${remote}/${vmid}`, remote, node: 'n', vmid, type: 'qemu', name: 'x', status: 'running', template: false,
    tags: [], cpu: 0, maxcpu: 1, mem: 0, maxmem: 1, disk: 0, maxdisk: 1, uptime: 0, backupState: 'unknown'
  })
  const rec = (id: string, hoursAgo: number, extra: Partial<BackupRecord> = {}): BackupRecord =>
    ({ remote: 'pbs', datastore: 'ds', ns: '', type: 'vm', id, time: NOW - hoursAgo * HOUR, ...extra })
  const { orphans } = attachBackups([guest('a', 100), guest('b', 200)], [
    rec('100', 1, { ns: 'a' }), // a's 100 exists
    rec('200', 2, { ns: 'a' }), // a has no 200 (b does): orphan of a
    rec('200', 3, { ns: 'a' }), // older copy: folded into the one above
    rec('300', 4), // nobody named, nobody has 300: orphan
    rec('100', 5), // nobody named, but some guest has 100: not an orphan
    rec('pbs-main', 6, { type: 'host' }) // host backups are not guests
  ], { now: NOW, staleHours: 26, available: true })
  assert.deepEqual(orphans.map((o) => [o.key, o.remote ?? null, o.lastBackup]), [
    ['a|vm/200', 'a', NOW - 2 * HOUR],
    ['|vm/300', null, NOW - 4 * HOUR]
  ])
})

test('malformed PDM answers: a bad item is skipped with a warning, a missing list is a clear error', async () => {
  const routes = pdmRoutes(NOW)
  const list = routes['/resources/list?max-age=30'] as { remote: string; resources?: unknown[] }[]
  const fsn = list.find((e) => e.remote === 'pve-fsn')!
  fsn.resources = [...(fsn.resources ?? []), { type: 'pve-qemu', vmid: 'x', node: 'fsn-pve1' }, null, { type: 'pve-lxc', vmid: 777, node: 'fsn-pve1', tags: { bad: true } }]
  list.push(42 as never)
  const { source } = setup(routes)
  const inventory = await source.fetchInventory({ maxAgeSeconds: 30 })
  assert.ok(inventory.warnings.some((w) => /3 malformed entries/.test(w)), inventory.warnings.join('\n'))
  // A malformed tags field costs that guest its tags, not the whole inventory.
  assert.deepEqual(inventory.guests.find((g) => g.vmid === 777)!.tags, [])

  // One task without a UPID drops only itself.
  routes['/remotes/tasks/list'] = [{ starttime: 1 }, { upid: 'pve:pve-fsn!UPID:fsn-pve1:1:2:6B000000:qmstart:100:root@pam:', starttime: 5, worker_type: 'qmstart' }]
  assert.equal((await setup(routes).source.fetchTasks()).length, 1)

  // `{ data: null }` for a list PDM must answer is a protocol error naming the path.
  routes['/remotes/remote'] = { status: 200, body: '{"data":null}' }
  await assert.rejects(setup(routes).source.fetchInventory({ maxAgeSeconds: 30 }), (e: unknown) => e instanceof ApiError && e.info.kind === 'protocol' && /\/remotes\/remote did not answer a list/.test(e.info.message))
})

test('partial PBS coverage: a guest without a backup found is unknown, not never backed up', async () => {
  const routes = pdmRoutes(NOW)
  routes['/pbs/remotes/pbs-main/datastore/store1/snapshots?ns=pve-hel'] = { status: 500, body: 'boom' }
  const { source } = setup(routes)
  const snap = await new EstateService(() => NOW).get(source, connection, DEFAULT_SETTINGS, { maxAgeMs: 0 })
  const byKey = new Map(snap.guests.map((g) => [g.key, g]))
  // pve-hel's backups live in the namespace that failed: unknown, not "none".
  assert.equal(byKey.get('pve-hel/200')!.backupState, 'unknown')
  assert.equal(byKey.get('pve-fsn/103')!.backupState, 'unknown')
  assert.match(snap.backups.incomplete ?? '', /pbs-main\/store1\/pve-hel/)
  // What was read still counts.
  assert.equal(byKey.get('pve-fsn/102')!.backupState, 'ok')
})

test('snapshots of guests on an unreachable remote are not called orphans', () => {
  const guest = (remote: string, vmid: number): Guest => ({
    key: `${remote}/${vmid}`, remote, node: 'n', vmid, type: 'qemu', name: 'x', status: 'running', template: false,
    tags: [], cpu: 0, maxcpu: 1, mem: 0, maxmem: 1, disk: 0, maxdisk: 1, uptime: 0, backupState: 'unknown'
  })
  const records: BackupRecord[] = [
    { remote: 'pbs', datastore: 'ds', ns: 'down', type: 'vm', id: '300', time: NOW },
    { remote: 'pbs', datastore: 'ds', ns: '', type: 'vm', id: '301', time: NOW }
  ]
  const known = attachBackups([guest('up', 100), guest('down', 1)], records, { now: NOW, staleHours: 26, available: true })
  assert.equal(known.orphans.length, 2)
  const gap = attachBackups([guest('up', 100), guest('down', 1)], records, { now: NOW, staleHours: 26, available: true, offlineRemotes: ['down'] })
  assert.deepEqual(gap.orphans, [])
})

test('a request cancelled before it starts is never sent', async () => {
  const { client, transport } = setup()
  const controller = new AbortController()
  controller.abort(new Error('connection changed'))
  await assert.rejects(client.get('/version', {}, controller.signal), /connection changed/)
  assert.equal(transport.requests.length, 0)
})

test('an unreadable snapshot entry makes backup coverage incomplete', async () => {
  const routes = pdmRoutes(NOW)
  const key = '/pbs/remotes/pbs-main/datastore/store1/snapshots?ns=pve-hel'
  routes[key] = [...(routes[key] as unknown[]), { 'backup-type': 'vm', 'backup-id': '200' }, null]
  const snap = await new EstateService(() => NOW).get(setup(routes).source, connection, DEFAULT_SETTINGS, { maxAgeMs: 0 })
  assert.match(snap.backups.incomplete ?? '', /2 unreadable snapshot entries in pbs-main\/store1\/pve-hel/)
  assert.equal(snap.guests.find((g) => g.key === 'pve-fsn/103')!.backupState, 'unknown')
})
