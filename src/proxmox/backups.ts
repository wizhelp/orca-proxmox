// Matches PBS snapshots to guests. Pure: no I/O, so tests drive it with plain data.
//
// A PBS snapshot names a guest only by type and VMID (`vm/100`, `ct/101`), not by the cluster it
// came from, and VMIDs repeat across clusters. Two hints say which remote a snapshot belongs to:
//   - its namespace: a path segment named after the remote (`alpha`, `prod/alpha`);
//   - its owner: the PBS user PVE backs up as, when named after the remote (`alpha@pbs!pve`).
// A snapshot hinting at one remote is never matched to another remote's guest. A snapshot with no
// hint matches any guest of its type and VMID, and is flagged ambiguous when that VMID is used on
// more than one remote.
import type { BackupState, Guest, OrphanBackup } from '../model'

export type BackupRecord = {
  /** The PBS remote. */
  remote: string
  datastore: string
  /** Namespace path, `''` for the root namespace. */
  ns: string
  type: 'vm' | 'ct' | 'host'
  id: string
  /** Epoch milliseconds. */
  time: number
  /** PBS owner, `user@realm` or `user@realm!token`. */
  owner?: string
}

export type BackupOptions = {
  now: number
  staleHours: number
  /** False when no snapshot list could be read: every guest is `unknown`. */
  available: boolean
  /** False when some datastore or namespace was not read: a guest with no backup found is `unknown`. */
  complete?: boolean
  /** Remotes PDM cannot reach: their guests are not listed, so their snapshots are no orphans. */
  offlineRemotes?: readonly string[]
  /**
   * Remote id -> the name its own server uses, where they differ (a cluster reached directly
   * beside PDM): a namespace or owner named either way points at that remote.
   */
  aliases?: Readonly<Record<string, string>>
  /**
   * Remotes that may hold guests but cannot be read now (offline, or their connection failed):
   * their guests are not listed, so a snapshot their name points at may be theirs.
   */
  unavailableRemotes?: readonly string[]
  /** A source is down whose remotes were never seen: any named snapshot may be one of theirs. */
  unknownSources?: boolean
}

const GUEST_BACKUP_TYPE = { qemu: 'vm', lxc: 'ct' } as const

/** Names a snapshot carries that may name its remote: namespace segments and the owner's user. */
export function recordHints(record: BackupRecord): string[] {
  const hints = record.ns.toLowerCase().split('/').filter(Boolean)
  const user = record.owner?.split('@')[0]?.toLowerCase()
  if (user) hints.push(user)
  return hints
}

function where(record: BackupRecord): string {
  return [record.remote, record.datastore, record.ns].filter(Boolean).join('/')
}

export function backupStateFor(last: number | undefined, options: BackupOptions): BackupState {
  if (!options.available) return 'unknown'
  if (last === undefined) return options.complete === false ? 'unknown' : 'none'
  return options.now - last > options.staleHours * 3600 * 1000 ? 'stale' : 'ok'
}

/** Guests with `lastBackup`, `backupState` and `backupAmbiguous` filled in, and how many need a backup. */
export function attachBackups(
  guests: readonly Guest[],
  records: readonly BackupRecord[],
  options: BackupOptions
): { guests: Guest[]; missing: number; orphans: OrphanBackup[] } {
  // A hint (namespace part or owner) -> the remotes it names: by id, and by the server's own name.
  const named = new Map<string, Set<string>>()
  const name = (hint: string, remote: string) => named.set(hint.toLowerCase(), (named.get(hint.toLowerCase()) ?? new Set()).add(remote.toLowerCase()))
  for (const g of guests) name(g.remote, g.remote)
  for (const [remote, alias] of Object.entries(options.aliases ?? {})) name(alias, remote)
  for (const remote of options.unavailableRemotes ?? []) name(remote, remote)
  const unavailable = new Set((options.unavailableRemotes ?? []).map((r) => r.toLowerCase()))
  const byGuest = new Map<string, { record: BackupRecord; owners: string[] }[]>()
  for (const record of records) {
    const key = `${record.type}/${record.id}`
    const entry = { record, owners: [...new Set(recordHints(record).flatMap((hint) => [...(named.get(hint) ?? [])]))] }
    const list = byGuest.get(key)
    if (list) list.push(entry)
    else byGuest.set(key, [entry])
  }
  const remotesPerVmid = new Map<string, Set<string>>()
  for (const guest of guests) {
    const key = `${GUEST_BACKUP_TYPE[guest.type]}/${guest.vmid}`
    const remotes = remotesPerVmid.get(key) ?? new Set<string>()
    remotes.add(guest.remote.toLowerCase())
    remotesPerVmid.set(key, remotes)
  }

  let missing = 0
  const result = guests.map((guest) => {
    const key = `${GUEST_BACKUP_TYPE[guest.type]}/${guest.vmid}`
    const remote = guest.remote.toLowerCase()
    const all = byGuest.get(key) ?? []
    const holders = remotesPerVmid.get(key) ?? new Set<string>()
    // A hint that also names another remote which has this VMID (a PDM remote and a cluster
    // reached directly, both called "lab"), or which cannot be read now and so may have it, cannot
    // say whose snapshot it is; nor can any hint while a source with unknown remotes is down.
    const disputed = (e: { owners: string[] }) => options.unknownSources === true || e.owners.some((o) => o !== remote && (holders.has(o) || unavailable.has(o)))
    const mine = all.filter((e) => e.owners.includes(remote) && !disputed(e))
    const contested = all.filter((e) => e.owners.includes(remote) && disputed(e))
    const unattributed = all.filter((e) => e.owners.length === 0)
    const candidates = mine.length > 0 ? mine : contested.length > 0 ? contested : unattributed
    const shared = holders.size > 1
    const ambiguous = mine.length === 0 && candidates.length > 0 && (contested.length > 0 || shared)

    let newest: BackupRecord | undefined
    for (const { record } of candidates) {
      if (!newest || record.time > newest.time) newest = record
    }
    // Only a contested snapshot found: it may be another guest's, so the state is unknown.
    const state = mine.length === 0 && contested.length > 0 ? 'unknown' : backupStateFor(newest?.time, options)
    if (!guest.template && (state === 'none' || state === 'stale')) missing += 1
    // No undefined fields: the answer crosses to the panel as JSON.
    const next: Guest = { ...guest, backupState: state }
    delete next.lastBackup
    delete next.lastBackupWhere
    delete next.backupAmbiguous
    if (newest) {
      next.lastBackup = newest.time
      next.lastBackupWhere = where(newest)
    }
    if (ambiguous) next.backupAmbiguous = true
    return next
  })
  return { guests: result, missing, orphans: findOrphans(guests, byGuest, options.offlineRemotes ?? []) }
}

/**
 * Snapshots no current guest can claim: one naming a remote (by namespace or owner) whose
 * guest with that type and VMID is gone, or one naming no remote whose VMID no guest uses.
 */
function findOrphans(
  guests: readonly Guest[],
  byGuest: Map<string, { record: BackupRecord; owners: string[] }[]>,
  offlineRemotes: readonly string[]
): OrphanBackup[] {
  const offline = new Set(offlineRemotes.map((r) => r.toLowerCase()))
  const present = new Set<string>()
  const anywhere = new Set<string>()
  for (const g of guests) {
    const key = `${GUEST_BACKUP_TYPE[g.type]}/${g.vmid}`
    present.add(`${g.remote.toLowerCase()}|${key}`)
    anywhere.add(key)
  }
  const remoteNames = new Map(guests.map((g) => [g.remote.toLowerCase(), g.remote]))
  const newest = new Map<string, OrphanBackup>()
  for (const [key, entries] of byGuest) {
    const [type, id] = key.split('/')
    if (type !== 'vm' && type !== 'ct') continue
    for (const { record, owners } of entries) {
      const owner = owners[0]
      // A guest on a remote that cannot be reached is simply not listed: its snapshot proves nothing.
      if (owner ? owners.some((o) => offline.has(o)) : offline.size > 0) continue
      const orphaned = owner ? !owners.some((o) => present.has(`${o}|${key}`)) : !anywhere.has(key)
      if (!orphaned) continue
      const orphanKey = `${owner ?? ''}|${key}`
      const previous = newest.get(orphanKey)
      if (previous && previous.lastBackup >= record.time) continue
      const orphan: OrphanBackup = {
        key: orphanKey,
        type: type === 'vm' ? 'qemu' : 'lxc',
        vmid: Number(id),
        lastBackup: record.time,
        where: where(record)
      }
      if (owner) orphan.remote = remoteNames.get(owner) ?? owner
      newest.set(orphanKey, orphan)
    }
  }
  return [...newest.values()].sort((a, b) => b.lastBackup - a.lastBackup)
}
