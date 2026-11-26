// Runs a generated script on an Orca host, through Orca: a terminal in one of that host's
// workspaces (so the shell runs there over Orca's own connection, as Orca's user there), its
// output read with `orca terminal read`, and the terminal closed again whatever happens. The
// plugin never learns the host's address or credentials.
//
// The terminal is a normal Orca terminal: what it shows is kept like any other terminal's output.
// So nothing secret may ever be in it: the script carries only public values, and its answers
// hold no secret but the token's, encrypted to a one-time key (keys.ts).
import { gzipSync } from 'node:zlib'
import type { OrcaHost, OrcaWorkspace } from '../model'
import type { CliRunner } from '../orca/inventory'
import { pick, worktreeSelector } from '../orca/terminal'
import { parseAnswer, type ScriptAnswer } from './script'

/** Where a script for one Orca host runs: the workspace to open the terminal in. */
export type HostShell = { hostKey: string; environment?: string; worktree: string; where: string }

/** The shell for `host`, or why there is none. */
export function hostShell(host: OrcaHost, workspaces: readonly OrcaWorkspace[]): HostShell | { error: string } {
  if (host.kind === 'local') return { error: 'This machine is not a server Orca connects to.' }
  if (host.kind === 'ssh' && host.connected === false) return { error: `Orca is not connected to ${host.name}; connect it in Orca first.` }
  const keys = new Set([host.key, ...(host.paired ? [host.paired.key] : [])])
  const ws = pick(workspaces.filter((w) => keys.has(w.hostKey)))
  if (!ws?.worktreeId) return { error: `${host.name} has no Orca workspace to open a terminal in; open a folder on it in Orca first.` }
  return {
    hostKey: host.key,
    worktree: worktreeSelector(ws.worktreeId),
    where: ws.environment ? `the ${ws.name} workspace of ${ws.serverName ?? host.name}` : `the ${ws.name} workspace on ${host.name}`,
    ...(ws.environment ? { environment: ws.environment } : {})
  }
}

/**
 * The one line typed into the shell: the script, compressed, decoded and run by sh, as root or
 * through `sudo -n` (never a password prompt). Only base64 is typed, so the line itself can never
 * look like one of the script's answers. A leading space keeps it out of most shells' history.
 */
export function commandLine(script: string): string {
  const b64 = gzipSync(Buffer.from(script, 'utf8'), { level: 9 }).toString('base64')
  return ` sh -c 's=$(printf %s ${b64} | base64 -d | gunzip) && if [ "$(id -u)" = 0 ]; then exec sh -c "$s"; else exec sudo -n sh -c "$s"; fi'`
}

type TerminalRead = { terminal?: { tail?: unknown; tailRows?: unknown; status?: string } }

/** The terminal's rows as lines again: a row Orca marks `wrapped` continues the one before. */
export function logicalLines(answer: TerminalRead | null | undefined): string[] {
  const tail = Array.isArray(answer?.terminal?.tail) ? (answer!.terminal!.tail as unknown[]).map(String) : []
  const rows = Array.isArray(answer?.terminal?.tailRows) ? (answer!.terminal!.tailRows as { wrapped?: boolean }[]) : []
  const out: string[] = []
  tail.forEach((line, i) => {
    if (i > 0 && rows[i]?.wrapped === true && out.length) out[out.length - 1] += line
    else out.push(line)
  })
  return out
}

export type RunDeps = {
  run: CliRunner
  sleep: (ms: number) => Promise<void>
  now: () => number
  log: (text: string) => void
}

const env = (shell: HostShell) => (shell.environment ? [`--environment=${shell.environment}`] : [])

/**
 * Runs `script` in a new terminal of `shell` and answers what it said, once it said `end` (or
 * what it said until the timeout). The terminal is closed in every case, its whole tab.
 */
export async function runScript(deps: RunDeps, shell: HostShell, script: string, runId: string, title: string, timeoutMs: number): Promise<ScriptAnswer & { timedOut?: boolean; unread?: boolean }> {
  const created = (await deps.run(['terminal', 'create', ...env(shell), `--worktree=${shell.worktree}`, `--title=${title.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 60)}`, `--command=${commandLine(script)}`], 30000)) as {
    terminal?: { handle?: unknown }
  } | null
  const handle = typeof created?.terminal?.handle === 'string' ? created.terminal.handle : ''
  if (!handle) throw new Error('Orca did not open a terminal on that host.')
  try {
    const until = deps.now() + timeoutMs
    let answer: ScriptAnswer = { pairs: [] }
    let failed = 0
    for (;;) {
      await deps.sleep(700)
      let read: TerminalRead | null
      try {
        read = (await deps.run(['terminal', 'read', ...env(shell), `--terminal=${handle}`, '--limit=2000'], 20000)) as TerminalRead | null
        failed = 0
      } catch (error) {
        // What was read so far is kept (it says what the script created); a few misses are retried.
        deps.log(`Could not read the setup terminal on ${shell.hostKey}: ${error instanceof Error ? error.message : String(error)}`)
        if ((failed += 1) >= 3 || deps.now() > until) return { ...answer, timedOut: true, unread: true }
        continue
      }
      answer = parseAnswer(logicalLines(read), runId)
      if (answer.end) return answer
      if (read?.terminal?.status === 'exited' || deps.now() > until) return { ...answer, timedOut: true }
    }
  } finally {
    // Closed even when reading failed: nothing of the run stays open in Orca.
    await deps.run(['terminal', 'close', ...env(shell), `--terminal=${handle}`, '--tab'], 20000).catch((error: unknown) => {
      deps.log(`Could not close the setup terminal on ${shell.hostKey}: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
}
