// Worker answers for panel tests and `orca plugin check`, built by the real PDM source and
// EstateService over the recorded PDM answers, so the panel is checked against real shapes.
import { EstateService } from '../../src/estate'
import { DEFAULT_SETTINGS, type ConnectionConfig, type EstateSnapshot } from '../../src/model'
import type { ConfigAnswer } from '../../src/protocol'
import { ProxmoxClient } from '../../src/proxmox/client'
import { createSource } from '../../src/proxmox/source'
import { mockTransport, pdmRoutes } from './pdm'
import { RECORDED_AT, recordedRoutes } from './recorded-pdm'
import { RENAMED_AT } from './recorded-pdm-renamed'
import { exampleRoutes } from './extras'
import { recordedOrcaCli } from './orca-cli'
import type { CliRunner } from '../../src/orca/inventory'
import type { OrcaLinks } from '../../src/orca/match'
import { OrcaService } from '../../src/orca/service'

/** Answers `orca <args> --json` from the recorded CLI output; an unknown command fails like the CLI. */
export function recordedCli(overrides: Record<string, unknown> = {}): CliRunner & { calls: string[][] } {
  const calls: string[][] = []
  const run = (async (args: string[]) => {
    calls.push(args)
    // The plugin names paired servers by id (`--environment=<id>`); the recordings by name.
    const envs = (recordedOrcaCli as unknown as { 'environment list': { result: { environments: { id: string; name: string }[] } } })['environment list'].result.environments
    const named = args.map((a) => (a.startsWith('--environment=') ? `--environment ${envs.find((e) => e.id === a.slice(14))?.name ?? a.slice(14)}` : a))
    const key = named.join(' ')
    if (key in overrides) {
      const value = overrides[key]
      if (value instanceof Error) throw value
      return value
    }
    const cli = recordedOrcaCli as unknown as Record<string, { result: unknown }> & { 'worktree ps': Record<string, { result: unknown }> }
    if (args[0] === 'worktree' && args[1] === 'ps') return cli['worktree ps'][named[2]?.slice('--environment '.length) ?? 'local'].result
    if (key in cli) return cli[key].result
    throw new Error(`unknown command: ${key}`)
  }) as unknown as CliRunner & { calls: string[][] }
  run.calls = calls
  return run
}

/** Fails on anything Orca refuses in an answer: undefined fields, NaN, Infinity, non-plain objects. */
export function assertPlainJson(value: unknown, path = 'answer'): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${path} is ${value}`)
    return
  }
  if (Array.isArray(value)) return value.forEach((item, i) => assertPlainJson(item, `${path}[${i}]`))
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, item] of Object.entries(value)) assertPlainJson(item, `${path}.${key}`)
    return
  }
  throw new Error(`${path} is not JSON: ${typeof value}`)
}

export const FIXTURE_PIN =
  'EC:7A:EF:38:FF:F7:59:92:C1:E3:B0:4C:1D:22:FF:C9:67:C6:91:C8:74:48:53:13:12:1A:C0:42:D1:5B:37:05'

export const fixtureConnection: ConnectionConfig = {
  id: 'default',
  kind: 'pdm',
  baseUrl: 'https://pdm.example.test:8443',
  tokenId: 'monitor@pdm!orca',
  fingerprint: FIXTURE_PIN
}

export function fixtureConfig(configured: boolean): ConfigAnswer {
  return {
    connections: configured ? [{ ...fixtureConnection, hasSecret: true }] : [],
    connection: configured ? { ...fixtureConnection, hasSecret: true } : null,
    secretsProtection: 'os-keyring',
    settings: DEFAULT_SETTINGS,
    importPath: '~/.config/orca-proxmox-visualizer/connection-import.json',
    importStatus: null
  }
}

/** The estate from a real, scrubbed PDM recording (test/fixtures/recorded-pdm.ts), as of then. */
export function recordedEstate(): Promise<EstateSnapshot> {
  return build(recordedRoutes, RECORDED_AT)
}

export function fixtureEstate(now = Date.now()): Promise<EstateSnapshot> {
  return build(pdmRoutes(now), now)
}

/**
 * The estate after the server rename (test/fixtures/recorded-pdm-renamed.ts) with Orca's recorded
 * hosts, bots and workspaces placed on it, as the worker answers it.
 */
export async function renamedEstate(links: OrcaLinks = {}): Promise<EstateSnapshot> {
  const snapshot = await build(exampleRoutes(RENAMED_AT), RENAMED_AT, true)
  const orca = await new OrcaService(() => recordedCli(), () => RENAMED_AT).view(snapshot, links)
  return JSON.parse(JSON.stringify({ ...snapshot, pdmUrl: fixtureConnection.baseUrl, orca })) as EstateSnapshot
}

async function build(routes: Record<string, unknown>, now: number, orcaAwareness = false): Promise<EstateSnapshot> {
  const client = new ProxmoxClient({
    connection: fixtureConnection,
    secret: 'fixture-secret',
    transport: mockTransport(routes),
    probe: async () => null
  })
  const snapshot = await new EstateService(() => now).get(createSource('pdm', client), fixtureConnection, { ...DEFAULT_SETTINGS, orcaAwareness }, {
    maxAgeMs: 0
  })
  // As it crosses from the worker to the panel: JSON, so absent fields are dropped.
  return JSON.parse(JSON.stringify(snapshot)) as EstateSnapshot
}

/** The example PVE cluster and PBS reached directly, beside the PDM estate (fixtures/direct.ts). */
export const directConnections: ConnectionConfig[] = [
  { id: 'c-lab', kind: 'pve', name: 'lab', baseUrl: 'https://pve.example.test:8006', tokenId: 'monitor@pve!orca', fingerprint: FIXTURE_PIN, revision: 'example-2' },
  { id: 'c-backup', kind: 'pbs', name: 'backup-x', baseUrl: 'https://pbs.example.test:8007', tokenId: 'monitor@pbs!orca', fingerprint: FIXTURE_PIN, revision: 'example-3' }
]

/**
 * PDM plus a PVE and a PBS reached directly, read as one estate, as the worker answers it, with
 * the Settings answer that goes with it: for the harness and the screenshots.
 */
export async function mixedEstate(): Promise<{ snapshot: EstateSnapshot; config: ConfigAnswer }> {
  const { pveRoutes, pbsRoutes } = await import('./direct')
  const { CompositeSource } = await import('../../src/proxmox/composite')
  const { estateScope } = await import('../../src/model')
  const pdmConnection = { ...fixtureConnection, revision: 'example-1' }
  const connections = [pdmConnection, ...directConnections]
  const routes: Record<string, Record<string, unknown>> = {
    'pdm.example.test:8443': exampleRoutes(RENAMED_AT),
    'pve.example.test:8006': pveRoutes(RENAMED_AT),
    'pbs.example.test:8007': pbsRoutes(RENAMED_AT)
  }
  const parts = connections.map((connection) => {
    const transport = mockTransport(routes[new URL(connection.baseUrl).host] as never)
    const client = new ProxmoxClient({ connection, secret: 'fixture-secret', transport, probe: async () => null })
    return { connection, source: createSource(connection.kind, client, connection) }
  })
  const scope = estateScope(connections)
  const scopeConnection: ConnectionConfig = { id: scope, kind: 'pdm', baseUrl: connections.map((c) => c.baseUrl).sort().join(' '), tokenId: '', fingerprint: '' }
  const snapshot = await new EstateService(() => RENAMED_AT).get(new CompositeSource(parts), scopeConnection, { ...DEFAULT_SETTINGS, orcaAwareness: true }, { maxAgeMs: 0 })
  const orca = await new OrcaService(() => recordedCli(), () => RENAMED_AT).view(snapshot, {})
  const views = connections.map((c) => ({ ...c, hasSecret: true }))
  return {
    snapshot: JSON.parse(JSON.stringify({ ...snapshot, pdmUrl: fixtureConnection.baseUrl, orca })) as EstateSnapshot,
    config: { connections: views, connection: views[0], secretsProtection: 'os-keyring', settings: DEFAULT_SETTINGS, importPath: '~/.config/orca-proxmox-visualizer/connection-import.json', importStatus: null }
  }
}
