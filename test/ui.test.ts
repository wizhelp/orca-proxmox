// The panel's pure parts: view logic, chart geometry, where a drag lands, and the RRD history
// the charts draw. The DOM side is checked in a browser (dev/harness, see the README).
import { assert, test } from 'orca/testing'
import { withLevel } from '../src/arrange'
import type { Guest } from '../src/model'
import { rrdMetrics, usageHistory } from '../src/proxmox/pdm'
import { scaleMax, sparkPath } from '../src/ui/charts'
import { ago, backupAge, filterGuests, nextSort, NO_FILTER, placeName, placementValue, sortGuests } from '../src/ui/logic'
import { dropIndex } from '../src/ui/sortable'
import { renamedEstate } from './fixtures/estate'

test('a drop lands before the first sibling below the pointer, else at the end', () => {
  const mids = [10, 30, 50]
  assert.equal(dropIndex(mids, 0), 0)
  assert.equal(dropIndex(mids, 29), 1)
  assert.equal(dropIndex(mids, 31), 2)
  assert.equal(dropIndex(mids, 99), 3)
  assert.equal(dropIndex([], 5), 0)
})

test('one level of the order is replaced, the others kept', () => {
  assert.deepEqual(withLevel(['remote|a', 'node|x', 'node|y'], ['node|y', 'node|x']), ['remote|a', 'node|y', 'node|x'])
})

test('sparkline geometry: scaled into the box, gaps break the line', () => {
  const geo = sparkPath([0, 0.5, 1], 100, 20, 1)
  assert.equal(geo.line, 'M0.0,19.0L50.0,10.0L100.0,1.0')
  assert.deepEqual(geo.last, { x: 100, y: 1 })
  const gap = sparkPath([0.2, null, 0.4, 0.4], 30, 12, 1)
  assert.equal(gap.line.split('M').length - 1, 2, 'two runs around the gap')
  assert.ok(gap.area.endsWith('Z'))
  assert.equal(sparkPath([null, null], 10, 10, 1).line, '')
  // A quiet CPU is drawn against a low ceiling, memory always against 100 %.
  assert.equal(scaleMax([0.002, 0.004], 'share'), 0.05)
  assert.equal(scaleMax([0.1, 0.5], 'share'), 0.575)
  assert.equal(scaleMax([0.1], 'fixed'), 1)
  assert.equal(scaleMax([], 'auto'), 1)
})

test('RRD points become shares and byte rates, oldest first', () => {
  const m = rrdMetrics([
    { time: 120, 'cpu-current': 0.25, 'mem-used': 2, 'mem-total': 8, 'net-in': 100, 'net-out': 23.456 },
    { time: 60 },
    { time: 180, 'cpu-current': 0.123456, 'mem-used': 4, 'mem-total': 8 }
  ])
  assert.deepEqual(m.cpu, [null, 0.25, 0.123])
  assert.deepEqual(m.mem, [null, 0.25, 0.5])
  assert.deepEqual(m.net, [null, 123, null])
  assert.equal(m.until, 180000)
  const day = usageHistory(
    Array.from({ length: 96 }, (_, i) => (i < 48 ? { time: i } : { time: i, 'disk-used': 1, 'disk-total': 4 })),
    4
  )
  assert.deepEqual(day, [null, null, 0.25, 0.25])
})

test('the recorded estate carries an hour of history for every node and running guest', async () => {
  const snap = await renamedEstate()
  assert.ok(snap.hosts.every((h) => (h.metrics?.cpu.length ?? 0) === 61))
  const running = snap.guests.filter((g) => g.status === 'running')
  assert.ok(running.every((g) => g.metrics && g.metrics.mem.some((v) => v !== null)))
  assert.equal(snap.guests.find((g) => g.status !== 'running')!.metrics, undefined)
  assert.ok((snap.datastores[0].usageHistory?.filter((v) => v !== null).length ?? 0) > 0)
  assert.deepEqual(snap.warnings, [])
})

test('guest filters, sorts and labels', async () => {
  const snap = await renamedEstate()
  const by = (f: Partial<typeof NO_FILTER>) => filterGuests(snap.guests, { ...NO_FILTER, ...f }).map((g) => g.key)
  assert.equal(by({}).length, 19)
  assert.deepEqual(by({ search: '10.0.10.30' }), ['pve-a/320'], 'search covers addresses')
  assert.deepEqual(by({ place: 'pve-lab' }), ['pve-lab/410', 'pve-lab/411'])
  assert.deepEqual(by({ needsBackup: true }), ['pve-a/320'])
  assert.equal(by({ type: 'lxc' }).length, 6)
  assert.deepEqual(by({ status: 'stopped' }), ['pve-backup/9100'])

  const byCpu = sortGuests(snap.guests, { column: 'cpu', direction: 'desc' })
  assert.ok(byCpu[0].cpu >= byCpu[1].cpu)
  assert.deepEqual(nextSort({ column: 'cpu', direction: 'asc' }, 'cpu'), { column: 'cpu', direction: 'desc' })
  assert.deepEqual(nextSort({ column: 'cpu', direction: 'desc' }, 'name'), { column: 'name', direction: 'asc' })

  assert.equal(placeName(snap, 'node:pve-a/pve-a'), 'pve-a (node of pve-a)')
  assert.equal(placeName(snap, 'guest:pve-a/320'), 'VM vm-pve-a-320 (320) on pve-a/pve-a')
  assert.equal(placementValue({ key: 'x', kind: 'ssh', name: 'x' }), 'auto')
  assert.equal(placementValue({ key: 'x', kind: 'ssh', name: 'x', match: 'manual' }), 'none')
  assert.equal(placementValue({ key: 'x', kind: 'ssh', name: 'x', match: 'manual', runsOn: { kind: 'guest', key: 'a/1' } }), 'guest:a/1')
})

test('backup age against the stale limit, and short relative times', () => {
  const g = (lastBackup?: number) => ({ lastBackup }) as Guest
  assert.equal(backupAge(g(0), 13 * 3600 * 1000, 26), 0.5)
  assert.equal(backupAge(g(undefined), 1, 26), null)
  assert.equal(ago(0, 30 * 1000), 'just now')
  assert.equal(ago(0, 5 * 60 * 1000), '5m ago')
  assert.equal(ago(0, 3 * 3600 * 1000), '3h ago')
  assert.equal(ago(0, 72 * 3600 * 1000), '3d ago')
})
