// How to open a terminal on the machine an Orca host runs on. Pure: the worker runs the plan with
// the orca CLI. Through Orca itself when the host has a workspace (so the shell runs there with
// Orca's own connection); else a local terminal running ssh to the machine's address.
import type { EstateSnapshot, OrcaView, OrcaWorkspace } from '../model'
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

export function terminalPlan(hostKey: string, view: OrcaView | undefined, snap: EstateSnapshot | undefined, title?: string): TerminalPlan {
  const host = view?.hosts.find((h) => h.key === hostKey)
  if (!host || !view) return { error: 'This Orca host is not known (any more).' }
  // A tab title only: no control characters, short.
  const label = (title ?? host.name).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80) || 'Proxmox'
  const ws = pick(view.workspaces.filter((w) => w.hostKey === host.key))
  if (ws?.worktreeId) {
    return {
      how: 'workspace',
      environment: ws.environment,
      where: ws.environment ? `the ${ws.name} workspace of ${ws.serverName ?? 'that server'} in Orca's sidebar` : `the ${ws.name} workspace in Orca's sidebar`,
      // `--flag=value`: Orca would read a separate value starting with `--` as another flag.
      args: ['terminal', 'create', ...(ws.environment ? [`--environment=${ws.environment}`] : []), `--worktree=${worktreeSelector(ws.worktreeId)}`, `--title=${label}`, '--focus']
    }
  }
  // A place known only from what a server reported (or its endpoint) never becomes a root SSH
  // destination: only a placement by hand, by Orca's own records or by a configured name does.
  if (host.match === 'identified') {
    return { error: `${host.name} is placed from what it reported about itself, which is not enough to open a root SSH session to that machine. Open a terminal in one of its Orca workspaces, or place it by hand in the Orca view to confirm.` }
  }
  let ssh: string | undefined
  if (snap && host.runsOn?.kind === 'node') {
    const node = snap.hosts.find((h) => h.key === host.runsOn!.key)
    ssh = node ? hostSsh(node) : undefined
  } else if (snap && host.runsOn?.kind === 'guest') {
    const guest = snap.guests.find((g) => g.key === host.runsOn!.key)
    ssh = guest ? guestSsh(guest, snap.hosts.find((h) => h.remote === guest.remote && h.node === guest.node)) : undefined
  }
  // Typed into a shell: only the exact form sshArgs builds from validated addresses.
  if (!ssh || !isSafeSshCommand(ssh)) return { error: `${host.name} has no Orca workspace and no valid address to ssh to.` }
  // A local workspace by id: `active` means the one holding the caller's folder, which the
  // worker's folder is not once the plugin is installed.
  const local = pick(view.workspaces.filter((w) => w.hostKey === 'local'))
  return {
    how: 'ssh',
    where: local ? `the ${local.name} workspace in Orca's sidebar, a tab named ${label}` : `your active workspace, a tab named ${label}`,
    args: ['terminal', 'create', `--worktree=${local?.worktreeId ? worktreeSelector(local.worktreeId) : 'active'}`, `--title=${label}`, `--command=${ssh}`, '--focus']
  }
}
