// Pure view logic of the panel: labels, tones, filters and sorts. No DOM, so tests run it in Node.
import type { BackupState, EstateSnapshot, Guest, Host, OrcaHost } from '../model'
import { guestRef, nodeRef } from '../presence'

export type Tone = 'ok' | 'warn' | 'bad' | 'off' | 'info'

export const hostLabel = (h: Host) => h.node || h.remote
export const guestName = (g: Guest) => `${g.name} (${g.vmid})`
export const guestKind = (g: Guest) => (g.type === 'qemu' ? 'VM' : 'CT')

export function statusTone(status: string): Tone {
  if (status === 'running' || status === 'online') return 'ok'
  if (status === 'stopped') return 'off'
  if (status === 'unreachable' || status === 'offline' || status === 'unknown') return 'bad'
  return 'warn'
}

export const BACKUP_LABEL: Record<BackupState, string> = { ok: 'ok', stale: 'stale', none: 'none', unknown: 'unknown' }
export const BACKUP_TONE: Record<BackupState, Tone> = { ok: 'ok', stale: 'warn', none: 'bad', unknown: 'off' }
export const BACKUP_RANK: Record<BackupState, number> = { none: 0, stale: 1, unknown: 2, ok: 3 }

export const ORCA_KIND: Record<OrcaHost['kind'], string> = { local: 'this machine', ssh: 'SSH target', environment: 'Orca server' }

/** What an Orca host is: an SSH target that also runs a paired Orca server is one Orca server. */
export function orcaKindLabel(host: OrcaHost): string {
  return host.paired ? 'Orca server' : ORCA_KIND[host.kind]
}

/** `pve-b · paired as server-b`, or just the name. */
export function orcaHostLabel(host: OrcaHost): string {
  return host.paired && host.paired.name !== host.name ? `${host.name} · paired as ${host.paired.name}` : host.name
}

export const MATCH_LABEL: Record<NonNullable<OrcaHost['match']>, string> = {
  manual: 'placed by hand',
  name: 'matched by name',
  address: 'matched by IP address',
  'via-ssh': 'deployed over its SSH target',
  identified: 'matched by the server’s own host name or addresses',
  resolved: 'matched by what its DNS name resolves to here (a hint: place it by hand to confirm)'
}

/** Tone of an Orca workspace or agent state. */
export function orcaTone(state: string): Tone {
  if (state === 'working') return 'info'
  if (state === 'permission' || state === 'blocked' || state === 'waiting') return 'warn'
  if (state === 'done') return 'ok'
  return 'off'
}

// ---- guests ----

export type GuestFilter = {
  search: string
  /** `all`, `qemu`, `lxc`. */
  type: string
  /** `all`, `running`, `stopped` (anything not running). */
  status: string
  /** `all`, a remote id, or `remote/node`. */
  place: string
  needsBackup: boolean
  /** `all` or one Proxmox tag. */
  tag: string
}

export const NO_FILTER: GuestFilter = { search: '', type: 'all', status: 'all', place: 'all', needsBackup: false, tag: 'all' }

export function filterGuests(guests: readonly Guest[], f: GuestFilter): Guest[] {
  const terms = f.search.toLowerCase().split(/\s+/).filter(Boolean)
  return guests.filter((g) => {
    if (f.type !== 'all' && g.type !== f.type) return false
    if (f.status === 'running' && g.status !== 'running') return false
    if (f.status === 'stopped' && g.status === 'running') return false
    if (f.place !== 'all' && g.remote !== f.place && `${g.remote}/${g.node}` !== f.place) return false
    if (f.needsBackup && (g.template || (g.backupState !== 'none' && g.backupState !== 'stale'))) return false
    if (f.tag && f.tag !== 'all' && !g.tags.includes(f.tag)) return false
    const haystack = [g.name, g.vmid, g.node, g.remote, g.status, g.hostname ?? '', g.notes ?? '', ...g.tags, ...(g.addresses ?? [])].join(' ').toLowerCase()
    return terms.every((t) => haystack.includes(t))
  })
}

export type GuestSort = { column: 'name' | 'status' | 'cpu' | 'mem' | 'disk' | 'uptime' | 'node' | 'backup'; direction: 'asc' | 'desc' }

/** A guest's disk use as a share (the last one measured for a stopped guest), or undefined when unknown. */
export function diskShare(g: Guest): number | undefined {
  return g.diskUsage && g.diskUsage.total ? g.diskUsage.used / g.diskUsage.total : undefined
}

const DISK_UNKNOWN_TEXT: Record<NonNullable<Guest['diskUnknown']>, string> = {
  'no-agent': 'unknown (no guest agent)',
  'no-permission': 'unknown (the token may not ask the guest agent)',
  unsupported: 'unknown (the API offers no guest agent call)',
  stopped: 'unknown (stopped)',
  'not-read': 'unknown (not read yet)',
  off: 'unknown (reading the guest agent is off in Settings)'
}

/** Why a guest's disk use is unknown, in words. */
export function diskUnknownText(g: Guest): string {
  return DISK_UNKNOWN_TEXT[g.diskUnknown ?? 'no-agent']
}

function sortValue(g: Guest, column: GuestSort['column']): string | number {
  switch (column) {
    case 'status':
      return g.status
    case 'cpu':
      return g.cpu
    case 'mem':
      return g.maxmem ? g.mem / g.maxmem : 0
    case 'disk':
      // Unknown use sorts below any known one, by allocated size.
      return diskShare(g) ?? -1 + g.maxdisk / 1e18
    case 'uptime':
      return g.uptime
    case 'node':
      return `${g.remote}/${g.node}`
    case 'backup':
      return BACKUP_RANK[g.backupState] * 1e13 + (g.lastBackup ?? 0)
    default:
      return g.name.toLowerCase()
  }
}

export function sortGuests(guests: readonly Guest[], sort: GuestSort): Guest[] {
  const dir = sort.direction === 'asc' ? 1 : -1
  return [...guests].sort((a, b) => {
    const x = sortValue(a, sort.column)
    const y = sortValue(b, sort.column)
    return (x < y ? -1 : x > y ? 1 : 0) * dir || a.key.localeCompare(b.key)
  })
}

/** The next sort when a column header is pressed: ascending first, then flipping. */
export function nextSort(current: GuestSort, column: GuestSort['column']): GuestSort {
  return current.column === column ? { column, direction: current.direction === 'asc' ? 'desc' : 'asc' } : { column, direction: 'asc' }
}

/** Host filter choices: each PVE remote, then its nodes. */
export function placeOptions(snap: EstateSnapshot): { value: string; label: string }[] {
  return [
    { value: 'all', label: 'All hosts' },
    ...snap.remotes
      .filter((r) => r.type === 'pve')
      .flatMap((r) => [
        { value: r.id, label: r.id },
        ...snap.hosts.filter((h) => h.remote === r.id && h.node).map((h) => ({ value: `${r.id}/${h.node}`, label: `  ${h.node}` }))
      ])
  ]
}

/** Every Proxmox tag in use, sorted. */
export function allTags(guests: readonly Guest[]): string[] {
  return [...new Set(guests.flatMap((g) => g.tags))].sort((a, b) => a.localeCompare(b))
}

// ---- backups ----

/** How far a guest's newest backup is towards (1) and past (>1) the stale limit; null without one. */
export function backupAge(g: Guest, now: number, staleHours: number): number | null {
  return g.lastBackup === undefined ? null : Math.max(0, now - g.lastBackup) / (staleHours * 3600 * 1000)
}

// ---- Orca placement ----

/** Options for placing an Orca host: automatic, not on Proxmox, every node and guest. */
export function placementOptions(snap: EstateSnapshot): { value: string; label: string }[] {
  return [
    { value: 'auto', label: 'Automatic' },
    { value: 'none', label: 'Not on Proxmox' },
    ...snap.hosts.filter((h) => h.node).map((h) => ({ value: nodeRef(h), label: `Node ${hostLabel(h)}` })),
    ...snap.guests.map((g) => ({ value: guestRef(g), label: `${guestKind(g)} ${guestName(g)} · ${g.remote}` }))
  ]
}

/** The current placement of an Orca host as a placement option value. */
export function placementValue(host: OrcaHost): string {
  if (host.match !== 'manual') return 'auto'
  return host.runsOn ? `${host.runsOn.kind}:${host.runsOn.key}` : 'none'
}

/** `pve-a (node of pve-a)` or `VM pdm (110) on pve-a/pve-a`. */
export function placeName(snap: EstateSnapshot, ref: string): string {
  const colon = ref.indexOf(':')
  const kind = ref.slice(0, colon)
  const key = ref.slice(colon + 1)
  if (kind === 'node') {
    const host = snap.hosts.find((h) => h.key === key)
    return host ? `${hostLabel(host)} (node of ${host.remote})` : key
  }
  const guest = snap.guests.find((g) => g.key === key)
  return guest ? `${guestKind(guest)} ${guestName(guest)} on ${guest.remote}/${guest.node}` : key
}

// ---- time ----

/** `just now`, `5m ago`, `3h ago`, `2d ago`. */
export function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}
