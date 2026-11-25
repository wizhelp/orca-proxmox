// Keeps the Orca inventory fresh enough for the panel (it changes as agents work) without running
// the CLI on every panel poll, and places it on an estate snapshot.
import type { EstateSnapshot, OrcaView } from '../model'
import { readOrcaInventory, type CliRunner, type OrcaInventory } from './inventory'
import { placeOrcaHosts, type OrcaLinks } from './match'

const MAX_AGE_MS = 20000

export class OrcaService {
  private cached: { at: number; inventory?: OrcaInventory; error?: string } | undefined
  private inflight: Promise<void> | undefined

  constructor(
    private readonly run: () => CliRunner,
    private readonly now: () => number = Date.now
  ) {}

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
    const view: OrcaView = {
      fetchedAt: cached.at,
      hosts: placeOrcaHosts(inventory.hosts, snapshot, links),
      workspaces: inventory.workspaces,
      bots: inventory.bots,
      warnings: inventory.warnings
    }
    if (cached.error) view.error = cached.error
    return view
  }
}
