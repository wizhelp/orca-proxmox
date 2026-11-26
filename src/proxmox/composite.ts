// Several connections as one estate: a PDM and PVE or PBS servers reached directly, each with its
// own client, token and pin. Each part reads its own remotes under the names its server uses
// ("native" names); the composite gives every remote an estate id that depends only on the
// configuration, never on which parts answered, and translates both ways: estate ids and keys for
// the views, caches and placements, native names for every request a part sends.
//
// - PDM's remotes keep PDM's ids (at most one PDM connection is configured).
// - A direct connection's remote is named after the connection (its name, else its URL's host),
//   with " (direct)" when a PDM is configured too, so it can never take a PDM remote's id: the
//   same cluster seen both ways shows twice, clearly labelled. Two direct connections of the same
//   name are told apart by "-2", "-3"… in the order of their connection ids.
//
// A part that fails becomes an unreachable remote under the same id, with a warning; only when
// every part fails does the refresh fail as a whole (with the first part's error).
import type { ConnectionConfig, Guest, Host, Datastore, Remote, SourceKind, Task } from '../model'
import type { AccessCheck, BackupScan, EstateSource, Inventory, MetricsScan, NetworkScan } from './source'
import { ApiError } from './client'
import { message, unreachableHost } from './pdm'

export type Part = { connection: ConnectionConfig; source: EstateSource }
/** A connection that could not even be set up (no secret, say), with why. */
export type FailedPart = { connection: ConnectionConfig; reason: string }

/** The label of a connection in messages: its name, else its URL's host. */
export function connectionLabel(c: ConnectionConfig): string {
  if (c.name?.trim()) return c.name.trim()
  try {
    return new URL(c.baseUrl).hostname.replace(/^\[|\]$/g, '')
  } catch {
    return c.id
  }
}

/** Connection id -> the estate id of a direct connection's remote, from the configuration alone. */
export function directRemoteIds(connections: readonly ConnectionConfig[]): Map<string, string> {
  const withPdm = connections.some((c) => c.kind === 'pdm')
  const ids = new Map<string, string>()
  const taken = new Set<string>()
  // An enrich-only connection adds no remote of its own.
  for (const c of [...connections].filter((x) => x.kind !== 'pdm' && !x.enrichOnly).sort((a, b) => a.id.localeCompare(b.id))) {
    const base = connectionLabel(c)
    let id = base
    for (let n = 2; taken.has(id.toLowerCase()); n += 1) id = `${base}-${n}`
    taken.add(id.toLowerCase())
    ids.set(c.id, withPdm ? `${id} (direct)` : id)
  }
  return ids
}

/** Native remote name <-> estate id for one part. PDM's map is empty: its ids are kept. */
type Names = { toEstate: Map<string, string> }

function rename(names: Names, remote: string): string {
  return names.toEstate.get(remote) ?? remote
}

function renameKey(names: Names, key: string): string {
  const slash = key.indexOf('/')
  if (slash < 0) return rename(names, key)
  return `${rename(names, key.slice(0, slash))}${key.slice(slash)}`
}

function renameRecord<T>(names: Names, record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).map(([k, v]) => [renameKey(names, k), v]))
}

export class CompositeSource implements EstateSource {
  readonly kind: SourceKind
  /** Estate remote id -> the part that reports it, from the last inventory. */
  private owner = new Map<string, number>()
  /** Per part, native names to estate ids. */
  private names: Names[]
  /** Estate keys -> the part's own (native) objects, to hand back to that part. */
  private native = { remotes: new Map<string, Remote>(), hosts: new Map<string, Host>(), guests: new Map<string, Guest>(), datastores: new Map<string, Datastore>() }
  /**
   * Enrich-only parts: an estate guest -> the part whose guest agent is read for it (and that
   * part's own guest); an estate node -> the part's own node, for pending updates.
   */
  private enrichGuests = new Map<string, { part: number; guest: Guest }>()
  private enrichHosts = new Map<string, { part: number; host: Host }>()
  private enrichNative = new Map<number, Inventory>()
  /** Connections that hold backups (PDM, PBS) and could not be read in the last inventory. */
  private downBackupSources: ConnectionConfig[] = []
  private readonly ids: Map<string, string>

  constructor(
    private readonly parts: Part[],
    private readonly failed: FailedPart[] = []
  ) {
    this.kind = parts.some((p) => p.source.kind === 'pdm') ? 'pdm' : (parts[0]?.source.kind ?? 'pdm')
    this.ids = directRemoteIds([...parts.map((p) => p.connection), ...failed.map((f) => f.connection)])
    this.names = parts.map(() => ({ toEstate: new Map() }))
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
    this.native = { remotes: new Map(), hosts: new Map(), guests: new Map(), datastores: new Map() }
    this.downBackupSources = this.failed.map((f) => f.connection).filter((c) => c.kind !== 'pve')
    this.enrichGuests = new Map()
    this.enrichHosts = new Map()
    this.enrichNative = new Map()
    const enrichers: number[] = []
    answers.forEach((answer, i) => {
      const part = this.parts[i]
      if (part.connection.enrichOnly) {
        // It only adds to what the others show: down, a warning; up, matched once all are merged.
        if (answer.status === 'rejected') merged.warnings.push(`${connectionLabel(part.connection)} (enrich only) could not be read: ${message(answer.reason)}; what it adds (VM disk use, storage types, updates) is missing.`)
        else {
          this.enrichNative.set(i, answer.value)
          enrichers.push(i)
        }
        return
      }
      if (answer.status === 'rejected') {
        this.addUnreachable(merged, part.connection, message(answer.reason))
        if (part.connection.kind !== 'pve') this.downBackupSources.push(part.connection)
        return
      }
      const inventory = answer.value
      const names: Names = { toEstate: new Map() }
      const estateId = this.ids.get(part.connection.id)
      // A direct connection reports one remote; it takes the configured id.
      if (estateId) for (const r of inventory.remotes) names.toEstate.set(r.id, estateId)
      this.names[i] = names
      for (const r of inventory.remotes) {
        const id = rename(names, r.id)
        if (this.owner.has(id)) {
          // Cannot happen with one PDM and configured ids; never let one part shadow another.
          merged.warnings.push(`${connectionLabel(part.connection)}: the remote ${id} is already shown by another connection and was left out.`)
          continue
        }
        this.owner.set(id, i)
        this.native.remotes.set(id, r)
        merged.remotes.push({ ...r, id, ...(r.alias ? {} : id !== r.id ? { alias: r.id } : {}) })
      }
      const mine = (remote: string) => this.owner.get(rename(names, remote)) === i
      for (const h of inventory.hosts.filter((x) => mine(x.remote))) {
        const key = renameKey(names, h.key)
        this.native.hosts.set(key, h)
        merged.hosts.push({ ...h, key, remote: rename(names, h.remote) })
      }
      for (const g of inventory.guests.filter((x) => mine(x.remote))) {
        const key = renameKey(names, g.key)
        this.native.guests.set(key, g)
        merged.guests.push({ ...g, key, remote: rename(names, g.remote) })
      }
      for (const d of inventory.datastores.filter((x) => mine(x.remote))) {
        const key = renameKey(names, d.key)
        this.native.datastores.set(key, d)
        merged.datastores.push({ ...d, key, remote: rename(names, d.remote) })
      }
      merged.warnings.push(...inventory.warnings)
    })
    for (const f of this.failed) {
      if (f.connection.enrichOnly) merged.warnings.push(`${connectionLabel(f.connection)} (enrich only) could not be used: ${f.reason}`)
      else this.addUnreachable(merged, f.connection, f.reason)
    }
    for (const i of enrichers) this.enrich(merged, i, this.enrichNative.get(i)!)
    return merged
  }

  /**
   * Matches an enrich-only part's nodes and guests to the estate's, by node name (or its mapping,
   * `node` or `remote/node`) and VMID; only a single match counts. Nothing of it is added to the
   * estate: its guests' agents answer for the matched guests, its storages' content types fill
   * the matched nodes' where missing, its pending updates the nodes' that have none.
   */
  private enrich(merged: Inventory, index: number, own: Inventory): void {
    const connection = this.parts[index].connection
    const label = connectionLabel(connection)
    const where = (node: string) => {
      const [a, b] = (connection.nodeMap?.[node] ?? node).split('/')
      return b === undefined ? { node: a } : { remote: a, node: b }
    }
    const fits = (x: { remote: string; node: string }, w: { remote?: string; node: string }) => x.node === w.node && (w.remote === undefined || x.remote === w.remote)
    let matched = 0
    let ambiguous = 0
    for (const g of own.guests) {
      const w = where(g.node)
      const found = merged.guests.filter((x) => x.vmid === g.vmid && x.type === g.type && fits(x, w))
      if (found.length === 1 && !this.enrichGuests.has(found[0].key)) {
        this.enrichGuests.set(found[0].key, { part: index, guest: g })
        matched += 1
      } else if (found.length > 1) ambiguous += 1
    }
    for (const h of own.hosts) {
      const w = where(h.node)
      const found = merged.hosts.filter((x) => x.remoteType === 'pve' && fits(x, w))
      if (found.length !== 1 || this.enrichHosts.has(found[0].key)) continue
      const target = found[0]
      this.enrichHosts.set(target.key, { part: index, host: h })
      if (target.storages && h.storages) {
        target.storages = target.storages.map((s) => {
          const theirs = h.storages!.find((o) => o.name === s.name)
          return s.content || !theirs?.content ? s : { ...s, content: theirs.content }
        })
      }
    }
    if (own.guests.length && !matched) merged.warnings.push(`${label} (enrich only) matched none of the estate's guests: its node names must be PDM's, or be mapped in Settings.`)
    if (ambiguous) merged.warnings.push(`${label} (enrich only): ${ambiguous} guest(s) matched more than one guest of the estate and were left alone; map their node as remote/node.`)
  }

  agentScope(guest: Guest): string {
    const e = this.enrichGuests.get(guest.key)
    return e ? `enrich:${e.part}` : guest.remote
  }

  /** The estate id a connection's remote has, or would have: for PDM its label (it has no single remote). */
  private idOf(connection: ConnectionConfig): string {
    return this.ids.get(connection.id) ?? `${connectionLabel(connection)} (PDM)`
  }

  private addUnreachable(merged: Inventory, connection: ConnectionConfig, reason: string): void {
    const id = this.idOf(connection)
    if (merged.remotes.some((r) => r.id === id)) return
    const type = connection.kind === 'pbs' ? 'pbs' : 'pve'
    merged.remotes.push({ id, type, online: false, error: reason, direct: true, ...(connection.kind !== 'pve' ? { backupSource: true } : {}) })
    merged.hosts.push(unreachableHost(id, type, reason))
    merged.warnings.push(`The connection ${connectionLabel(connection)} could not be read: ${reason}`)
  }

  /** The part's own share of an inventory, under its own (native) names. */
  private slice(inventory: Inventory, index: number): Inventory {
    const mine = (remote: string) => this.owner.get(remote) === index
    const back = <T>(map: Map<string, T>, key: string) => map.get(key)
    return {
      remotes: inventory.remotes.filter((r) => mine(r.id)).map((r) => back(this.native.remotes, r.id)).filter((x): x is Remote => !!x),
      hosts: inventory.hosts.filter((h) => mine(h.remote)).map((h) => back(this.native.hosts, h.key)).filter((x): x is Host => !!x),
      guests: inventory.guests.filter((g) => mine(g.remote)).map((g) => back(this.native.guests, g.key)).filter((x): x is Guest => !!x),
      datastores: inventory.datastores.filter((d) => mine(d.remote)).map((d) => back(this.native.datastores, d.key)).filter((x): x is Datastore => !!x),
      warnings: []
    }
  }

  /** Runs `work` on each part that reported something; parts that fail add a warning. */
  private async each<T>(inventory: Inventory, work: (part: Part, own: Inventory, names: Names) => Promise<T>): Promise<{ results: { part: Part; value: T }[]; warnings: string[]; failed: Part[] }> {
    const used = this.parts.map((part, i) => ({ part, own: this.slice(inventory, i), names: this.names[i] })).filter((x) => x.own.remotes.length > 0)
    const answers = await Promise.allSettled(used.map(({ part, own, names }) => work(part, own, names)))
    const results: { part: Part; value: T }[] = []
    const warnings: string[] = []
    const failed: Part[] = []
    answers.forEach((a, i) => {
      if (a.status === 'fulfilled') results.push({ part: used[i].part, value: a.value })
      else {
        if (a.reason instanceof ApiError && a.reason.info.kind === 'auth' && used.length === 1) throw a.reason
        warnings.push(`${connectionLabel(used[i].part.connection)}: ${message(a.reason)}`)
        failed.push(used[i].part)
      }
    })
    return { results, warnings, failed }
  }

  async fetchBackups(inventory: Inventory, signal?: AbortSignal): Promise<BackupScan> {
    const { results, warnings, failed } = await this.each(inventory, async (part, own, names) => {
      const scan = await part.source.fetchBackups(own, signal)
      return { ...scan, records: scan.records.map((r) => ({ ...r, remote: rename(names, r.remote) })), holdsPbs: own.remotes.some((r) => r.type === 'pbs') }
    })
    // Coverage comes from the sources that hold PBS: a part without any (a PVE, or a PDM without
    // PBS remotes) says nothing about backups. A PDM or PBS connection that could not be read may
    // hold the only backup of a guest, so with one down no "never backed up" is definite.
    const scans = results.map((r) => r.value).filter((s) => s.holdsPbs)
    const down = [...this.downBackupSources, ...failed.filter((p) => p.connection.kind !== 'pve').map((p) => p.connection)]
    const gaps = [...scans.flatMap((s) => s.gaps), ...down.map((c) => `${connectionLabel(c)} could not be read`)]
    const available = scans.some((s) => s.available)
    return {
      records: scans.flatMap((s) => s.records),
      available,
      complete: available && scans.every((s) => s.complete) && gaps.length === 0,
      gaps,
      warnings: [...scans.flatMap((s) => s.warnings), ...warnings]
    }
  }

  async fetchNetwork(inventory: Inventory, signal?: AbortSignal): Promise<NetworkScan> {
    const { results, warnings } = await this.each(inventory, async (part, own, names) => {
      const r = await part.source.fetchNetwork(own, signal)
      return { ...r, nodes: renameRecord(names, r.nodes), guests: renameRecord(names, r.guests), nodeNotes: renameRecord(names, r.nodeNotes) }
    })
    const values = results.map((r) => r.value)
    return {
      nodes: Object.assign({}, ...values.map((r) => r.nodes)),
      guests: Object.assign({}, ...values.map((r) => r.guests)),
      nodeNotes: Object.assign({}, ...values.map((r) => r.nodeNotes)),
      warnings: [...values.flatMap((r) => r.warnings), ...warnings]
    }
  }

  async fetchMetrics(inventory: Inventory, signal?: AbortSignal): Promise<MetricsScan> {
    const { results, warnings } = await this.each(inventory, async (part, own, names) => {
      const r = await part.source.fetchMetrics(own, signal)
      return { ...r, hosts: renameRecord(names, r.hosts), guests: renameRecord(names, r.guests), datastores: renameRecord(names, r.datastores) }
    })
    const values = results.map((r) => r.value)
    return {
      hosts: Object.assign({}, ...values.map((r) => r.hosts)),
      guests: Object.assign({}, ...values.map((r) => r.guests)),
      datastores: Object.assign({}, ...values.map((r) => r.datastores)),
      warnings: [...values.flatMap((r) => r.warnings), ...warnings]
    }
  }

  async fetchTasks(signal?: AbortSignal): Promise<Task[]> {
    const live = [...new Set(this.owner.values())]
    const answers = await Promise.allSettled(live.map((i) => this.parts[i].source.fetchTasks(signal).then((tasks) => tasks.map((t) => ({ ...t, remote: rename(this.names[i], t.remote) })))))
    return answers.flatMap((a) => (a.status === 'fulfilled' ? a.value : [])).sort((a, b) => b.start - a.start)
  }

  async fetchUpdates(inventory: Inventory, signal?: AbortSignal): Promise<{ hosts: Record<string, number>; warnings: string[] }> {
    const { results, warnings } = await this.each(inventory, async (part, own, names) => {
      const r = await part.source.fetchUpdates(own, signal)
      return { ...r, hosts: renameRecord(names, r.hosts) }
    })
    const values = results.map((r) => r.value)
    const hosts: Record<string, number> = Object.assign({}, ...values.map((r) => r.hosts))
    const more: string[] = []
    // Enrich-only parts: their nodes' counts for the matched nodes PDM gave none for.
    await Promise.all(
      [...this.enrichNative].map(async ([i, own]) => {
        try {
          const r = await this.parts[i].source.fetchUpdates({ ...own, guests: [] }, signal)
          for (const [key, e] of this.enrichHosts) if (e.part === i && hosts[key] === undefined && r.hosts[e.host.key] !== undefined) hosts[key] = r.hosts[e.host.key]
        } catch (error) {
          more.push(`${connectionLabel(this.parts[i].connection)} (enrich only): updates could not be read: ${message(error)}`)
        }
      })
    )
    return { hosts, warnings: [...values.flatMap((r) => r.warnings), ...warnings, ...more] }
  }

  readGuestFs(guest: Guest, signal?: AbortSignal): Promise<unknown> {
    // A guest an enrich-only connection matched: its agent is read there (PDM offers no such call).
    const enriched = this.enrichGuests.get(guest.key)
    if (enriched) {
      const source = this.parts[enriched.part].source
      if (source.readGuestFs) return source.readGuestFs(enriched.guest, signal)
    }
    const part = this.parts[this.owner.get(guest.remote) ?? -1]
    const own = this.native.guests.get(guest.key)
    if (!part?.source.readGuestFs || !own) return Promise.reject(new ApiError({ kind: 'http', status: 501, message: 'No guest agent call for this remote' }))
    return part.source.readGuestFs(own, signal)
  }
}
