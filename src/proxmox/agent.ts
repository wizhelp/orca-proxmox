// Disk usage inside guests. A container's usage is known to Proxmox; a VM's only to its QEMU guest
// agent (`GET …/qemu/{vmid}/agent/get-fsinfo`). This reads the agent for running VMs, a few at a
// time and only every so often, and says why usage is unknown when it cannot be read. Pure apart
// from the `read` callback the source passes in.
import type { DiskUnknown, Guest } from '../model'
import { ApiError, mapLimit } from './client'

/** One filesystem as `get-fsinfo` reports it (only the fields read here). */
type FsInfo = { name?: unknown; mountpoint?: unknown; type?: unknown; 'total-bytes'?: unknown; 'used-bytes'?: unknown }

/** Pseudo and read-only filesystems that are not the guest's disks. */
const NOT_DISKS = new Set(['tmpfs', 'devtmpfs', 'squashfs', 'iso9660', 'udf', 'overlay', 'proc', 'sysfs', 'cgroup', 'cgroup2', 'autofs', 'efivarfs', 'fuse', 'fuse.lxcfs', 'nsfs', 'ramfs'])

/**
 * Used and total bytes over the guest's real filesystems in a `get-fsinfo` answer (each device
 * once, so bind mounts are not counted twice); undefined when it lists none.
 */
export function fsUsage(answer: unknown): { used: number; total: number } | undefined {
  const list = answer && typeof answer === 'object' && Array.isArray((answer as { result?: unknown }).result) ? ((answer as { result: unknown[] }).result as FsInfo[]) : Array.isArray(answer) ? (answer as FsInfo[]) : []
  const seen = new Set<string>()
  let used = 0
  let total = 0
  for (const fs of list) {
    if (!fs || typeof fs !== 'object') continue
    const size = fs['total-bytes']
    const inUse = fs['used-bytes']
    if (typeof size !== 'number' || !(size > 0) || typeof inUse !== 'number' || inUse < 0) continue
    if (typeof fs.type === 'string' && NOT_DISKS.has(fs.type.toLowerCase())) continue
    const device = typeof fs.name === 'string' ? fs.name : String(fs.mountpoint)
    if (seen.has(device)) continue
    seen.add(device)
    used += inUse
    total += size
  }
  return total > 0 ? { used: Math.min(used, total), total } : undefined
}

/** Why a read failed, as a reason the panel can show. */
export function unknownReason(error: unknown): DiskUnknown {
  if (error instanceof ApiError) {
    if (error.info.kind === 'forbidden' || error.info.kind === 'auth') return 'no-permission'
    // 404 or 501: this API (often PDM) does not offer the agent call.
    if (error.info.status === 404 || error.info.status === 501) return 'unsupported'
    // PVE answers 500 when the agent is disabled in the VM's options or not running inside it.
    if (error.info.status === 500) return 'no-agent'
  }
  return 'not-read'
}

export type DiskEntry = { at: number; used?: number; total?: number; unknown?: DiskUnknown }

/** Agent reads per refresh at most, and at once; usage is refreshed every DISK_EVERY_MS. */
export const DISK_PER_REFRESH = 24
export const DISK_PARALLEL = 2
export const DISK_EVERY_MS = 10 * 60 * 1000
/** After an 'unsupported' or 'no-permission' answer, that remote is not asked again for this long. */
export const DISK_BACKOFF_MS = 6 * 60 * 60 * 1000

/**
 * Brings the per-guest cache up to date: reads the agent of running VMs whose entry is missing or
 * old, the oldest first, at most DISK_PER_REFRESH, skipping remotes that cannot answer.
 */
export async function refreshGuestDisks(
  guests: readonly Guest[],
  cache: Map<string, DiskEntry>,
  read: (guest: Guest) => Promise<unknown>,
  now: number,
  blocked: Map<string, { until: number; reason: DiskUnknown }>
): Promise<void> {
  const due = guests
    .filter((g) => g.type === 'qemu' && g.status === 'running' && !g.template)
    .filter((g) => !((blocked.get(g.remote)?.until ?? 0) > now))
    .filter((g) => {
      const entry = cache.get(g.key)
      return !entry || now - entry.at >= DISK_EVERY_MS
    })
    .sort((a, b) => (cache.get(a.key)?.at ?? -Infinity) - (cache.get(b.key)?.at ?? -Infinity))
    .slice(0, DISK_PER_REFRESH)
  await mapLimit(due, DISK_PARALLEL, async (guest) => {
    if ((blocked.get(guest.remote)?.until ?? 0) > now) return
    try {
      const usage = fsUsage(await read(guest))
      cache.set(guest.key, usage ? { at: now, ...usage } : { at: now, unknown: 'no-agent' })
    } catch (error) {
      if (error instanceof ApiError && (error.info.kind === 'auth' || error.info.kind === 'fingerprint-mismatch')) throw error
      const reason = unknownReason(error)
      cache.set(guest.key, { at: now, unknown: reason })
      if (reason === 'unsupported' || reason === 'no-permission') blocked.set(guest.remote, { until: now + DISK_BACKOFF_MS, reason })
    }
  })
}

/**
 * The guests with disk usage filled in: running containers from Proxmox, VMs from the agent cache.
 * A running container's use is remembered in `cache`, so that once stopped (Proxmox then reports
 * 0) it shows the last use measured, marked as such, rather than an empty disk.
 */
export function withDiskUsage(guests: readonly Guest[], cache: Map<string, DiskEntry> | undefined, blocked: Map<string, { until: number; reason: DiskUnknown }> | undefined, now: number): Guest[] {
  return guests.map((g) => {
    const next: Guest = { ...g }
    delete next.diskUsage
    delete next.diskUnknown
    const from = g.type === 'lxc' ? 'container' : 'agent'
    const entry = cache?.get(g.key)
    if (g.status !== 'running') {
      next.diskUnknown = 'stopped'
      if (entry?.total) next.diskUsage = { used: entry.used ?? 0, total: entry.total, from, asOf: entry.at }
      return next
    }
    if (g.type === 'lxc') {
      if (g.maxdisk > 0) {
        next.diskUsage = { used: g.disk, total: g.maxdisk, from }
        cache?.set(g.key, { at: now, used: g.disk, total: g.maxdisk })
      } else next.diskUnknown = 'not-read'
      return next
    }
    const block = blocked?.get(g.remote)
    if (entry && entry.total) next.diskUsage = { used: entry.used ?? 0, total: entry.total, from }
    else if (block && block.until > now) next.diskUnknown = block.reason
    else next.diskUnknown = entry?.unknown ?? 'not-read'
    return next
  })
}
