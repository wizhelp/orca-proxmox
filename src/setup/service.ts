// "Connect via Orca": sets a Proxmox VE or Backup Server up for the plugin through the Orca
// connection that already reaches it, in place of the guide's manual steps.
//
// 1. Orca's servers (SSH targets, paired servers) are listed; a read-only check, run on one in a
//    terminal of it, says what it runs (PVE, PBS, PDM) and whether the shell may act as root.
// 2. Connect generates the exact script (script.ts) and shows it; nothing runs until the person
//    confirms that very plan (single use, 10 minutes).
// 3. Before anything runs, a record of the run is stored, sealed with the worker's key (the panel
//    can read and write plugin storage, but cannot forge or alter a record). The script runs in a
//    terminal of that host (runner.ts), closed afterwards whatever happens, as a background job the
//    panel polls. It keeps its own durable record on the host, which Undo works from.
// 4. Nothing the terminal says is taken on its word alone: the answer must be complete and match
//    its checksum, else the outcome is reported as unknown. The plugin then checks from this
//    machine what it can: the certificate the host reported is the one the address presents
//    (the connection test pins it), and the token has no right beyond auditing (the API's own
//    permission list, every listed privilege). Only then is the connection saved.
// 5. Undo is bound to one recorded run: its script removes only what that run recorded as made,
//    still labelled with its id, and the plugin removes only the connection revision it saved.
//
// Only the read-only token: an SSH tunnel account stays the guided manual path (AGENT_SETUP).
import { randomBytes } from 'node:crypto'
import type { ConnectionConfig } from '../model'
import type { ConnectionInput, SetupDetection, SetupHost, SetupHostsAnswer, SetupJobAnswer, SetupPlan, SetupPlanInput, SetupRecord, SetupRunAnswer, TestAnswer } from '../protocol'
import { safeIp, safeTarget } from '../features/targets'
import { readOrcaInventory, type CliRunner } from '../orca/inventory'
import { oneTimeKey, type OneTimeKey } from './keys'
import { hostShell, runScript, type HostShell, type RunResult } from './runner'
import {
  apiPortOf,
  cipherOf,
  detectScript,
  productLabel,
  RUN_ID,
  ScriptError,
  setupScript,
  tokenIdOf,
  undoScript,
  valueOf,
  type ScriptAnswer,
  type SetupProduct,
  type SetupRequest
} from './script'

/** A sealed record as stored: who it is for in the clear, the record itself sealed to exactly that. */
export type SealedRecord = { hostKey: string; runId: string; sealed: string }

export type SetupDeps = {
  cli: () => CliRunner
  storage: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> }
  /** Seals a record with the worker's key, bound to its host and run; opens it again or null. */
  sealRecord(hostKey: string, runId: string, plain: string): Promise<string>
  openRecord(hostKey: string, runId: string, sealed: string): Promise<string | null>
  connections(): Promise<ConnectionConfig[]>
  test(input: ConnectionInput): Promise<TestAnswer>
  /** The token's privileges, as the API lists them for it (GET /access/permissions). */
  privileges(input: ConnectionInput): Promise<string[]>
  save(input: ConnectionInput): Promise<ConnectionConfig>
  /** Removes exactly this connection revision. */
  remove(connection: { id: string; revision: string }): Promise<void>
  /** Whether a PDM connection already shows a node of this name. */
  pdmCovers(node: string): Promise<boolean>
  /** A secret now known: every log and answer masks it from here on. */
  secretSeen(secret: string): void
  log(text: string): void
  now(): number
  sleep(ms: number): Promise<void>
}

export class SetupInputError extends Error {
  readonly code = 'invalid_params'
}

const DETECTED_KEY = 'setup.detected'
const RECORDS_KEY = 'setup.records'
const PLAN_MS = 10 * 60_000
const DETECT_MS = 45_000
const RUN_MS = 180_000
const NODE_NAME = /^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/
const VERSION = /^[0-9A-Za-z.+~:-]{1,40}$/
const SECRET = /^[0-9A-Za-z-]{8,128}$/
const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/
const HOST_KEY_ID = /^(ssh|env):[A-Za-z0-9._:-]{1,120}$/

type Status = SetupRecord['status']
const STATUSES: Status[] = ['pending', 'unknown', 'stopped', 'failed', 'saved']

/** What the plugin keeps about one setup run (sealed): enough for Undo, no secret. */
type StoredRecord = {
  hostKey: string
  runId: string
  product: SetupProduct
  at: number
  status: Status
  message?: string
  /** The connection revision this run saved. */
  connection?: { id: string; revision: string }
}

/** A record exactly as written, or null: every field in the one form it is written in. */
export function validRecord(raw: unknown, hostKey: string, runId: string): StoredRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const allowed = new Set(['hostKey', 'runId', 'product', 'at', 'status', 'message', 'connection'])
  if (Object.keys(r).some((k) => !allowed.has(k))) return null
  if (r.hostKey !== hostKey || r.runId !== runId || !HOST_KEY_ID.test(hostKey) || !RUN_ID.test(runId)) return null
  if (r.product !== 'pve' && r.product !== 'pbs') return null
  if (typeof r.at !== 'number' || !Number.isFinite(r.at)) return null
  if (!STATUSES.includes(r.status as Status)) return null
  if (r.message !== undefined && (typeof r.message !== 'string' || r.message.length > 600)) return null
  if (r.connection !== undefined) {
    const c = r.connection as Record<string, unknown>
    if (!c || typeof c !== 'object' || Object.keys(c).sort().join() !== 'id,revision' || typeof c.id !== 'string' || typeof c.revision !== 'string' || c.id.length > 80 || c.revision.length > 80) return null
  }
  return r as unknown as StoredRecord
}

type Plan = {
  id: string
  action: 'setup' | 'undo'
  hostKey: string
  shell: HostShell
  script: string
  expiresAt: number
  timer?: ReturnType<typeof setTimeout>
  request?: SetupRequest
  oneTime?: OneTimeKey
  input?: { product: SetupProduct; name: string; address: string; enrichOnly: boolean }
  record?: StoredRecord
}

type Job = { hostKey: string; action: 'setup' | 'undo'; answer?: SetupRunAnswer }

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** The check's answer, every value as strict as it is used: anything else is left out. */
export function detectionOf(answer: ScriptAnswer, at: number): SetupDetection | null {
  if (answer.end !== 'ok') return null
  const root = valueOf(answer, 'root')
  const hostname = valueOf(answer, 'hostname') ?? ''
  if (!NODE_NAME.test(hostname)) return null
  const version = (key: string) => {
    const v = valueOf(answer, key)
    return v !== undefined ? (VERSION.test(v) ? v : 'unknown') : undefined
  }
  const products: SetupDetection['products'] = {}
  for (const p of ['pve', 'pbs', 'pdm'] as const) {
    const v = version(p)
    if (v) products[p] = v
  }
  const out: SetupDetection = { at, root: root === 'yes' || root === 'sudo' ? root : 'no', products, hostname }
  const fqdn = safeTarget(valueOf(answer, 'fqdn'))
  if (fqdn && fqdn !== hostname) out.fqdn = fqdn
  const via = (valueOf(answer, 'via') ?? '').split(/\s+/)
  const client = safeIp(via[0])
  const server = safeIp(via[2])
  const port = Number(via[3])
  if (client && server && Number.isInteger(port) && port > 0 && port < 65536) out.via = { client, server, port }
  return out
}

const urlHost = (address: string) => (address.includes(':') ? `[${address}]` : address)

/** Why a finished run's answer cannot be relied on, in words, or undefined. */
function unknownWhy(r: RunResult): string {
  if (r.invalid) return `its answer could not be trusted (${r.invalid})`
  if (r.unread) return 'its terminal could not be read to the end'
  if (r.timedOut) return 'it did not finish in time (is the shell root, or may it use sudo without a password?)'
  return 'its end was not seen'
}

export class SetupService {
  private plans = new Map<string, Plan>()
  private jobs = new Map<string, Job>()
  private running = false
  private detected = new Map<string, SetupDetection>()
  private loaded = false

  constructor(private readonly deps: SetupDeps) {}

  private async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    const stored = await this.deps.storage.get(DETECTED_KEY)
    if (isRecord(stored)) for (const [k, v] of Object.entries(stored)) if (isRecord(v)) this.detected.set(k, v as unknown as SetupDetection)
  }

  /** The records that open with the worker's key and are exactly as written; others are ignored. */
  private async records(): Promise<{ list: StoredRecord[]; ignored: number }> {
    const stored = await this.deps.storage.get(RECORDS_KEY)
    const list: StoredRecord[] = []
    let ignored = 0
    for (const item of Array.isArray(stored) ? stored : []) {
      const e = item as Partial<SealedRecord>
      const ok = isRecord(item) && typeof e.hostKey === 'string' && typeof e.runId === 'string' && typeof e.sealed === 'string' && HOST_KEY_ID.test(e.hostKey) && RUN_ID.test(e.runId)
      const plain = ok ? await this.deps.openRecord(e.hostKey!, e.runId!, e.sealed!).catch(() => null) : null
      let parsed: unknown = null
      try {
        parsed = plain ? JSON.parse(plain) : null
      } catch {
        parsed = null
      }
      const record = ok ? validRecord(parsed, e.hostKey!, e.runId!) : null
      if (record) list.push(record)
      else ignored += 1
    }
    return { list, ignored }
  }

  /** Writes one record (replacing that run's), sealed, keeping every other stored entry as it is. */
  private async putRecord(record: StoredRecord | null, drop?: { hostKey: string; runId: string }): Promise<void> {
    const key = record ?? drop!
    const stored = await this.deps.storage.get(RECORDS_KEY)
    const others = (Array.isArray(stored) ? stored : []).filter((e) => !(isRecord(e) && e.hostKey === key.hostKey && e.runId === key.runId))
    const next = record ? [...others, { hostKey: record.hostKey, runId: record.runId, sealed: await this.deps.sealRecord(record.hostKey, record.runId, JSON.stringify(record)) }] : others
    await this.deps.storage.set(RECORDS_KEY, next)
  }

  /** Orca's servers with what is known of them; the inventory is read fresh. */
  async hosts(): Promise<SetupHostsAnswer> {
    await this.load()
    let inventory
    try {
      inventory = await readOrcaInventory(this.deps.cli())
    } catch (error) {
      return { hosts: [], error: error instanceof Error ? error.message : String(error), busy: this.running }
    }
    const { list, ignored } = await this.records()
    const known = new Set(inventory.hosts.map((h) => h.key))
    const view = (r: StoredRecord): SetupRecord => ({
      product: r.product,
      runId: r.runId,
      at: r.at,
      status: r.status,
      ...(r.message ? { message: r.message } : {}),
      ...(r.connection ? { connectionId: r.connection.id } : {})
    })
    const hosts: SetupHost[] = inventory.hosts
      .filter((h) => h.kind !== 'local')
      .map((h) => {
        const shell = hostShell(h, inventory.workspaces)
        return {
          key: h.key,
          name: h.name,
          kind: h.kind as 'ssh' | 'environment',
          ...(typeof h.connected === 'boolean' ? { connected: h.connected } : {}),
          ...('error' in shell ? { unavailable: shell.error } : { where: shell.where }),
          ...(this.detected.has(h.key) ? { detection: this.detected.get(h.key) } : {}),
          records: list.filter((r) => r.hostKey === h.key).map(view)
        }
      })
    // Runs on hosts Orca no longer lists are still shown, so they are not forgotten.
    for (const r of list.filter((x) => !known.has(x.hostKey))) {
      let host = hosts.find((h) => h.key === r.hostKey)
      if (!host) {
        host = { key: r.hostKey, name: r.hostKey, kind: r.hostKey.startsWith('env:') ? 'environment' : 'ssh', unavailable: 'Orca no longer lists this host; its setup can only be undone by hand (the guide’s way back).', records: [] }
        hosts.push(host)
      }
      host.records.push(view(r))
    }
    return { hosts, busy: this.running, ...(ignored ? { ignoredRecords: ignored } : {}) }
  }

  private async shellOf(hostKey: string): Promise<{ shell: HostShell; name: string }> {
    const inventory = await readOrcaInventory(this.deps.cli())
    const host = inventory.hosts.find((h) => h.key === hostKey)
    if (!host) throw new SetupInputError('That Orca host is not known (any more).')
    const shell = hostShell(host, inventory.workspaces)
    if ('error' in shell) throw new SetupInputError(shell.error)
    return { shell, name: host.name }
  }

  /** One script at a time: a second one is refused while one runs. */
  private claim(): void {
    if (this.running) throw new SetupInputError('Another setup step is running; wait for it to finish.')
    this.running = true
  }

  async detect(hostKey: string): Promise<SetupHostsAnswer> {
    await this.load()
    this.claim()
    try {
      const { shell } = await this.shellOf(hostKey)
      const runId = randomBytes(8).toString('hex')
      const result = await runScript(this.runDeps(), shell, detectScript(runId), runId, 'Proxmox check', DETECT_MS)
      const detection = detectionOf(result, this.deps.now())
      if (!detection) {
        this.deps.log(`Setup check on ${hostKey}: no usable answer (${unknownWhy(result)})`)
        throw new SetupInputError(result.unread ? 'The check’s terminal could not be read; try again.' : `The check gave no usable answer: ${unknownWhy(result)}.`)
      }
      this.detected.set(hostKey, detection)
      await this.deps.storage.set(DETECTED_KEY, JSON.parse(JSON.stringify(Object.fromEntries(this.detected))))
      this.deps.log(`Setup check on ${hostKey}: ${Object.keys(detection.products).join(', ') || 'no Proxmox product'}; root: ${detection.root}`)
    } finally {
      this.running = false
    }
    return this.hosts()
  }

  private runDeps() {
    return { run: this.deps.cli(), sleep: this.deps.sleep, now: this.deps.now, log: this.deps.log }
  }

  private forget(plan: Plan): void {
    clearTimeout(plan.timer)
    plan.oneTime?.wipe()
    this.plans.delete(plan.id)
  }

  /** Keeps a plan for 10 minutes; then its one-time key is wiped even if nothing else happens. */
  private keep(plan: Plan): void {
    plan.timer = setTimeout(() => this.forget(plan), PLAN_MS)
    ;(plan.timer as { unref?: () => void }).unref?.()
    this.plans.set(plan.id, plan)
  }

  /** The setup script for one host and product, shown before it runs. */
  async plan(input: SetupPlanInput): Promise<SetupPlan> {
    await this.load()
    const product: SetupProduct | null = input.product === 'pbs' || input.product === 'pve' ? input.product : null
    if (!product) throw new SetupInputError('Choose Proxmox VE or Backup Server; for PDM, see the guide’s PDM token steps.')
    const detection = this.detected.get(input.hostKey)
    if (!detection) throw new SetupInputError('Check the host first.')
    if (!detection.products[product]) throw new SetupInputError(`The check found no ${productLabel(product)} on this host.`)
    if (detection.root === 'no') throw new SetupInputError('Orca’s shell on this host is not root and may not use sudo without a password; nothing can be set up from it.')
    const address = safeTarget(input.address)
    if (!address) throw new SetupInputError('The address must be a DNS name or an IP address that this machine reaches the host at.')
    const name = (input.name ?? '').trim()
    if (!NAME.test(name)) throw new SetupInputError('The name may hold letters, digits, ".", "_" and "-" (40 at most).')
    const { shell, name: hostName } = await this.shellOf(input.hostKey)
    const port = apiPortOf(product)
    const baseUrl = `https://${urlHost(address)}:${port}`
    const existing = await this.deps.connections()
    if (existing.some((c) => c.baseUrl === baseUrl)) throw new SetupInputError(`A connection to ${baseUrl} exists already.`)
    if (existing.some((c) => c.name === name && c.kind !== 'pdm')) throw new SetupInputError(`A connection named ${name} exists already; choose another name.`)
    const enrichOnly = product === 'pve' && (await this.deps.pdmCovers(detection.hostname))
    const runId = randomBytes(8).toString('hex')
    const oneTime = oneTimeKey()
    let script: string
    let request: SetupRequest
    try {
      request = { product, runId, resultKey: oneTime.publicPem, replace: input.replace === true }
      script = setupScript(request)
    } catch (error) {
      oneTime.wipe()
      throw new SetupInputError(error instanceof ScriptError ? error.message : 'The script could not be generated.')
    }
    const plan: Plan = {
      id: runId,
      action: 'setup',
      hostKey: input.hostKey,
      shell,
      script,
      expiresAt: this.deps.now() + PLAN_MS,
      request,
      oneTime,
      input: { product, name, address, enrichOnly }
    }
    this.keep(plan)
    return {
      planId: plan.id,
      action: 'setup',
      hostKey: input.hostKey,
      hostName,
      where: shell.where,
      script,
      expiresAt: plan.expiresAt,
      summary: [
        `Runs on ${hostName} in a terminal of ${shell.where}, as root${detection.root === 'sudo' ? ' (sudo -n)' : ''}; the terminal is closed afterwards. It keeps a record of what it changes on the host (/var/lib/orca-proxmox-setup), which Undo works from.`,
        `Creates ${tokenIdOf(product)} with ${product === 'pve' ? 'PVEAuditor' : 'Audit'} on / for the user and the token (privilege separation), both labelled with this run. The plugin then asks the API which rights the token has, and refuses it if any is more than auditing.`,
        input.replace === true ? 'Replaces an earlier token of that name: the old one stops working, and Undo cannot bring it back.' : 'Stops without changing anything if that token exists already (choose Replace to make a new one).',
        `The host reports the API certificate; the plugin pins it and then connects to ${baseUrl} from this machine, which must present the same.`,
        'The token secret is printed only encrypted to a one-time key held by the plugin; no secret is ever in the terminal.',
        enrichOnly ? 'PDM already shows this node: the connection is saved as enrich only.' : 'Saved as a direct connection once every check passes.'
      ],
      connection: {
        kind: product,
        name,
        baseUrl,
        tokenId: tokenIdOf(product),
        enrichOnly
      }
    }
  }

  /** The Undo script for one recorded run on a host. */
  async undoPlan(hostKey: string, runId: string): Promise<SetupPlan> {
    if (!RUN_ID.test(runId)) throw new SetupInputError('Name the setup run to undo.')
    const record = (await this.records()).list.find((r) => r.hostKey === hostKey && r.runId === runId)
    if (!record) throw new SetupInputError('The plugin has no (valid) record of that setup run on this host.')
    const undoId = randomBytes(8).toString('hex')
    let script: string
    try {
      script = undoScript(record.product, record.runId, undoId)
    } catch (error) {
      throw new SetupInputError(error instanceof ScriptError ? error.message : 'The Undo script could not be generated.')
    }
    const { shell, name } = await this.shellOf(hostKey)
    const plan: Plan = { id: undoId, action: 'undo', hostKey, shell, script, expiresAt: this.deps.now() + PLAN_MS, record }
    this.keep(plan)
    return {
      planId: plan.id,
      action: 'undo',
      hostKey,
      hostName: name,
      where: shell.where,
      script,
      expiresAt: plan.expiresAt,
      summary: [
        `Runs on ${name} in a terminal of ${shell.where}; the terminal is closed afterwards.`,
        `Undoes setup run ${record.runId} only, and only while no other Orca step runs on the host: it reads what that run recorded there and removes only what it recorded as made and that still carries its label, each step checked, stopping at the first that fails:`,
        `the token ${tokenIdOf(record.product)} and its permission; the user, or its permission, only when that run made it and it has no token left. Never what was there before; what that run started but did not record as done is kept and named for you to check.`,
        ...(record.connection ? ['Then removes the connection that run saved, if it is still that revision.'] : [])
      ]
    }
  }

  /** Starts a plan the person was shown, once, as a background job; `job` reports on it. */
  async run(planId: string, hostKey: string): Promise<{ jobId: string }> {
    const plan = this.plans.get(planId)
    if (!plan || plan.hostKey !== hostKey || plan.expiresAt <= this.deps.now()) {
      if (plan && plan.expiresAt <= this.deps.now()) this.forget(plan)
      throw new SetupInputError('This script is no longer valid (shown too long ago, already run, or for another host); show it again.')
    }
    this.claim()
    // Single use, from here on; its keys stay with the job until it ends.
    clearTimeout(plan.timer)
    this.plans.delete(plan.id)
    const job: Job = { hostKey, action: plan.action }
    this.jobs.set(plan.id, job)
    void (async () => {
      try {
        job.answer = plan.action === 'setup' ? await this.runSetup(plan) : await this.runUndo(plan)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.deps.log(`Setup job on ${hostKey} failed: ${message}`)
        job.answer = { ok: false, stage: 'script', outcome: 'unknown', message: `The run failed in the plugin (${message}); what happened on the host is not known. Undo works from the host’s own record.`, steps: [], undo: plan.action === 'setup' }
      } finally {
        plan.oneTime?.wipe()
        this.running = false
      }
    })()
    return { jobId: plan.id }
  }

  /** A job's state: running, or its answer. */
  job(jobId: string): SetupJobAnswer {
    const job = this.jobs.get(jobId)
    if (!job) throw new SetupInputError('That run is not known (the plugin restarted?); its record shows its last known state.')
    return job.answer ? { running: false, answer: job.answer } : { running: true }
  }

  private async runSetup(plan: Plan): Promise<SetupRunAnswer> {
    const request = plan.request!
    const input = plan.input!
    const record: StoredRecord = {
      hostKey: plan.hostKey,
      runId: plan.id,
      product: input.product,
      at: this.deps.now(),
      status: 'pending'
    }
    // Recorded before anything can change on the host.
    await this.putRecord(record)
    const set = async (status: Status, message: string) => {
      record.status = status
      record.message = message.slice(0, 600)
      await this.putRecord(record)
    }
    const result = await runScript(this.runDeps(), plan.shell, plan.script, plan.id, 'Proxmox setup', RUN_MS)
    const steps = result.pairs.map(([k]) => k).filter((k) => /^(created|added|replaced|reused)/.test(k))
    const closeNote = result.closeError ? ` The setup terminal could not be closed (${result.closeError}); close it in Orca.` : ''
    if (result.end !== 'ok') {
      const known = result.end === 'stop'
      const why = known ? `The host stopped: ${result.stop ?? 'no reason given'}.` : `The outcome is unknown: ${unknownWhy(result)}.`
      await set(known ? 'stopped' : 'unknown', why)
      this.deps.log(`Setup on ${plan.hostKey}: ${why}`)
      return { ok: false, stage: 'script', outcome: known ? 'stopped' : 'unknown', message: `${why} Undo reverses whatever the host recorded for this run.${closeNote}`, steps, undo: true }
    }
    const fail = async (stage: SetupRunAnswer['stage'], message: string, test?: TestAnswer): Promise<SetupRunAnswer> => {
      await set('failed', message)
      this.deps.log(`Setup on ${plan.hostKey}: ${message}`)
      return { ok: false, stage, outcome: 'failed', message: `${message} Nothing was saved; Undo reverses what was created on the host.${closeNote}`, ...(test ? { test } : {}), steps, undo: true }
    }
    const secret = plan.oneTime!.open(cipherOf(result) ?? '')
    const fingerprint = (valueOf(result, 'api_fp') ?? '').toUpperCase()
    if (!secret || !SECRET.test(secret) || !FINGERPRINT.test(fingerprint)) {
      return fail('secret', 'The host’s answer was incomplete (secret or certificate fingerprint).')
    }
    this.deps.secretSeen(secret)
    const port = apiPortOf(input.product)
    const connection: ConnectionInput = {
      id: 'new',
      kind: input.product,
      name: input.name,
      baseUrl: `https://${urlHost(input.address)}:${port}`,
      tokenId: tokenIdOf(input.product),
      fingerprint,
      secret,
      ...(input.enrichOnly ? { enrichOnly: true } : {})
    }
    // From this machine: the address presents the reported certificate...
    const test = await this.deps.test(connection)
    if (!test.ok) return fail('test', `The connection test from this machine failed: ${test.error.message}.`, test)
    // ...and the token has no right beyond auditing, at any path.
    let privileges: string[]
    try {
      privileges = await this.deps.privileges(connection)
    } catch (error) {
      return fail('rights', `The token’s rights could not be read: ${error instanceof Error ? error.message : String(error)}.`)
    }
    const more = privileges.filter((p) => !/^[A-Za-z]+(\.[A-Za-z]+)*\.Audit$/.test(p))
    if (more.length) return fail('rights', `The token has more than read rights (${more.slice(0, 6).join(', ')}).`)
    let saved: ConnectionConfig
    try {
      saved = await this.deps.save(connection)
    } catch (error) {
      return fail('save', `Everything checked out, but the connection could not be saved: ${error instanceof Error ? error.message : String(error)}.`)
    }
    record.connection = { id: saved.id, revision: saved.revision ?? '' }
    await set('saved', `Saved ${connection.baseUrl}.`)
    this.deps.log(`Setup on ${plan.hostKey}: saved the ${input.product.toUpperCase()} connection to ${connection.baseUrl}${input.enrichOnly ? ' (enrich only)' : ''}`)
    return {
      ok: true,
      stage: 'saved',
      outcome: 'saved',
      message: `Connected: ${productLabel(input.product)} ${test.version}, ${test.remotes} ${test.unit ?? 'nodes'} visible, read rights only${input.enrichOnly ? ', adding to what PDM shows' : ''}.${closeNote}`,
      test,
      steps,
      undo: true
    }
  }

  private async runUndo(plan: Plan): Promise<SetupRunAnswer> {
    const record = plan.record!
    const result = await runScript(this.runDeps(), plan.shell, plan.script, plan.id, 'Proxmox undo', RUN_MS)
    const steps = result.pairs.map(([k]) => k).filter((k) => /^(removed|kept|nothing)/.test(k))
    const closeNote = result.closeError ? ` The terminal could not be closed (${result.closeError}); close it in Orca.` : ''
    if (result.end !== 'ok') {
      const why = result.end === 'stop' ? `The host stopped: ${result.stop ?? 'no reason given'}.` : `The outcome is unknown: ${unknownWhy(result)}.`
      return { ok: false, stage: 'script', outcome: result.end === 'stop' ? 'stopped' : 'unknown', message: `${why} The host keeps track of what was undone; run Undo again once that is fixed.${closeNote}`, steps, undo: true }
    }
    // The connection that run saved, only while it is still that revision; and the plugin's key.
    let note = ''
    if (record.connection) {
      const c = (await this.deps.connections()).find((x) => x.id === record.connection!.id)
      if (c && c.revision === record.connection.revision) await this.deps.remove(record.connection)
      else if (c) note = ' The connection was changed since; it was kept, remove it in Settings if you want.'
    }
    // Something this run started but did not record as done is never removed: the record (and
    // the host's journal) stay, and the person checks it.
    const unsure = valueOf(result, 'unconfirmed')?.trim()
    const changed = valueOf(result, 'changed')?.trim()
    if (unsure || changed) {
      const parts = [unsure ? `not recorded as done: ${unsure}` : '', changed ? `changed since the run (an administrator's now): ${changed}` : ''].filter(Boolean)
      record.message = `Kept on the host, ${parts.join('; ')}.`
      await this.putRecord(record)
      return { ok: false, stage: 'undone', outcome: 'stopped', message: `Undone what this run made and is still as it made it. Kept for you to check on the host (${tokenIdOf(record.product)}), ${parts.join('; ')}.${note}${closeNote}`, steps, undo: true }
    }
    await this.putRecord(null, { hostKey: record.hostKey, runId: record.runId })
    const kept = [valueOf(result, 'kept_user'), valueOf(result, 'kept_token')].filter(Boolean)
    this.deps.log(`Undo on ${record.hostKey} of ${record.runId}: done`)
    return { ok: true, stage: 'undone', outcome: 'undone', message: `Undone on the host${kept.length ? `; kept: ${kept.join('; ')}` : ''}.${note}${closeNote}`, steps, undo: false }
  }
}
