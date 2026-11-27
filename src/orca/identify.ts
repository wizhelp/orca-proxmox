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
import { hostShell, runScript, type RunDeps } from '../setup/runner'
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
  private running = false
  private retryAt = new Map<string, number>()

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

  /** The hosts with what is known of paired servers without an identity from Orca itself. */
  async apply(hosts: readonly OrcaHost[]): Promise<OrcaHost[]> {
    await this.load()
    return hosts.map((h) => {
      if (h.kind !== 'environment' || h.identity || !h.runtimeId) return h
      const known = this.known.get(h.key)
      return known && known.runtimeId === h.runtimeId ? { ...h, identity: { names: known.names, addresses: known.addresses, from: 'server' as const } } : h
    })
  }

  /**
   * Asks, in the background, the first paired server that is still not placed and that nothing
   * identifies yet (one at a time); the next read of the Orca view uses the answer.
   */
  ask(placed: readonly OrcaHost[], workspaces: readonly OrcaWorkspace[]): void {
    if (this.running) return
    const now = this.deps().now()
    const next = placed.find(
      (h) => h.kind === 'environment' && !h.viaSsh && !h.runsOn && h.match !== 'manual' && !h.identity && h.runtimeId && (this.retryAt.get(h.key) ?? 0) <= now
    )
    if (!next) return
    const shell = hostShell(next, workspaces)
    if ('error' in shell) {
      this.retryAt.set(next.key, now + RETRY_MS)
      return
    }
    this.running = true
    const deps = this.deps()
    const runId = randomBytes(8).toString('hex')
    void runScript(deps, shell, identifyScript(runId), runId, 'Proxmox: identify this server', TIMEOUT_MS, false)
      .then(async (answer) => {
        const identity = identityOf(answer, next.runtimeId!, deps.now())
        if (!identity) {
          this.retryAt.set(next.key, deps.now() + RETRY_MS)
          deps.log(`Orca server ${next.key}: no identity (${answer.invalid ?? (answer.timedOut ? 'timed out' : 'no answer')}); asked again in an hour`)
          return
        }
        this.known.set(next.key, identity)
        await deps.storage.set(KEY, JSON.parse(JSON.stringify(Object.fromEntries(this.known))))
        deps.log(`Orca server ${next.key}: identified (${identity.names.length} names, ${identity.addresses.length} addresses)`)
      })
      .catch((error: unknown) => {
        this.retryAt.set(next.key, deps.now() + RETRY_MS)
        deps.log(`Orca server ${next.key}: could not be identified: ${error instanceof Error ? error.message : String(error)}`)
      })
      .finally(() => {
        this.running = false
      })
  }
}
