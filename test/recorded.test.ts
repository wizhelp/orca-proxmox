// The worker over answers recorded from a real PDM 1.1.10 (test/fixtures/recorded-pdm.ts):
// 4 PVE 9.x remotes and one PBS 4.2 with a datastore `main` and namespaces alpha, beta and delta.
import { afterEach, assert, mockHost, mountWorker, test, type TestWorker } from 'orca/testing'
import type { EstateResponse, EstateSnapshot } from '../src/model'
import * as main from '../src/worker'
import { assertPlainJson, FIXTURE_PIN } from './fixtures/estate'
import { mockTransport } from './fixtures/pdm'
import { RECORDED_AT, recordedRoutes } from './fixtures/recorded-pdm'

const HOUR = 3600 * 1000
let worker: TestWorker | undefined
afterEach(async () => {
  await worker?.deactivate()
  worker = undefined
})

async function connected(now = RECORDED_AT) {
  const transport = mockTransport(recordedRoutes)
  main.useTestDoubles({ transport, probe: async () => null, now: () => now })
  // This recording predates network and config capture: no Orca awareness here.
  worker = await mountWorker(main, { host: mockHost({ settings: { orcaAwareness: false } }) })
  await worker.request('config.save', {
    baseUrl: 'https://pdm.example.test:8443',
    tokenId: 'monitor@pdm!orca',
    fingerprint: FIXTURE_PIN,
    secret: 'recorded-secret'
  })
  return { transport, worker }
}

function ok(answer: EstateResponse): EstateSnapshot {
  assert.equal(answer.state, 'ok', JSON.stringify(answer).slice(0, 400))
  return (answer as { snapshot: EstateSnapshot }).snapshot
}

test('every answer is plain JSON (a real estate once produced undefined fields)', async () => {
  const { worker } = await connected()
  const answer = await worker.request('estate.get', { force: true })
  assertPlainJson(answer)
  assertPlainJson(await worker.request('config.get'))
  assertPlainJson(await worker.request('connection.test', { baseUrl: 'https://pdm.example.test:8443', tokenId: 'monitor@pdm!orca', fingerprint: '', secret: 'x' }))
})

test('connection test reads the PDM version and remote count', async () => {
  const { worker } = await connected()
  const answer = await worker.request('connection.test', {
    baseUrl: 'https://pdm.example.test:8443',
    tokenId: 'monitor@pdm!orca',
    fingerprint: FIXTURE_PIN
  })
  assert.deepEqual(answer, { ok: true, version: '1.1.10', remotes: 5 })
})

test('hosts, guests and the datastore of the recorded estate', async () => {
  const { worker } = await connected()
  const snap = ok(await worker.request('estate.get', {}))
  assert.deepEqual(
    snap.remotes.map((r) => `${r.id}:${r.type}:${r.online}`),
    ['alpha:pve:true', 'beta:pve:true', 'gamma:pve:true', 'gamma-pbs:pbs:true', 'delta:pve:true']
  )
  assert.deepEqual(
    snap.hosts.map((h) => `${h.remote}/${h.node} ${h.status} ${h.version}`),
    [
      'alpha/pve online 9.2.32',
      'beta/pve01 online 9.2.32',
      'gamma/pve-gamma online 9.2.32',
      // PBS calls its node `localhost`; the remote's name is shown instead.
      'gamma-pbs/gamma-pbs online 4.2.14',
      'delta/pve-delta online 9.3.1'
    ]
  )
  // Root disk comes from node status (`rootfs` on PVE, `root` on PBS).
  assert.ok(snap.hosts.every((h) => (h.maxdisk ?? 0) > 400 * 1024 ** 3 && (h.disk ?? 0) > 0))
  assert.ok(snap.hosts.every((h) => !h.detailError))

  assert.equal(snap.guests.length, 19)
  assert.equal(snap.guests.filter((g) => g.status === 'running').length, 18)
  assert.deepEqual(snap.guests.filter((g) => g.template).map((g) => g.key), ['gamma/9100'])

  assert.equal(snap.datastores.length, 1)
  assert.equal(snap.datastores[0].key, 'gamma-pbs/main')
  assert.ok(Math.abs(snap.datastores[0].usage - 0.3649) < 0.001)
  // This recording predates history capture, so only that is missing.
  assert.deepEqual(snap.warnings.filter((w) => !/^(History of|Tasks could not|Updates of)/.test(w)), [])
})

test('backups: owner and namespace tell apart VMIDs used on several remotes', async () => {
  const { worker, transport } = await connected()
  const snap = ok(await worker.request('estate.get', {}))
  const g = new Map(snap.guests.map((x) => [x.key, x]))

  // vm/310 exists on alpha and beta. alpha backs up to the root namespace as alpha@pbs, beta to
  // namespace `beta` (and once to the root, as beta@pbs).
  assert.equal(g.get('alpha/310')!.lastBackup, Date.parse('2026-10-14T16:04:58Z'))
  assert.equal(g.get('alpha/310')!.lastBackupWhere, 'gamma-pbs/main')
  assert.equal(g.get('beta/310')!.lastBackup, Date.parse('2026-10-15T06:26:33Z'))
  assert.equal(g.get('beta/310')!.lastBackupWhere, 'gamma-pbs/main/beta')
  assert.equal(g.get('beta/314')!.lastBackup, Date.parse('2026-10-15T06:28:15Z'))
  assert.ok(snap.guests.every((x) => !x.backupAmbiguous))

  // One running guest has never been backed up; the template is not counted.
  assert.deepEqual(
    snap.guests.filter((x) => !x.template && x.backupState !== 'ok').map((x) => `${x.key}:${x.backupState}`),
    ['beta/320:none']
  )
  assert.equal(snap.backups.missing, 1)

  // Every namespace was scanned.
  const scanned = transport.requests.filter((r) => r.url.pathname.endsWith('/snapshots')).map((r) => r.url.search)
  assert.deepEqual(scanned.sort(), ['', '?ns=alpha', '?ns=beta', '?ns=delta'])
})

test('a destroyed guest is not listed; its leftover backup is reported as orphaned', async () => {
  // beta's VM 312 was destroyed (qmdestroy) two hours after its first PBS
  // backup. PVE, and so PDM, no longer lists it (`/pve/remotes/beta/qemu/312/status` answers
  // 404 "no such vmid"), but the snapshot in namespace `beta` remains.
  const { worker } = await connected()
  const snap = ok(await worker.request('estate.get', {}))
  assert.deepEqual(
    snap.guests.filter((g) => g.remote === 'beta').map((g) => g.vmid),
    [310, 314, 320, 430, 431]
  )
  assert.deepEqual(snap.backups.orphans, [
    {
      key: 'beta|vm/312',
      remote: 'beta',
      type: 'qemu',
      vmid: 312,
      lastBackup: Date.parse('2026-10-15T06:27:36Z'),
      where: 'gamma-pbs/main/beta'
    }
  ])
  // alpha's own VM 312, backed up as alpha@pbs in the root namespace, is not an orphan.
  assert.equal(snap.guests.find((g) => g.key === 'alpha/312')!.lastBackupWhere, 'gamma-pbs/main')
})

test('a day later the alpha backups are stale', async () => {
  const { worker } = await connected(RECORDED_AT + 12 * HOUR)
  const snap = ok(await worker.request('estate.get', {}))
  const stale = snap.guests.filter((x) => x.backupState === 'stale').map((x) => x.remote)
  assert.equal(stale.length, 11)
  assert.ok(stale.every((remote) => remote === 'alpha'))
  assert.equal(snap.backups.missing, 12)
})
