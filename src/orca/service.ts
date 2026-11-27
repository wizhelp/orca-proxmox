// Keeps the Orca inventory fresh enough for the panel (it changes as agents work) without running
// the CLI on every panel poll, and places it on an estate snapshot.
import type { EstateSnapshot, OrcaHost, OrcaView } from '../model'
import { safeIp, safeTarget } from '../features/targets'
import { readOrcaInventory, type CliRunner, type OrcaInventory } from './inventory'
import type { ServerIdentities } from './identify'
import { placeOrcaHosts, type OrcaLinks } from './match'

const MAX_AGE_MS = 20000
const RESOLVE_MS = 10 * 60_000
/** More answers than this place nothing: they are not one machine, and all of them must agree. */
const MAX_ANSWERS = 16

export class OrcaService {
  private cached: { at: number; inventory?: OrcaInventory; error?: string } | undefined
  private inflight: Promise<void> | undefined

  constructor(
    private readonly run: () => CliRunner,
    private readonly now: () => number = Date.now,
    /** Paired servers Orca does not identify: asked themselves, once per runtime (identify.ts). */
    private readonly identities?: ServerIdentities,
    /** The IP addresses a DNS name resolves to here (SSH targets named by one). */
    private readonly resolve?: (name: string) => Promise<string[]>
  ) {}

  private resolvedAt = new Map<string, { at: number; addresses: string[] }>()

  /** SSH targets named by a DNS name get the addresses it resolves to (kept 10 minutes). */
  private async withResolved(hosts: readonly OrcaHost[]): Promise<OrcaHost[]> {
    if (!this.resolve) return [...hosts]
    return Promise.all(
      hosts.map(async (h) => {
        const name = h.name.trim().toLowerCase().replace(/\.$/, '')
        if (h.kind !== 'ssh' || !name.includes('.') || safeIp(name) || safeTarget(name) !== name) return h
        let entry = this.resolvedAt.get(name)
        if (!entry || this.now() - entry.at > RESOLVE_MS) {
          const addresses = await this.resolve!(name).catch(() => [] as string[])
          const usable = addresses.filter((a) => safeIp(a) === a)
          entry = { at: this.now(), addresses: usable.length <= MAX_ANSWERS ? usable : [] }
          this.resolvedAt.set(name, entry)
        }
        return entry.addresses.length ? { ...h, resolved: entry.addresses } : h
      })
    )
  }

  private async refresh(force: boolean): Promise<void> {
    if (!force && this.cached && this.now() - this.cached.at < MAX_AGE_MS) return
    this.inflight ??= (async () => {
      try {
        this.cached = { at: this.now(), inventory: await readOrcaInventory(this.run()) }
      } catch (error) {
        // Keep the last inventory: Orca's own hosts rarely vanish between two reads.
        this.cached = {
          at: this.now(),
          inventory: this.cached?.inventory,
          error: error instanceof Error ? error.message : String(error)
        }
      } finally {
        this.inflight = undefined
      }
    })()
    await this.inflight
  }

  /** The Orca view of `snapshot`'s estate, read again when older than 20 s or when forced. */
  async view(snapshot: EstateSnapshot, links: OrcaLinks, force = false): Promise<OrcaView> {
    await this.refresh(force)
    const cached = this.cached!
    const inventory = cached.inventory ?? { hosts: [], workspaces: [], bots: [], warnings: [] }
    const named = await this.withResolved(inventory.hosts)
    const hosts = this.identities ? await this.identities.apply(named) : named
    const placed = placeOrcaHosts(hosts, snapshot, links)
    this.identities?.ask(placed, inventory.workspaces)
    const view: OrcaView = {
      fetchedAt: cached.at,
      // DNS answers stay here: the panel needs where a host is placed and how, not the answers.
      hosts: placed.map(({ resolved: _answers, ...h }) => h),
      workspaces: inventory.workspaces,
      bots: inventory.bots,
      warnings: [...inventory.warnings, ...(this.identities?.warnings() ?? [])]
    }
    if (cached.error) view.error = cached.error
    return view
  }
}
