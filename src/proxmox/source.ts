// Where an estate comes from. A source reads inventory (remotes, hosts, guests, datastores) and,
// on a slower cadence, PBS snapshot lists: PDM (many remotes), or a PVE or PBS reached directly
// (one remote each, direct.ts), all over the same `ProxmoxClient` with its own token and pin.
// Several connections are combined by composite.ts.
import type { ConnectionConfig, Datastore, Guest, Host, Metrics, Remote, SourceKind, Task } from '../model'
import type { ProxmoxClient } from './client'
import type { BackupRecord } from './backups'
import { PdmSource } from './pdm'
import { PbsSource, PveSource } from './direct'

export type Inventory = {
  remotes: Remote[]
  hosts: Host[]
  /** `backupState` is `unknown` here; `attachBackups` fills it in. */
  guests: Guest[]
  datastores: Datastore[]
  warnings: string[]
  /** Remotes the source knows but could not list (PDM: none of their resources came back). */
  unlisted?: string[]
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
  /** Remotes the token can see (nodes of a PVE, datastores of a PBS); 0 usually means a missing role. */
  remotes: number
  /** What `remotes` counts, when it is not remotes. */
  unit?: 'nodes' | 'datastores'
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
  /**
   * A running VM's filesystems from its QEMU guest agent (`get-fsinfo`), where the API offers it;
   * absent on sources without guests.
   */
  readGuestFs?(guest: Guest, signal?: AbortSignal): Promise<unknown>
  /**
   * Which API answers a guest's agent call, where that is not simply its remote's (a guest PDM
   * shows whose agent is read through an enrich-only connection): a refusal of the call is
   * remembered per such scope.
   */
  agentScope?(guest: Guest): string
  /** Pending package updates per host key, where PDM has checked. */
  fetchUpdates(inventory: Inventory, signal?: AbortSignal): Promise<{ hosts: Record<string, number>; warnings: string[] }>
}

/** A stand-in configuration where only the client is known (its name comes from the server). */
function fallback(client: ProxmoxClient, kind: SourceKind): ConnectionConfig {
  return { id: 'direct', kind, baseUrl: client.baseUrl, tokenId: '', fingerprint: '' }
}

export function createSource(kind: SourceKind, client: ProxmoxClient, connection?: ConnectionConfig): EstateSource {
  switch (kind) {
    case 'pdm':
      return new PdmSource(client)
    case 'pve':
      return new PveSource(client, connection ?? fallback(client, kind))
    case 'pbs':
      return new PbsSource(client, connection ?? fallback(client, kind))
  }
}
