// Runs a generated script on an Orca host, through Orca: a terminal in one of that host's
// workspaces (so the shell runs there over Orca's own connection, as Orca's user there), its
// output read with `orca terminal read`, and the terminal closed again whatever happens. The
// plugin never learns the host's address or credentials.
//
// The terminal is a normal Orca terminal: what it shows is kept like any other terminal's output.
// So nothing secret may ever be in it: the script carries only public values, and its answers
// hold no secret but the token's, encrypted to a one-time key (keys.ts). What it shows is also
// only as trustworthy as the host: answers are collected strictly (script.ts AnswerReader), and a
// run whose end was not seen complete is reported as of unknown outcome.
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import type { OrcaHost, OrcaWorkspace } from '../model'
import type { CliRunner } from '../orca/inventory'
import { pick, worktreeSelector } from '../orca/terminal'
import { AnswerReader, type ScriptAnswer } from './script'

/** Where a script for one Orca host runs: the workspace to open the terminal in. */
export type HostShell = { hostKey: string; environment?: string; worktree: string; where: string }

/** The shell for `host`, or why there is none. */
export function hostShell(host: OrcaHost, workspaces: readonly OrcaWorkspace[]): HostShell | { error: string } {
  if (host.kind === 'local') return { error: 'This machine is not a server Orca connects to.' }
  if (host.kind === 'ssh' && host.connected === false) return { error: `Orca is not connected to ${host.name}; connect it in Orca first.` }
  const keys = new Set([host.key, ...(host.paired ? [host.paired.key] : [])])
  const mine = workspaces.filter((w) => keys.has(w.hostKey))
  // A workspace of the SSH target itself first: its shell came in over SSH (SSH_CONNECTION), the
  // context a tunnel's checks need; a paired server's own workspaces have none.
  const ws = pick(mine.filter((w) => !w.environment)) ?? pick(mine)
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
export function commandLine(script: string, asRoot = true): string {
  const b64 = gzipSync(Buffer.from(script, 'utf8'), { level: 9 }).toString('base64')
  if (!asRoot) return ` sh -c 's=$(printf %s ${b64} | base64 -d | gunzip) && exec sh -c "$s"'`
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
  /** True once the run should end early (the worker is stopping); the terminal is still closed. */
  aborted?: () => boolean
}

const env = (shell: HostShell) => (shell.environment ? [`--environment=${shell.environment}`] : [])

/**
 * Runs `script` in a new terminal of `shell` and answers what it said, once it said `end` (or
 * what it said until the timeout). The terminal is closed in every case, its whole tab.
 */
export type RunResult = ScriptAnswer & {
  timedOut?: boolean
  /** The terminal could not be read to the end. */
  unread?: boolean
  /** The terminal could not be closed: it may still be open in Orca. */
  closeError?: string
  /** Where that terminal is, to close it later. */
  openTerminal?: OpenTerminal
  /** The run was ended early (the worker is stopping). */
  aborted?: boolean
}

/** A terminal a run opened: its handle, or (when Orca did not say) the unique title tag to find it by. */
export type OpenTerminal = { environment?: string; worktree: string; handle?: string; tag: string }

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

/** The terminals Orca lists in a workspace whose title carries `tag`, by handle. */
async function findTerminals(deps: RunDeps, t: OpenTerminal): Promise<string[]> {
  const listed = (await deps.run(['terminal', 'list', ...(t.environment ? [`--environment=${t.environment}`] : []), `--worktree=${t.worktree}`], 20000)) as {
    terminals?: { handle?: unknown; title?: unknown }[]
  } | null
  return (Array.isArray(listed?.terminals) ? listed!.terminals : [])
    .filter((x) => typeof x?.handle === 'string' && typeof x.title === 'string' && x.title.includes(t.tag))
    .map((x) => x.handle as string)
}

/**
 * Closes a terminal a run opened: by its handle, or found by its unique title when Orca did not
 * give one (a create whose answer was lost). Tried three times; answers why it could not, or null.
 * The one way any run's terminal is closed, also for a later retry.
 */
export async function closeTerminal(deps: RunDeps, t: OpenTerminal): Promise<string | null> {
  let last = ''
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const handles = t.handle ? [t.handle] : await findTerminals(deps, t)
      for (const handle of handles) await deps.run(['terminal', 'close', ...(t.environment ? [`--environment=${t.environment}`] : []), `--terminal=${handle}`, '--tab'], 20000)
      return null
    } catch (error) {
      last = error instanceof Error ? error.message : String(error)
      if (attempt < 3) await deps.sleep(500)
    }
  }
  deps.log(`Could not close a terminal the plugin opened (${t.tag}): ${last}`)
  return last || 'it could not be closed'
}

export async function runScript(deps: RunDeps, shell: HostShell, script: string, runId: string, title: string, timeoutMs: number, asRoot = true): Promise<RunResult> {
  // The run id in the title makes the terminal findable even if Orca's answer to the create is lost.
  const tag = `#${runId.slice(0, 8)}`
  const opened: OpenTerminal = { worktree: shell.worktree, tag, ...(shell.environment ? { environment: shell.environment } : {}) }
  let result: RunResult | undefined
  try {
    const created = (await deps.run(['terminal', 'create', ...env(shell), `--worktree=${shell.worktree}`, `--title=${`${title.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 50)} ${tag}`}`, `--command=${commandLine(script, asRoot)}`], 30000)) as {
      terminal?: { handle?: unknown }
    } | null
    if (typeof created?.terminal?.handle === 'string' && created.terminal.handle) opened.handle = created.terminal.handle
    else throw new Error('Orca did not say which terminal it opened on that host.')
    const until = deps.now() + timeoutMs
    const reader = new AnswerReader(runId)
    let answer: ScriptAnswer = { pairs: [] }
    let failed = 0
    for (;;) {
      await deps.sleep(700)
      if (deps.aborted?.()) return (result = { ...answer, aborted: true })
      let read: TerminalRead | null
      try {
        read = (await deps.run(['terminal', 'read', ...env(shell), `--terminal=${opened.handle}`, '--limit=2000'], 20000)) as TerminalRead | null
        failed = 0
      } catch (error) {
        // What was read so far is kept (it says what the script created); a few misses are retried.
        deps.log(`Could not read the setup terminal on ${shell.hostKey}: ${error instanceof Error ? error.message : String(error)}`)
        if ((failed += 1) >= 3 || deps.now() > until) return (result = { ...answer, timedOut: true, unread: true })
        continue
      }
      reader.add(logicalLines(read))
      answer = reader.answer(sha256)
      if (answer.end || answer.invalid) return (result = answer)
      if (read?.terminal?.status === 'exited' || deps.now() > until) return (result = { ...answer, timedOut: true })
    }
  } finally {
    // Every way out, an error included, closes the terminal (found by its title when Orca gave
    // no handle); if it cannot be closed, the answer says so and where it is.
    const closeError = await closeTerminal(deps, opened)
    if (closeError && result) {
      result.closeError = closeError
      result.openTerminal = opened
    } else if (closeError) {
      deps.log(`A terminal the plugin opened on ${shell.hostKey} may still be open (${tag}).`)
    }
  }
}
