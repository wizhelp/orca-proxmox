// How to open a terminal on the machine an Orca host runs on. Pure: the card shows the route
// (presence.ts terminalOffer) and the worker runs the plan made from that same offer with the
// orca CLI. Through Orca itself when the host has a workspace (so the shell runs there with Orca's
// own connection); else, only for a host placed by hand, a local terminal running ssh to the
// machine's address.
import type { EstateSnapshot, OrcaHost, OrcaView, OrcaWorkspace } from '../model'
import type { TerminalOffer } from '../presence'
import { guestSsh, hostSsh, isSafeSshCommand } from '../features/links'

export type TerminalPlan =
  | {
      how: 'workspace' | 'ssh'
      /** `orca terminal create`; the worker then switches to the handle it returns. */
      args: string[]
      /** The paired server the terminal lives on, for the switch; absent for this machine. */
      environment?: string
      /** Where to find it by hand when Orca cannot switch to it. */
      where: string
    }
  | { error: string }

/** What one Orca host offers: a workspace of it, a local ssh (placed by hand only), or why neither. */
export type HostRoute = { route: 'workspace'; workspace: OrcaWorkspace } | { route: 'ssh'; ssh: string } | { route: 'none'; why: string }

/** `orca terminal switch` to a created terminal, on the server that issued its handle. */
export function switchArgs(handle: string, environment?: string): string[] {
  return ['terminal', 'switch', ...(environment ? [`--environment=${environment}`] : []), `--terminal=${handle}`]
}

/** The `--worktree` selector of a worktree id: `folder:<id>` as is, a Git worktree as `id:<repo>::<path>`. */
export function worktreeSelector(worktreeId: string): string {
  return worktreeId.startsWith('folder:') ? worktreeId : `id:${worktreeId}`
}

/** A plain workspace first (the server's own folder, say), a bot's home last; then the newest. */
export function pick(workspaces: OrcaWorkspace[]): OrcaWorkspace | undefined {
  return [...workspaces]
    .filter((w) => w.worktreeId)
    .sort((a, b) => Number(!!a.bot) - Number(!!b.bot) || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))[0]
}

/**
 * The route of one Orca host, given the ssh command of the place it is on. A local `ssh root@`
 * goes to an address of the estate, not to whatever Orca reaches: only a placement made by hand
 * says that address is this host's machine. Every automatic placement (a name, an address, a DNS
 * answer, a server's own claims) offers a workspace or nothing.
 */
export function hostRoute(view: OrcaView, host: OrcaHost, ssh: string | undefined): HostRoute {
  // A server placed only from its own claims: only a workspace it runs itself, never one it
  // reaches over an SSH target of its own (another machine).
  const own = (w: OrcaWorkspace) => w.ownRuntime === true && w.environment === host.key.replace(/^env:/, '')
  const workspace = pick(view.workspaces.filter((w) => w.hostKey === host.key && (host.match !== 'identified' || own(w))))
  if (workspace) return { route: 'workspace', workspace }
  if (host.match === 'identified') {
    return { route: 'none', why: `${host.name} is placed from what it reported about itself, which is not enough to open a root SSH session to that machine. Open a terminal in one of its Orca workspaces, or place it by hand in the Orca view to confirm.` }
  }
  if (host.match === 'resolved') {
    return { route: 'none', why: `${host.name} is placed by what its DNS name resolves to here, which is not enough to open a root SSH session to that machine. Open a folder on it in Orca (e.g. /root), or place it by hand in the Orca view to confirm.` }
  }
  if (host.match !== 'manual') {
    return { route: 'none', why: `Orca has no workspace on ${host.name}. Open a folder on it in Orca (e.g. /root) for a terminal through Orca, or place it by hand in the Orca view to confirm the machine for a local ssh.` }
  }
  // Typed into a shell: only the exact form sshArgs builds from validated addresses.
  if (!ssh || !isSafeSshCommand(ssh)) return { route: 'none', why: `${host.name} has no Orca workspace and no valid address to ssh to.` }
  return { route: 'ssh', ssh }
}

/** What exactly an offer runs, to bind a click to the card: the workspace, or the ssh command. */
export function routeDestination(route: HostRoute): string {
  if (route.route === 'workspace') return `workspace ${route.workspace.environment ?? 'local'} ${route.workspace.worktreeId}`
  return route.route === 'ssh' ? `ssh ${route.ssh}` : ''
}

/** The ssh command of the place an Orca host runs on, as its card shows it. */
export function placeSsh(snap: EstateSnapshot | undefined, host: OrcaHost): string | undefined {
  if (!snap || !host.runsOn) return undefined
  if (host.runsOn.kind === 'node') {
    const node = snap.hosts.find((h) => h.key === host.runsOn!.key)
    return node ? hostSsh(node) : undefined
  }
  const guest = snap.guests.find((g) => g.key === host.runsOn!.key)
  return guest ? guestSsh(guest, snap.hosts.find((h) => h.remote === guest.remote && h.node === guest.node)) : undefined
}

/** The plan for an offer, exactly as shown: its workspace, or its ssh command. */
export function offerPlan(offer: TerminalOffer, view: OrcaView, title?: string): TerminalPlan {
  const host = offer.host
  if (!host || offer.route === 'none') return { error: offer.title }
  // A tab title only: no control characters, short.
  const label = (title ?? host.name).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80) || 'Proxmox'
  const ws = offer.workspace
  if (offer.route === 'workspace' && ws?.worktreeId) {
    return {
      how: 'workspace',
      environment: ws.environment,
      where: ws.environment ? `the ${ws.name} workspace of ${ws.serverName ?? 'that server'} in Orca's sidebar` : `the ${ws.name} workspace in Orca's sidebar`,
      // `--flag=value`: Orca would read a separate value starting with `--` as another flag.
      args: ['terminal', 'create', ...(ws.environment ? [`--environment=${ws.environment}`] : []), `--worktree=${worktreeSelector(ws.worktreeId)}`, `--title=${label}`, '--focus']
    }
  }
  const ssh = offer.ssh
  // Checked again where it is typed into a shell.
  if (offer.route !== 'ssh' || host.match !== 'manual' || !ssh || !isSafeSshCommand(ssh)) return { error: `${host.name} has no Orca workspace and no valid address to ssh to.` }
  // A local workspace by id: `active` means the one holding the caller's folder, which the
  // worker's folder is not once the plugin is installed.
  const local = pick(view.workspaces.filter((w) => w.hostKey === 'local'))
  return {
    how: 'ssh',
    where: local ? `the ${local.name} workspace in Orca's sidebar, a tab named ${label}` : `your active workspace, a tab named ${label}`,
    args: ['terminal', 'create', `--worktree=${local?.worktreeId ? worktreeSelector(local.worktreeId) : 'active'}`, `--title=${label}`, `--command=${ssh}`, '--focus']
  }
}

/** The plan for one Orca host where it is placed (tests, and anything not bound to a card). */
export function terminalPlan(hostKey: string, view: OrcaView | undefined, snap: EstateSnapshot | undefined, title?: string): TerminalPlan {
  const host = view?.hosts.find((h) => h.key === hostKey)
  if (!host || !view) return { error: 'This Orca host is not known (any more).' }
  const route = hostRoute(view, host, placeSsh(snap, host))
  if (route.route === 'none') return { error: route.why }
  return offerPlan({ host, title: '', destination: routeDestination(route), ...route } as TerminalOffer, view, title)
}
