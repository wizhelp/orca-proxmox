// Where an estate comes from. A source reads inventory (remotes, hosts, guests, datastores) and,
// on a slower cadence, PBS snapshot lists. v1 ships the PDM source; a single PVE or PBS host
// added directly would be another `EstateSource` over the same `ProxmoxClient` (same token and
// fingerprint model, a different auth scheme and API paths).
import type { Datastore, Guest, Host, Metrics, Remote, SourceKind, Task } from '../model'
import { ApiError, type ProxmoxClient } from './client'
import type { BackupRecord } from './backups'
import { PdmSource } from './pdm'

export type Inventory = {
  remotes: Remote[]
  hosts: Host[]
  /** `backupState` is `unknown` here; `attachBackups` fills it in. */
  guests: Guest[]
  datastores: Datastore[]
  warnings: string[]
}

export type BackupScan = {
  records: BackupRecord[]
  /** At least one PBS datastore was read; false means there is nothing to judge backups by. */
  available: boolean
  /** Every datastore of every PBS remote was read, all namespaces: only then is "no backup" definite. */
  complete: boolean
  /** What was not read, short and generated here (never a server's error text). */
  gaps: string[]
  warnings: string[]
}

export type NetworkScan = {
  /** Host key (`remote/node`) to the node's interface addresses. */
  nodes: Record<string, string[]>
  /** Guest key (`remote/vmid`) to its configured hostname, static addresses and notes. */
  guests: Record<string, { hostname?: string; addresses: string[]; notes?: string }>
  /** Host key to the node's notes. */
  nodeNotes: Record<string, string>
  warnings: string[]
}

export type MetricsScan = {
  /** By host key (`remote/node`). */
  hosts: Record<string, Metrics>
  /** By guest key (`remote/vmid`). */
  guests: Record<string, Metrics>
  /** By datastore key (`remote/name`). */
  datastores: Record<string, (number | null)[]>
  warnings: string[]
}

export type AccessCheck = {
  version: string
  /** Remotes the token can see; 0 usually means the token lacks the Auditor role. */
  remotes: number
}

export interface EstateSource {
  readonly kind: SourceKind
  checkAccess(signal?: AbortSignal): Promise<AccessCheck>
  fetchInventory(options: { maxAgeSeconds: number; signal?: AbortSignal }): Promise<Inventory>
  fetchBackups(inventory: Inventory, signal?: AbortSignal): Promise<BackupScan>
  /** Node and guest addresses and guest hostnames, to find where Orca hosts run. */
  fetchNetwork(inventory: Inventory, signal?: AbortSignal): Promise<NetworkScan>
  /** The last hour of CPU, memory and network per node and running guest; datastore usage over a day. */
  fetchMetrics(inventory: Inventory, signal?: AbortSignal): Promise<MetricsScan>
  /** The newest tasks of all remotes, newest first. */
  fetchTasks(signal?: AbortSignal): Promise<Task[]>
  /** Pending package updates per host key, where PDM has checked. */
  fetchUpdates(inventory: Inventory, signal?: AbortSignal): Promise<{ hosts: Record<string, number>; warnings: string[] }>
}

export function createSource(kind: SourceKind, client: ProxmoxClient): EstateSource {
  switch (kind) {
    case 'pdm':
      return new PdmSource(client)
    case 'pve':
    case 'pbs':
      throw new ApiError({
        kind: 'invalid-config',
        message: `Connecting to a single ${kind.toUpperCase()} host is not supported yet; connect through Proxmox Datacenter Manager.`
      })
  }
}
