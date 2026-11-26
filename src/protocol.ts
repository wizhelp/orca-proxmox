// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
// Nothing here ever carries the token secret back to the panel.
import type { ConnectionView, EstateResponse, PluginSettings, SourceError, SourceKind, SshTunnel } from './model'

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
  /** Reach a direct connection through an SSH tunnel (`hostKey` empty until a test showed it). */
  tunnel?: SshTunnel
  /** A direct PVE that only adds to PDM's guests and nodes (see ConnectionConfig). */
  enrichOnly?: boolean
  /** For enrich only: node name here -> node (or `remote/node`) in PDM. */
  nodeMap?: Record<string, string>
}

/** The SSH server's host key a test saw (learnt, when none was pinned): to compare and save. */
export type SshHostKey = { key: string; fingerprint: string; /** The SSH server tested, `host:port`: the key is for it only. */ for: string }

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
  | { ok: true; version: string; remotes: number; unit?: 'nodes' | 'datastores'; sshHostKey?: SshHostKey }
  | { ok: false; error: SourceError; sshHostKey?: SshHostKey }

/** What the read-only check found on an Orca host (values as the host said them, cleaned). */
export type SetupDetection = {
  at: number
  /** The shell's user is root, may use `sudo -n`, or neither (then nothing can be set up). */
  root: 'yes' | 'sudo' | 'no'
  /** Installed product versions. */
  products: { pve?: string; pbs?: string; pdm?: string }
  sshd: boolean
  hostname: string
  fqdn?: string
  /** From the shell's SSH_CONNECTION: the address it was reached at, and where from. */
  via?: { client: string; server: string; port: number }
}

/**
 * A setup run the plugin recorded (sealed, before it ran): its last known state. `pending` and
 * `unknown`: what happened on the host is not known; Undo works from the host's own record.
 */
export type SetupRecord = { product: 'pve' | 'pbs'; runId: string; at: number; tunnel: boolean; status: 'pending' | 'unknown' | 'stopped' | 'failed' | 'saved'; message?: string; connectionId?: string }

/** An Orca host for "Connect via Orca". */
export type SetupHost = {
  key: string
  name: string
  kind: 'ssh' | 'environment'
  connected?: boolean
  /** Where its scripts run (a workspace of it), or why they cannot. */
  where?: string
  unavailable?: string
  detection?: SetupDetection
  records: SetupRecord[]
}

/** `ignoredRecords`: stored records that did not open with the worker's key or were altered. */
export type SetupHostsAnswer = { hosts: SetupHost[]; error?: string; busy: boolean; ignoredRecords?: number }

/** What Connect or Undo will run, shown in full before anything runs; `planId` runs it once. */
export type SetupPlan = {
  planId: string
  action: 'setup' | 'undo'
  hostKey: string
  hostName: string
  where: string
  /** The exact script, as it will run on the host. */
  script: string
  /** What it does, in a few lines. */
  summary: string[]
  expiresAt: number
  /** The connection that will be saved (setup only). */
  connection?: { kind: 'pve' | 'pbs'; name: string; baseUrl: string; tokenId: string; enrichOnly: boolean; tunnel?: string }
}

export type SetupPlanInput = { hostKey: string; product: 'pve' | 'pbs'; tunnel: boolean; replace: boolean; address: string; name: string }

export type SetupRunAnswer = {
  ok: boolean
  /** How far it got. */
  stage: 'script' | 'secret' | 'test' | 'rights' | 'scope' | 'save' | 'saved' | 'undone'
  /** What is known of the result: `unknown` when the host's answer was not seen complete. */
  outcome: 'saved' | 'undone' | 'stopped' | 'failed' | 'unknown'
  message: string
  test?: TestAnswer
  /** What the host reported it did, step by step (no values). */
  steps: string[]
  /** An Undo is available for what was created. */
  undo: boolean
}

/** A started setup or Undo: still running, or how it ended. */
export type SetupJobAnswer = { running: true } | { running: false; answer: SetupRunAnswer }

declare module 'orca' {
  interface PluginRequests {
    /** The saved connection (without its secret), secret storage status and settings. */
    'config.get': { output: ConfigAnswer }
    /** Validates and saves the connection; the secret goes to Orca's encrypted secrets. */
    'config.save': { input: ConnectionInput; output: ConfigAnswer }
    /**
     * Removes one connection and its stored secret: `id` names it and `revision` must be its
     * current one, so a confirmation given for an earlier configuration removes nothing.
     */
    'config.clear': { input: { id: string; revision?: string }; output: ConfigAnswer }
    /** Forgets the last import's outcome (the panel's dismiss button). */
    'config.dismissImport': { output: ConfigAnswer }
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
    /** Orca's servers, for "Connect via Orca", with what a check found and what was set up. */
    'setup.hosts': { output: SetupHostsAnswer }
    /** Runs the read-only check on one host (in a terminal of it, closed again). */
    'setup.detect': { input: { hostKey: string }; output: SetupHostsAnswer }
    /** The exact setup script for a host, to show before it runs. */
    'setup.plan': { input: SetupPlanInput; output: SetupPlan }
    /** The exact Undo script for one recorded setup run on a host. */
    'setup.undoPlan': { input: { hostKey: string; runId: string }; output: SetupPlan }
    /** Starts a shown plan, once, before it expires, as a background job. */
    'setup.run': { input: { planId: string; hostKey: string }; output: { jobId: string } }
    /** A started job: still running, or its answer. */
    'setup.job': { input: { jobId: string }; output: SetupJobAnswer }
    /** The estate, refreshed when older than the refresh interval or when `force` is set. */
    'estate.get': { input: { force?: boolean }; output: EstateResponse }
  }
}
