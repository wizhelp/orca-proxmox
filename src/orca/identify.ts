// Tells which machine a paired Orca server runs on when Orca does not say: no SSH target it was
// deployed over, and an endpoint on loopback (an SSH tunnel). Orca's CLI lists a paired server's
// label, ids and endpoint only, never its machine name or addresses.
//
// Once per paired server and runtime (a new runtime, after a reconnect or redeploy, is asked
// again), a read-only script prints the machine's host name, full name and addresses, and
// nothing else (setup/script.ts identifyScript), in a terminal of one of its workspaces, which is
// closed again; it runs as Orca's user there, never as root. The answer is kept in plugin storage
// and used like an SSH target's name and address to place the server on the estate. Only with
// "Show where Orca runs" on (the caller is the Orca view), one server at a time, and a server
// that gave no answer is asked again only after an hour.
import { randomBytes } from 'node:crypto'
import type { OrcaHost, OrcaWorkspace } from '../model'
import { safeIp, safeTarget } from '../features/targets'
import { closeTerminal, runScript, type HostShell, type OpenTerminal, type RunDeps } from '../setup/runner'
import { pick, worktreeSelector } from './terminal'
import { identifyScript, valueOf } from '../setup/script'

export type ServerIdentity = { runtimeId: string; at: number; names: string[]; addresses: string[] }

export type IdentifyDeps = RunDeps & {
  storage: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> }
}

const KEY = 'orca.identities'
const RETRY_MS = 60 * 60_000
const TIMEOUT_MS = 30_000
const NAME = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/

/** Addresses that name the machine: not loopback, not link-local. */
function useful(address: string): boolean {
  const a = address.toLowerCase()
  return !/^127\./.test(a) && a !== '::1' && !/^fe80:/.test(a) && !/^169\.254\./.test(a)
}

/** A stored identity exactly in its form, or null. */
function valid(raw: unknown): ServerIdentity | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.runtimeId !== 'string' || !r.runtimeId || r.runtimeId.length > 120 || typeof r.at !== 'number') return null
  if (!Array.isArray(r.names) || !Array.isArray(r.addresses) || r.names.length > 4 || r.addresses.length > 32) return null
  if (!r.names.every((n) => typeof n === 'string' && NAME.test(n)) || !r.addresses.every((a) => typeof a === 'string' && safeIp(a) === a)) return null
  return { runtimeId: r.runtimeId, at: r.at, names: r.names as string[], addresses: r.addresses as string[] }
}

/** The identity in a script's answer, or null when it gave none that can be used. */
export function identityOf(answer: { end?: string; pairs: [string, string][] }, runtimeId: string, at: number): ServerIdentity | null {
  if (answer.end !== 'ok') return null
  const names = [valueOf(answer as never, 'hostname'), valueOf(answer as never, 'fqdn')]
    .map((n) => safeTarget(n))
    .filter((n): n is string => !!n && NAME.test(n))
  const addresses = answer.pairs.filter(([k]) => k === 'addr').map(([, v]) => safeIp(v)).filter((a): a is string => !!a && useful(a))
  if (!names.length && !addresses.length) return null
  return { runtimeId, at, names: [...new Set(names)].slice(0, 4), addresses: [...new Set(addresses)].slice(0, 32) }
}

export class ServerIdentities {
  private known = new Map<string, ServerIdentity>()
  private loaded = false
  private stopped = false
  private inflight: Promise<void> | undefined
  /** By server and runtime: a new runtime is not held back by the old one's failure. */
  private retryAt = new Map<string, number>()
  /** Terminals a probe opened that could not be closed yet: retried before any new probe. */
  private unclosed: OpenTerminal[] = []

  constructor(private readonly deps: () => IdentifyDeps) {}

  private async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    const stored = await this.deps().storage.get(KEY).catch(() => null)
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
      for (const [k, v] of Object.entries(stored as Record<string, unknown>)) {
        const identity = valid(v)
        if (identity && /^env:/.test(k)) this.known.set(k, identity)
      }
    }
  }

  private save(): Promise<void> {
    return this.deps().storage.set(KEY, JSON.parse(JSON.stringify(Object.fromEntries(this.known))))
  }

  /**
   * The hosts with what is known of paired servers without an identity from Orca itself. What
   * is kept for a server Orca no longer lists is dropped.
   */
  async apply(hosts: readonly OrcaHost[]): Promise<OrcaHost[]> {
    await this.load()
    const servers = new Set(hosts.filter((h) => h.kind === 'environment').map((h) => h.key))
    const merged = new Set(hosts.flatMap((h) => (h.paired ? [h.paired.key] : [])))
    let pruned = false
    for (const key of [...this.known.keys()]) {
      if (!servers.has(key) && !merged.has(key)) {
        this.known.delete(key)
        pruned = true
      }
    }
    if (pruned) await this.save().catch(() => undefined)
    return hosts.map((h) => {
      if (h.kind !== 'environment' || h.identity || !h.runtimeId) return h
      const known = this.known.get(h.key)
      return known && known.runtimeId === h.runtimeId ? { ...h, identity: { names: known.names, addresses: known.addresses, from: 'server' as const } } : h
    })
  }

  /** What the Orca view should say about probes: terminals that could not be closed. */
  warnings(): string[] {
    return this.unclosed.map((t) => `A terminal the plugin opened to identify an Orca server (${t.tag}) could not be closed; close it in Orca.`)
  }

  /**
   * Asks, in the background, the first paired server that is still not placed and that nothing
   * identifies yet (one at a time); the next read of the Orca view uses the answer. Only in a
   * workspace the server runs itself (`hostId` local in its own listing): never one it reaches
   * over an SSH target of its own, which would describe another machine.
   */
  ask(placed: readonly OrcaHost[], workspaces: readonly OrcaWorkspace[]): void {
    if (this.inflight || this.stopped) return
    const deps = this.deps()
    const now = deps.now()
    const retryKey = (h: OrcaHost) => `${h.key}|${h.runtimeId}`
    const candidates = placed.filter(
      (h) => h.kind === 'environment' && !h.viaSsh && !h.runsOn && h.match !== 'manual' && !h.identity && h.runtimeId && (this.retryAt.get(retryKey(h)) ?? 0) <= now
    )
    if (!candidates.length && !this.unclosed.length) return
    const run = deps.aborted ? deps : { ...deps, aborted: () => this.stopped }
    this.inflight = (async () => {
      // Earlier terminals that could not be closed come first.
      const still: OpenTerminal[] = []
      for (const t of this.unclosed) if (await closeTerminal(run, t)) still.push(t)
      this.unclosed = still
      const next = candidates[0]
      if (!next || this.stopped) return
      const id = next.key.slice('env:'.length)
      const ws = pick(workspaces.filter((w) => w.environment === id && w.ownRuntime === true))
      if (!ws?.worktreeId) {
        this.retryAt.set(retryKey(next), now + RETRY_MS)
        deps.log(`Orca server ${next.key}: no workspace it runs itself, so it is not asked who it is`)
        return
      }
      const shell: HostShell = { hostKey: next.key, environment: id, worktree: worktreeSelector(ws.worktreeId), where: `the ${ws.name} workspace of ${next.name}` }
      const runId = randomBytes(8).toString('hex')
      try {
        const answer = await runScript(run, shell, identifyScript(runId), runId, 'Proxmox: identify this server', TIMEOUT_MS, false)
        if (answer.openTerminal) this.unclosed.push(answer.openTerminal)
        const identity = answer.aborted ? null : identityOf(answer, next.runtimeId!, deps.now())
        if (!identity) {
          this.retryAt.set(retryKey(next), deps.now() + RETRY_MS)
          if (!answer.aborted) deps.log(`Orca server ${next.key}: no identity (${answer.invalid ?? (answer.timedOut ? 'timed out' : 'no answer')}); asked again in an hour`)
          return
        }
        this.known.set(next.key, identity)
        await this.save()
        deps.log(`Orca server ${next.key}: identified (${identity.names.length} names, ${identity.addresses.length} addresses)`)
      } catch (error) {
        this.retryAt.set(retryKey(next), deps.now() + RETRY_MS)
        deps.log(`Orca server ${next.key}: could not be identified: ${error instanceof Error ? error.message : String(error)}`)
      }
    })().finally(() => {
      this.inflight = undefined
    })
  }

  /** No new probe from here on; a running one ends early and its terminal is closed (awaited). */
  stop(): Promise<void> {
    this.stopped = true
    return this.inflight ?? Promise.resolve()
  }
}
