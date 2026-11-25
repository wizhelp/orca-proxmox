// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
// Nothing here ever carries the token secret back to the panel.
import type { ConnectionView, EstateResponse, PluginSettings, SourceError } from './model'

export type ConnectionInput = {
  baseUrl: string
  tokenId: string
  fingerprint: string
  /** A new secret; empty keeps the stored one (only while the base URL's origin is unchanged). */
  secret?: string
}

export type SecretsProtection = 'os-keyring' | 'unavailable' | 'unknown'

/** The last import from the import file: when, whether it worked, and why not. Never its content. */
/**
 * The last import from the import file: when, whether it worked and why not (`message`, capped),
 * and what became of the file (`file`, never cut: it names any path where the secret may remain).
 */
export type ImportStatus = { at: number; ok: boolean; message: string; file?: string }

export type ConfigAnswer = {
  connection: ConnectionView | null
  secretsProtection: SecretsProtection
  settings: PluginSettings
  /** Where an agent or script puts a connection to import (see docs/AGENT_SETUP.md). */
  importPath: string
  importStatus: ImportStatus | null
}

export type TestAnswer =
  | { ok: true; version: string; remotes: number }
  | { ok: false; error: SourceError }

declare module 'orca' {
  interface PluginRequests {
    /** The saved connection (without its secret), secret storage status and settings. */
    'config.get': { output: ConfigAnswer }
    /** Validates and saves the connection; the secret goes to Orca's encrypted secrets. */
    'config.save': { input: ConnectionInput; output: ConfigAnswer }
    /** Removes the connection and its stored secret. */
    'config.clear': { output: ConfigAnswer }
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
