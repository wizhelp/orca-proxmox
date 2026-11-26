// Disk use inside guests: containers from Proxmox, VMs from the QEMU guest agent, read a few at a
// time and seldom; unknown (with the reason) rather than 0 % when it cannot be read.
import { assert, test } from 'orca/testing'
import { ApiError } from '../src/proxmox/client'
import { DISK_BACKOFF_MS, DISK_BUDGET_MS, DISK_EVERY_MS, DISK_PER_REFRESH, fsUsage, refreshGuestDisks, unknownReason, withDiskUsage, type DiskEntry } from '../src/proxmox/agent'
import type { DiskUnknown, Guest } from '../src/model'
import { diskShare, diskUnknownText, sortGuests } from '../src/ui/logic'
import { diskWarnings } from '../src/features/capacity'

const GiB = 1024 ** 3
const guest = (vmid: number, type: 'qemu' | 'lxc', extra: Partial<Guest> = {}): Guest => ({
  key: `r/${vmid}`, remote: 'r', node: 'n', vmid, type, name: `g${vmid}`, status: 'running', template: false, tags: [],
  cpu: 0, maxcpu: 1, mem: 0, maxmem: 1, disk: 0, maxdisk: 32 * GiB, uptime: 1, backupState: 'unknown', ...extra
})

/** A guest agent answer: a Linux VM with a root fs, a bind mount of it and pseudo filesystems. */
const LINUX_FS = {
  result: [
    { name: 'sda1', mountpoint: '/', type: 'ext4', 'total-bytes': 30 * GiB, 'used-bytes': 12 * GiB },
    { name: 'sda1', mountpoint: '/var/lib/docker', type: 'ext4', 'total-bytes': 30 * GiB, 'used-bytes': 12 * GiB },
    { name: 'sdb1', mountpoint: '/data', type: 'xfs', 'total-bytes': 100 * GiB, 'used-bytes': 90 * GiB },
    { name: 'tmpfs', mountpoint: '/run', type: 'tmpfs', 'total-bytes': 1 * GiB, 'used-bytes': 0 },
    { name: 'sr0', mountpoint: '/media/cdrom', type: 'iso9660', 'total-bytes': 1 * GiB, 'used-bytes': 1 * GiB }
  ]
}

test('filesystem use from the guest agent: real disks, each device once', () => {
  assert.deepEqual(fsUsage(LINUX_FS), { used: 102 * GiB, total: 130 * GiB })
  assert.deepEqual(fsUsage({ result: [{ name: 'C:', mountpoint: 'C:\\', type: 'NTFS', 'total-bytes': 64 * GiB, 'used-bytes': 40 * GiB }] }), { used: 40 * GiB, total: 64 * GiB })
  assert.equal(fsUsage({ result: [] }), undefined)
  assert.equal(fsUsage('junk'), undefined)
})

test('why use is unknown, from the answer', () => {
  assert.equal(unknownReason(new ApiError({ kind: 'http', status: 500, message: 'x' })), 'no-agent')
  assert.equal(unknownReason(new ApiError({ kind: 'forbidden', status: 403, message: 'x' })), 'no-permission')
  assert.equal(unknownReason(new ApiError({ kind: 'http', status: 404, message: 'x' })), 'unsupported')
  assert.equal(unknownReason(new Error('x')), 'not-read')
})

test('agent reads are capped, cached and backed off per remote', async () => {
  const vms = Array.from({ length: DISK_PER_REFRESH + 6 }, (_, i) => guest(100 + i, 'qemu'))
  const cache = new Map<string, DiskEntry>()
  const blocked = new Map<string, { until: number; reason: DiskUnknown }>()
  let calls = 0
  let inFlight = 0
  let peak = 0
  const read = async (g: Guest) => {
    calls++
    inFlight++
    peak = Math.max(peak, inFlight)
    await new Promise((r) => setTimeout(r, 1))
    inFlight--
    if (g.vmid === 101) throw new ApiError({ kind: 'http', status: 500, message: 'agent not running' })
    return LINUX_FS
  }
  await refreshGuestDisks(vms, cache, read, 1_000, blocked)
  assert.equal(calls, DISK_PER_REFRESH, 'a few per refresh')
  assert.ok(peak <= 2, 'two at a time')
  await refreshGuestDisks(vms, cache, read, 2_000, blocked)
  assert.equal(calls, DISK_PER_REFRESH + 6, 'the rest next refresh, the read ones not again')
  await refreshGuestDisks(vms, cache, read, 3_000, blocked)
  assert.equal(calls, DISK_PER_REFRESH + 6, 'nothing is due yet')
  await refreshGuestDisks(vms, cache, read, 1_000 + DISK_EVERY_MS, blocked)
  assert.equal(calls, DISK_PER_REFRESH * 2 + 6, 'after the interval, again')

  const shown = withDiskUsage(vms, cache, blocked, 3_000)
  assert.deepEqual(shown[0].diskUsage, { used: 102 * GiB, total: 130 * GiB, from: 'agent' })
  assert.equal(shown[1].diskUnknown, 'no-agent')
  assert.equal(shown[1].diskUsage, undefined)

  // A remote whose API has no agent call (PDM answering 404) is asked once, then left alone.
  const pdmCache = new Map<string, DiskEntry>()
  const pdmBlocked = new Map<string, { until: number; reason: DiskUnknown }>()
  let pdmCalls = 0
  await refreshGuestDisks(vms.slice(0, 4), pdmCache, async () => {
    pdmCalls++
    throw new ApiError({ kind: 'http', status: 404, message: 'no such path' })
  }, 1_000, pdmBlocked)
  assert.ok(pdmCalls <= 2, 'stops after the first answers')
  assert.ok(withDiskUsage(vms.slice(0, 4), pdmCache, pdmBlocked, 1_000).every((g) => g.diskUnknown === 'unsupported'))
})

test('the Disk column: containers known, VMs by agent, unknown sorted last and never 0 %', () => {
  const ct = withDiskUsage([guest(200, 'lxc', { disk: 9 * GiB, maxdisk: 10 * GiB })], new Map(), undefined, 1)[0]
  const vmKnown = guest(201, 'qemu', { diskUsage: { used: 5 * GiB, total: 50 * GiB, from: 'agent' } })
  const vmUnknown = guest(202, 'qemu', { diskUnknown: 'no-agent' })
  const stopped = guest(203, 'qemu', { status: 'stopped', diskUnknown: 'stopped' })
  assert.equal(diskShare(ct), 0.9)
  assert.equal(diskShare(vmKnown), 0.1)
  assert.equal(diskShare(vmUnknown), undefined)
  assert.equal(diskUnknownText(vmUnknown), 'unknown (no guest agent)')
  assert.equal(diskUnknownText(stopped), 'unknown (stopped)')
  const desc = sortGuests([vmUnknown, vmKnown, ct, stopped], { column: 'disk', direction: 'desc' }).map((g) => g.vmid)
  assert.deepEqual(desc.slice(0, 2), [200, 201])
  // Warnings use the same thresholds: the container over 85 %, a VM only with agent data.
  const full = guest(204, 'qemu', { diskUsage: { used: 47 * GiB, total: 50 * GiB, from: 'agent' } })
  const keys = diskWarnings({ guests: [ct, vmKnown, vmUnknown, full], datastores: [], hosts: [] } as never).map((w) => w.key)
  assert.deepEqual(keys.sort(), ['guest|r/200', 'guest|r/204'])
})

test('a stopped container is not an empty one: its last use while running, else unknown', () => {
  const cache = new Map<string, DiskEntry>()
  const running = guest(300, 'lxc', { disk: 9 * GiB, maxdisk: 10 * GiB })
  assert.deepEqual(withDiskUsage([running], cache, undefined, 1_000)[0].diskUsage, { used: 9 * GiB, total: 10 * GiB, from: 'container' })
  // Stopped, Proxmox reports 0 of the configured size: shown as the last use, marked, not as 0 %.
  const stopped = withDiskUsage([{ ...running, status: 'stopped', disk: 0 }], cache, undefined, 5_000)[0]
  assert.equal(stopped.diskUnknown, 'stopped')
  assert.deepEqual(stopped.diskUsage, { used: 9 * GiB, total: 10 * GiB, from: 'container', asOf: 1_000 })
  assert.equal(diskShare(stopped), 0.9)
  // Never seen running: unknown, with no share at all.
  const never = withDiskUsage([guest(301, 'lxc', { status: 'stopped', disk: 0, maxdisk: 8 * GiB })], cache, undefined, 5_000)[0]
  assert.equal(never.diskUsage, undefined)
  assert.equal(diskShare(never), undefined)
  assert.equal(diskUnknownText(never), 'unknown (stopped)')
})

test('a refusal is about that VM: the others are still read, it is asked again only after hours', async () => {
  const vms = [guest(110, 'qemu'), guest(111, 'qemu'), guest(112, 'qemu')]
  const cache = new Map<string, DiskEntry>()
  const blocked = new Map<string, { until: number; reason: DiskUnknown }>()
  const asked: number[] = []
  const read = async (g: Guest) => {
    asked.push(g.vmid)
    if (g.vmid === 110) throw new ApiError({ kind: 'forbidden', status: 403, message: 'no' })
    return LINUX_FS
  }
  await refreshGuestDisks(vms, cache, read, 1_000, blocked)
  assert.deepEqual(asked.sort(), [110, 111, 112])
  assert.equal(blocked.size, 0, 'a 403 does not stop the whole remote')
  const shown = withDiskUsage(vms, cache, blocked, 1_000)
  assert.deepEqual(shown.map((g) => g.diskUnknown ?? 'known'), ['no-permission', 'known', 'known'])
  asked.length = 0
  await refreshGuestDisks(vms, cache, read, 1_000 + DISK_EVERY_MS, blocked)
  assert.deepEqual(asked.sort(), [111, 112], 'the refused VM waits longer')
  asked.length = 0
  await refreshGuestDisks(vms, cache, read, 1_000 + DISK_BACKOFF_MS, blocked)
  assert.ok(asked.includes(110))
})

test('slow agents cannot hold a refresh up: no new read starts after the time budget', async () => {
  const vms = Array.from({ length: 10 }, (_, i) => guest(120 + i, 'qemu'))
  let t = 0
  let calls = 0
  await refreshGuestDisks(vms, new Map(), async () => {
    calls++
    t += DISK_BUDGET_MS / 2 // every read takes half the budget
    return LINUX_FS
  }, 1_000, new Map(), () => t)
  assert.ok(calls <= 4, String(calls))
})

test('reading the guest agent turned off: VMs show their allocated size, nothing from agents', () => {
  const cache = new Map<string, DiskEntry>([['r/130', { at: 1, used: GiB, total: 2 * GiB }]])
  const [vm, ct] = withDiskUsage([guest(130, 'qemu'), guest(131, 'lxc', { disk: GiB, maxdisk: 4 * GiB })], cache, undefined, 5, true)
  assert.equal(vm.diskUnknown, 'off')
  assert.equal(vm.diskUsage, undefined)
  assert.equal(diskUnknownText(vm), 'unknown (reading the guest agent is off in Settings)')
  assert.deepEqual(ct.diskUsage, { used: GiB, total: 4 * GiB, from: 'container' }, 'containers are not the agent')
})
