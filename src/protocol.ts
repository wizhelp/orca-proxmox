// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
// Nothing here ever carries the token secret back to the panel.
import type { ConnectionView, EstateResponse, PluginSettings, SourceError, SourceKind } from './model'

export type ConnectionInput = {
  /** Which connection: an existing id to change it, `new` to add one; absent means the first (or a new one). */
  id?: string
  /** PDM (default), or a Proxmox VE or Backup Server reached directly. */
  kind?: SourceKind
  /** A direct connection's name in the estate (letters, digits, `.`, `_`, `-`); else the server's own. */
  name?: string
  baseUrl: string
  tokenId: string
  fingerprint: string
  /** A new secret; empty keeps the stored one (only for the same URL, token and pin). */
  secret?: string
}

export type SecretsProtection = 'os-keyring' | 'unavailable' | 'unknown'

/**
 * The last import from the import file: when, whether it worked and why not (`message`, capped),
 * and what became of the file (`file`, never cut: it names any path where the secret may remain).
 */
export type ImportStatus = { at: number; ok: boolean; message: string; file?: string }

export type ConfigAnswer = {
  /** Every saved connection (PDM, PVE, PBS), without secrets. */
  connections: ConnectionView[]
  /** The first of them, for older callers. */
  connection: ConnectionView | null
  secretsProtection: SecretsProtection
  settings: PluginSettings
  /** Where an agent or script puts a connection to import (see docs/AGENT_SETUP.md). */
  importPath: string
  importStatus: ImportStatus | null
}

export type TestAnswer =
  | { ok: true; version: string; remotes: number; unit?: 'nodes' | 'datastores' }
  | { ok: false; error: SourceError }

declare module 'orca' {
  interface PluginRequests {
    /** The saved connection (without its secret), secret storage status and settings. */
    'config.get': { output: ConfigAnswer }
    /** Validates and saves the connection; the secret goes to Orca's encrypted secrets. */
    'config.save': { input: ConnectionInput; output: ConfigAnswer }
    /** Removes one connection (`id`) and its stored secret, or all of them. */
    'config.clear': { input: { id?: string }; output: ConfigAnswer }
    /** Imports the import file now, if there is one. */
    'config.import': { output: ConfigAnswer & { found: boolean } }
    /** Tries the given (unsaved) connection: PDM version and how many remotes the token sees. */
    'connection.test': { input: ConnectionInput; output: TestAnswer }
    /**
     * Places an Orca host by hand: `node:<remote/node>`, `guest:<remote/vmid>`, `none` (not on
     * Proxmox), or null to go back to automatic placement.
     */
    /** `scope`: the connectionId of the estate the panel shows; refused when it is not the current one. */
    'orca.link': { input: { hostKey: string; link: string | null; scope: string }; output: { links: Record<string, string> } }
    /**
     * Opens a terminal on the machine an Orca host runs on: in a workspace of its Orca server when
     * it has one, else a local terminal running ssh to it. Answers how it was opened.
     */
    /** Opens a terminal where an Orca host runs; `navigated` when Orca switched to it, else `where` it is. */
    'orca.terminal': { input: { hostKey: string; title?: string; scope: string }; output: { how: 'workspace' | 'ssh'; navigated: boolean; where: string } }
    /** The estate, refreshed when older than the refresh interval or when `force` is set. */
    'estate.get': { input: { force?: boolean }; output: EstateResponse }
  }
}
