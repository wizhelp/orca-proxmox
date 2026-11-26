// The Proxmox Datacenter Manager source. Endpoints (all GET, under /api2/json):
//   /version                                       PDM's own version (connection test)
//   /remotes/remote                                configured remotes and their type
//   /resources/list?max-age=N                      every remote's nodes, guests and datastores
//   /pve/remotes/{r}/nodes/{node}/status           PVE version, root disk, uptime
//   /pbs/remotes/{r}/status                        PBS root disk, uptime
//   /remotes/remote/{r}/version                    PBS version
//   /pbs/remotes/{r}/datastore/{ds}/namespaces     namespaces to scan
//   /pbs/remotes/{r}/datastore/{ds}/snapshots?ns=  snapshots (backup-type, backup-id, backup-time)
// All of them need only read privileges: the PDM `Auditor` role on `/resource` (or per remote).
import type { Datastore, Guest, Host, Metrics, Remote, RemoteType, Storage, Task } from '../model'
import { ApiError, mapLimit, type ProxmoxClient, type Query } from './client'
import type { BackupRecord } from './backups'
import { safeIp, safeTarget } from '../features/targets'
import type { AccessCheck, BackupScan, EstateSource, Inventory, MetricsScan, NetworkScan } from './source'

// ---- PDM wire types (kebab-case as serialized) ----

export type PdmRemote = { type: RemoteType; id: string; authid?: string; 'web-url'?: string; nodes?: string[] }
/** One interface of PVE's `/nodes/{node}/network`. */
export type PveInterface = { iface: string; address?: string; cidr?: string; active?: boolean }
/** A guest config, of which only these keys are read: never kept or logged as a whole. */
export type GuestConfig = Record<string, unknown>

type PdmGuestResource = {
  type: 'pve-qemu' | 'pve-lxc'
  id: string
  vmid: number
  name?: string
  node: string
  status: string
  cpu?: number
  maxcpu?: number
  mem?: number
  maxmem?: number
  disk?: number
  maxdisk?: number
  uptime?: number
  template?: boolean
  tags?: string[] | string
}

export type PdmResource =
  | {
      type: 'pve-node'
      id: string
      node: string
      status: string
      cpu?: number
      maxcpu?: number
      mem?: number
      maxmem?: number
      uptime?: number
    }
  | PdmGuestResource
  | { type: 'pbs-node'; id: string; name: string; cpu?: number; maxcpu?: number; mem?: number; maxmem?: number; uptime?: number }
  | { type: 'pbs-datastore'; id: string; name: string; disk?: number; maxdisk?: number; usage?: number; maintenance?: string }
  | { type: 'pve-storage'; id: string; storage: string; node: string; disk?: number; maxdisk?: number; shared?: boolean; status?: string }
  | { type: 'pve-network'; id: string }

export type PdmRemoteResources = { remote: string; error?: string; resources?: PdmResource[] }

type MemoryInfo = { total?: number; used?: number }
type DiskInfo = { total?: number; used?: number; avail?: number }
export type PveNodeStatus = { pveversion?: string; uptime?: number; memory?: MemoryInfo; rootfs?: DiskInfo }
export type PbsNodeStatus = { uptime?: number; memory?: MemoryInfo; root?: DiskInfo }
export type VersionInfo = { version?: string; release?: string; repoid?: string }
/** One item of PBS's snapshot list (also `comment`, `files`, `size`, `protected`, `verification`). */
export type PbsSnapshot = { 'backup-type': string; 'backup-id': string; 'backup-time': number; owner?: string }
export type PbsNamespace = { ns?: string }

/** Namespaces scanned per datastore at most; deeper estates are reported as a warning. */
const MAX_NAMESPACES = 64
const PARALLEL = 4
/** Guest configs read per network scan at most. */
const MAX_GUEST_CONFIGS = 300

const seg = encodeURIComponent

/**
 * A version as Proxmox numbers them (`9.2.32`, `4.2.14`, `8.3.2-1`), else undefined: a version
 * is shown and exported, so nothing else a server puts there gets through.
 */
export function safeVersion(value: unknown): string | undefined {
  return typeof value === 'string' && /^\d{1,4}(\.\d{1,4}){0,3}(-\d{1,4})?$/.test(value) ? value : undefined
}

/** `pve-manager/8.2.4/faa83925c9641325` -> `8.2.4`. */
export function pveVersion(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const match = /pve-manager\/([^/\s]+)/.exec(raw)
  return safeVersion(match ? match[1] : raw)
}

/**
 * `{ version: '3.2', release: '7' }` (PBS, PDM) -> `3.2.7`; `{ version: '8.2.4', release: '8.2' }`
 * (PVE) -> `8.2.4`.
 */
export function formatVersion(info: VersionInfo): string | undefined {
  if (typeof info.version !== 'string') return undefined
  if (/^\d+\.\d+$/.test(info.version) && typeof info.release === 'string' && /^\d+$/.test(info.release)) {
    return safeVersion(`${info.version}.${info.release}`)
  }
  return safeVersion(info.version)
}

function tagsOf(tags: unknown): string[] {
  if (Array.isArray(tags)) return tags.filter((t): t is string => typeof t === 'string' && t !== '')
  return typeof tags === 'string' ? tags.split(/[;,\s]+/).filter(Boolean) : []
}

// ---- shapes: PDM's answers are checked where they arrive; a malformed item is skipped ----

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

/** A storage's content types (`images,rootdir` or a list), when PDM reports them. */
function contentOf(value: unknown): { content?: string[] } {
  const list = typeof value === 'string' ? value.split(',') : Array.isArray(value) ? value : undefined
  const content = list?.filter((c): c is string => typeof c === 'string').map((c) => c.trim()).filter(Boolean)
  return content?.length ? { content } : {}
}

/** A list answer, or a protocol error naming the path: the core endpoints cannot do without. */
function listOf(value: unknown, path: string): unknown[] {
  if (Array.isArray(value)) return value
  throw new ApiError({ kind: 'protocol', message: `${path} did not answer a list`, hint: 'Is the base URL a Proxmox Datacenter Manager 1.x, and the token allowed to read it?' })
}

/** A resource of a known type with the fields this plugin needs, else null. */
export function validResource(r: unknown): PdmResource | null {
  if (!isObj(r) || typeof r.type !== 'string') return null
  switch (r.type) {
    case 'pve-node':
      return str(r.node) ? (r as PdmResource) : null
    case 'pve-qemu':
    case 'pve-lxc':
      return Number.isInteger(r.vmid) && (r.vmid as number) > 0 && str(r.node) ? (r as PdmResource) : null
    case 'pbs-node':
    case 'pbs-datastore':
      return str(r.name) ? (r as PdmResource) : null
    case 'pve-storage':
      return str(r.storage) && str(r.node) ? (r as PdmResource) : null
    default:
      return { type: 'pve-network', id: '' } // other kinds are ignored, not malformed
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class PdmSource implements EstateSource {
  readonly kind = 'pdm' as const

  constructor(private readonly client: ProxmoxClient) {}

  async checkAccess(signal?: AbortSignal): Promise<AccessCheck> {
    const version = await this.client.get<unknown>('/version', {}, signal)
    const remotes = listOf(await this.client.get<unknown>('/remotes/remote', {}, signal), '/remotes/remote')
    return {
      version: (isObj(version) ? formatVersion(version as VersionInfo) : undefined) ?? 'unknown',
      remotes: remotes.length
    }
  }

  async fetchInventory({ maxAgeSeconds, signal }: { maxAgeSeconds: number; signal?: AbortSignal }): Promise<Inventory> {
    const [rawRemotes, rawResources] = await Promise.all([
      this.client.get<unknown>('/remotes/remote', {}, signal),
      this.client.get<unknown>('/resources/list', { 'max-age': maxAgeSeconds }, signal)
    ])
    const warnings: string[] = []
    let skipped = 0
    const remoteList = listOf(rawRemotes, '/remotes/remote').filter((r): r is PdmRemote => {
      const ok = isObj(r) && !!str(r.id) && (r.type === 'pve' || r.type === 'pbs')
      if (!ok) skipped += 1
      return ok
    })
    const resourceList = listOf(rawResources, '/resources/list').filter((e): e is PdmRemoteResources => {
      const ok = isObj(e) && !!str(e.remote)
      if (!ok) skipped += 1
      return ok
    })
    const types = new Map(remoteList.map((r) => [r.id, r.type]))
    const remotes: Remote[] = []
    const hosts: Host[] = []
    const guests: Guest[] = []
    const datastores: Datastore[] = []
    const storages: { remote: string; storage: Storage }[] = []

    const seen = new Set<string>()
    for (const entry of resourceList) {
      seen.add(entry.remote)
      const resources = (Array.isArray(entry.resources) ? entry.resources : []).map((r) => {
        const valid = validResource(r)
        if (!valid) skipped += 1
        return valid
      }).filter((r): r is PdmResource => r !== null)
      const type = types.get(entry.remote) ?? guessType(resources)
      const config = remoteList.find((r) => r.id === entry.remote)
      const failure = entry.error === undefined || entry.error === null ? undefined : typeof entry.error === 'string' ? entry.error : 'PDM reported an error for this remote.'
      const remote: Remote = { id: entry.remote, type, online: !failure }
      if (failure) remote.error = failure
      if (config?.['web-url']) remote.webUrl = config['web-url']
      const address = typeof config?.nodes?.[0] === 'string' ? nodeAddress(config.nodes[0]) : undefined
      if (address) {
        remote.nodeAddress = address
        const port = nodePort(config!.nodes![0])
        if (port) remote.nodePort = port
      }
      remotes.push(remote)
      if (failure) {
        hosts.push(unreachableHost(entry.remote, type, failure))
        continue
      }
      for (const resource of resources) {
        switch (resource.type) {
          case 'pve-node':
            hosts.push({
              key: `${entry.remote}/${resource.node}`,
              remote: entry.remote,
              remoteType: 'pve',
              node: resource.node,
              online: resource.status === 'online',
              status: str(resource.status) ?? 'unknown',
              cpu: num(resource.cpu),
              maxcpu: num(resource.maxcpu),
              mem: num(resource.mem),
              maxmem: num(resource.maxmem),
              uptime: num(resource.uptime)
            })
            break
          case 'pbs-node':
            hosts.push({
              key: `${entry.remote}/${resource.name}`,
              remote: entry.remote,
              remoteType: 'pbs',
              // A PBS reports its node as `localhost`; the remote's name says more.
              node: resource.name === 'localhost' ? entry.remote : resource.name,
              online: (num(resource.uptime) ?? 0) > 0,
              status: (num(resource.uptime) ?? 0) > 0 ? 'online' : 'offline',
              cpu: num(resource.cpu),
              maxcpu: num(resource.maxcpu),
              mem: num(resource.mem),
              maxmem: num(resource.maxmem),
              uptime: num(resource.uptime)
            })
            break
          case 'pve-qemu':
          case 'pve-lxc':
            guests.push(toGuest(entry.remote, resource))
            break
          case 'pbs-datastore': {
            const total = num(resource.maxdisk) ?? 0
            const used = num(resource.disk) ?? 0
            datastores.push({
              key: `${entry.remote}/${resource.name}`,
              remote: entry.remote,
              name: resource.name,
              used,
              total,
              usage: num(resource.usage) ?? (total > 0 ? used / total : 0),
              maintenance: str(resource.maintenance)
            })
            break
          }
          case 'pve-storage':
            storages.push({
              remote: entry.remote,
              storage: {
                name: resource.storage,
                node: resource.node,
                disk: num(resource.disk) ?? 0,
                maxdisk: num(resource.maxdisk) ?? 0,
                shared: resource.shared === true,
                status: str(resource.status) ?? 'unknown',
                ...contentOf((resource as { content?: unknown }).content)
              }
            })
            break
          default:
            break
        }
      }
    }
    for (const { remote, storage } of storages) {
      const host = hosts.find((h) => h.remote === remote && h.node === storage.node)
      if (host) (host.storages ??= []).push(storage)
    }
    if (skipped > 0) warnings.push(`${skipped} malformed entries in PDM's remote and resource lists were skipped.`)
    // A remote PDM knows but /resources/list left out (e.g. no Resource.Audit on it).
    for (const remote of remoteList) {
      if (!seen.has(remote.id)) {
        warnings.push(`No resources visible for remote ${remote.id}; check the token's permissions on /resource/${remote.id}.`)
      }
    }

    // A single-node remote's PDM connection address is that node's.
    for (const remote of remoteList) {
      const mine = hosts.filter((h) => h.remote === remote.id && h.node)
      const addresses = (Array.isArray(remote.nodes) ? remote.nodes : []).map((n) => (typeof n === 'string' ? nodeAddress(n) : undefined)).filter((a): a is string => !!a)
      if (mine.length === 1 && addresses.length > 0) mine[0].addresses = addresses
    }
    await this.addHostDetails(hosts, remotes, warnings, signal)
    return { remotes, hosts, guests, datastores, warnings }
  }

  /** Version, root disk and a fresher uptime per host. A failure marks the row, never the refresh. */
  private async addHostDetails(hosts: Host[], remotes: Remote[], warnings: string[], signal?: AbortSignal) {
    const pbsVersions = new Map<string, string | undefined>()
    await mapLimit(
      remotes.filter((r) => r.online && r.type === 'pbs'),
      PARALLEL,
      async (remote) => {
        try {
          const version = await this.client.get<unknown>(`/remotes/remote/${seg(remote.id)}/version`, {}, signal)
          pbsVersions.set(remote.id, isObj(version) ? formatVersion(version as VersionInfo) : undefined)
        } catch (error) {
          warnings.push(`Version of ${remote.id}: ${message(error)}`)
        }
      }
    )
    await mapLimit(
      hosts.filter((h) => h.online),
      PARALLEL,
      async (host) => {
        try {
          if (host.remoteType === 'pve') {
            const raw = await this.client.get<unknown>(`/pve/remotes/${seg(host.remote)}/nodes/${seg(host.node)}/status`, {}, signal)
            const status = (isObj(raw) ? raw : {}) as PveNodeStatus
            const rootfs = isObj(status.rootfs) ? status.rootfs : {}
            host.version = pveVersion(str(status.pveversion))
            host.disk = num(rootfs.used)
            host.maxdisk = num(rootfs.total)
            host.uptime = num(status.uptime) ?? host.uptime
          } else {
            const raw = await this.client.get<unknown>(`/pbs/remotes/${seg(host.remote)}/status`, {}, signal)
            const status = (isObj(raw) ? raw : {}) as PbsNodeStatus
            const root = isObj(status.root) ? status.root : {}
            host.version = pbsVersions.get(host.remote)
            host.disk = num(root.used)
            host.maxdisk = num(root.total)
            host.uptime = num(status.uptime) ?? host.uptime
          }
        } catch (error) {
          if (error instanceof ApiError && (error.info.kind === 'auth' || error.info.kind === 'fingerprint-mismatch')) throw error
          host.detailError = message(error)
        }
      }
    )
  }

  async fetchMetrics(inventory: Inventory, signal?: AbortSignal): Promise<MetricsScan> {
    const scan: MetricsScan = { hosts: {}, guests: {}, datastores: {}, warnings: [] }
    const failures: string[] = []
    const hour = { timeframe: 'hour', cf: 'AVERAGE' }
    const read = async (what: string, path: string, query: Query, use: (points: RrdPoint[]) => void) => {
      try {
        const points = await this.client.get<unknown>(path, query, signal)
        use(Array.isArray(points) ? (points.filter((p) => isObj(p) && typeof p.time === 'number') as RrdPoint[]) : [])
      } catch (error) {
        if (error instanceof ApiError && error.info.kind === 'auth') throw error
        failures.push(`${what}: ${message(error)}`)
      }
    }
    const online = new Set(inventory.remotes.filter((r) => r.online).map((r) => r.id))
    const jobs: (() => Promise<void>)[] = []
    for (const host of inventory.hosts.filter((h) => h.online)) {
      const path =
        host.remoteType === 'pve'
          ? `/pve/remotes/${seg(host.remote)}/nodes/${seg(host.node)}/rrddata`
          : `/pbs/remotes/${seg(host.remote)}/rrddata`
      jobs.push(() => read(host.key, path, hour, (points) => (scan.hosts[host.key] = rrdMetrics(points))))
    }
    const running = inventory.guests.filter((g) => g.status === 'running' && online.has(g.remote))
    if (running.length > MAX_GUEST_CONFIGS) {
      scan.warnings.push(`History is read for the first ${MAX_GUEST_CONFIGS} of ${running.length} running guests; the others show no charts.`)
    }
    for (const guest of running.slice(0, MAX_GUEST_CONFIGS)) {
      const path = `/pve/remotes/${seg(guest.remote)}/${guest.type}/${guest.vmid}/rrddata`
      jobs.push(() => read(guest.key, path, hour, (points) => (scan.guests[guest.key] = rrdMetrics(points))))
    }
    for (const store of inventory.datastores.filter((d) => online.has(d.remote))) {
      const path = `/pbs/remotes/${seg(store.remote)}/datastore/${seg(store.name)}/rrddata`
      jobs.push(() =>
        read(store.key, path, { timeframe: 'day', cf: 'AVERAGE' }, (points) => (scan.datastores[store.key] = usageHistory(points)))
      )
    }
    await mapLimit(jobs, PARALLEL, (job) => job())
    if (failures.length > 0) {
      // One line: a missing permission or an old PDM fails them all the same way.
      scan.warnings.push(`History of ${failures.length} items could not be read, e.g. ${failures[0]}`)
    }
    return scan
  }

  async fetchTasks(signal?: AbortSignal): Promise<Task[]> {
    const list = listOf(await this.client.get<unknown>('/remotes/tasks/list', {}, signal), '/remotes/tasks/list')
    // One odd entry is skipped, not the whole feed.
    return list
      .map((t) => (isObj(t) ? toTask(t as PdmTask) : null))
      .filter((t): t is Task => t !== null)
      .sort((a, b) => b.start - a.start)
  }

  /** PDM proxies PVE's guest-agent call when it supports it; else it answers 404 and the plugin stops asking. */
  readGuestFs(guest: Guest, signal?: AbortSignal): Promise<unknown> {
    return this.client.get<unknown>(`/pve/remotes/${seg(guest.remote)}/qemu/${guest.vmid}/agent/get-fsinfo`, {}, signal)
  }

  async fetchUpdates(inventory: Inventory, signal?: AbortSignal): Promise<{ hosts: Record<string, number>; warnings: string[] }> {
    const hosts: Record<string, number> = {}
    const failures: string[] = []
    const remotes = inventory.remotes.filter((r) => r.online && r.type === 'pve')
    await mapLimit(remotes, PARALLEL, async (remote) => {
      try {
        const summary = await this.client.get<unknown>(`/pve/remotes/${seg(remote.id)}/updates`, {}, signal)
        const nodes = isObj(summary) && isObj(summary.nodes) ? summary.nodes : {}
        for (const [node, info] of Object.entries(nodes)) {
          if (!isObj(info)) continue
          const count = updateCount(info)
          if (count !== undefined) hosts[`${remote.id}/${node}`] = count
        }
      } catch (error) {
        if (error instanceof ApiError && error.info.kind === 'auth') throw error
        failures.push(`${remote.id}: ${message(error)}`)
      }
    })
    return { hosts, warnings: failures.length ? [`Updates of ${failures.length} remotes could not be read, e.g. ${failures[0]}`] : [] }
  }

  async fetchNetwork(inventory: Inventory, signal?: AbortSignal): Promise<NetworkScan> {
    const warnings: string[] = []
    const nodes: NetworkScan['nodes'] = {}
    const guests: NetworkScan['guests'] = {}
    const nodeNotes: NetworkScan['nodeNotes'] = {}
    await mapLimit(
      inventory.hosts.filter((h) => h.online && h.remoteType === 'pve'),
      PARALLEL,
      async (host) => {
        try {
          const answer = await this.client.get<unknown>(`/pve/remotes/${seg(host.remote)}/nodes/${seg(host.node)}/network`, {}, signal)
          const ifaces = (Array.isArray(answer) ? answer : []).filter(isObj) as PveInterface[]
          nodes[host.key] = ifaces.map((i) => safeIp(i?.address)).filter((a): a is string => !!a && !a.startsWith('127.'))
          const config = await this.client.get<unknown>(`/pve/remotes/${seg(host.remote)}/nodes/${seg(host.node)}/config`, {}, signal).catch(() => ({}))
          const notes = notesOf(isObj(config) ? config : {})
          if (notes) nodeNotes[host.key] = notes
        } catch (error) {
          if (error instanceof ApiError && error.info.kind === 'auth') throw error
          warnings.push(`Network of ${host.key}: ${message(error)}`)
        }
      }
    )
    const online = new Set(inventory.remotes.filter((r) => r.online).map((r) => r.id))
    const scanned = inventory.guests.filter((g) => online.has(g.remote)).slice(0, MAX_GUEST_CONFIGS)
    if (scanned.length < inventory.guests.length) {
      warnings.push(`Only the first ${MAX_GUEST_CONFIGS} guest configs were read for addresses.`)
    }
    const configFailures: string[] = []
    await mapLimit(scanned, PARALLEL, async (guest) => {
      try {
        const config = await this.client.get<unknown>(`/pve/remotes/${seg(guest.remote)}/${guest.type}/${guest.vmid}/config`, { state: 'active' }, signal)
        guests[guest.key] = guestNetwork(isObj(config) ? config : {})
      } catch (error) {
        if (error instanceof ApiError && error.info.kind === 'auth') throw error
        configFailures.push(`${guest.key}: ${message(error)}`)
      }
    })
    if (configFailures.length > 0) {
      // One line, not one per guest: usually the same cause (a permission) for all of them.
      warnings.push(`Configs of ${configFailures.length} guests could not be read for addresses, e.g. ${configFailures[0]}`)
    }
    return { nodes, guests, nodeNotes, warnings }
  }

  async fetchBackups(inventory: Inventory, signal?: AbortSignal): Promise<BackupScan> {
    const warnings: string[] = []
    const records: BackupRecord[] = []
    const gaps: string[] = []
    let available = false
    const online = new Set(inventory.remotes.filter((r) => r.online && r.type === 'pbs').map((r) => r.id))
    for (const r of inventory.remotes) if (r.type === 'pbs' && !r.online) gaps.push(`${r.id} is unreachable`)
    const stores = inventory.datastores.filter((d) => online.has(d.remote))

    await mapLimit(stores, 2, async (store) => {
      const base = `/pbs/remotes/${seg(store.remote)}/datastore/${seg(store.name)}`
      let namespaces = ['']
      try {
        const listed = listOf(await this.client.get<unknown>(`${base}/namespaces`, {}, signal), `${base}/namespaces`)
        namespaces = [...new Set(['', ...listed.map((n) => (isObj(n) && typeof n.ns === 'string' ? n.ns : '')).filter((n) => n === '' || /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(n))])]
      } catch (error) {
        warnings.push(`Namespaces of ${store.remote}/${store.name}: ${message(error)}; scanning the root namespace only.`)
        gaps.push(`namespaces of ${store.remote}/${store.name}`)
      }
      if (namespaces.length > MAX_NAMESPACES) {
        warnings.push(`${store.remote}/${store.name} has ${namespaces.length} namespaces; only the first ${MAX_NAMESPACES} were scanned.`)
        namespaces = namespaces.slice(0, MAX_NAMESPACES)
        gaps.push(`namespaces past ${MAX_NAMESPACES} in ${store.remote}/${store.name}`)
      }
      await mapLimit(namespaces, PARALLEL, async (ns) => {
        try {
          const snapshots = listOf(await this.client.get<unknown>(`${base}/snapshots`, { ns: ns || undefined }, signal), `${base}/snapshots`)
          available = true
          // An entry that cannot be read could be a guest's only backup: the scan is incomplete.
          let unreadable = 0
          for (const item of snapshots) {
            const snap = (isObj(item) ? item : {}) as PbsSnapshot
            const type = snap['backup-type']
            if (typeof snap['backup-time'] !== 'number' || !Number.isFinite(snap['backup-time']) || (typeof snap['backup-id'] !== 'string' && typeof snap['backup-id'] !== 'number') || typeof type !== 'string') {
              unreadable += 1
              continue
            }
            if (type !== 'vm' && type !== 'ct' && type !== 'host') continue
            records.push({
              remote: store.remote,
              datastore: store.name,
              ns,
              type,
              id: String(snap['backup-id']),
              time: snap['backup-time'] * 1000,
              ...(typeof snap.owner === 'string' && snap.owner ? { owner: snap.owner } : {})
            })
          }
          if (unreadable > 0) gaps.push(`${unreadable} unreadable snapshot entr${unreadable > 1 ? 'ies' : 'y'} in ${[store.remote, store.name, ns].filter(Boolean).join('/')}`)
        } catch (error) {
          if (error instanceof ApiError && error.info.kind === 'auth') throw error
          warnings.push(`Snapshots of ${[store.remote, store.name, ns].filter(Boolean).join('/')}: ${message(error)}`)
          gaps.push([store.remote, store.name, ns].filter(Boolean).join('/'))
        }
      })
    })
    return { records, available, complete: available && gaps.length === 0, gaps, warnings }
  }
}

/** One RRD point as PDM serializes it (kebab-case); fields are absent where nothing was recorded. */
export type RrdPoint = {
  time: number
  'cpu-current'?: number
  'mem-used'?: number
  'mem-total'?: number
  'net-in'?: number
  'net-out'?: number
  'disk-used'?: number
  'disk-total'?: number
}

/** Three significant digits: enough for a sparkline, a fraction of the JSON. */
function round(value: number): number {
  return value === 0 ? 0 : Number(value.toPrecision(3))
}

export function rrdMetrics(points: readonly RrdPoint[]): Metrics {
  const sorted = [...points].sort((a, b) => a.time - b.time)
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
  return {
    cpu: sorted.map((p) => (num(p['cpu-current']) ? round(Math.max(0, p['cpu-current'])) : null)),
    mem: sorted.map((p) => (num(p['mem-used']) && num(p['mem-total']) && p['mem-total'] > 0 ? round(p['mem-used'] / p['mem-total']) : null)),
    net: sorted.map((p) => (num(p['net-in']) || num(p['net-out']) ? round((p['net-in'] ?? 0) + (p['net-out'] ?? 0)) : null)),
    until: (sorted[sorted.length - 1]?.time ?? 0) * 1000
  }
}

/** Datastore usage share over a day, averaged into 48 half-hour buckets. */
export function usageHistory(points: readonly RrdPoint[], buckets = 48): (number | null)[] {
  const sorted = [...points].sort((a, b) => a.time - b.time)
  if (sorted.length === 0) return []
  const size = Math.ceil(sorted.length / buckets)
  const out: (number | null)[] = []
  for (let i = 0; i < sorted.length; i += size) {
    const values = sorted
      .slice(i, i + size)
      .filter((p) => typeof p['disk-used'] === 'number' && typeof p['disk-total'] === 'number' && p['disk-total']! > 0)
      .map((p) => p['disk-used']! / p['disk-total']!)
    out.push(values.length ? round(values.reduce((a, b) => a + b, 0) / values.length) : null)
  }
  return out
}

/** A config's `description` (Proxmox notes), trimmed; capped for memory here and for the panel after scrubbing. */
export function notesOf(config: GuestConfig): string | undefined {
  const text = typeof config.description === 'string' ? config.description.trim() : ''
  return text ? text.slice(0, 8000) : undefined
}

/** One entry of PDM's `/remotes/tasks/list`. */
export type PdmTask = {
  upid: string
  node?: string
  starttime: number
  endtime?: number
  status?: string
  user?: string
  worker_type?: string
  worker_id?: string | null
}

/**
 * A PDM task entry as a Task. The UPID carries the remote (`pve:<remote>!UPID:…`) and, for PVE,
 * the id the task acted on; PBS names it in `worker_id` (with `\x3a` for colons in the UPID).
 */
export function toTask(t: PdmTask): Task | null {
  if (typeof t?.upid !== 'string' || typeof t.starttime !== 'number' || !Number.isFinite(t.starttime)) return null
  const bang = t.upid.indexOf('!')
  if (bang < 0) return null
  const [kind, remote] = t.upid.slice(0, bang).split(':')
  const parts = t.upid.slice(bang + 1).split(':')
  const type = str(t.worker_type) ?? parts[5] ?? 'task'
  const at = parts.indexOf(type)
  const raw = str(t.worker_id) ?? (at >= 0 ? parts[at + 1] : undefined)
  const id = raw ? raw.replace(/\\x3a/g, ':') : undefined
  const status = str(t.status)
  if (typeof t.endtime !== 'number') delete t.endtime
  const task: Task = {
    key: t.upid,
    remote: remote ?? '',
    remoteType: kind === 'pbs' ? 'pbs' : 'pve',
    node: str(t.node) ?? parts[1] ?? '',
    type,
    user: str(t.user) ?? '',
    start: t.starttime * 1000,
    state: status === undefined || t.endtime === undefined ? 'running' : status === 'OK' ? 'ok' : /^WARNINGS/.test(status) ? 'warning' : 'failed'
  }
  if (id) task.id = id
  if (t.endtime !== undefined) task.end = t.endtime * 1000
  if (status !== undefined) task.status = status
  return task
}

/** What `/pve/remotes/{remote}/updates` answers. */
export type PdmUpdateSummary = { 'remote-type'?: string; status?: string; nodes?: Record<string, Record<string, unknown>> }

/** The number of pending updates of one node in PDM's update summary, if PDM has checked. */
export function updateCount(info: Record<string, unknown>): number | undefined {
  const n = info['number-of-updates'] ?? info.number_of_updates ?? info.numberOfUpdates
  if (typeof n === 'number' && Number.isFinite(n)) return n
  return Array.isArray(info.versions) ? info.versions.length : undefined
}

/**
 * `10.0.0.1:8006,fingerprint=…` or `hostname=pve1,…` -> `10.0.0.1` / `pve1`; undefined unless the
 * result is strictly an IP address or a DNS name (it ends up in ssh commands and links).
 */
export function nodeAddress(entry: string): string | undefined {
  const first = entry.split(',')[0]?.trim() ?? ''
  const value = first.includes('=') ? (first.startsWith('hostname=') ? first.slice('hostname='.length) : '') : first
  if (!value) return undefined
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value)
  if (bracketed) return safeIp(bracketed[1])
  return safeTarget(value.split(':').length === 2 ? value.split(':')[0] : value)
}

/** The port of a PDM node entry (`10.0.0.1:8006,…`, `[2001:db8::1]:8006`), when it names one. */
export function nodePort(entry: string): number | undefined {
  const first = entry.split(',')[0]?.trim() ?? ''
  const match = /^(?:\[[^\]]+\]|[^:[\]]+):(\d{1,5})$/.exec(first)
  const port = match ? Number(match[1]) : NaN
  return port > 0 && port < 65536 ? port : undefined
}

/**
 * A guest's hostname and static addresses from its config: `ip=` in an LXC `netN` or a
 * cloud-init `ipconfigN` (`dhcp` and `manual` are skipped). Nothing else is kept.
 */
export function guestNetwork(config: GuestConfig): { hostname?: string; addresses: string[]; notes?: string } {
  const addresses: string[] = []
  for (const [key, value] of Object.entries(config)) {
    if (!/^(net|ipconfig)\d+$/.test(key) || typeof value !== 'string') continue
    for (const part of value.split(',')) {
      const match = /^ip6?=(.+)$/.exec(part.trim())
      if (!match || /^(dhcp|auto|manual)$/.test(match[1])) continue
      const ip = safeIp(match[1].split('/')[0])
      if (ip) addresses.push(ip)
    }
  }
  const result: { hostname?: string; addresses: string[]; notes?: string } = { addresses: [...new Set(addresses)] }
  const hostname = safeTarget(config.hostname)
  if (hostname) result.hostname = hostname
  const notes = notesOf(config)
  if (notes) result.notes = notes
  return result
}

function guessType(resources: PdmResource[]): RemoteType {
  return resources.some((r) => r.type.startsWith('pbs-')) ? 'pbs' : 'pve'
}

function unreachableHost(remote: string, type: RemoteType, error: string): Host {
  return { key: `${remote}/`, remote, remoteType: type, node: '', online: false, status: 'unreachable', detailError: error }
}

function toGuest(remote: string, r: PdmGuestResource): Guest {
  return {
    key: `${remote}/${r.vmid}`,
    remote,
    node: r.node,
    vmid: r.vmid,
    type: r.type === 'pve-qemu' ? 'qemu' : 'lxc',
    name: str(r.name) ?? `${r.type === 'pve-qemu' ? 'VM' : 'CT'} ${r.vmid}`,
    status: str(r.status) ?? 'unknown',
    template: r.template === true || (r.template as unknown) === 1,
    tags: tagsOf(r.tags),
    cpu: num(r.cpu) ?? 0,
    maxcpu: num(r.maxcpu) ?? 0,
    mem: num(r.mem) ?? 0,
    maxmem: num(r.maxmem) ?? 0,
    disk: num(r.disk) ?? 0,
    maxdisk: num(r.maxdisk) ?? 0,
    uptime: num(r.uptime) ?? 0,
    backupState: 'unknown'
  }
}
