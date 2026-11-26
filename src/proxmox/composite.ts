// Several connections as one estate: PDM and PVE or PBS servers reached directly, each with its
// own client, token and pin. Each part reads its own remotes; the composite merges what they
// report and hands each later step (history, backups, tasks…) only the part's own remotes. A
// part that fails becomes an unreachable remote with a warning; only when every part fails does
// the refresh fail as a whole (with the first part's error, as a single connection would).
import type { ConnectionConfig, Guest, SourceKind, Task } from '../model'
import type { AccessCheck, BackupScan, EstateSource, Inventory, MetricsScan, NetworkScan } from './source'
import { ApiError } from './client'
import { message, unreachableHost } from './pdm'

export type Part = { connection: ConnectionConfig; source: EstateSource }
/** A connection that could not even be set up (no secret, say), with why. */
export type FailedPart = { connection: ConnectionConfig; reason: string }

/** The label of a connection in messages and as an unreachable remote's id. */
export function connectionLabel(c: ConnectionConfig): string {
  if (c.name?.trim()) return c.name.trim()
  try {
    return new URL(c.baseUrl).hostname
  } catch {
    return c.id
  }
}

/** Keys of everything in an inventory moved from remote `from` to remote `to`. */
function rekey(inventory: Inventory, from: string, to: string): void {
  const key = (k: string) => (k.startsWith(`${from}/`) ? `${to}/${k.slice(from.length + 1)}` : k)
  for (const r of inventory.remotes) if (r.id === from) r.id = to
  for (const h of inventory.hosts) if (h.remote === from) Object.assign(h, { remote: to, key: key(h.key), ...(h.node === from ? { node: to } : {}) })
  for (const g of inventory.guests) if (g.remote === from) Object.assign(g, { remote: to, key: key(g.key) })
  for (const d of inventory.datastores) if (d.remote === from) Object.assign(d, { remote: to, key: key(d.key) })
}

export class CompositeSource implements EstateSource {
  readonly kind: SourceKind
  /** Remote id -> the part that reports it, from the last inventory. */
  private owner = new Map<string, number>()

  constructor(
    private readonly parts: Part[],
    private readonly failed: FailedPart[] = []
  ) {
    this.kind = parts.some((p) => p.source.kind === 'pdm') ? 'pdm' : (parts[0]?.source.kind ?? 'pdm')
  }

  checkAccess(): Promise<AccessCheck> {
    return Promise.reject(new ApiError({ kind: 'invalid-config', message: 'Test each connection on its own.' }))
  }

  async fetchInventory(options: { maxAgeSeconds: number; signal?: AbortSignal }): Promise<Inventory> {
    const answers = await Promise.allSettled(this.parts.map((p) => p.source.fetchInventory(options)))
    const fatal = answers.find((a): a is PromiseRejectedResult => a.status === 'rejected')
    if (answers.every((a) => a.status === 'rejected') && this.failed.length === 0 && fatal) throw fatal.reason
    const merged: Inventory = { remotes: [], hosts: [], guests: [], datastores: [], warnings: [] }
    this.owner = new Map()
    const taken = new Set<string>()
    answers.forEach((answer, i) => {
      const part = this.parts[i]
      if (answer.status === 'rejected') {
        this.addUnreachable(merged, part.connection, message(answer.reason), taken)
        return
      }
      const inventory = answer.value
      for (const remote of [...inventory.remotes]) {
        let id = remote.id
        // Two parts naming a remote alike: a direct one gives way (PDM's ids are its paths).
        if (taken.has(id)) {
          let n = 2
          while (taken.has(`${remote.id}-${n}`)) n += 1
          id = `${remote.id}-${n}`
          rekey(inventory, remote.id, id)
          const source = part.source as { remoteId?: string }
          if ('remoteId' in source) source.remoteId = id
        }
        taken.add(id)
        this.owner.set(id, i)
      }
      merged.remotes.push(...inventory.remotes)
      merged.hosts.push(...inventory.hosts)
      merged.guests.push(...inventory.guests)
      merged.datastores.push(...inventory.datastores)
      merged.warnings.push(...inventory.warnings)
    })
    for (const f of this.failed) this.addUnreachable(merged, f.connection, f.reason, taken)
    return merged
  }

  private addUnreachable(merged: Inventory, connection: ConnectionConfig, reason: string, taken: Set<string>): void {
    let id = connectionLabel(connection)
    while (taken.has(id)) id = `${id}-x`
    taken.add(id)
    const type = connection.kind === 'pbs' ? 'pbs' : 'pve'
    merged.remotes.push({ id, type, online: false, error: reason })
    merged.hosts.push(unreachableHost(id, type, reason))
    merged.warnings.push(`The connection ${connectionLabel(connection)} could not be read: ${reason}`)
  }

  /** The part's own share of an inventory. */
  private slice(inventory: Inventory, index: number): Inventory {
    const mine = (remote: string) => this.owner.get(remote) === index
    return {
      remotes: inventory.remotes.filter((r) => mine(r.id)),
      hosts: inventory.hosts.filter((h) => mine(h.remote)),
      guests: inventory.guests.filter((g) => mine(g.remote)),
      datastores: inventory.datastores.filter((d) => mine(d.remote)),
      warnings: []
    }
  }

  /** Runs `work` on each part that reported something; parts that fail add a warning. */
  private async each<T>(inventory: Inventory, work: (part: Part, own: Inventory) => Promise<T>): Promise<{ results: T[]; warnings: string[] }> {
    const used = this.parts.map((part, i) => ({ part, own: this.slice(inventory, i) })).filter((x) => x.own.remotes.length > 0)
    const answers = await Promise.allSettled(used.map(({ part, own }) => work(part, own)))
    const results: T[] = []
    const warnings: string[] = []
    answers.forEach((a, i) => {
      if (a.status === 'fulfilled') results.push(a.value)
      else {
        if (a.reason instanceof ApiError && a.reason.info.kind === 'auth' && used.length === 1) throw a.reason
        warnings.push(`${connectionLabel(used[i].part.connection)}: ${message(a.reason)}`)
      }
    })
    return { results, warnings }
  }

  async fetchBackups(inventory: Inventory, signal?: AbortSignal): Promise<BackupScan> {
    // Only PDM and PBS parts hold backups; a PVE part's empty scan says nothing about them.
    const { results, warnings } = await this.each(inventory, async (part, own) => ({ kind: part.source.kind, scan: await part.source.fetchBackups(own, signal) }))
    const holders = results.filter((r) => r.kind !== 'pve')
    const scans = holders.map((r) => r.scan)
    const gaps = scans.flatMap((s) => s.gaps)
    const available = scans.some((s) => s.available)
    return {
      records: scans.flatMap((s) => s.records),
      available,
      complete: available && scans.every((s) => s.complete) && warnings.length === 0,
      gaps: warnings.length ? [...gaps, ...warnings] : gaps,
      warnings: [...scans.flatMap((s) => s.warnings), ...warnings]
    }
  }

  async fetchNetwork(inventory: Inventory, signal?: AbortSignal): Promise<NetworkScan> {
    const { results, warnings } = await this.each(inventory, (part, own) => part.source.fetchNetwork(own, signal))
    return {
      nodes: Object.assign({}, ...results.map((r) => r.nodes)),
      guests: Object.assign({}, ...results.map((r) => r.guests)),
      nodeNotes: Object.assign({}, ...results.map((r) => r.nodeNotes)),
      warnings: [...results.flatMap((r) => r.warnings), ...warnings]
    }
  }

  async fetchMetrics(inventory: Inventory, signal?: AbortSignal): Promise<MetricsScan> {
    const { results, warnings } = await this.each(inventory, (part, own) => part.source.fetchMetrics(own, signal))
    return {
      hosts: Object.assign({}, ...results.map((r) => r.hosts)),
      guests: Object.assign({}, ...results.map((r) => r.guests)),
      datastores: Object.assign({}, ...results.map((r) => r.datastores)),
      warnings: [...results.flatMap((r) => r.warnings), ...warnings]
    }
  }

  async fetchTasks(signal?: AbortSignal): Promise<Task[]> {
    const answers = await Promise.allSettled(this.parts.filter((_, i) => [...this.owner.values()].includes(i)).map((p) => p.source.fetchTasks(signal)))
    return answers.flatMap((a) => (a.status === 'fulfilled' ? a.value : [])).sort((a, b) => b.start - a.start)
  }

  async fetchUpdates(inventory: Inventory, signal?: AbortSignal): Promise<{ hosts: Record<string, number>; warnings: string[] }> {
    const { results, warnings } = await this.each(inventory, (part, own) => part.source.fetchUpdates(own, signal))
    return { hosts: Object.assign({}, ...results.map((r) => r.hosts)), warnings: [...results.flatMap((r) => r.warnings), ...warnings] }
  }

  readGuestFs(guest: Guest, signal?: AbortSignal): Promise<unknown> {
    const part = this.parts[this.owner.get(guest.remote) ?? -1]
    if (!part?.source.readGuestFs) return Promise.reject(new ApiError({ kind: 'http', status: 501, message: 'No guest agent call for this remote' }))
    return part.source.readGuestFs(guest, signal)
  }
}
