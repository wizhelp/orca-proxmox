// Disk warnings, "full in ~N days" from history, free capacity per node and where a new VM fits.
// Pure: everything comes from the snapshot the worker already builds.
import type { Datastore, EstateSnapshot, Host } from '../model'

export const GUEST_DISK_LIMIT = 0.85
export const DATASTORE_LIMIT = 0.8
export const STORAGE_LIMIT = 0.85

export type DiskWarning = {
  key: string
  kind: 'guest' | 'datastore' | 'storage' | 'root'
  /** `CT web (101)`, `datastore main`, `storage local on pve-a`. */
  label: string
  usage: number
  limit: number
  /** Days until full at the recent rate, when the history shows a steady rise. */
  fullInDays?: number
}

/**
 * Days until `history` (shares 0..1, evenly spaced, oldest first, spanning `spanMs`) reaches 1 at
 * its least-squares trend. Undefined without enough points, without a rise, or beyond a year.
 */
export function fullInDays(history: readonly (number | null)[] | undefined, spanMs: number): number | undefined {
  if (!history || history.length < 2) return undefined
  const step = spanMs / (history.length - 1)
  const points = history.map((v, i) => (v === null ? null : { x: i * step, y: v })).filter((p): p is { x: number; y: number } => p !== null)
  if (points.length < 6) return undefined
  const n = points.length
  const mx = points.reduce((s, p) => s + p.x, 0) / n
  const my = points.reduce((s, p) => s + p.y, 0) / n
  const sxx = points.reduce((s, p) => s + (p.x - mx) ** 2, 0)
  if (sxx === 0) return undefined
  const slope = points.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0) / sxx // share per ms
  if (slope <= 0) return undefined
  const last = points[n - 1]
  const current = my + slope * (last.x - mx)
  const days = (1 - current) / slope / 86_400_000
  return days > 0 && days <= 365 ? days : undefined
}

const DAY = 86_400_000

export function datastoreForecast(store: Datastore): number | undefined {
  return fullInDays(store.usageHistory, DAY)
}

/** Everything over its limit, worst first. */
export function diskWarnings(snap: EstateSnapshot): DiskWarning[] {
  const out: DiskWarning[] = []
  for (const g of snap.guests) {
    // Containers report their use, a VM only through its guest agent; a stopped guest its last one.
    const known = g.diskUsage
    if (!known || !known.total) continue
    const usage = known.used / known.total
    if (usage > GUEST_DISK_LIMIT) out.push({ key: `guest|${g.key}`, kind: 'guest', label: `${g.type === 'qemu' ? 'VM' : 'CT'} ${g.name} (${g.vmid})`, usage, limit: GUEST_DISK_LIMIT })
  }
  for (const d of snap.datastores) {
    const fullIn = datastoreForecast(d)
    if (d.usage > DATASTORE_LIMIT || (fullIn !== undefined && fullIn < 14)) {
      const w: DiskWarning = { key: `datastore|${d.key}`, kind: 'datastore', label: `datastore ${d.name}`, usage: d.usage, limit: DATASTORE_LIMIT }
      if (fullIn !== undefined) w.fullInDays = fullIn
      out.push(w)
    }
  }
  const seenShared = new Set<string>()
  for (const h of snap.hosts) {
    if (h.maxdisk && h.disk !== undefined && h.disk / h.maxdisk > STORAGE_LIMIT) {
      out.push({ key: `root|${h.key}`, kind: 'root', label: `root disk of ${h.node}`, usage: h.disk / h.maxdisk, limit: STORAGE_LIMIT })
    }
    for (const s of h.storages ?? []) {
      if (!s.maxdisk || s.status !== 'available') continue
      const id = s.shared ? `${h.remote}/${s.name}` : `${h.key}/${s.name}`
      if (seenShared.has(id)) continue
      seenShared.add(id)
      const usage = s.disk / s.maxdisk
      if (usage > STORAGE_LIMIT) out.push({ key: `storage|${id}`, kind: 'storage', label: `storage ${s.name} on ${s.shared ? h.remote : h.node}`, usage, limit: STORAGE_LIMIT })
    }
  }
  return out.sort((a, b) => b.usage - a.usage)
}

// ---- free capacity and placement ----

export type Capacity = {
  host: Host
  cores: number
  /** Cores idle now (cores × (1 − CPU use)). */
  freeCores: number
  memTotal: number
  memFree: number
  /** Memory the running guests may use at most, against the node's total. */
  memCommitted: number
  /** Largest free space on one storage that holds guest disks (not the PBS mount, not root). */
  diskFree: number
  /** Size of that storage. */
  diskTotal: number
  diskStorage?: string
  /**
   * How sure the disk figures are: `verified` when PDM reported the storage's content types and
   * they include VM disks; `unverified` when the storage was chosen by its name only; `unknown`
   * when no storage on the node may hold VM disks as far as known.
   */
  diskCheck: 'verified' | 'unverified' | 'unknown'
}

/**
 * Whether a storage can hold VM disks: by its content types when PDM reports them (true or
 * false); without them only a name that says backup, ISO, template or dump rules it out (false),
 * and any other is undefined: possible, not verified.
 */
export function holdsGuestDisks(s: { name: string; shared: boolean; content?: string[] }): boolean | undefined {
  if (s.content) return s.content.includes('images')
  const notForDisks = /^(pbs|backup)/i.test(s.name) || (s.shared && /backup/i.test(s.name)) || /(^|[-_])(iso|isos|templates?|vztmpl|snippets|dump|backups?)($|[-_])/i.test(s.name)
  return notForDisks ? false : undefined
}

export function capacities(snap: EstateSnapshot): Capacity[] {
  return snap.hosts
    .filter((h) => h.remoteType === 'pve' && h.online && h.maxmem)
    .map((host) => {
      const guests = snap.guests.filter((g) => g.remote === host.remote && g.node === host.node && g.status === 'running')
      const usable = (host.storages ?? []).filter((s) => s.status === 'available' && s.maxdisk > 0)
      const roomiest = <T extends { maxdisk: number; disk: number }>(list: T[]) => [...list].sort((a, b) => b.maxdisk - b.disk - (a.maxdisk - a.disk))[0]
      const verified = roomiest(usable.filter((s) => holdsGuestDisks(s) === true))
      const guessed = verified ? undefined : roomiest(usable.filter((s) => holdsGuestDisks(s) === undefined))
      const best = verified ?? guessed
      const cap: Capacity = {
        host,
        cores: host.maxcpu ?? 0,
        freeCores: (host.maxcpu ?? 0) * (1 - (host.cpu ?? 0)),
        memTotal: host.maxmem ?? 0,
        memFree: (host.maxmem ?? 0) - (host.mem ?? 0),
        memCommitted: guests.reduce((s, g) => s + g.maxmem, 0),
        // No storage for guest disks known: the root disk is not one, so disk space stays unknown.
        diskFree: best ? best.maxdisk - best.disk : 0,
        diskTotal: best ? best.maxdisk : 0,
        diskCheck: verified ? 'verified' : guessed ? 'unverified' : 'unknown'
      }
      if (best) cap.diskStorage = best.name
      return cap
    })
}

export type VmRequest = { cores: number; memGiB: number; diskGiB: number }

export type Placement = Capacity & {
  fits: boolean
  /** Why it does not fit, or what is tight. */
  notes: string[]
  /** Higher is better: the share of RAM, disk and CPU left after placing the VM. */
  score: number
  /** It fits, and the disk side is verified too: only then is it called a fit without a caveat. */
  confirmed: boolean
}

const GiB = 1024 ** 3
/** Memory kept free for the host itself. */
const MEM_RESERVE = 0.1

/** Every node, best place for the VM first; nodes where it does not fit last. */
export function placeVm(snap: EstateSnapshot, req: VmRequest): Placement[] {
  return capacities(snap)
    .map((c) => {
      const notes: string[] = []
      const mem = req.memGiB * GiB
      const disk = req.diskGiB * GiB
      const memAfter = c.memFree - mem - c.memTotal * MEM_RESERVE
      const diskAfter = c.diskCheck === 'unknown' ? 0 : c.diskFree - disk
      const coresAfter = c.freeCores - req.cores
      let fits = true
      if (memAfter < 0) {
        fits = false
        notes.push('not enough free memory')
      }
      if (c.diskCheck === 'unknown') notes.push('disk space unknown')
      else if (c.diskCheck === 'unverified') notes.push(diskAfter < 0 ? 'disk may be short (unverified)' : 'disk unverified')
      else if (diskAfter < 0) {
        fits = false
        notes.push('not enough free disk')
      }
      if (req.cores > c.cores) {
        fits = false
        notes.push(`only ${c.cores} cores`)
      } else if (coresAfter < 0) notes.push('CPU is busy')
      if (fits && c.memCommitted + mem > c.memTotal) notes.push('memory over-committed')
      const score = fits ? Math.min(1, memAfter / c.memTotal) * 0.5 + (c.diskCheck !== 'verified' ? 0 : Math.min(1, diskAfter / Math.max(disk, GiB) / 10) * 0.3) + Math.max(0, coresAfter / Math.max(1, c.cores)) * 0.2 : -1
      return { ...c, fits, notes, score, confirmed: fits && c.diskCheck === 'verified' }
    })
    .sort((a, b) => b.score - a.score)
}
