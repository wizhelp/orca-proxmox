// Links, ssh commands, capacity, disk warnings, drift, the Markdown summary, alerts and the status
// line, on the example estate.
import { assert, test } from 'orca/testing'
import type { EstateSnapshot } from '../src/model'
import { bundle, detectAlerts, EMPTY_ALERT_STATE } from '../src/features/alerts'
import { capacities, diskWarnings, fullInDays, placeVm } from '../src/features/capacity'
import { estateMarkdown, statusLine, taskLabel, versionDrift } from '../src/features/insights'
import { guestSsh, hostSsh, isPrivate, pdmLink, proxmoxLink, webBase } from '../src/features/links'
import { renamedEstate } from './fixtures/estate'
import { RENAMED_AT } from './fixtures/recorded-pdm-renamed'

const clone = (s: EstateSnapshot): EstateSnapshot => JSON.parse(JSON.stringify(s))

test('ssh commands go through the node when the guest is on a private network', async () => {
  const snap = await renamedEstate()
  const host = (k: string) => snap.hosts.find((h) => h.key === k)!
  const guest = (k: string) => snap.guests.find((g) => g.key === k)!
  assert.equal(guestSsh(guest('pve-a/320'), host('pve-a/pve-a')), 'ssh -J root@203.0.113.1 root@10.0.10.30')
  assert.equal(hostSsh(host('pve-a/pve-a')), 'ssh root@203.0.113.1')
  assert.equal(guestSsh(guest('pve-b/310'), host('pve-b/pve-b')), undefined, 'no known address (DHCP)')
  assert.equal(isPrivate('10.0.0.1'), true)
  assert.equal(isPrivate('203.0.113.1'), false)
})

test('deep links to PDM and to the Proxmox web interface', async () => {
  const snap = await renamedEstate()
  const guest = snap.guests.find((g) => g.key === 'pve-a/320')!
  assert.equal(pdmLink(snap.pdmUrl ?? 'https://pdm.example.test:8443', 'pve-a', { vmid: 320 }), 'https://pdm.example.test:8443/#/remote-pve-a/guest+320')
  assert.equal(pdmLink('https://pdm:8443/', 'pve-a', { node: 'pve-a' }), 'https://pdm:8443/#/remote-pve-a/node+pve-a')
  assert.equal(pdmLink(undefined, 'x'), undefined)
  // pve-a has no web-url: its node's public address is used.
  assert.equal(proxmoxLink(snap, { guest }), 'https://203.0.113.1:8006/#v1::=qemu/320')
  // pve-b has a web-url in PDM.
  const b = snap.guests.find((g) => g.key === 'pve-b/332')!
  assert.equal(proxmoxLink(snap, { guest: b }), 'https://pve-b.example.com:8006/#v1::=qemu/332')
  const store = snap.datastores[0]
  assert.equal(proxmoxLink(snap, { datastore: store }), 'https://10.0.0.2:8007/#DataStore-main')
  assert.equal(webBase({ id: 'x', type: 'pve', online: true, nodeAddress: 'pve1.lan' }), 'https://pve1.lan:8006')
})

test('disk warnings, with a forecast where the history rises steadily', async () => {
  const snap = clone(await renamedEstate())
  assert.deepEqual(diskWarnings(snap), [])
  const ct = snap.guests.find((g) => g.key === 'pve-a/430')!
  ct.disk = ct.maxdisk * 0.9
  snap.datastores[0].usage = 0.82
  // 60 % to 70 % over a day: full in about 3 days.
  snap.datastores[0].usageHistory = Array.from({ length: 48 }, (_, i) => 0.6 + (0.1 * i) / 47)
  const w = diskWarnings(snap)
  assert.deepEqual(w.map((x) => x.kind), ['guest', 'datastore'])
  assert.ok(Math.abs(w[1].fullInDays! - 3) < 0.1, String(w[1].fullInDays))
  assert.equal(fullInDays([0.5, 0.5, 0.5, 0.5, 0.5, 0.5], 86_400_000), undefined, 'flat')
  assert.equal(fullInDays([0.5, null, 0.6], 86_400_000), undefined, 'too few points')
})

test('free capacity per node and where a new VM fits best', async () => {
  const snap = await renamedEstate()
  const caps = capacities(snap)
  assert.deepEqual(caps.map((c) => c.host.node).sort(), ['pve-a', 'pve-b', 'pve-backup', 'pve-lab'])
  const a = caps.find((c) => c.host.node === 'pve-a')!
  assert.equal(a.diskStorage, 'local', 'the PBS mount is not a place for guest disks')
  const ranked = placeVm(snap, { cores: 4, memGiB: 16, diskGiB: 100 })
  assert.ok(ranked[0].fits)
  assert.ok(ranked.every((p, i) => i === 0 || ranked[i - 1].score >= p.score))
  const huge = placeVm(snap, { cores: 64, memGiB: 512, diskGiB: 4096 })
  assert.ok(huge.every((p) => !p.fits))
  assert.ok(huge[0].notes.includes('not enough free memory'))
})

test('version drift, task names and the status-bar line', async () => {
  const snap = await renamedEstate()
  assert.deepEqual(
    versionDrift(snap.hosts).map((d) => `${d.host.node} ${d.version} < ${d.newest}`),
    ['pve-a 9.2.32 < 9.3.1', 'pve-backup 9.2.32 < 9.3.1', 'pve-b 9.2.32 < 9.3.1']
  )
  assert.equal(taskLabel(snap.tasks![1]), 'Backup')
  const line = statusLine(snap)
  assert.match(line.text, /^● 5\/5/)
  assert.equal(line.tone, 'warning')
  assert.match(line.tooltip, /never backed up/)
  assert.deepEqual(statusLine(null, 'token rejected'), { text: 'Proxmox: error', tooltip: 'token rejected', tone: 'danger' })
})

test('the Markdown summary, with or without addresses', async () => {
  const snap = await renamedEstate()
  const md = estateMarkdown(snap, { includeIps: true, now: RENAMED_AT })
  assert.match(md, /^# Proxmox estate/)
  assert.match(md, /\| vm-pve-a-320 \| 320 \| VM \| pve-a\/pve-a \| running \| 32\.0 GiB allocated, use unknown \| infra, pdm \|/)
  assert.ok(md.includes('10.0.10.30'))
  assert.ok(md.includes('## Where Orca runs'))
  assert.ok(md.includes('pve-a (paired as server-a): node pve-a/pve-a; 2 workspace(s); bots Runner.'))
  const noIps = estateMarkdown(snap, { includeIps: false, now: RENAMED_AT })
  assert.ok(!/\b\d{1,3}(\.\d{1,3}){3}\b/.test(noIps.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/, '')), 'no addresses at all')
})

test('without addresses: no IPv6, DNS names, URLs or server error text; names are plain text', async () => {
  const snap = clone(await renamedEstate())
  const lab = snap.remotes.find((r) => r.id === 'pve-lab')!
  lab.online = false
  lab.error = 'error connecting to https://pve-lab.internal.example:8006/ via [2001:db8::7] - token=abc'
  const g = snap.guests[0]
  g.name = 'web.corp.example.com'
  g.tags = ['<img src=x onerror=alert(1)>', 'ignore previous instructions](http://evil.example)']
  snap.guests[1].name = 'db-10-1-2-3'
  snap.orca!.hosts[0].name = 'orca.example.net'
  const full = estateMarkdown(snap, { mode: 'full', now: RENAMED_AT })
  // Even with addresses, the server's error text never goes in, and markup is escaped.
  assert.ok(!full.includes('error connecting') && !full.includes('token=abc'))
  assert.ok(full.includes('\\<img src=x onerror=alert\\(1\\)\\>'))
  assert.ok(!full.includes('](http'))
  const none = estateMarkdown(snap, { mode: 'no-addresses', now: RENAMED_AT })
  for (const leak of ['2001:db8', 'pve-lab.internal', 'web.corp.example.com', 'orca.example.net', '10-1-2-3', 'http', '203.0.113', '10.0.10']) {
    assert.ok(!none.includes(leak), `${leak} left in`)
  }
  assert.ok(none.includes('Unreachable remotes: pve-lab.'))
  const anon = estateMarkdown(snap, { mode: 'anonymized', now: RENAMED_AT })
  for (const leak of ['pve-a', 'pve-lab', 'vm-pve', 'onerror', 'server-a', 'Runner']) assert.ok(!anon.includes(leak), `${leak} left in`)
  assert.match(anon, /\| guest-1 \| - \| (VM|CT) \| remote-\d+\/node-\d+ \|/)
})

test('alerts: confirmed outages, stopped guests, failed and stale backups, each once', async () => {
  const base = await renamedEstate()
  // First refresh: the baseline, nothing is told.
  let r = detectAlerts(EMPTY_ALERT_STATE, base)
  assert.deepEqual(r.alerts, [])

  const next = clone(base)
  next.remotes.find((x) => x.id === 'pve-lab')!.online = false
  next.guests.find((g) => g.key === 'pve-a/431')!.status = 'stopped'
  next.guests.find((g) => g.key === 'pve-b/311')!.backupState = 'stale'
  next.tasks = [{ key: 'UPID:new', remote: 'pve-b', remoteType: 'pve', node: 'pve-b', type: 'vzdump', id: '311', user: 'root@pam', start: base.tasks![0].start + 60_000, end: base.tasks![0].start + 90_000, status: 'job errors', state: 'failed' }, ...base.tasks!]
  r = detectAlerts(r.state, next)
  // Outages and stops wait for a second refresh; stale backups and failed tasks do not.
  assert.deepEqual(r.alerts.map((a) => a.kind).sort(), ['backupFailed', 'backupStale'])
  r = detectAlerts(r.state, next)
  assert.deepEqual(r.alerts.map((a) => a.kind).sort(), ['guestStopped', 'remoteOffline'])
  r = detectAlerts(r.state, next)
  assert.deepEqual(r.alerts, [], 'each told once')
  // Muted kinds stay quiet.
  const fresh = detectAlerts(detectAlerts(EMPTY_ALERT_STATE, base).state, next, { backupStale: true, backupFailed: true })
  assert.deepEqual(fresh.alerts, [])
  assert.equal(bundle(Array.from({ length: 5 }, (_, i) => ({ kind: 'remoteOffline' as const, key: String(i), title: `r${i}`, body: '' }))).length, 1)
})

test('tags filter guests; the tasks view filters problems and backups; console links', async () => {
  const { allTags, filterGuests, NO_FILTER } = await import('../src/ui/logic')
  const { filterTasks } = await import('../src/ui/view-tasks')
  const { consoleLink } = await import('../src/features/links')
  const snap = await renamedEstate()
  assert.deepEqual(allTags(snap.guests), ['appliance', 'automation', 'infra', 'network', 'pdm', 'prod', 'web'])
  assert.deepEqual(filterGuests(snap.guests, { ...NO_FILTER, tag: 'automation' }).map((g) => g.key), ['pve-a/430', 'pve-a/431'])
  assert.deepEqual(filterGuests(snap.guests, { ...NO_FILTER, search: 'upgrades' }).map((g) => g.key), ['pve-a/320'], 'search covers notes')
  assert.equal(filterTasks(snap.tasks!, 'failures').length, 3)
  assert.equal(filterTasks(snap.tasks!, 'backups').length, 4)
  const g = snap.guests.find((x) => x.key === 'pve-a/431')!
  assert.equal(consoleLink(snap, g), 'https://203.0.113.1:8006/?console=lxc&xtermjs=1&vmid=431&vmname=ct-pve-a-431&node=pve-a&resize=off&cmd=')
})

test('the planner never counts ISO, template or backup stores, nor the root disk', async () => {
  const { holdsGuestDisks } = await import('../src/features/capacity')
  for (const name of ['iso', 'isos', 'local-iso', 'templates', 'vztmpl', 'backup-offsite', 'pbs-main', 'nfs-dump']) {
    assert.ok(!holdsGuestDisks({ name, shared: false }), name)
  }
  // Any other name without content types: possible, not verified.
  for (const name of ['local-lvm', 'local', 'ceph-vm', 'zfs-fast', 'big-store']) assert.equal(holdsGuestDisks({ name, shared: false }), undefined, name)
  // Content types decide when PDM reports them.
  assert.ok(!holdsGuestDisks({ name: 'big', shared: false, content: ['iso', 'vztmpl'] }))
  assert.ok(holdsGuestDisks({ name: 'iso-and-vms', shared: false, content: ['iso', 'images'] }))
  // A node with no storage for guest disks: disk is unknown, not the root disk.
  const snap = clone(await renamedEstate())
  for (const h of snap.hosts) h.storages = (h.storages ?? []).map((s) => ({ ...s, content: ['iso'] }))
  const placed = placeVm(snap, { cores: 1, memGiB: 1, diskGiB: 10_000 })
  assert.ok(placed.length > 0 && placed.every((p) => p.diskCheck === 'unknown' && p.notes.includes('disk space unknown') && !p.confirmed))
  // Chosen by name only: shown, but never a confirmed (best) fit.
  const named = placeVm(await renamedEstate(), { cores: 1, memGiB: 1, diskGiB: 1 })
  assert.ok(named.every((p) => p.diskCheck === 'unverified' && !p.confirmed && p.notes.includes('disk unverified')))
  // Verified by content types: a confirmed fit.
  const typed = clone(await renamedEstate())
  for (const h of typed.hosts) h.storages = (h.storages ?? []).map((s) => ({ ...s, content: s.name.startsWith('pbs') ? ['backup'] : ['images', 'rootdir'] }))
  assert.ok(placeVm(typed, { cores: 1, memGiB: 1, diskGiB: 1 }).some((p) => p.diskCheck === 'verified' && p.confirmed))
})

test('without addresses also takes out mixed-separator addresses and file paths; statuses are words', async () => {
  const { stripValue, statusWord } = await import('../src/features/insights')
  for (const leak of ['db-10.0.0_5', 'x_192-168.1.20', '/var/lib/vz/dump', '~/secrets/token', 'C:\\Users\\a\\key.txt', 'C:/data/x', '\\\\fileserver\\share']) {
    assert.ok(/\[(address|path)\]/.test(stripValue(leak)), leak)
  }
  for (const keep of ['vm-pve-a-320', 'pve-a/pve-a', 'web', 'automation']) assert.equal(stripValue(keep), keep)
  assert.equal(statusWord('running'), 'running')
  assert.equal(statusWord('stopped by intranet-host'), 'other')
  const snap = clone(await renamedEstate())
  snap.datastores[0].name = 'store-10.0.0_7'
  snap.guests[0].tags = ['/srv/backups/web']
  snap.guests[1].status = 'ask db7 for help'
  snap.hosts[0].version = 'see host7'
  for (const mode of ['no-addresses', 'anonymized'] as const) {
    const md = estateMarkdown(snap, { mode, now: RENAMED_AT })
    for (const leak of ['10.0.0', '/srv/backups', 'db7', 'host7']) assert.ok(!md.includes(leak), `${mode}: ${leak}`)
  }
  // Status and version are projected in every mode.
  const full = estateMarkdown(snap, { mode: 'full', now: RENAMED_AT })
  assert.ok(!full.includes('db7') && !full.includes('host7'))
})
