// What the panel shows per node and guest: its guests and their backups, and the Orca hosts,
// bots and workspaces on it. Pure helpers over an EstateSnapshot, shared by the panel and tests.
import type { EstateSnapshot, Guest, Host, OrcaBot, OrcaHost, OrcaView, OrcaWorkspace } from './model'
import { guestSsh, hostSsh } from './features/links'
import { hostRoute, routeDestination } from './orca/terminal'

export type OrcaPresence = {
  hosts: OrcaHost[]
  bots: OrcaBot[]
  workspaces: OrcaWorkspace[]
  /** Agents working right now across those workspaces. */
  working: number
}

/**
 * The Terminal a node or guest card offers, and what it does or why there is none:
 *   - through Orca: an Orca host placed there has a workspace (its own, for a server placed from
 *     its own claims), whichever of the hosts there has one;
 *   - a local terminal running `ssh` (shown as such): placed there by hand, but Orca has no
 *     workspace on it;
 *   - none, said in the tooltip: nothing placed there (and how many Orca hosts are not placed
 *     yet), no workspace on a host placed automatically, or no address.
 * Undefined with Orca awareness off. A click sends the route, host and destination shown; the
 * worker runs exactly that, or refuses when the card's offer is no longer the same.
 */
export type TerminalOffer = {
  host?: OrcaHost
  route: 'workspace' | 'ssh' | 'none'
  title: string
  /** What the click runs, compared on click: the workspace, or the ssh command; '' for none. */
  destination: string
  workspace?: OrcaWorkspace
  ssh?: string
}

export function terminalOffer(view: OrcaView | undefined, presence: OrcaPresence | undefined, ssh: string | undefined, place: 'node' | 'guest'): TerminalOffer | undefined {
  if (!view) return undefined
  const routes = (presence?.hosts ?? []).map((host) => ({ host, route: hostRoute(view, host, ssh) }))
  for (const { host, route } of routes) {
    if (route.route !== 'workspace') continue
    const hint = host.match === 'resolved' ? ` (placed on this ${place} by what its DNS name resolves to here)` : ''
    return { host, ...route, destination: routeDestination(route), title: `Open a terminal on ${host.name} through Orca (its ${route.workspace.name} workspace)${hint}` }
  }
  for (const { host, route } of routes) {
    if (route.route !== 'ssh') continue
    return {
      host,
      ...route,
      destination: routeDestination(route),
      title: `Orca has no workspace on ${host.name}: this opens a local terminal running “${route.ssh}” to the ${place} you placed it on. Open a folder on ${host.name} in Orca (e.g. /root) for a terminal through Orca’s own connection.`
    }
  }
  if (routes.length) return { route: 'none', destination: '', title: routes.map(({ route }) => (route.route === 'none' ? route.why : '')).join(' ') }
  const unplaced = view.hosts.filter((h) => !h.runsOn && h.kind !== 'local' && h.match !== 'manual')
  return {
    route: 'none',
    destination: '',
    title: unplaced.length
      ? `No Orca host is placed on this ${place}. ${unplaced.length} Orca host${unplaced.length > 1 ? 's are' : ' is'} not placed yet (${unplaced.map((h) => h.name).join(', ')}): place one in the Orca view.`
      : `No Orca SSH target or paired server runs on this ${place}.`
  }
}

/** The offer of the card at `place` (`node:…` or `guest:…`), as the panel draws it and the worker checks it. */
export function cardOffer(snap: EstateSnapshot, place: string, presence: OrcaPresence | undefined = orcaByPlace(snap.orca).get(place)): TerminalOffer | undefined {
  const m = /^(node|guest):(.+)$/.exec(place)
  if (!m) return undefined
  if (m[1] === 'node') {
    const host = snap.hosts.find((h) => h.key === m[2])
    return host ? terminalOffer(snap.orca, presence, hostSsh(host), 'node') : undefined
  }
  const guest = snap.guests.find((g) => g.key === m[2])
  return guest ? terminalOffer(snap.orca, presence, guestSsh(guest, snap.hosts.find((h) => h.remote === guest.remote && h.node === guest.node)), 'guest') : undefined
}

/** Which estate a card was drawn from: its connection scope, estate read and Orca read. */
export function estateRevision(snap: EstateSnapshot): string {
  return `${snap.connectionId}@${snap.fetchedAt}/${snap.orca?.fetchedAt ?? '-'}`
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
