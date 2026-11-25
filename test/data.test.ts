// The data added for the second round: tasks, storages, notes, updates and link details, read from
// the example estate (recorded estate plus test/fixtures/extras.ts).
import { assert, test } from 'orca/testing'
import { toTask, updateCount } from '../src/proxmox/pdm'
import { renamedEstate } from './fixtures/estate'
import { RENAMED_AT } from './fixtures/recorded-pdm-renamed'

test('tasks of every remote, newest first, with their state', async () => {
  const snap = await renamedEstate()
  const tasks = snap.tasks!
  assert.equal(tasks.length, 8)
  assert.ok(tasks.every((t, i) => i === 0 || tasks[i - 1].start >= t.start))
  assert.deepEqual(
    tasks.map((t) => `${t.remote}/${t.type}/${t.id ?? ''}:${t.state}`),
    [
      'pve-a/qmstart/314:running',
      'pve-b/vzdump/332:failed',
      'pve-backup-pbs/backup/main:vm/332:failed',
      'pve-backup-pbs/backup/main:vm/411:ok',
      'pve-lab/vzdump/411:ok',
      'pve-a/vzstart/431:warning',
      'pve-a/vzshutdown/431:ok',
      'pve-b/aptupdate/:ok'
    ]
  )
  const pbs = tasks.find((t) => t.remoteType === 'pbs')!
  assert.equal(pbs.user, 'beta@pbs!pve')
  assert.equal(tasks[0].end, undefined)
  assert.equal(tasks[1].end! - tasks[1].start, 610 * 1000)
})

test('a PDM task entry: the remote from the UPID, the id from the UPID or worker_id', () => {
  const t = toTask({ upid: 'pve:east!UPID:n1:00000001:00000002:6B000000:qmstop:105:ops@pve:', node: 'n1', starttime: 100, endtime: 102, status: 'OK', worker_type: 'qmstop' })!
  assert.deepEqual([t.remote, t.remoteType, t.node, t.type, t.id, t.state, t.start], ['east', 'pve', 'n1', 'qmstop', '105', 'ok', 100000])
  const pbs = toTask({ upid: 'pbs:store!UPID:localhost:1:2:3:6B000000:backup:main\\x3act/101:x@pbs:', starttime: 1, worker_type: 'backup', worker_id: null })!
  assert.equal(pbs.id, 'main:ct/101')
  assert.equal(pbs.state, 'running')
  assert.equal(toTask({ upid: 'UPID:no-remote', starttime: 1 }), null)
})

test('storages per node, notes, pending updates and link details', async () => {
  const snap = await renamedEstate()
  const a = snap.hosts.find((h) => h.key === 'pve-a/pve-a')!
  assert.deepEqual(a.storages!.map((s) => `${s.name}${s.shared ? '*' : ''}`).sort(), ['local', 'pbs-gamma*'])
  assert.equal(a.notes, 'Main node. Runs the PDM VM and the automation containers.')
  assert.equal(a.pendingUpdates, 12)
  assert.equal(snap.hosts.find((h) => h.key === 'pve-b/pve-b')!.pendingUpdates, 0)
  assert.equal(snap.hosts.find((h) => h.key === 'pve-lab/pve-lab')!.pendingUpdates, undefined, 'PDM has not checked')
  assert.equal(snap.guests.find((g) => g.key === 'pve-a/320')!.notes, 'Proxmox Datacenter Manager.\nBack up before upgrades.')
  assert.deepEqual(snap.guests.find((g) => g.key === 'pve-b/332')!.tags, ['prod', 'web'])
  const remoteB = snap.remotes.find((r) => r.id === 'pve-b')!
  assert.equal(remoteB.webUrl, 'https://pve-b.example.com:8006')
  assert.equal(snap.remotes.find((r) => r.id === 'pve-a')!.nodeAddress, '10.0.10.1')
  assert.equal(snap.remotes.find((r) => r.id === 'pve-a')!.nodePort, 8006)
  assert.ok(RENAMED_AT > 0)
})

test('update counts in the shapes PDM may use', () => {
  assert.equal(updateCount({ 'number-of-updates': 3 }), 3)
  assert.equal(updateCount({ number_of_updates: 0 }), 0)
  assert.equal(updateCount({ versions: [{}, {}] }), 2)
  assert.equal(updateCount({ status: 'unknown' }), undefined)
})
