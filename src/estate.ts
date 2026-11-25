// Builds an EstateSnapshot from a source: inventory every refresh, PBS snapshot lists and (for
// Orca awareness) node networks and guest configs on their own slower cadence, since they are the
// expensive part; concurrent callers share one refresh.
//
// Everything is scoped to one saved configuration (connectionScope): a refresh still running for
// a configuration that was replaced is aborted, and whatever it returns is never cached.
import { connectionScope, type ConnectionConfig, type EstateSnapshot, type PluginSettings, type Task } from './model'
import { attachBackups } from './proxmox/backups'
import type { BackupScan, EstateSource, MetricsScan, NetworkScan } from './proxmox/source'

type BackupCache = { scope: string; fetchedAt: number; scan?: BackupScan; error?: string }
type NetworkCache = { scope: string; fetchedAt: number; scan?: NetworkScan }
type MetricsCache = { scope: string; fetchedAt: number; scan?: MetricsScan; tasks?: Task[] }
type UpdatesCache = { scope: string; fetchedAt: number; hosts: Record<string, number> }

/** RRD history has a point a minute: reading it more often adds nothing. */
const METRICS_EVERY_MS = 60 * 1000

/** A refresh of a configuration that was replaced meanwhile. */
export class StaleRefreshError extends Error {
  constructor() {
    super('The connection changed during the refresh.')
  }
}

export class EstateService {
  private backups: BackupCache | undefined
  private network: NetworkCache | undefined
  private metrics: MetricsCache | undefined
  private updates: UpdatesCache | undefined
  private inflight: { scope: string; promise: Promise<EstateSnapshot> } | undefined
  private last: EstateSnapshot | undefined
  /** Bumped by reset(): a build started under an older generation keeps nothing. */
  private generation = 0
  private abort = new AbortController()

  constructor(private readonly now: () => number = Date.now) {}

  /** The newest snapshot built, for showing beside an error. */
  get lastGood(): EstateSnapshot | undefined {
    return this.last
  }

  /** The cached snapshot when younger than `maxAgeMs`, else a fresh one. */
  async get(
    source: EstateSource,
    connection: ConnectionConfig,
    settings: PluginSettings,
    options: { force?: boolean; maxAgeMs: number }
  ): Promise<EstateSnapshot> {
    const scope = connectionScope(connection)
    const last = this.last
    if (!options.force && last && last.connectionId === scope && this.now() - last.fetchedAt < options.maxAgeMs) {
      return last
    }
    if (this.inflight && this.inflight.scope === scope) return this.inflight.promise
    const promise = this.build(source, connection, settings, options.force ?? false, this.generation, this.abort.signal)
    this.inflight = { scope, promise }
    try {
      return await promise
    } finally {
      if (this.inflight?.promise === promise) this.inflight = undefined
    }
  }

  /** Forget everything and abort the refresh in flight, e.g. after the connection changed. */
  reset(): void {
    this.generation += 1
    this.abort.abort(new StaleRefreshError())
    this.abort = new AbortController()
    this.backups = undefined
    this.network = undefined
    this.metrics = undefined
    this.updates = undefined
    this.last = undefined
    this.inflight = undefined
  }

  private async build(
    source: EstateSource,
    connection: ConnectionConfig,
    settings: PluginSettings,
    force: boolean,
    generation: number,
    signal: AbortSignal
  ): Promise<EstateSnapshot> {
    const scope = connectionScope(connection)
    /** Throws once the configuration was replaced, so nothing of an old one is kept. */
    const live = () => {
      if (generation !== this.generation) throw new StaleRefreshError()
    }
    const inventory = await source.fetchInventory({ maxAgeSeconds: settings.refreshSeconds, signal })
    live()
    const warnings = [...inventory.warnings]

    const cached = this.backups?.scope === scope ? this.backups : undefined
    const due = force || !cached || this.now() - cached.fetchedAt >= settings.backupRefreshMinutes * 60 * 1000
    let backups: BackupCache = cached ?? { scope, fetchedAt: this.now() }
    if (due) {
      try {
        const scan = await source.fetchBackups(inventory, signal)
        live()
        backups = { scope, fetchedAt: this.now(), scan }
      } catch (error) {
        live()
        // Keep the previous scan on a failure: an old answer beats none.
        backups = { scope, fetchedAt: this.now(), scan: cached?.scan, error: error instanceof Error ? error.message : String(error) }
      }
      this.backups = backups
    }
    if (backups.scan) warnings.push(...backups.scan.warnings)

    const met = this.metrics?.scope === scope ? this.metrics : undefined
    if (force || !met || this.now() - met.fetchedAt >= METRICS_EVERY_MS) {
      try {
        const [scan, tasks] = await Promise.all([
          source.fetchMetrics(inventory, signal),
          source.fetchTasks(signal).catch((error: unknown) => {
            warnings.push(`Tasks could not be read: ${error instanceof Error ? error.message : String(error)}`)
            return met?.tasks
          })
        ])
        live()
        this.metrics = { scope, fetchedAt: this.now(), scan, tasks }
      } catch (error) {
        live()
        warnings.push(`History could not be read: ${error instanceof Error ? error.message : String(error)}`)
        this.metrics = { scope, fetchedAt: this.now(), scan: met?.scan, tasks: met?.tasks }
      }
    }
    const history = this.metrics?.scan
    if (history) {
      warnings.push(...history.warnings)
      for (const host of inventory.hosts) if (history.hosts[host.key]) host.metrics = history.hosts[host.key]
      for (const guest of inventory.guests) if (history.guests[guest.key]) guest.metrics = history.guests[guest.key]
      for (const store of inventory.datastores) if (history.datastores[store.key]) store.usageHistory = history.datastores[store.key]
    }

    const upd = this.updates?.scope === scope ? this.updates : undefined
    if (due || !upd) {
      try {
        const result = await source.fetchUpdates(inventory, signal)
        live()
        warnings.push(...result.warnings)
        this.updates = { scope, fetchedAt: this.now(), hosts: result.hosts }
      } catch (error) {
        live()
        warnings.push(`Updates could not be read: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    for (const host of inventory.hosts) {
      const count = this.updates?.hosts[host.key]
      if (count !== undefined) host.pendingUpdates = count
    }

    if (settings.orcaAwareness) {
      const net = this.network?.scope === scope ? this.network : undefined
      const netDue = force || !net || this.now() - net.fetchedAt >= settings.backupRefreshMinutes * 60 * 1000
      if (netDue) {
        try {
          const scan = await source.fetchNetwork(inventory, signal)
          live()
          this.network = { scope, fetchedAt: this.now(), scan }
        } catch (error) {
          live()
          warnings.push(`Addresses could not be read: ${error instanceof Error ? error.message : String(error)}`)
          this.network = { scope, fetchedAt: this.now(), scan: net?.scan }
        }
      }
      const scan = this.network?.scan
      if (scan) {
        warnings.push(...scan.warnings)
        for (const host of inventory.hosts) {
          const found = scan.nodes[host.key]
          if (found) host.addresses = [...new Set([...(host.addresses ?? []), ...found])]
          if (scan.nodeNotes?.[host.key]) host.notes = scan.nodeNotes[host.key]
        }
        for (const guest of inventory.guests) {
          const found = scan.guests[guest.key]
          if (!found) continue
          if (found.addresses.length > 0) guest.addresses = found.addresses
          if (found.hostname) guest.hostname = found.hostname
          if (found.notes) guest.notes = found.notes
        }
      }
    }
    live()

    const now = this.now()
    const available = backups.scan?.available ?? false
    // Some datastore or namespace was not read: a guest without a backup found may have one there.
    const complete = backups.scan?.complete ?? false
    const offlineRemotes = inventory.remotes.filter((r) => !r.online).map((r) => r.id)
    const { guests, missing, orphans } = attachBackups(inventory.guests, backups.scan?.records ?? [], {
      now,
      staleHours: settings.backupStaleHours,
      available,
      complete,
      offlineRemotes
    })
    const pbsRemotes = inventory.remotes.filter((r) => r.type === 'pbs')
    const snapshot: EstateSnapshot = {
      connectionId: scope,
      sourceKind: source.kind,
      fetchedAt: now,
      remotes: inventory.remotes,
      hosts: inventory.hosts,
      guests,
      datastores: inventory.datastores,
      backups: {
        fetchedAt: backups.scan ? backups.fetchedAt : undefined,
        error:
          backups.error ??
          (pbsRemotes.length === 0
            ? 'No Proxmox Backup Server remote is visible, so backups cannot be checked.'
            : available
              ? undefined
              : 'No PBS datastore could be read.'),
        staleHours: settings.backupStaleHours,
        missing: available ? missing : 0,
        orphans: available ? orphans : []
      },
      warnings,
      tasks: this.metrics?.tasks ?? []
    }
    if (available && !complete) {
      snapshot.backups.incomplete = `Not every PBS datastore or namespace could be read${backups.scan?.gaps?.length ? ` (${backups.scan.gaps.slice(0, 3).join('; ')}${backups.scan.gaps.length > 3 ? '; …' : ''})` : ''}, so a guest without a backup found there is shown as unknown, not as never backed up.`
    }
    this.last = snapshot
    return snapshot
  }
}
