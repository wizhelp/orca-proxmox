// What the panel shows per node and guest: its guests and their backups, and the Orca hosts,
// bots and workspaces on it. Pure helpers over an EstateSnapshot, shared by the panel and tests.
import type { EstateSnapshot, Guest, Host, OrcaBot, OrcaHost, OrcaView, OrcaWorkspace } from './model'

export type OrcaPresence = {
  hosts: OrcaHost[]
  bots: OrcaBot[]
  workspaces: OrcaWorkspace[]
  /** Agents working right now across those workspaces. */
  working: number
}

/** `node:<remote/node>` or `guest:<remote/vmid>`: how a place on the estate is named. */
export const nodeRef = (host: Host) => `node:${host.key}`
export const guestRef = (guest: Guest) => `guest:${guest.key}`

/** Orca presence by place on the estate; Orca hosts that run elsewhere are left out. */
export function orcaByPlace(view: OrcaView | undefined): Map<string, OrcaPresence> {
  const places = new Map<string, OrcaPresence>()
  if (!view) return places
  for (const host of view.hosts) {
    if (!host.runsOn) continue
    const ref = `${host.runsOn.kind}:${host.runsOn.key}`
    const place = places.get(ref) ?? { hosts: [], bots: [], workspaces: [], working: 0 }
    place.hosts.push(host)
    const workspaces = view.workspaces.filter((w) => w.hostKey === host.key)
    place.workspaces.push(...workspaces)
    place.bots.push(...view.bots.filter((b) => b.hostKey === host.key))
    place.working += workspaces.reduce((n, w) => n + w.agents.filter((a) => a.state === 'working').length, 0)
    places.set(ref, place)
  }
  return places
}

/** Orca hosts that run on no known place: this machine, or hosts not placed yet. */
export function orcaElsewhere(view: OrcaView | undefined): OrcaHost[] {
  return view ? view.hosts.filter((h) => !h.runsOn) : []
}

/** `Orca · 2 bots · 3 workspaces · 1 working`. */
export function presenceLabel(p: OrcaPresence): string {
  const parts = ['Orca']
  if (p.bots.length) parts.push(`${p.bots.length} bot${p.bots.length > 1 ? 's' : ''}`)
  if (p.workspaces.length) parts.push(`${p.workspaces.length} workspace${p.workspaces.length > 1 ? 's' : ''}`)
  if (p.working) parts.push(`${p.working} working`)
  return parts.join(' · ')
}

export function guestsOf(snap: EstateSnapshot, host: Host): Guest[] {
  return host.remoteType === 'pve' && host.node
    ? snap.guests.filter((g) => g.remote === host.remote && g.node === host.node)
    : []
}

export type BackupRollup = {
  /** Guests (templates excluded) whose newest snapshot is missing or stale. */
  needing: number
  /** Newest snapshot of any guest here. */
  newest?: number
  /** Oldest "newest snapshot" across backed-up guests: how far behind the laggard is. */
  oldest?: number
  unknown: boolean
}

export function backupRollup(guests: readonly Guest[]): BackupRollup {
  const counted = guests.filter((g) => !g.template)
  const times = counted.map((g) => g.lastBackup).filter((t): t is number => t !== undefined)
  const rollup: BackupRollup = {
    needing: counted.filter((g) => g.backupState === 'none' || g.backupState === 'stale').length,
    unknown: counted.length > 0 && counted.every((g) => g.backupState === 'unknown')
  }
  if (times.length) {
    rollup.newest = Math.max(...times)
    rollup.oldest = Math.min(...times)
  }
  return rollup
}
