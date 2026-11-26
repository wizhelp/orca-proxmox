// The normalized estate the worker builds and the panel draws. Pure types and helpers only:
// both src/panel.tsx (no Node) and the worker import this file.

/**
 * Where data comes from. v1 implements `pdm` (Proxmox Datacenter Manager, which aggregates many
 * PVE and PBS remotes); `pve` and `pbs` are a single host added directly, with the same token
 * and fingerprint model, and are reserved for a later version.
 */
export type SourceKind = 'pdm' | 'pve' | 'pbs'

/** One configured API endpoint. The token secret is never part of it: it lives in Orca's secrets. */
export type ConnectionConfig = {
  id: string
  kind: SourceKind
  /** `https://host:port`, without `/api2/json`. */
  baseUrl: string
  /** `user@realm!tokenname`. */
  tokenId: string
  /** Pinned SHA-256 certificate fingerprint, `AA:BB:...` (64 hex digits); empty uses the system CAs. */
  fingerprint: string
  /**
   * New on every save. The secret is stored per revision, so whoever read one configuration only
   * ever gets that configuration's secret; absent on connections saved before revisions.
   */
  revision?: string
  /** A direct PVE or PBS connection's name in the estate; else the cluster's or server's own. */
  name?: string
  /** A direct connection reached through an SSH tunnel (its API is closed to the network). */
  tunnel?: SshTunnel
  /**
   * A direct PVE that only adds to what PDM shows (VM disk use, storage content types, pending
   * updates) for the guests and nodes it matches by node name and VMID; it adds no remote.
   */
  enrichOnly?: boolean
  /** For enrich only: this connection's node name -> the node (or `remote/node`) in PDM, where they differ. */
  nodeMap?: Record<string, string>
}

/** An SSH tunnel to a direct connection's API: `ssh -N -L 127.0.0.1:<port>:<target> user@host`. */
export type SshTunnel = {
  /** The SSH server: a DNS name or IP address. */
  host: string
  port: number
  user: string
  /** The private key on this machine (absolute path). */
  identityFile: string
  /** The API as the SSH server reaches it, `host:port` (usually 127.0.0.1:8006 or :8007). */
  target: string
  /** The SSH server's pinned host key, `ssh-ed25519 AAAA…`; empty until a test in Settings showed it. */
  hostKey: string
}

/** One saved configuration: what estates, caches, alerts and secrets are scoped to. */
export function connectionScope(connection: Pick<ConnectionConfig, 'id' | 'revision'>): string {
  return connection.revision ? `${connection.id}@${connection.revision}` : connection.id
}

/**
 * The scope of an estate made of several connections: every connection's scope, so a change to
 * any of them is a new estate. One connection keeps its own scope.
 */
export function estateScope(connections: readonly Pick<ConnectionConfig, 'id' | 'revision'>[]): string {
  return connections.length === 1 ? connectionScope(connections[0]) : connections.map(connectionScope).join('+')
}

/** A connection as the panel sees it: whether a secret is stored, never the secret. */
export type ConnectionView = ConnectionConfig & { hasSecret: boolean }

export type ErrorKind =
  | 'not-configured'
  | 'invalid-config'
  | 'secrets-unavailable'
  | 'unreachable'
  | 'timeout'
  | 'tls'
  | 'fingerprint-mismatch'
  | 'auth'
  | 'forbidden'
  | 'http'
  | 'protocol'

export type SourceError = {
  kind: ErrorKind
  message: string
  /** What the person can do about it. */
  hint?: string
  /** The SHA-256 fingerprint the server presented, for TLS and pinning errors. */
  presentedFingerprint?: string
  status?: number
}

export type RemoteType = 'pve' | 'pbs'

/** A remote PDM manages: a PVE cluster or a PBS server. */
export type Remote = {
  id: string
  type: RemoteType
  online: boolean
  /** Why PDM could not reach it. */
  error?: string
  /** The remote's web interface as set in PDM (`web-url`), when set. */
  webUrl?: string
  /** The IP or DNS name of the remote's first node as PDM connects to it. */
  nodeAddress?: string
  /** Its port, when PDM names one. */
  nodePort?: number
  /** Not one of PDM's remotes (reached directly, or a connection that could not be read): PDM has no page for it. */
  direct?: boolean
  /** A connection that holds backups (PDM or PBS) and could not be read: backup coverage is unknown. */
  backupSource?: boolean
  /** The name its own server uses (a cluster, node or host name), where the id differs from it. */
  alias?: string
}

/** A PVE storage on a node (from /resources/list; `content` only where PDM reports it). */
export type Storage = {
  name: string
  node: string
  disk: number
  maxdisk: number
  shared: boolean
  status: string
  /** Content types (`images`, `rootdir`, `iso`, …) where PDM reports them. */
  content?: string[]
}

/** One task of any remote, from PDM's merged task list. */
export type Task = {
  /** The UPID, unique. */
  key: string
  remote: string
  remoteType: RemoteType
  node: string
  /** `qmstart`, `vzdump`, `backup`, … */
  type: string
  /** What the task acted on: a VMID, a datastore and group, … */
  id?: string
  user: string
  /** Epoch ms. */
  start: number
  end?: number
  /** As Proxmox reports it: `OK`, `WARNINGS: 1`, or the error. */
  status?: string
  state: 'running' | 'ok' | 'warning' | 'failed'
}

/** A PVE node or a PBS server. */
export type Host = {
  key: string
  remote: string
  remoteType: RemoteType
  node: string
  online: boolean
  status: string
  /** CPU use, 0..1 of `maxcpu`. */
  cpu?: number
  maxcpu?: number
  mem?: number
  maxmem?: number
  disk?: number
  maxdisk?: number
  /** Seconds. */
  uptime?: number
  /** `8.2.4` for PVE, `3.2.7` for PBS. */
  version?: string
  /** A detail call (node status, version) failed; the row still shows what /resources/list had. */
  detailError?: string
  /** IP addresses the node has (its PDM connection address and its network interfaces). */
  addresses?: string[]
  /** The last hour, one point a minute, for sparklines. */
  metrics?: Metrics
  /** The node's notes (its config `description`). */
  notes?: string
  /** PVE storages on this node, shared ones included. */
  storages?: Storage[]
  /** Pending package updates as PDM last saw them; absent when PDM has not checked. */
  pendingUpdates?: number
}

export type GuestType = 'qemu' | 'lxc'

export type BackupState = 'ok' | 'stale' | 'none' | 'unknown'

export type Guest = {
  key: string
  remote: string
  node: string
  vmid: number
  type: GuestType
  name: string
  status: string
  template: boolean
  tags: string[]
  cpu: number
  maxcpu: number
  mem: number
  maxmem: number
  disk: number
  maxdisk: number
  uptime: number
  /** Newest PBS snapshot of this guest, epoch milliseconds. */
  lastBackup?: number
  /** Where `lastBackup` lives: `remote/datastore[/namespace]`. */
  lastBackupWhere?: string
  backupState: BackupState
  /**
   * The same VMID exists on more than one remote and no namespace tells their snapshots apart,
   * so `lastBackup` may belong to another guest with this VMID.
   */
  backupAmbiguous?: boolean
  /** From the guest config: an LXC `hostname`. */
  hostname?: string
  /** Static addresses from the guest config (`ip=` of LXC `netN`, cloud-init `ipconfigN`). */
  addresses?: string[]
  /** The guest's notes (its config `description`). */
  notes?: string
  /** The last hour, one point a minute, for sparklines. */
  metrics?: Metrics
  /**
   * Filesystem use inside the guest: from Proxmox for a running container, from the QEMU guest agent
   * for a VM. Absent when unknown; then `diskUnknown` says why (and `maxdisk` is the allocated
   * size). A stopped guest has no current use (Proxmox reports 0 for a stopped container): it
   * keeps the last one measured while it ran, with `asOf`, and `diskUnknown` is 'stopped'.
   */
  diskUsage?: { used: number; total: number; from: 'container' | 'agent'; asOf?: number }
  diskUnknown?: DiskUnknown
}

/**
 * Why a VM's disk use is unknown: no guest agent (disabled, not installed or not running), the
 * token may not ask the agent, the API offers no agent call (PDM), the VM is stopped, or not read
 * yet (it is read every few minutes, a few VMs at a time).
 */
export type DiskUnknown = 'no-agent' | 'no-permission' | 'unsupported' | 'stopped' | 'not-read' | 'off'

export type Datastore = {
  key: string
  remote: string
  name: string
  used: number
  total: number
  /** 0..1. */
  usage: number
  maintenance?: string
  /** Used share (0..1) over the last day, about every 30 minutes; null where nothing was recorded. */
  usageHistory?: (number | null)[]
}

export type BackupSummary = {
  /** When the snapshot lists were last read, epoch ms; absent until the first read. */
  fetchedAt?: number
  /** The snapshot lists could not be read at all; per-datastore failures land in `warnings`. */
  error?: string
  staleHours: number
  /** Guests (templates excluded) with no snapshot newer than `staleHours`. */
  missing: number
  /**
   * Guest backups on PBS whose guest no longer exists (destroyed or moved): the newest snapshot
   * per remote, type and VMID. Usually safe to prune once no longer needed.
   */
  orphans: OrphanBackup[]
  /** Set when some datastore or namespace was not read: absence of a backup is then not proof. */
  incomplete?: string
}

export type OrphanBackup = {
  key: string
  /** The PDM remote the snapshot's namespace or owner names; absent when nothing names one. */
  remote?: string
  type: GuestType
  vmid: number
  /** Newest snapshot, epoch ms. */
  lastBackup: number
  /** `pbs-remote/datastore[/namespace]`. */
  where: string
}

/**
 * Recent history of a node or guest from Proxmox's RRD, oldest first, one point a minute; null
 * where nothing was recorded. `cpu` and `mem` are shares (0..1), `net` bytes per second in+out.
 */
export type Metrics = {
  cpu: (number | null)[]
  mem: (number | null)[]
  net: (number | null)[]
  /** Epoch ms of the newest point. */
  until: number
}

export type EstateSnapshot = {
  connectionId: string
  sourceKind: SourceKind
  fetchedAt: number
  remotes: Remote[]
  hosts: Host[]
  guests: Guest[]
  datastores: Datastore[]
  backups: BackupSummary
  /** Partial failures that did not stop the refresh. */
  warnings: string[]
  /** The newest tasks of all remotes, newest first. */
  tasks?: Task[]
  /** The PDM web interface, for links. */
  pdmUrl?: string
  /** Orca hosts, bots and workspaces and where they run in this estate; absent when turned off. */
  orca?: OrcaView
}

// ---- Orca awareness ----

/** Where an Orca host runs in the estate: a node (`remote/node`) or a guest (`remote/vmid`). */
export type ProxmoxRef = { kind: 'node' | 'guest'; key: string }

/** How an Orca host was placed: set by hand, by name, by IP address, or through the SSH target its orcad was deployed over. */
export type OrcaMatch = 'manual' | 'name' | 'address' | 'via-ssh'

export type OrcaHostKind = 'local' | 'ssh' | 'environment'

export type OrcaHost = {
  /** `local`, `ssh:<id>` or `env:<id>`; stable, used for manual links. */
  key: string
  kind: OrcaHostKind
  name: string
  /** SSH targets: whether Orca is connected to it now. */
  connected?: boolean
  /** Paired servers: the SSH target Orca deployed its runtime through. */
  viaSsh?: string
  /**
   * An SSH target that also runs a paired Orca server (deployed over it): one machine, one Orca.
   * Orca keeps two records for it; they are shown as this one host, named after the SSH target.
   * The server's own workspaces and bots are listed under this host.
   */
  paired?: { key: string; name: string }
  runsOn?: ProxmoxRef
  match?: OrcaMatch
}

export type OrcaAgent = { agent: string; state: string }

export type OrcaWorkspace = {
  key: string
  hostKey: string
  name: string
  repo: string
  /** Orca's sidebar status: working, done, permission, active, inactive. */
  status: string
  bot?: string
  agents: OrcaAgent[]
  lastActivityAt?: number
  /** Orca's worktree id, to open a terminal in it. */
  worktreeId?: string
  /** The paired Orca server it lives on, by its id (names can change); absent for this machine. */
  environment?: string
  /** That server's name, to show. */
  serverName?: string
}

export type OrcaBot = {
  id: string
  name: string
  agent: string
  paused: boolean
  hostKey: string
}

export type OrcaView = {
  fetchedAt: number
  hosts: OrcaHost[]
  workspaces: OrcaWorkspace[]
  bots: OrcaBot[]
  /** Something could not be read (the orca CLI, one paired server); what was read is still shown. */
  warnings: string[]
  /** The whole Orca inventory could not be read. */
  error?: string
}

export type EstateResponse =
  | { state: 'unconfigured'; refreshSeconds: number }
  | { state: 'ok'; snapshot: EstateSnapshot; refreshSeconds: number }
  | { state: 'error'; error: SourceError; lastGood?: EstateSnapshot; refreshSeconds: number }

export type PluginSettings = {
  refreshSeconds: number
  backupStaleHours: number
  backupRefreshMinutes: number
  /** Show Orca hosts, bots and workspaces on the estate (read with the orca CLI). */
  orcaAwareness: boolean
  /** Read disk use inside running VMs from their QEMU guest agent (`get-fsinfo`). */
  guestAgentDisk: boolean
  /** Show the estate in the status bar. */
  statusBar: boolean
  /** Notify when a remote goes offline, a running guest stops, a backup fails or goes stale. */
  alertRemoteOffline: boolean
  alertGuestStopped: boolean
  alertBackupFailed: boolean
  alertBackupStale: boolean
}

export const DEFAULT_SETTINGS: PluginSettings = {
  refreshSeconds: 30,
  backupStaleHours: 26,
  backupRefreshMinutes: 5,
  orcaAwareness: true,
  guestAgentDisk: true,
  statusBar: true,
  alertRemoteOffline: true,
  alertGuestStopped: true,
  alertBackupFailed: true,
  alertBackupStale: true
}

// ---- formatting, shared by the panel and tests ----

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '-'
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 100 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${UNITS[unit]}`
}

export function formatPercent(fraction: number | undefined): string {
  if (fraction === undefined || !Number.isFinite(fraction)) return '-'
  return `${(fraction * 100).toFixed(fraction < 0.1 ? 1 : 0)}%`
}

/** `used / total (pct)`, or `-` when the total is unknown. */
export function formatUsage(used: number | undefined, total: number | undefined): string {
  if (!total || used === undefined) return '-'
  return `${formatBytes(used)} / ${formatBytes(total)} (${formatPercent(used / total)})`
}

export function formatUptime(seconds: number | undefined): string {
  if (!seconds || seconds <= 0) return '-'
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

/** `AABB...` or `aa:bb:...` to `AA:BB:...`; null when it is not 32 bytes of hex. */
export function normalizeFingerprint(input: string): string | null {
  const hex = input.replace(/[\s:]/g, '').toUpperCase()
  if (!/^[0-9A-F]{64}$/.test(hex)) return null
  return hex.match(/../g)!.join(':')
}
