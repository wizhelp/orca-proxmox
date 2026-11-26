// The plugin's worker: holds the connection, makes every HTTP call and answers the panel.
// The token secret is kept in Orca's encrypted secrets (secrets:own) sealed with a key only the
// worker can read (see vault.ts), read when a request needs it, never stored in plugin storage,
// never returned to the panel and never logged; everything outbound is scrubbed (see scrub.ts).
import { randomUUID } from 'node:crypto'
import type { OrcaWorkerApi } from 'orca/worker'
import { EstateService, StaleRefreshError } from './estate'
import {
  connectionScope,
  estateScope,
  DEFAULT_SETTINGS,
  normalizeFingerprint,
  type ConnectionConfig,
  type ConnectionView,
  type EstateResponse,
  type EstateSnapshot,
  type PluginSettings,
  type SourceError,
  type SourceKind,
  type SshTunnel
} from './model'
import { CompositeSource, type EnrichBindings, type FailedPart, type Part } from './proxmox/composite'
import type { ConfigAnswer, ConnectionInput, ImportStatus, SecretsProtection, SshHostKey, TestAnswer } from './protocol'
import { ApiError, normalizeBaseUrl, ProxmoxClient } from './proxmox/client'
import { nodeTransport, type ConnectTo, type Transport } from './proxmox/http'
import { findSsh, freeLocalPort, hostKeyFingerprint, sshEnvironment, TunnelManager, type SpawnSsh } from './proxmox/tunnel'
import { safeTarget } from './features/targets'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { createSource, type AccessCheck } from './proxmox/source'
import { cliEnvironment, nodeCliRunner } from './orca/cli'
import type { CliRunner } from './orca/inventory'
import { parseLink, type OrcaLinks } from './orca/match'
import { OrcaService } from './orca/service'
import { switchArgs, terminalPlan } from './orca/terminal'
import { Background } from './background'
import { outboundSnapshot, redactDeep, scrubLine } from './scrub'
import { fileVault, keyFile, memoryVault, type Binding, type Vault } from './vault'
import { cleanupText, importFile, takeImport, type ImportedConnection } from './importer'
import { SetupService } from './setup/service'
import type { AlertState } from './features/alerts'
import type { JsonValue } from 'orca/worker'

const CONNECTIONS_KEY = 'connections'
/** Manual placements of Orca hosts, before they were kept per estate (read once, then moved). */
const ORCA_LINKS_KEY = 'orcaLinks'
/** Manual placements of Orca hosts on the estate: PDM base URL -> Orca host key -> link. */
const ORCA_LINKS_BY_ESTATE_KEY = 'orcaLinks.byEstate'
/**
 * One keyring entry per saved configuration: a reader that loaded one configuration can only
 * ever read that configuration's secret, never a replacement meant for another server.
 */
const secretKey = (connection: Pick<ConnectionConfig, 'id' | 'revision'>) =>
  connection.revision ? `token-secret:${connection.id}:${connection.revision}` : `token-secret:${connection.id}`
/**
 * A secret is carried over to a new configuration only for the very same endpoint, token and TLS
 * trust (pin): changing any of them needs the secret entered again.
 */
const sameEndpoint = (a: ConnectionConfig, b: ConnectionConfig) =>
  a.baseUrl === b.baseUrl && a.tokenId === b.tokenId && a.kind === b.kind && a.fingerprint === b.fingerprint && routeOf(a) === routeOf(b)
/** How a connection is reached when not directly: its SSH tunnel, every field that decides where. */
const routeOf = (c: ConnectionConfig): string | undefined => {
  const t = c.tunnel
  return t ? JSON.stringify(['ssh', t.host, t.port, t.user, t.identityFile, t.target, t.hostKey]) : undefined
}
/** What a sealed secret is bound to: everything that decides where it is sent. */
const binding = (c: ConnectionConfig): Binding => {
  const route = routeOf(c)
  return { id: c.id, revision: c.revision, kind: c.kind, baseUrl: c.baseUrl, tokenId: c.tokenId, fingerprint: c.fingerprint, ...(route ? { route } : {}) }
}
const TOKEN_ID = /^[^\s@!]+@[^\s@!]+![A-Za-z0-9][A-Za-z0-9._-]*$/

let transport: Transport = nodeTransport
let probe: ((url: URL, connectTo?: ConnectTo) => Promise<string | null>) | undefined
/** SSH tunnels (tunnel.ts); tests swap in a fake ssh. */
let spawnSsh: SpawnSsh = (command, args) => spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, shell: false, env: sshEnvironment(cliEnvironment(), process.platform) })
let sshPath: () => string | null = () => findSsh(process.platform, cliEnvironment())
let tunnelDir: () => string = () => join(dirname(keyFile()), 'tunnels')
let tunnelManager: TunnelManager | undefined
/** The tunnel manager; none is created once the worker is stopping (a read still in flight then fails). */
const tunnels = () => {
  if (stopped) throw new ApiError({ kind: 'unreachable', message: 'The plugin is stopping; no SSH tunnel is started' })
  return (tunnelManager ??= new TunnelManager({ spawn: spawnSsh, sshPath: () => sshPath(), dir: tunnelDir(), freePort: freeLocalPort, now: () => clock() }))
}
let clock: () => number = Date.now
let sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
let cliRunner: (() => CliRunner) | undefined
let vault: Vault | undefined
/** The import file; tests point it at a temporary folder (or nowhere). */
let importPath: string | undefined
let importPlatform: NodeJS.Platform = process.platform
const IMPORT_STATUS_KEY = 'import.status'
/** The background loop (status bar, alerts); off in tests unless they ask for it. */
let background = true
const ALERT_STATE_KEY = 'alerts.state'
/** The terminals the plugin opened (newest last), so they can be told apart from others' later. */
const TERMINALS_KEY = 'terminals'
type OpenedTerminal = { handle: string; environment?: string; hostKey: string; at: number }

/** Every privilege name in an /access/permissions answer (path -> privilege -> set). */
/**
 * Every privilege name in an /access/permissions answer: path -> privilege -> propagate bit. A
 * privilege that is listed is granted at that path whatever its bit (0 or false only means it is
 * not inherited further down), so every listed name counts. Any other shape is refused.
 */
export function privilegeNames(answer: unknown): string[] {
  const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  if (!isMap(answer)) throw new Error('The permission list has an unexpected shape')
  const out = new Set<string>()
  for (const [path, privs] of Object.entries(answer)) {
    if (!path.startsWith('/') || !isMap(privs)) throw new Error('The permission list has an unexpected shape')
    for (const [name, bit] of Object.entries(privs)) {
      if (!/^[A-Za-z][A-Za-z0-9.]*$/.test(name) || !(typeof bit === 'number' || typeof bit === 'boolean')) throw new Error('The permission list has an unexpected shape')
      out.add(name)
    }
  }
  return [...out].sort()
}

/** Tests replace the network (and the clock) with recorded answers. Orca never calls this. */
export function useTestDoubles(doubles: {
  transport: Transport
  probe?: (url: URL, connectTo?: ConnectTo) => Promise<string | null>
  now?: () => number
  spawnSsh?: SpawnSsh
  sshPath?: string | null
  tunnelDir?: string
  orcaCli?: CliRunner
  background?: boolean
  vault?: Vault
  importPath?: string
  importPlatform?: NodeJS.Platform
  sleep?: (ms: number) => Promise<void>
}): void {
  sleep = doubles.sleep ?? ((ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))))
  background = doubles.background ?? false
  // Never the real import file in tests: a path that does not exist unless a test makes it.
  importPath = doubles.importPath ?? '\0no-import-file-in-tests'
  importPlatform = doubles.importPlatform ?? process.platform
  // Never the real key file in tests.
  vault = doubles.vault ?? memoryVault()
  transport = doubles.transport
  probe = doubles.probe
  clock = doubles.now ?? Date.now
  // Never the real ssh in tests: without a fake one, a tunnel cannot start.
  tunnelManager?.stopAll()
  tunnelManager = undefined
  spawnSsh = doubles.spawnSsh ?? (() => {
    throw new Error('no ssh in tests')
  })
  sshPath = () => (doubles.sshPath === undefined ? '/usr/bin/ssh' : doubles.sshPath)
  tunnelDir = () => doubles.tunnelDir ?? join(tmpdir(), 'orca-proxmox-test-tunnels')
  // Tests never run the real orca CLI: without a recorded one, reading Orca's inventory fails.
  const cli: CliRunner = doubles.orcaCli ?? (async () => Promise.reject(new Error('no orca CLI in tests')))
  cliRunner = () => cli
}

/**
 * What a handler answers must be plain JSON: Orca refuses `undefined` fields, NaN and the like.
 * Optional fields that are absent are simply dropped.
 */
export function toJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

class InputError extends Error {
  readonly code = 'invalid_params'
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function numberSetting(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
}

function cleanSecret(secret: string | undefined): string | undefined {
  const value = secret?.trim()
  if (!value) return undefined
  if (/[\s\x00-\x1f]/.test(value) || value.length > 512) throw new InputError('The token secret contains invalid characters')
  return value
}

const KINDS: Record<SourceKind, string> = { pdm: 'PDM', pve: 'PVE', pbs: 'PBS' }
/** A direct connection's name becomes a remote's key: plain characters only. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/

/** Validated connection fields, or an InputError naming what is wrong. */
function validate(input: ConnectionInput, id: string): ConnectionConfig {
  const kind: SourceKind = input.kind === 'pve' || input.kind === 'pbs' ? input.kind : 'pdm'
  const name = (input.name ?? '').trim()
  if (name && (kind === 'pdm' || !NAME.test(name))) {
    throw new InputError(kind === 'pdm' ? 'A PDM connection has no name: its remotes keep theirs.' : 'The name may hold letters, digits, ".", "_" and "-" (40 at most).')
  }
  let baseUrl: string
  try {
    baseUrl = normalizeBaseUrl(input.baseUrl ?? '')
  } catch (error) {
    throw new InputError(error instanceof Error ? error.message : 'Invalid base URL')
  }
  const tokenId = (input.tokenId ?? '').trim()
  if (!TOKEN_ID.test(tokenId)) throw new InputError('The token ID must look like user@realm!tokenname')
  let fingerprint = ''
  if ((input.fingerprint ?? '').trim()) {
    const normalized = normalizeFingerprint(input.fingerprint)
    if (!normalized) throw new InputError('The fingerprint must be a SHA-256 fingerprint: 32 hex bytes, colons optional')
    fingerprint = normalized
  }
  const out: ConnectionConfig = { id, kind, baseUrl, tokenId, fingerprint, ...(name ? { name } : {}) }
  if (input.tunnel) {
    if (kind === 'pdm') throw new InputError('An SSH tunnel is for a direct PVE or PBS connection.')
    out.tunnel = validTunnel(input.tunnel, kind)
  }
  if (input.enrichOnly) {
    if (kind !== 'pve') throw new InputError('Only a direct PVE connection can add to what PDM shows (enrich only).')
    out.enrichOnly = true
    const nodeMap = validNodeMap(input.nodeMap)
    if (Object.keys(nodeMap).length) out.nodeMap = nodeMap
  }
  return out
}

const SSH_USER = /^[A-Za-z_][A-Za-z0-9._-]{0,31}$/
const NODE_NAME = /^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/

/** An SSH tunnel's fields, checked one by one; they become ssh arguments (never through a shell). */
function validTunnel(raw: Partial<Record<keyof SshTunnel, unknown>>, kind: SourceKind): SshTunnel {
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '')
  const host = text(raw.host)
  if (!host || safeTarget(host) !== host) throw new InputError('The SSH host must be a DNS name or an IP address.')
  const port = Number(text(raw.port) || 22)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new InputError('The SSH port must be a number from 1 to 65535.')
  const user = text(raw.user)
  if (!SSH_USER.test(user)) throw new InputError('The SSH user must be a plain user name.')
  const identityFile = text(raw.identityFile)
  if (!isAbsolute(identityFile) || identityFile.startsWith('-') || /[\0\r\n]/.test(identityFile)) throw new InputError('The identity file must be the absolute path of a private key on this machine, e.g. C:\\Users\\you\\.ssh\\key or C:/Users/you/.ssh/key. On Windows, backslashes lost on the way (in a shell) make a path relative: write it from PowerShell or use forward slashes.')
  const target = text(raw.target) || (kind === 'pbs' ? '127.0.0.1:8007' : '127.0.0.1:8006')
  const t = /^([^:\s]+):(\d{1,5})$/.exec(target)
  if (!t || safeTarget(t[1]) !== t[1] || Number(t[2]) < 1 || Number(t[2]) > 65535) throw new InputError('The tunnel target must be host:port as the SSH server reaches the API, e.g. 127.0.0.1:8006.')
  const hostKey = text(raw.hostKey).split(/\s+/).slice(0, 2).join(' ')
  if (hostKey && !hostKeyFingerprint(hostKey)) throw new InputError('The SSH host key must be one public key, like "ssh-ed25519 AAAA…".')
  return { host, port, user, identityFile, target, hostKey }
}

/** Node names here -> PDM node names (or remote/node), for enrich only. */
function validNodeMap(raw: unknown): Record<string, string> {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new InputError('The node mapping must name nodes.')
  const out: Record<string, string> = {}
  for (const [from, to] of Object.entries(raw as Record<string, unknown>)) {
    const target = typeof to === 'string' ? to.trim() : ''
    const [a, b] = target.split('/')
    const ok = NODE_NAME.test(from) && (b === undefined ? NODE_NAME.test(a) : NAME.test(a) && NODE_NAME.test(b) && target.split('/').length === 2)
    if (!ok) throw new InputError('Each node mapping is a node name here and a node name (or remote/node) in PDM.')
    out[from] = target
  }
  return out
}

export default function activate(orca: OrcaWorkerApi): void {
  stopped = false
  /** Which PDM cluster each enrich-only connection adds to, for the current configuration. */
  const enrichBindings: EnrichBindings = new Map()
  const estate = new EstateService(() => clock())
  const orcaView = new OrcaService(() => (cliRunner ?? nodeCliRunner)(), () => clock())

  /** Every message logged passes through here, so a secret that slipped into one is masked. */
  const knownSecrets = new Set<string>()
  const log = (text: string) => orca.log(scrubLine(text, knownSecrets, 2000))
  /** Only the known secret values replaced: for text that must stay exact, like file paths. */
  const maskKnown = (text: string) => [...knownSecrets].reduce((out, secret) => (secret.length >= 4 ? out.split(secret).join('[redacted]') : out), text)
  const sealer = () => (vault ??= fileVault())

  async function readSecret(connection: ConnectionConfig): Promise<string | null> {
    const stored = await orca.secrets.get(secretKey(connection))
    if (!stored) return null
    // Opens only for exactly the settings it was sealed with: settings rewritten in storage (the
    // panel can write it) leave the secret unusable instead of sending it elsewhere. A value
    // stored before this binding is never trusted, as its settings may have been changed since.
    const secret = await sealer().open(stored, binding(connection))
    if (secret === null) {
      log('The stored token secret does not match the saved connection (or its key file is missing, or it was stored by an older version); enter it again in Settings.')
      return null
    }
    knownSecrets.add(secret)
    return secret
  }

  /** Every saved connection: PDM and PVE or PBS servers reached directly. */
  async function loadConnections(): Promise<ConnectionConfig[]> {
    const stored = await orca.storage.get(CONNECTIONS_KEY)
    const list = Array.isArray(stored) ? (stored as unknown as ConnectionConfig[]) : []
    return list.filter((c) => c && typeof c === 'object' && typeof c.baseUrl === 'string' && typeof c.id === 'string' && ['pdm', 'pve', 'pbs'].includes(c.kind))
  }

  async function loadConnection(): Promise<ConnectionConfig | null> {
    return (await loadConnections())[0] ?? null
  }

  /** Orca placements are kept per estate: its connections' URLs. */
  const linksKey = (list: readonly ConnectionConfig[]) => list.map((c) => c.baseUrl).sort().join(' ')

  /**
   * Bumped on every configuration change: answers, terminal targets and alerts of an older
   * generation are dropped rather than shown for the new one.
   */
  let generation = 0
  /** Reads in flight per configuration scope, so a replaced secret is deleted only once they settle. */
  const reading = new Map<string, number>()
  const retiring = new Map<string, ConnectionConfig>()

  async function sweepRetired(): Promise<void> {
    for (const [scope, connection] of [...retiring]) {
      if ((reading.get(scope) ?? 0) > 0) continue
      retiring.delete(scope)
      await orca.secrets.delete(secretKey(connection)).catch((error: unknown) => log(`Could not delete an old token secret: ${String(error)}`))
    }
  }

  /** Runs `read` as a reader of `connection`'s configuration (see sweepRetired). */
  async function asReader<T>(connection: ConnectionConfig, read: () => Promise<T>): Promise<T> {
    const scope = connectionScope(connection)
    reading.set(scope, (reading.get(scope) ?? 0) + 1)
    try {
      return await read()
    } finally {
      const left = (reading.get(scope) ?? 1) - 1
      if (left > 0) reading.set(scope, left)
      else reading.delete(scope)
      void sweepRetired()
    }
  }

  /** Runs `read` as a reader of every connection in `list`. */
  function asReaders<T>(list: readonly ConnectionConfig[], read: () => Promise<T>): Promise<T> {
    return list.reduceRight<() => Promise<T>>((inner, connection) => () => asReader(connection, inner), read)()
  }

  /** After a save or a clear: nothing of the previous configuration is used any more. */
  async function switched(previous: readonly ConnectionConfig[]): Promise<void> {
    generation += 1
    enrichBindings.clear()
    estate.reset()
    latest = undefined
    loop?.reset()
    // A replaced or removed connection's tunnel stops now, not at the next read.
    if (tunnelManager) {
      const current = await loadConnections()
      tunnelManager.retain(new Set(current.filter((c) => c.tunnel).map(connectionScope)))
    }
    await orca.storage.set(ALERT_STATE_KEY, null).catch(() => undefined)
    for (const old of previous) retiring.set(connectionScope(old), old)
    if (previous.length) await sweepRetired()
  }

  async function loadSettings(): Promise<PluginSettings> {
    const raw = await orca.settings.get()
    return {
      refreshSeconds: numberSetting(raw.refreshSeconds, DEFAULT_SETTINGS.refreshSeconds, 10, 3600),
      backupStaleHours: numberSetting(raw.backupStaleHours, DEFAULT_SETTINGS.backupStaleHours, 1, 24 * 90),
      backupRefreshMinutes: numberSetting(raw.backupRefreshMinutes, DEFAULT_SETTINGS.backupRefreshMinutes, 1, 24 * 60),
      orcaAwareness: flag(raw.orcaAwareness, DEFAULT_SETTINGS.orcaAwareness),
      guestAgentDisk: flag(raw.guestAgentDisk, DEFAULT_SETTINGS.guestAgentDisk),
      statusBar: flag(raw.statusBar, DEFAULT_SETTINGS.statusBar),
      alertRemoteOffline: flag(raw.alertRemoteOffline, DEFAULT_SETTINGS.alertRemoteOffline),
      alertGuestStopped: flag(raw.alertGuestStopped, DEFAULT_SETTINGS.alertGuestStopped),
      alertBackupFailed: flag(raw.alertBackupFailed, DEFAULT_SETTINGS.alertBackupFailed),
      alertBackupStale: flag(raw.alertBackupStale, DEFAULT_SETTINGS.alertBackupStale)
    }
  }

  async function secretsProtection(): Promise<SecretsProtection> {
    if (!orca.host.has('secrets.protection')) return 'unknown'
    try {
      return (await orca.host.call('secrets.protection')).status
    } catch {
      return 'unknown'
    }
  }

  async function view(connection: ConnectionConfig | null): Promise<ConnectionView | null> {
    if (!connection) return null
    const ssh = connection.tunnel?.hostKey ? hostKeyFingerprint(connection.tunnel.hostKey) : null
    return { ...connection, hasSecret: (await readSecret(connection)) !== null, ...(ssh ? { sshFingerprint: ssh } : {}) }
  }

  async function configAnswer(): Promise<ConfigAnswer> {
    const connections = await Promise.all((await loadConnections()).map((c) => view(c)))
    const status = await orca.storage.get(IMPORT_STATUS_KEY)
    return toJson<ConfigAnswer>({
      connections: connections.filter((c): c is ConnectionView => c !== null),
      connection: connections[0] ?? null,
      secretsProtection: await secretsProtection(),
      settings: await loadSettings(),
      importPath: importPath ?? importFile(),
      importStatus: status && typeof status === 'object' && !Array.isArray(status) ? (status as unknown as ImportStatus) : null
    })
  }

  function toSourceError(error: unknown): SourceError {
    const info: SourceError =
      error instanceof ApiError
        ? { ...error.info }
        : { kind: 'unreachable', message: error instanceof Error ? error.message : String(error) }
    info.message = scrubLine(info.message, knownSecrets)
    if (info.hint) info.hint = scrubLine(info.hint, knownSecrets, 400)
    return info
  }

  /**
   * The secret for `next`: a new one from the input, else the stored one only for the very same
   * base URL (path included) and token ID. Never a token entered for another server.
   */
  async function secretFor(next: ConnectionConfig, current: ConnectionConfig | null, input: ConnectionInput) {
    const fresh = cleanSecret(input.secret)
    if (fresh) {
      knownSecrets.add(fresh)
      return fresh
    }
    if (current && sameEndpoint(current, next)) return readSecret(current)
    return null
  }

  orca.panels.handle('config.get', () => configAnswer())

  orca.panels.handle('config.dismissImport', async () => {
    await orca.storage.set(IMPORT_STATUS_KEY, null).catch(() => undefined)
    return configAnswer()
  })

  // Saved or removed by hand: an earlier import's outcome no longer applies.
  orca.panels.handle('config.save', async (input) => {
    await withConfigLock(async () => {
      configEpoch += 1
      await saveConnection(input)
      await orca.storage.set(IMPORT_STATUS_KEY, null).catch(() => undefined)
    })
    return configAnswer()
  })

  /** Saves a connection as the Settings form does: new revision, sealed and bound secret, switch. */
  /** A client for reading the estate: through the connection's SSH tunnel when it has one. */
  function clientFor(c: ConnectionConfig, secret: string): ProxmoxClient {
    const tunnel = c.tunnel
    return new ProxmoxClient({ connection: c, secret, transport, probe, ...(tunnel ? { route: () => tunnels().ensure(connectionScope(c), tunnel) } : {}) })
  }

  /**
   * Runs a one-off check (a test in Settings, an import) with a client for `c`: directly, or
   * through a tunnel started for this check only and stopped after it. A tunnel without a pinned
   * host key learns it (accept-new) and reports it in `seen`, to be shown and saved.
   */
  async function checkWith<T>(c: ConnectionConfig, secret: string, seen: { sshHostKey?: SshHostKey }, work: (client: ProxmoxClient) => Promise<T>): Promise<T> {
    if (!c.tunnel) return work(new ProxmoxClient({ connection: c, secret, transport, probe }))
    const opened = await tunnels().probe(c.tunnel)
    try {
      if (!c.tunnel.hostKey) {
        if (!opened.hostKey) throw new ApiError({ kind: 'unreachable', message: `SSH did not report the host key of ${c.tunnel.host}` })
        seen.sshHostKey = { key: opened.hostKey, fingerprint: hostKeyFingerprint(opened.hostKey) ?? '', for: `${c.tunnel.host}:${c.tunnel.port}` }
      }
      return await work(new ProxmoxClient({ connection: c, secret, transport, probe, route: async () => opened.connectTo }))
    } finally {
      opened.stop()
    }
  }

  async function saveConnection(input: ConnectionInput): Promise<ConnectionConfig> {
    const list = await loadConnections()
    // An id changes that connection; `new` (or none while there is none) adds one.
    const id = input.id === 'new' || (!input.id && !list.length) ? (list.length ? `c-${randomUUID().slice(0, 8)}` : 'default') : (input.id ?? list[0].id)
    const current = list.find((c) => c.id === id) ?? null
    if (input.id && input.id !== 'new' && !current) throw new InputError('That connection no longer exists; reload Settings.')
    const next: ConnectionConfig = { ...validate(input, id), revision: randomUUID() }
    if (next.tunnel && !next.tunnel.hostKey) throw new InputError('Test the connection first: the test shows the SSH server’s host key to compare, and saving pins it.')
    if (list.some((c) => c.id !== id && c.baseUrl === next.baseUrl)) throw new InputError('Another connection already uses this URL.')
    // One PDM: its remotes keep PDM's ids, which a second PDM could repeat.
    if (next.kind === 'pdm' && list.some((c) => c.id !== id && c.kind === 'pdm')) throw new InputError('There is a PDM connection already; edit it, or remove it first. Add PVE and PBS servers beside it.')
    const fresh = cleanSecret(input.secret)
    if (fresh && (await secretsProtection()) === 'unavailable') {
      throw new InputError('Orca cannot encrypt secrets on this machine (no OS keyring), and this plugin will not store the token in plain text.')
    }
    // Stage the secret under the new configuration's own key first; readers of the current one
    // keep reading theirs. Then switch the configuration in one write.
    const secret = await secretFor(next, current, input)
    if (secret) await orca.secrets.set(secretKey(next), await sealer().seal(secret, binding(next)))
    const nextList = current ? list.map((c) => (c.id === id ? next : c)) : [...list, next]
    try {
      await orca.storage.set(CONNECTIONS_KEY, toJson(nextList) as unknown as JsonValue)
    } catch (error) {
      if (secret) await orca.secrets.delete(secretKey(next)).catch(() => undefined)
      throw error
    }
    await switched(current ? [current] : [])
    log(`Saved the ${KINDS[next.kind]} connection to ${next.baseUrl} as ${next.tokenId}${next.fingerprint ? ' (pinned)' : ''}`)
    return next
  }

  /**
   * Imports the import file if there is one (see importer.ts). The candidate is validated field by
   * field (messages never contain a value) and tested against PDM over its pinned or verified TLS
   * before anything is saved: a file with a wrong pin or an expired token leaves the working
   * connection as it was. The outcome, with what became of the file, goes to the panel and the
   * plugin log (`orca plugin logs`), where an agent can read it; never the file's content.
   */
  let importing: Promise<boolean> | undefined
  /** True when there was a file (imported or refused); a missing file changes no status. */
  function importConnection(trigger: string): Promise<boolean> {
    importing ??= importOnce(trigger)
      .catch(async (error: unknown) => {
        // Never an unhandled rejection: whatever went wrong becomes a refusal.
        await recordImport(false, `The import failed (${error instanceof Error ? error.name : 'error'}); nothing was changed.`)
        return true
      })
      .finally(() => (importing = undefined))
    return importing
  }

  async function importOnce(trigger: string): Promise<boolean> {
    // The generation is taken before the file is even looked at: a save or removal in Settings at
    // any point of the import (reading the file included) wins, and the import then changes
    // neither the connection nor the status beyond saying it was dropped.
    const epoch = configEpoch
    /** Publishes the outcome under the config lock, unless Settings changed meanwhile. */
    const finish = (ok: boolean, message: string, fileFate: string) =>
      withConfigLock(async () => {
        if (epoch !== configEpoch) await recordImport(false, 'The connection was changed in Settings while the file was imported; the import was dropped.', fileFate)
        else await recordImport(ok, message, fileFate)
      })
    const result = await takeImport(importPath ?? importFile(), { platform: importPlatform, uid: typeof process.getuid === 'function' ? process.getuid() : undefined })
    if (result.state === 'none') return false
    const fileFate = cleanupText(result.cleanup)
    if (result.state === 'refused') {
      await finish(false, result.reason, fileFate)
      return true
    }
    try {
      return await useImported(result.connection, fileFate, epoch, trigger, finish)
    } catch (error) {
      // Whatever fails after the file was taken, the status still says what became of it.
      await finish(false, `The import failed (${error instanceof Error ? error.name : 'error'}); nothing was changed.`, fileFate)
      return true
    }
  }

  async function useImported(
    imported: ImportedConnection,
    fileFate: string,
    epoch: number,
    trigger: string,
    finish: (ok: boolean, message: string, fileFate: string) => Promise<void>
  ): Promise<boolean> {
    const result = { connection: imported }
    const { secret, ...fields } = result.connection
    // Known before anything can mention it, so every log and status line masks it exactly.
    if (secret.trim()) knownSecrets.add(secret.trim())
    const problem = importProblem(result.connection)
    if (problem) {
      await finish(false, `${problem} Nothing was changed.`, fileFate)
      return true
    }
    const { tunnel: rawTunnel, ...plain } = fields
    const input: ConnectionInput = { ...plain, kind: plain.kind as SourceKind | undefined, secret, ...(rawTunnel ? { tunnel: rawTunnel as unknown as SshTunnel } : {}) }
    let candidate: ConnectionConfig
    try {
      candidate = { ...validate(input, 'import') }
    } catch (error) {
      await finish(false, `${error instanceof Error ? error.message : 'The connection is not valid.'} Nothing was changed.`, fileFate)
      return true
    }
    // An import cannot show a host key to anyone: it must bring the one already verified.
    if (candidate.tunnel && !candidate.tunnel.hostKey) {
      await finish(false, 'The tunnel has no hostKey: put the SSH server’s verified host key in the file. Nothing was changed.', fileFate)
      return true
    }
    const existing = await loadConnections()
    if (candidate.kind === 'pdm' && existing.some((c) => c.kind === 'pdm' && c.baseUrl !== candidate.baseUrl)) {
      await finish(false, 'There is a PDM connection already: a second one is not imported (remove the current one in Settings first). Nothing was changed.', fileFate)
      return true
    }
    let access: AccessCheck
    try {
      access = await checkWith(candidate, secret.trim(), {}, (client) => createSource(candidate.kind, client, candidate).checkAccess())
    } catch (error) {
      const info = toSourceError(error)
      await finish(
        false,
        `The imported connection did not pass the connection test (${info.kind}: ${info.message})${info.presentedFingerprint ? `; the server presents ${info.presentedFingerprint}` : ''}. The current connection was kept.`,
        fileFate
      )
      return true
    }
    // Commit and status in one step under the lock, so neither can land after a newer manual change.
    await withConfigLock(async () => {
      if (epoch !== configEpoch) {
        await recordImport(false, 'The connection was changed in Settings while the file was imported; the import was dropped.', fileFate)
        return
      }
      // The same URL again replaces that connection; a new one is added beside the others.
      const list = await loadConnections()
      const same = list.find((c) => c.baseUrl === candidate.baseUrl)
      await saveConnection({ ...input, id: same?.id ?? (list.length ? 'new' : undefined) })
      await recordImport(true, `Imported the ${KINDS[candidate.kind]} connection to ${candidate.baseUrl} as ${candidate.tokenId}${candidate.fingerprint ? ', pinned' : ''} (${trigger}). Connection test: ${KINDS[candidate.kind]} ${access.version}, ${access.remotes} ${access.unit ?? 'remotes'} visible.`, fileFate)
    })
    return true
  }

  /** What is wrong with an imported connection, by field and without any value; else undefined. */
  function importProblem(c: { baseUrl: string; tokenId: string; fingerprint: string; secret: string; kind?: string; name?: string }): string | undefined {
    const problems: string[] = []
    if (c.kind !== undefined && !['pdm', 'pve', 'pbs'].includes(c.kind)) problems.push('kind is not pdm, pve or pbs')
    if (c.name !== undefined && c.name !== '' && ((c.kind ?? 'pdm') === 'pdm' || !NAME.test(c.name))) problems.push('name is not a plain name, or is given for a PDM connection')
    try {
      normalizeBaseUrl(c.baseUrl)
    } catch {
      problems.push('baseUrl is not an https:// URL of a server')
    }
    if (!TOKEN_ID.test(c.tokenId.trim())) problems.push('tokenId does not look like user@realm!tokenname')
    if (c.fingerprint.trim() && !normalizeFingerprint(c.fingerprint)) problems.push('fingerprint is not a SHA-256 fingerprint')
    const secret = c.secret.trim()
    if (!secret) problems.push('secret is empty')
    else if (/[\s\x00-\x1f]/.test(secret) || secret.length > 512) problems.push('secret has spaces, control characters or is too long')
    return problems.length ? `The import file was not imported: ${problems.join('; ')}.` : undefined
  }

  /**
   * Manual saves, removals and import commits run one at a time; manual ones advance the epoch,
   * so an import that started before them does not undo them.
   */
  let configEpoch = 0
  let configChain: Promise<unknown> = Promise.resolve()
  function withConfigLock<T>(work: () => Promise<T>): Promise<T> {
    const run = configChain.then(work, work)
    configChain = run.catch(() => undefined)
    return run
  }

  /**
   * The reason is capped; what became of the file is kept whole and apart, so the path of any
   * plaintext left behind is never cut off by a long URL or diagnostic.
   */
  async function recordImport(ok: boolean, message: string, file?: string): Promise<void> {
    const status: ImportStatus = { at: clock(), ok, message: scrubLine(message, knownSecrets, 400) }
    // Exact paths matter here (the person may have to delete a file by hand): only the known
    // secret values are masked, never generic patterns that a folder name could match.
    if (file) status.file = maskKnown(file)
    log(`Import: ${status.message}`)
    if (status.file) orca.log(`Import file: ${status.file}`)
    await orca.storage.set(IMPORT_STATUS_KEY, status as unknown as JsonValue).catch(() => undefined)
  }

  orca.panels.handle('config.import', async () => {
    const found = await importConnection('panel')
    return { ...(await configAnswer()), found }
  })
  orca.commands.register('proxmox.importConnection', async () => {
    if (!(await importConnection('command'))) return `No import file at ${importPath ?? importFile()}.`
    const status = (await orca.storage.get(IMPORT_STATUS_KEY)) as unknown as ImportStatus | null
    return status?.message ?? 'Imported.'
  })
  // The path is logged (it holds nothing secret) so an agent finds it with `orca plugin logs`.
  orca.log(maskKnown(`Connection import file: ${importPath ?? importFile()}`))
  void importConnection('start')

  orca.panels.handle('config.clear', async (input) => {
    const raw = input as { id?: unknown; revision?: unknown } | undefined
    const id = typeof raw?.id === 'string' ? raw.id : ''
    const revision = typeof raw?.revision === 'string' ? raw.revision : undefined
    // Always one named connection, as it was when the removal was confirmed; never "all".
    if (!id) throw new InputError('Name the connection to remove; nothing was removed.')
    await removeConnection(id, revision)
    return configAnswer()
  })

  /** Removes one connection, as it was when the removal was confirmed (its revision). */
  async function removeConnection(id: string, revision: string | undefined): Promise<void> {
    await withConfigLock(async () => {
      const list = await loadConnections()
      const target = list.find((c) => c.id === id)
      if (!target) throw new InputError('That connection no longer exists; nothing was removed.')
      if (target.revision !== revision) throw new InputError('That connection was changed since you confirmed; nothing was removed. Review it and confirm again.')
      configEpoch += 1
      await orca.storage.set(CONNECTIONS_KEY, toJson(list.filter((c) => c !== target)) as unknown as JsonValue)
      await orca.storage.set(IMPORT_STATUS_KEY, null).catch(() => undefined)
      await switched([target])
    })
    log('Removed a connection and its secret')
  }

  orca.panels.handle('connection.test', (input, { signal }) => testConnection(input, signal))

  /** Tries a connection that is not saved (yet): Settings' test, and Connect via Orca's before it saves. */
  async function testConnection(input: ConnectionInput, signal?: AbortSignal): Promise<TestAnswer> {
    const list = await loadConnections()
    const current = input.id && input.id !== 'new' ? (list.find((c) => c.id === input.id) ?? null) : input.id === 'new' ? null : (list[0] ?? null)
    let next: ConnectionConfig
    try {
      next = validate(input, current?.id ?? 'new')
    } catch (error) {
      return { ok: false, error: { kind: 'invalid-config', message: scrubLine((error as Error).message, knownSecrets) } }
    }
    const secret = await secretFor(next, current, input)
    if (!secret) {
      return { ok: false, error: { kind: 'not-configured', message: 'Enter the token secret to test the connection.' } }
    }
    const seen: { sshHostKey?: SshHostKey } = {}
    const target = next
    try {
      const access = await checkWith(target, secret, seen, (client) => createSource(target.kind, client, target).checkAccess(signal))
      log(`Connection test to ${next.baseUrl}${next.tunnel ? ` through SSH to ${next.tunnel.host}` : ''}: ${KINDS[next.kind]} ${access.version}, ${access.remotes} ${access.unit ?? 'remotes'} visible`)
      // Scrubbed like every answer: a server could put anything in what it calls its version.
      return toJson<TestAnswer>(redactDeep({ ok: true, version: scrubLine(access.version, knownSecrets, 40), remotes: access.remotes, ...(access.unit ? { unit: access.unit } : {}), ...(seen.sshHostKey ? { sshHostKey: seen.sshHostKey } : {}) }, [...knownSecrets]))
    } catch (error) {
      const info = toSourceError(error)
      log(`Connection test to ${next.baseUrl} failed: ${info.kind}: ${info.message}`)
      return toJson<TestAnswer>({ ok: false, error: info, ...(seen.sshHostKey ? { sshHostKey: seen.sshHostKey } : {}) })
    }
  }

  const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  /** Placements only make sense on the estate they were made on: kept per PDM base URL. */
  async function loadLinks(baseUrl: string): Promise<OrcaLinks> {
    const all = await orca.storage.get(ORCA_LINKS_BY_ESTATE_KEY)
    let raw: unknown = isRecord(all) ? all[baseUrl] : undefined
    if (!isRecord(raw)) {
      // Placements from before they were kept per estate: given to the first estate that reads
      // them and removed, so they never apply to another one.
      const legacy = await orca.storage.get(ORCA_LINKS_KEY)
      if (isRecord(legacy)) {
        raw = legacy
        await orca.storage.set(ORCA_LINKS_BY_ESTATE_KEY, { ...(isRecord(all) ? (all as Record<string, JsonValue>) : {}), [baseUrl]: legacy as JsonValue })
        await orca.storage.set(ORCA_LINKS_KEY, null)
      }
    }
    const links: OrcaLinks = {}
    if (isRecord(raw)) for (const [k, v] of Object.entries(raw)) if (typeof v === 'string' && parseLink(v) !== undefined) links[k] = v
    return links
  }

  /** The panel's action is for the estate it shows: refused when that is not the current one. */
  function requireScope(scope: unknown, list: readonly ConnectionConfig[]): void {
    if (!list.length || typeof scope !== 'string' || scope !== estateScope(list)) {
      throw new InputError('The connection changed since this view was loaded; it is refreshed now, try again.')
    }
  }

  orca.panels.handle('orca.link', async ({ hostKey, link, scope }) => {
    if (typeof hostKey !== 'string' || !hostKey) throw new InputError('hostKey is required')
    if (link !== null && parseLink(link) === undefined) throw new InputError('link must be node:<key>, guest:<key>, none or null')
    const list = await loadConnections()
    if (!list.length) throw new InputError('Connect to Proxmox first.')
    requireScope(scope, list)
    const key = linksKey(list)
    const links = { ...(await loadLinks(key)) }
    if (link === null) delete links[hostKey]
    else links[hostKey] = link
    const all = await orca.storage.get(ORCA_LINKS_BY_ESTATE_KEY)
    await orca.storage.set(ORCA_LINKS_BY_ESTATE_KEY, { ...(isRecord(all) ? (all as Record<string, JsonValue>) : {}), [key]: links })
    await orca.storage.set(ORCA_LINKS_KEY, null)
    latest = undefined
    return { links }
  })

  async function rememberTerminal(opened: OpenedTerminal): Promise<void> {
    const stored = await orca.storage.get(TERMINALS_KEY)
    const list = Array.isArray(stored) ? (stored as OpenedTerminal[]) : []
    await orca.storage.set(TERMINALS_KEY, toJson([...list, opened].slice(-20)))
  }

  /** The newest estate with Orca placed on it, for the terminal action. */
  let latest: EstateSnapshot | undefined
  let loop: Background | undefined

  async function loadEstate(force?: boolean, retry = true): Promise<EstateResponse> {
    const started = generation
    const answer = await readEstate(force, started)
    // The configuration changed meanwhile: this answer belongs to the old one. Read again once.
    if (started !== generation) {
      if (retry) return loadEstate(force, false)
      return { state: 'error', refreshSeconds: DEFAULT_SETTINGS.refreshSeconds, error: { kind: 'unreachable', message: 'The connection changed during the refresh; refresh again.' } }
    }
    return answer
  }

  async function readEstate(force: boolean | undefined, started: number): Promise<EstateResponse> {
    const settings = await loadSettings()
    const list = await loadConnections()
    if (!list.length) return { state: 'unconfigured', refreshSeconds: settings.refreshSeconds }
    return asReaders(list, () => readEstateOf(list, settings, force, started))
  }

  /**
   * One connection is read as before; several are read as one estate (composite.ts), where a
   * connection without its secret becomes an unreachable remote rather than failing the rest.
   */
  async function readEstateOf(list: ConnectionConfig[], settings: PluginSettings, force: boolean | undefined, started: number): Promise<EstateResponse> {
    const refreshSeconds = settings.refreshSeconds
    const noSecret: SourceError = { kind: 'not-configured', message: 'No token secret is stored for this connection.', hint: 'Open Settings in this panel and enter the token secret.' }
    const parts: Part[] = []
    const failed: FailedPart[] = []
    // Only the current configuration's tunnels run: a changed or removed connection's is stopped.
    // Only a refresh of the current configuration decides; an older one changes nothing (switched() retains).
    if (!stopped && started === generation && (tunnelManager || list.some((c) => c.tunnel))) tunnels().retain(new Set(list.filter((c) => c.tunnel).map(connectionScope)))
    for (const c of list) {
      const secret = await readSecret(c)
      if (secret) parts.push({ connection: c, source: createSource(c.kind, clientFor(c, secret), c) })
      else failed.push({ connection: c, reason: noSecret.message })
    }
    if (!parts.length) return { state: 'error', refreshSeconds, error: list.length > 1 ? { ...noSecret, message: 'No token secret is stored for these connections.' } : noSecret }
    // An enrich-only connection alone adds to nothing: it still goes through the composite, which says so.
    const single = list.length === 1 && !list[0].enrichOnly
    const connection: ConnectionConfig = single ? list[0] : { id: estateScope(list), kind: parts[0].source.kind, baseUrl: linksKey(list), tokenId: '', fingerprint: '' }
    const source = single ? parts[0].source : new CompositeSource(parts, failed, enrichBindings)
    const pdmUrl = list.find((c) => c.kind === 'pdm')?.baseUrl
    try {
      const snapshot = await estate.get(source, connection, settings, {
        force,
        // Half the interval, so a panel polling on that interval always gets a fresh read.
        maxAgeMs: Math.max(5000, (refreshSeconds * 1000) / 2)
      })
      let built: EstateSnapshot = { ...snapshot, ...(pdmUrl ? { pdmUrl } : {}) }
      if (settings.orcaAwareness) {
        const orcaAnswer = await orcaView.view(snapshot, await loadLinks(linksKey(list)), force)
        if (orcaAnswer.error) log(`Orca inventory: ${orcaAnswer.error}`)
        built = { ...built, orca: orcaAnswer }
      }
      // Only the current configuration's estate becomes the terminal action's target.
      if (started === generation) latest = built
      return toJson<EstateResponse>({ state: 'ok', snapshot: outboundSnapshot(built, [...knownSecrets]), refreshSeconds })
    } catch (error) {
      if (error instanceof StaleRefreshError || started !== generation) {
        return { state: 'error', refreshSeconds, error: { kind: 'unreachable', message: 'The connection changed during the refresh.' } }
      }
      const info = toSourceError(error)
      log(`Refresh from ${list.map((c) => c.baseUrl).join(', ')} failed: ${info.kind}: ${info.message}`)
      const lastGood = estate.lastGood
      return toJson<EstateResponse>({
        state: 'error',
        error: info,
        lastGood: lastGood?.connectionId === estateScope(list) ? outboundSnapshot(lastGood, [...knownSecrets]) : undefined,
        refreshSeconds
      })
    }
  }

  orca.panels.handle('estate.get', (input) => loadEstate(input?.force))

  orca.panels.handle('orca.terminal', async ({ hostKey, title, scope }) => {
    if (typeof hostKey !== 'string' || !hostKey) throw new InputError('hostKey is required')
    requireScope(scope, await loadConnections())
    if (!latest) await loadEstate(false)
    // The target must come from the estate the panel showed, not one loaded since.
    if (latest?.connectionId !== scope) throw new InputError('The connection changed since this view was loaded; it is refreshed now, try again.')
    const plan = terminalPlan(hostKey, latest?.orca, latest, typeof title === 'string' ? title : undefined)
    if ('error' in plan) throw new InputError(plan.error)
    const run = (cliRunner ?? nodeCliRunner)()
    // Created on a server, a terminal is often only a background handle: Orca opens no tab for it
    // until something switches to it. So switch, and only call it shown when Orca navigated there.
    const created = (await run(plan.args, 30000)) as { terminal?: { handle?: string } } | null
    const handle = created?.terminal?.handle
    let navigated = false
    if (handle) {
      try {
        const shown = (await run(switchArgs(handle, plan.environment), 20000)) as { focus?: { navigated?: boolean } } | null
        navigated = shown?.focus?.navigated === true
      } catch (error) {
        log(`Could not switch to the terminal for ${hostKey}: ${error instanceof Error ? error.message : String(error)}`)
      }
      await rememberTerminal({ handle, environment: plan.environment, hostKey, at: clock() })
    }
    log(`Opened a terminal (${plan.how}) for ${hostKey}, ${navigated ? 'shown' : 'not shown'}`)
    return { how: plan.how, navigated, where: plan.where }
  })

  // Connect via Orca (setup/service.ts).
  // Setup records are sealed like secrets, bound to their host and run: the panel can read and
  // write plugin storage, but cannot forge or alter one.
  const recordBinding = (hostKey: string, runId: string): Binding => ({ id: 'setup-record', kind: 'setup', baseUrl: hostKey, tokenId: runId, fingerprint: '' })
  /** A connection the setup is about to save, checked like the Settings form's. */
  const setupConnection = (input: ConnectionInput) => {
    const c = validate(input, 'new')
    const secret = cleanSecret(input.secret)
    if (!secret) throw new InputError('No secret for this connection')
    return { c, secret }
  }
  const setup = new SetupService({
    cli: () => (cliRunner ?? nodeCliRunner)(),
    storage: { get: (key) => orca.storage.get(key), set: (key, value) => orca.storage.set(key, value as JsonValue) },
    sealRecord: (hostKey, runId, plain) => sealer().seal(plain, recordBinding(hostKey, runId)),
    openRecord: (hostKey, runId, sealed) => sealer().open(sealed, recordBinding(hostKey, runId)),
    privileges: async (input) => {
      const { c, secret } = setupConnection(input)
      const answer = await checkWith(c, secret, {}, (client) => client.get<unknown>('/access/permissions'))
      return privilegeNames(answer)
    },
    connections: loadConnections,
    test: (input) => testConnection(input),
    save: (input) =>
      withConfigLock(async () => {
        configEpoch += 1
        return saveConnection(input)
      }),
    remove: (c) => removeConnection(c.id, c.revision),
    pdmCovers: async (node) => {
      const list = await loadConnections()
      if (!list.some((c) => c.kind === 'pdm')) return false
      if (!latest) await loadEstate(false).catch(() => undefined)
      const direct = new Set(list.filter((c) => c.kind !== 'pdm').map((c) => c.name))
      return !!latest?.hosts.some((h) => h.remoteType === 'pve' && h.node === node && !direct.has(h.remote))
    },
    secretSeen: (secret) => knownSecrets.add(secret),
    log,
    now: () => clock(),
    sleep: (ms) => sleep(ms)
  })
  /** Setup answers leave like every other: known secrets masked, server text scrubbed. */
  const outbound = <T extends object>(answer: T): T => {
    const out = redactDeep(answer, [...knownSecrets]) as T & { message?: unknown }
    if (typeof out.message === 'string') out.message = scrubLine(out.message, knownSecrets, 600)
    return toJson(out)
  }
  const setupError = (error: unknown): never => {
    if (error instanceof Error && 'code' in error && error.code === 'invalid_params') throw new InputError(scrubLine(error.message, knownSecrets, 400))
    throw new Error(scrubLine(error instanceof Error ? error.message : String(error), knownSecrets, 400))
  }
  const hostKeyOf = (input: unknown) => {
    const key = isRecord(input) && typeof input.hostKey === 'string' ? input.hostKey : ''
    if (!/^(ssh|env):[A-Za-z0-9._:-]{1,120}$/.test(key)) throw new InputError('hostKey must name an Orca SSH target or paired server')
    return key
  }
  orca.panels.handle('setup.hosts', () => setup.hosts().then(outbound, setupError))
  orca.panels.handle('setup.detect', (input) => setup.detect(hostKeyOf(input)).then(outbound, setupError))
  orca.panels.handle('setup.plan', (input) => setup.plan({ ...input, hostKey: hostKeyOf(input) }).then(outbound, setupError))
  orca.panels.handle('setup.undoPlan', (input) => setup.undoPlan(hostKeyOf(input), typeof input.runId === 'string' ? input.runId : '').then(outbound, setupError))
  orca.panels.handle('setup.run', (input) => setup.run(typeof input.planId === 'string' ? input.planId : '', hostKeyOf(input)).then(outbound, setupError))
  orca.panels.handle('setup.job', async (input) => {
    try {
      return outbound(setup.job(typeof input.jobId === 'string' ? input.jobId : ''))
    } catch (error) {
      return setupError(error)
    }
  })
  // The status-bar item runs this: show the panel (Orca's plugin API cannot, its CLI can).
  orca.commands.register('proxmox.openPanel', async () => {
    const run = (cliRunner ?? nodeCliRunner)()
    const list = (await run(['plugin', 'list'], 20000)) as { plugins?: { pluginKey?: string }[] }
    const key = (Array.isArray(list?.plugins) ? list.plugins : [])
      .map((p) => p?.pluginKey)
      .find((k): k is string => typeof k === 'string' && /^[a-z0-9][a-z0-9.-]*\.proxmox-visualizer$/.test(k))
    if (!key) return 'The Proxmox plugin was not found.'
    await run(['plugin', 'open', key, '--panel=proxmox'], 20000)
    return 'Opened the Proxmox panel.'
  })

  if (!background) return
  loop = new Background({
    load: () => loadEstate(false),
    settings: loadSettings,
    statusBar: async (line) => {
      if (!orca.host.has('statusBar.update')) return
      await orca.host.call('statusBar.update', { id: 'estate', text: line.text, tooltip: line.tooltip, tone: line.tone, visible: line.visible })
    },
    notify: async (title, body) => {
      if (orca.host.has('notifications.show')) {
        await orca.host.call('notifications.show', { title: scrubLine(title, knownSecrets, 120), body: scrubLine(body, knownSecrets, 300) })
      }
    },
    readState: async () => (await orca.storage.get(ALERT_STATE_KEY)) as AlertState | null,
    writeState: (state) => orca.storage.set(ALERT_STATE_KEY, state as unknown as JsonValue),
    log
  })
  const tick = async () => {
    try {
      await loop?.tick()
    } catch (error) {
      log(`Background refresh: ${error instanceof Error ? error.message : String(error)}`)
    }
    const seconds = Math.max(30, (await loadSettings().catch(() => DEFAULT_SETTINGS)).refreshSeconds)
    // A tick that was awaiting I/O when the worker was deactivated does not start another.
    if (stopped) return
    timer = setTimeout(() => void tick(), seconds * 1000)
  }
  stopped = false
  timer = setTimeout(() => void tick(), 3000)
}

let timer: ReturnType<typeof setTimeout> | undefined
let stopped = false

/** Orca awaits this before stopping the worker. */
export function deactivate(): void {
  stopped = true
  tunnelManager?.stopAll()
  clearTimeout(timer)
  timer = undefined
}
