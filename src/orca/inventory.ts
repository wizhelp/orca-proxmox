// Reads what Orca runs where: its hosts (this machine, SSH targets, paired servers), bots and
// workspaces with their agents.
//
// The plugin API (host API 1.10) has no call for Orca's hosts or bots: `workspace.list` gives a
// workspace's opaque `hostId` but not the host's name, address or the SSH target a paired server
// was deployed through, and nothing lists bots. Until it does, this reads the same data from the
// `orca` CLI, which the person's Orca ships, with `--json`. Only the fields below are kept; the
// CLI's output is never logged.
import type { OrcaAgent, OrcaBot, OrcaHost, OrcaWorkspace } from '../model'
import { mapLimit } from '../proxmox/client'

/** CLI processes at once for the per-server workspace lists. */
const CLI_PARALLEL = 3

/** Runs `orca <args> --json` and answers the parsed `result`, or throws with the CLI's error. */
export type CliRunner = (args: string[], timeoutMs: number) => Promise<unknown>

export type OrcaInventory = {
  hosts: OrcaHost[]
  workspaces: OrcaWorkspace[]
  bots: OrcaBot[]
  warnings: string[]
}

type CliHost = { kind?: string; name?: string; id?: string; machineName?: string; connected?: boolean }
type CliEnvironment = { id?: string; name?: string; orcadDeployment?: { sshTargetId?: string } }
type CliBot = { id?: string; name?: string; agent?: string; paused?: boolean; server?: { name?: string; on?: string } }
type CliWorktree = {
  worktreeId?: string
  hostId?: string
  repo?: string
  displayName?: string
  isArchived?: boolean
  bot?: string
  status?: string
  sidebarStatus?: string
  lastActivityAt?: number
  agents?: { agentType?: string; state?: string }[]
}

const TIMEOUT_MS = 30000

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** `ssh-123-abc` or `ssh:ssh-123-abc` -> `ssh:ssh-123-abc`. */
function sshKey(id: string): string {
  return `ssh:${id.replace(/^ssh:/, '')}`
}

function workspaceHostKey(hostId: string | undefined, runtimeHostKey: string): string {
  if (hostId && /^ssh[:-]/.test(hostId) && runtimeHostKey === 'local') return sshKey(hostId)
  // `local` is the runtime's own machine; a paired server's SSH targets are not ours to name.
  return runtimeHostKey
}

function toWorkspaces(worktrees: CliWorktree[], runtimeHostKey: string, server?: { id: string; name: string }): OrcaWorkspace[] {
  return worktrees
    .filter((w) => !w.isArchived && w.worktreeId)
    .map((w) => {
      const hostKey = workspaceHostKey(w.hostId, runtimeHostKey)
      const agents: OrcaAgent[] = (w.agents ?? []).map((a) => ({ agent: a.agentType ?? 'agent', state: a.state ?? 'unknown' }))
      const workspace: OrcaWorkspace = {
        key: `${hostKey}|${w.worktreeId}`,
        hostKey,
        name: w.displayName || w.repo || 'workspace',
        repo: w.repo ?? '',
        status: w.sidebarStatus ?? w.status ?? 'inactive',
        agents
      }
      if (w.bot) workspace.bot = w.bot
      if (w.worktreeId) workspace.worktreeId = w.worktreeId
      if (server) {
        workspace.environment = server.id
        workspace.serverName = server.name
      }
      if (typeof w.lastActivityAt === 'number') workspace.lastActivityAt = w.lastActivityAt
      return workspace
    })
}

/** Everything Orca knows about its hosts, bots and workspaces; partial failures become warnings. */
export async function readOrcaInventory(run: CliRunner): Promise<OrcaInventory> {
  const warnings: string[] = []
  const [hostAnswer, envAnswer, botAnswer, psAnswer] = await Promise.allSettled([
    run(['host', 'list'], TIMEOUT_MS),
    run(['environment', 'list'], TIMEOUT_MS),
    run(['bot', 'list'], TIMEOUT_MS),
    run(['worktree', 'ps'], TIMEOUT_MS)
  ])
  if (hostAnswer.status === 'rejected') throw new Error(`orca host list: ${message(hostAnswer.reason)}`)

  const environments = new Map<string, CliEnvironment>()
  if (envAnswer.status === 'fulfilled') {
    for (const e of ((envAnswer.value as { environments?: CliEnvironment[] }).environments ?? [])) if (e.id) environments.set(e.id, e)
  } else {
    warnings.push(`orca environment list: ${message(envAnswer.reason)}`)
  }

  const hosts: OrcaHost[] = []
  for (const h of ((hostAnswer.value as { hosts?: CliHost[] }).hosts ?? [])) {
    if (!h.id) continue
    if (h.kind === 'local') {
      hosts.push({ key: 'local', kind: 'local', name: h.machineName || h.name || 'this machine' })
    } else if (h.kind === 'ssh') {
      const host: OrcaHost = { key: sshKey(h.id), kind: 'ssh', name: h.name || h.id }
      if (typeof h.connected === 'boolean') host.connected = h.connected
      hosts.push(host)
    } else if (h.kind === 'environment') {
      const host: OrcaHost = { key: `env:${h.id}`, kind: 'environment', name: h.name || h.id }
      const via = environments.get(h.id)?.orcadDeployment?.sshTargetId
      if (via) host.viaSsh = sshKey(via)
      hosts.push(host)
    }
  }
  const envByName = new Map(hosts.filter((h) => h.kind === 'environment').map((h) => [h.name, h]))

  const bots: OrcaBot[] = []
  if (botAnswer.status === 'fulfilled') {
    for (const b of ((botAnswer.value as { bots?: CliBot[] }).bots ?? [])) {
      if (!b.id || !b.name) continue
      const server = b.server?.on ?? b.server?.name
      bots.push({
        id: b.id,
        name: b.name,
        agent: b.agent ?? 'agent',
        paused: b.paused === true,
        hostKey: server ? (envByName.get(server)?.key ?? `env:${server}`) : 'local'
      })
    }
  } else {
    warnings.push(`orca bot list: ${message(botAnswer.reason)}`)
  }

  const workspaces: OrcaWorkspace[] = []
  if (psAnswer.status === 'fulfilled') {
    workspaces.push(...toWorkspaces((psAnswer.value as { worktrees?: CliWorktree[] }).worktrees ?? [], 'local'))
  } else {
    warnings.push(`orca worktree ps: ${message(psAnswer.reason)}`)
  }
  // A few CLI processes at a time, not one per paired server at once.
  const remote = await mapLimit(
    hosts.filter((h) => h.kind === 'environment'),
    CLI_PARALLEL,
    async (env): Promise<PromiseSettledResult<OrcaWorkspace[]>> => {
      try {
        // By id with `=`: a name can change, and a value starting with `--` would read as a flag.
        const id = env.key.slice('env:'.length)
        const answer = (await run(['worktree', 'ps', `--environment=${id}`], TIMEOUT_MS)) as { worktrees?: CliWorktree[] }
        return { status: 'fulfilled', value: toWorkspaces(Array.isArray(answer?.worktrees) ? answer.worktrees : [], env.key, { id, name: env.name }) }
      } catch (reason) {
        return { status: 'rejected', reason }
      }
    }
  )
  remote.forEach((result, i) => {
    const env = hosts.filter((h) => h.kind === 'environment')[i]
    if (result.status === 'fulfilled') workspaces.push(...result.value)
    else warnings.push(`Workspaces on ${env.name}: ${message(result.reason)}`)
  })
  return mergePairedServers({ hosts, workspaces, bots, warnings })
}

/**
 * One Orca per machine. Orca keeps two records for a server it was deployed to over SSH: the SSH
 * target (named by the person, and renamed at will) and the paired server (named at pairing
 * time). Both are the same orcad, so they become one host: the SSH target, labelled with the
 * paired name, holding the server's workspaces and bots. An SSH target without a paired server,
 * or a paired server not deployed over a known SSH target, stays as it is.
 */
export function mergePairedServers(inventory: OrcaInventory): OrcaInventory {
  const byKey = new Map(inventory.hosts.map((h) => [h.key, h]))
  const mergedInto = new Map<string, string>()
  for (const env of inventory.hosts) {
    if (env.kind !== 'environment' || !env.viaSsh) continue
    const ssh = byKey.get(env.viaSsh)
    if (!ssh || ssh.kind !== 'ssh' || ssh.paired) continue
    ssh.paired = { key: env.key, name: env.name }
    mergedInto.set(env.key, ssh.key)
  }
  if (mergedInto.size === 0) return inventory
  const move = <T extends { hostKey: string }>(item: T): T =>
    mergedInto.has(item.hostKey) ? { ...item, hostKey: mergedInto.get(item.hostKey)! } : item
  return {
    hosts: inventory.hosts.filter((h) => !mergedInto.has(h.key)),
    workspaces: inventory.workspaces.map(move),
    bots: inventory.bots.map(move),
    warnings: inventory.warnings
  }
}
