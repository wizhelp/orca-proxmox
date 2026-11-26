// Proxmox VE and Proxmox Backup Server reached directly, without PDM. Each connection is one
// remote: a PVE cluster (or a single node) or one PBS. Their answers are mapped into the same
// estate model as PDM's, so every view, alert and export works the same. All GET, read-only.
//
// PVE (token header `PVEAPIToken=user@realm!id=secret`, role PVEAuditor on /):
//   /version, /cluster/status, /cluster/resources        version, cluster name, nodes, guests, storages
//   /nodes/{node}/status                                  PVE version, root disk, uptime
//   /nodes/{node}/rrddata, /nodes/{node}/{type}/{vmid}/rrddata   the last hour
//   /cluster/tasks                                        recent tasks of the cluster
//   /nodes/{node}/apt/update                              pending updates (Sys.Audit)
//   /nodes/{node}/network, …/config, …/{type}/{vmid}/config      addresses and notes
//   /nodes/{node}/qemu/{vmid}/agent/get-fsinfo            disk use inside VMs (guest agent)
// PBS (token header `PBSAPIToken=user@realm!id:secret`, role Audit on /):
//   /version, /nodes/localhost/status, /status/datastore-usage, /admin/datastore
//   /admin/datastore/{store}/namespace, …/snapshots       backups
//   /nodes/localhost/rrd, /admin/datastore/{store}/rrd   history
//   /nodes/localhost/tasks, /nodes/localhost/apt/update, /nodes/localhost/network
import type { ConnectionConfig, Datastore, Guest, Host, Remote, Storage, Task } from '../model'
import { ApiError, mapLimit, type ProxmoxClient } from './client'
import {
  contentOf,
  formatVersion,
  guestNetwork,
  isObj,
  listOf,
  MAX_GUEST_CONFIGS,
  message,
  notesOf,
  num,
  PARALLEL,
  pveVersion,
  rrdMetrics,
  scanSnapshots,
  str,
  toGuest,
  toTask,
  updateCount,
  usageHistory,
  validResource,
  type GuestConfig,
  type PdmGuestResource,
  type PdmResource,
  type RrdPoint,
  type VersionInfo
} from './pdm'
import type { AccessCheck, BackupScan, EstateSource, Inventory, MetricsScan, NetworkScan } from './source'
import { safeIp, safeTarget } from '../features/targets'

const seg = encodeURIComponent
const HOUR = { timeframe: 'hour', cf: 'AVERAGE' }
const DAY = { timeframe: 'day', cf: 'AVERAGE' }

/** A PVE or PBS RRD point (cpu, mem or memused, maxmem or memtotal, netin, netout, used, total) in PDM's form. */
export function toRrdPoint(p: Record<string, unknown>): RrdPoint {
  const point: RrdPoint = { time: num(p.time) ?? 0 }
  const set = (key: keyof RrdPoint, ...values: unknown[]) => {
    const v = values.map(num).find((x) => x !== undefined)
    if (v !== undefined) (point as Record<string, number>)[key] = v
  }
  set('cpu-current', p.cpu)
  set('mem-used', p.mem, p.memused)
  set('mem-total', p.maxmem, p.memtotal)
  set('net-in', p.netin)
  set('net-out', p.netout)
  set('disk-used', p.used)
  set('disk-total', p.total)
  return point
}

const points = (raw: unknown): RrdPoint[] => (Array.isArray(raw) ? raw.filter(isObj).filter((p) => typeof p.time === 'number').map(toRrdPoint) : [])

/** The host part of a base URL, as a remote's fallback name. */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.replace(/^\[|\]$/g, '')
  } catch {
    return 'proxmox'
  }
}

/**
 * The remote's id: what the person called the connection, else its URL's host. Never what the
 * server answers, so the id (and every key, cache and placement under it) is known from the
 * configuration alone and stays the same whether or not the server could be read.
 */
function remoteName(connection: ConnectionConfig): string {
  return connection.name?.trim() || hostOf(connection.baseUrl)
}

const noBackups = (): BackupScan => ({ records: [], available: false, complete: false, gaps: [], warnings: [] })

/** One PVE cluster or node, reached directly. */
export class PveSource implements EstateSource {
  readonly kind = 'pve' as const

  constructor(
    private readonly client: ProxmoxClient,
    private readonly connection: ConnectionConfig
  ) {}

  async checkAccess(signal?: AbortSignal): Promise<AccessCheck> {
    const version = await this.client.get<unknown>('/version', {}, signal)
    const resources = listOf(await this.client.get<unknown>('/cluster/resources', { type: 'node' }, signal), '/cluster/resources')
    return { version: (isObj(version) ? formatVersion(version as VersionInfo) : undefined) ?? 'unknown', remotes: resources.filter((r) => isObj(r) && r.type === 'node').length, unit: 'nodes' }
  }

  async fetchInventory({ signal }: { maxAgeSeconds: number; signal?: AbortSignal }): Promise<Inventory> {
    const [status, raw] = await Promise.all([
      this.client.get<unknown>('/cluster/status', {}, signal).catch((error: unknown) => {
        if (error instanceof ApiError && (error.info.kind === 'auth' || error.info.kind === 'fingerprint-mismatch')) throw error
        return []
      }),
      this.client.get<unknown>('/cluster/resources', {}, signal)
    ])
    const warnings: string[] = []
    let skipped = 0
    const resources: PdmResource[] = []
    for (const item of listOf(raw, '/cluster/resources')) {
      const mapped = isObj(item) ? fromPveResource(item) : null
      const valid = mapped && validResource(mapped)
      if (valid && valid.type !== 'pve-network') resources.push(valid)
      else if (mapped !== undefined && !valid) skipped += 1
    }
    if (skipped) warnings.push(`${skipped} malformed entries in the cluster's resource list were skipped.`)
    const cluster = (Array.isArray(status) ? status : []).find((s) => isObj(s) && s.type === 'cluster')
    const nodes = resources.filter((r): r is Extract<PdmResource, { type: 'pve-node' }> => r.type === 'pve-node')
    const id = remoteName(this.connection)
    // The cluster's own name (or a standalone node's), for backups whose namespace or owner is named after it.
    const own = (isObj(cluster) && str(cluster.name)) || (nodes.length === 1 ? nodes[0].node : undefined)
    const remote: Remote = { id, type: 'pve', online: true, webUrl: this.client.baseUrl, direct: true, ...(own && own !== id ? { alias: own } : {}) }
    const address = safeTarget(hostOf(this.connection.baseUrl))
    const hosts: Host[] = nodes.map((n) => ({
      key: `${id}/${n.node}`,
      remote: id,
      remoteType: 'pve',
      node: n.node,
      online: n.status === 'online',
      status: str(n.status) ?? 'unknown',
      cpu: num(n.cpu),
      maxcpu: num(n.maxcpu),
      mem: num(n.mem),
      maxmem: num(n.maxmem),
      uptime: num(n.uptime),
      // A single node's address is the one Orca connects to.
      ...(nodes.length === 1 && address ? { addresses: [address] } : {})
    }))
    const guests: Guest[] = resources.filter((r): r is PdmGuestResource => r.type === 'pve-qemu' || r.type === 'pve-lxc').map((r) => toGuest(id, r))
    for (const r of resources) {
      if (r.type !== 'pve-storage') continue
      const host = hosts.find((h) => h.node === r.node)
      const storage: Storage = { name: r.storage, node: r.node, disk: num(r.disk) ?? 0, maxdisk: num(r.maxdisk) ?? 0, shared: r.shared === true, status: str(r.status) ?? 'unknown', ...contentOf((r as { content?: unknown }).content) }
      if (host) (host.storages ??= []).push(storage)
    }
    await mapLimit(hosts.filter((h) => h.online), PARALLEL, async (host) => {
      try {
        const answer = await this.client.get<unknown>(`/nodes/${seg(host.node)}/status`, {}, signal)
        const s = isObj(answer) ? answer : {}
        const rootfs = isObj(s.rootfs) ? s.rootfs : {}
        host.version = pveVersion(str(s.pveversion))
        host.disk = num(rootfs.used)
        host.maxdisk = num(rootfs.total)
        host.uptime = num(s.uptime) ?? host.uptime
      } catch (error) {
        if (error instanceof ApiError && (error.info.kind === 'auth' || error.info.kind === 'fingerprint-mismatch')) throw error
        host.detailError = message(error)
      }
    })
    return { remotes: [remote], hosts, guests, datastores: [], warnings }
  }

  fetchBackups(): Promise<BackupScan> {
    // A PVE alone lists no PBS snapshots: add the PBS as its own connection for backups.
    return Promise.resolve(noBackups())
  }

  async fetchMetrics(inventory: Inventory, signal?: AbortSignal): Promise<MetricsScan> {
    const scan: MetricsScan = { hosts: {}, guests: {}, datastores: {}, warnings: [] }
    const failures: string[] = []
    const read = async (what: string, path: string, use: (p: RrdPoint[]) => void) => {
      try {
        use(points(await this.client.get<unknown>(path, HOUR, signal)))
      } catch (error) {
        if (error instanceof ApiError && error.info.kind === 'auth') throw error
        failures.push(`${what}: ${message(error)}`)
      }
    }
    const jobs: (() => Promise<void>)[] = []
    for (const host of inventory.hosts.filter((h) => h.online)) jobs.push(() => read(host.key, `/nodes/${seg(host.node)}/rrddata`, (p) => (scan.hosts[host.key] = rrdMetrics(p))))
    const running = inventory.guests.filter((g) => g.status === 'running')
    if (running.length > MAX_GUEST_CONFIGS) scan.warnings.push(`History is read for the first ${MAX_GUEST_CONFIGS} of ${running.length} running guests; the others show no charts.`)
    for (const g of running.slice(0, MAX_GUEST_CONFIGS)) jobs.push(() => read(g.key, `/nodes/${seg(g.node)}/${g.type}/${g.vmid}/rrddata`, (p) => (scan.guests[g.key] = rrdMetrics(p))))
    await mapLimit(jobs, PARALLEL, (job) => job())
    if (failures.length) scan.warnings.push(`History of ${failures.length} items could not be read, e.g. ${failures[0]}`)
    return scan
  }

  async fetchTasks(signal?: AbortSignal): Promise<Task[]> {
    const id = remoteName(this.connection)
    const list = listOf(await this.client.get<unknown>('/cluster/tasks', {}, signal), '/cluster/tasks')
    return list
      .map((t) => (isObj(t) && typeof t.upid === 'string' ? toTask({ upid: `pve:${id}!${t.upid}`, node: str(t.node), starttime: t.starttime as number, endtime: num(t.endtime), status: str(t.status), user: str(t.user), worker_type: str(t.type), worker_id: str(t.id) ?? null }) : null))
      .filter((t): t is Task => t !== null)
      .sort((a, b) => b.start - a.start)
  }

  async fetchUpdates(inventory: Inventory, signal?: AbortSignal): Promise<{ hosts: Record<string, number>; warnings: string[] }> {
    const hosts: Record<string, number> = {}
    const failures: string[] = []
    await mapLimit(inventory.hosts.filter((h) => h.online), PARALLEL, async (host) => {
      try {
        const list = await this.client.get<unknown>(`/nodes/${seg(host.node)}/apt/update`, {}, signal)
        if (Array.isArray(list)) hosts[host.key] = list.length
        else if (isObj(list)) {
          const count = updateCount(list)
          if (count !== undefined) hosts[host.key] = count
        }
      } catch (error) {
        if (error instanceof ApiError && error.info.kind === 'auth') throw error
        failures.push(`${host.node}: ${message(error)}`)
      }
    })
    return { hosts, warnings: failures.length ? [`Updates of ${failures.length} nodes could not be read, e.g. ${failures[0]}`] : [] }
  }

  async fetchNetwork(inventory: Inventory, signal?: AbortSignal): Promise<NetworkScan> {
    const scan: NetworkScan = { nodes: {}, guests: {}, nodeNotes: {}, warnings: [] }
    await mapLimit(inventory.hosts.filter((h) => h.online), PARALLEL, async (host) => {
      try {
        const answer = await this.client.get<unknown>(`/nodes/${seg(host.node)}/network`, {}, signal)
        scan.nodes[host.key] = (Array.isArray(answer) ? answer : []).filter(isObj).map((i) => safeIp(i.address)).filter((a): a is string => !!a && !a.startsWith('127.'))
        const config = await this.client.get<unknown>(`/nodes/${seg(host.node)}/config`, {}, signal).catch(() => ({}))
        const notes = notesOf(isObj(config) ? config : {})
        if (notes) scan.nodeNotes[host.key] = notes
      } catch (error) {
        if (error instanceof ApiError && error.info.kind === 'auth') throw error
        scan.warnings.push(`Network of ${host.key}: ${message(error)}`)
      }
    })
    const guests = inventory.guests.slice(0, MAX_GUEST_CONFIGS)
    if (guests.length < inventory.guests.length) scan.warnings.push(`Only the first ${MAX_GUEST_CONFIGS} guest configs were read for addresses.`)
    const failures: string[] = []
    await mapLimit(guests, PARALLEL, async (g) => {
      try {
        const config = await this.client.get<unknown>(`/nodes/${seg(g.node)}/${g.type}/${g.vmid}/config`, {}, signal)
        scan.guests[g.key] = guestNetwork(isObj(config) ? (config as GuestConfig) : {})
      } catch (error) {
        if (error instanceof ApiError && error.info.kind === 'auth') throw error
        failures.push(`${g.key}: ${message(error)}`)
      }
    })
    if (failures.length) scan.warnings.push(`Configs of ${failures.length} guests could not be read for addresses, e.g. ${failures[0]}`)
    return scan
  }

  readGuestFs(guest: Guest, signal?: AbortSignal): Promise<unknown> {
    return this.client.get<unknown>(`/nodes/${seg(guest.node)}/qemu/${guest.vmid}/agent/get-fsinfo`, {}, signal)
  }
}

/** One `/cluster/resources` entry in PDM's resource form (PDM prefixes the types). */
function fromPveResource(r: Record<string, unknown>): Record<string, unknown> | undefined {
  switch (r.type) {
    case 'node':
      return { ...r, type: 'pve-node' }
    case 'qemu':
      return { ...r, type: 'pve-qemu' }
    case 'lxc':
      return { ...r, type: 'pve-lxc' }
    case 'storage':
      return { ...r, type: 'pve-storage', shared: r.shared === 1 || r.shared === true }
    default:
      return undefined // pools, SDN zones: not shown
  }
}

/** One Proxmox Backup Server, reached directly. */
export class PbsSource implements EstateSource {
  readonly kind = 'pbs' as const

  constructor(
    private readonly client: ProxmoxClient,
    private readonly connection: ConnectionConfig
  ) {}

  async checkAccess(signal?: AbortSignal): Promise<AccessCheck> {
    const version = await this.client.get<unknown>('/version', {}, signal)
    const stores = await this.stores(signal)
    return { version: (isObj(version) ? formatVersion(version as VersionInfo) : undefined) ?? 'unknown', remotes: stores.length, unit: 'datastores' }
  }

  /** Datastores with their use; the plain list when usage may not be read. */
  private async stores(signal?: AbortSignal): Promise<{ store: string; used: number; total: number }[]> {
    try {
      const usage = listOf(await this.client.get<unknown>('/status/datastore-usage', {}, signal), '/status/datastore-usage')
      return usage.filter(isObj).filter((u) => str(u.store)).map((u) => ({ store: u.store as string, used: num(u.used) ?? 0, total: num(u.total) ?? 0 }))
    } catch (error) {
      if (error instanceof ApiError && (error.info.kind === 'auth' || error.info.kind === 'fingerprint-mismatch')) throw error
      const list = listOf(await this.client.get<unknown>('/admin/datastore', {}, signal), '/admin/datastore')
      return list.filter(isObj).map((d) => str(d.store) ?? str(d.name)).filter((s): s is string => !!s).map((store) => ({ store, used: 0, total: 0 }))
    }
  }

  async fetchInventory({ signal }: { maxAgeSeconds: number; signal?: AbortSignal }): Promise<Inventory> {
    const id = remoteName(this.connection)
    const [version, status, stores] = await Promise.all([
      this.client.get<unknown>('/version', {}, signal).catch(() => ({})),
      this.client.get<unknown>('/nodes/localhost/status', {}, signal).catch((error: unknown) => {
        if (error instanceof ApiError && (error.info.kind === 'auth' || error.info.kind === 'fingerprint-mismatch')) throw error
        return { error: message(error) }
      }),
      this.stores(signal)
    ])
    const s = isObj(status) ? status : {}
    const memory = isObj(s.memory) ? s.memory : {}
    const root = isObj(s.root) ? s.root : {}
    const cpu = num(s.cpu)
    const address = safeTarget(hostOf(this.connection.baseUrl))
    const host: Host = {
      key: `${id}/${id}`,
      remote: id,
      remoteType: 'pbs',
      node: id,
      online: true,
      status: 'online',
      ...(cpu !== undefined ? { cpu } : {}),
      ...(isObj(s.cpuinfo) && num(s.cpuinfo.cpus) !== undefined ? { maxcpu: num(s.cpuinfo.cpus) } : {}),
      ...(num(memory.used) !== undefined ? { mem: num(memory.used), maxmem: num(memory.total) } : {}),
      ...(num(root.used) !== undefined ? { disk: num(root.used), maxdisk: num(root.total) } : {}),
      ...(num(s.uptime) !== undefined ? { uptime: num(s.uptime) } : {}),
      ...(isObj(version) && formatVersion(version as VersionInfo) ? { version: formatVersion(version as VersionInfo) } : {}),
      ...(address ? { addresses: [address] } : {}),
      ...(typeof s.error === 'string' ? { detailError: s.error } : {})
    }
    const datastores: Datastore[] = stores.map((d) => ({ key: `${id}/${d.store}`, remote: id, name: d.store, used: d.used, total: d.total, usage: d.total > 0 ? d.used / d.total : 0 }))
    const remote: Remote = { id, type: 'pbs', online: true, webUrl: this.client.baseUrl, direct: true }
    return { remotes: [remote], hosts: [host], guests: [], datastores, warnings: [] }
  }

  fetchBackups(inventory: Inventory, signal?: AbortSignal): Promise<BackupScan> {
    return scanSnapshots(this.client, inventory.datastores, (store) => {
      const base = `/admin/datastore/${seg(store.name)}`
      return { namespaces: `${base}/namespace`, snapshots: `${base}/snapshots` }
    }, [], signal)
  }

  async fetchMetrics(inventory: Inventory, signal?: AbortSignal): Promise<MetricsScan> {
    const scan: MetricsScan = { hosts: {}, guests: {}, datastores: {}, warnings: [] }
    const failures: string[] = []
    const host = inventory.hosts[0]
    const jobs: (() => Promise<void>)[] = []
    if (host) {
      jobs.push(async () => {
        try {
          scan.hosts[host.key] = rrdMetrics(points(await this.client.get<unknown>('/nodes/localhost/rrd', HOUR, signal)))
        } catch (error) {
          if (error instanceof ApiError && error.info.kind === 'auth') throw error
          failures.push(`${host.key}: ${message(error)}`)
        }
      })
    }
    for (const store of inventory.datastores) {
      jobs.push(async () => {
        try {
          scan.datastores[store.key] = usageHistory(points(await this.client.get<unknown>(`/admin/datastore/${seg(store.name)}/rrd`, DAY, signal)))
        } catch (error) {
          if (error instanceof ApiError && error.info.kind === 'auth') throw error
          failures.push(`${store.key}: ${message(error)}`)
        }
      })
    }
    await mapLimit(jobs, PARALLEL, (job) => job())
    if (failures.length) scan.warnings.push(`History of ${failures.length} items could not be read, e.g. ${failures[0]}`)
    return scan
  }

  async fetchTasks(signal?: AbortSignal): Promise<Task[]> {
    const id = remoteName(this.connection)
    const list = listOf(await this.client.get<unknown>('/nodes/localhost/tasks', { limit: 50 }, signal), '/nodes/localhost/tasks')
    return list
      .map((t) => (isObj(t) && typeof t.upid === 'string' ? toTask({ upid: `pbs:${id}!${t.upid}`, node: 'localhost', starttime: t.starttime as number, endtime: num(t.endtime), status: str(t.status), user: str(t.user), worker_type: str(t.worker_type), worker_id: str(t.worker_id) ?? null }) : null))
      .filter((t): t is Task => t !== null)
      .sort((a, b) => b.start - a.start)
  }

  async fetchUpdates(inventory: Inventory, signal?: AbortSignal): Promise<{ hosts: Record<string, number>; warnings: string[] }> {
    const host = inventory.hosts[0]
    if (!host) return { hosts: {}, warnings: [] }
    try {
      const list = await this.client.get<unknown>('/nodes/localhost/apt/update', {}, signal)
      return { hosts: Array.isArray(list) ? { [host.key]: list.length } : {}, warnings: [] }
    } catch (error) {
      if (error instanceof ApiError && error.info.kind === 'auth') throw error
      return { hosts: {}, warnings: [`Updates of ${host.key} could not be read: ${message(error)}`] }
    }
  }

  async fetchNetwork(inventory: Inventory, signal?: AbortSignal): Promise<NetworkScan> {
    const scan: NetworkScan = { nodes: {}, guests: {}, nodeNotes: {}, warnings: [] }
    const host = inventory.hosts[0]
    if (!host) return scan
    try {
      const answer = await this.client.get<unknown>('/nodes/localhost/network', {}, signal)
      scan.nodes[host.key] = (Array.isArray(answer) ? answer : []).filter(isObj).map((i) => safeIp(i.address)).filter((a): a is string => !!a && !a.startsWith('127.'))
    } catch (error) {
      if (error instanceof ApiError && error.info.kind === 'auth') throw error
      scan.warnings.push(`Network of ${host.key}: ${message(error)}`)
    }
    return scan
  }
}
