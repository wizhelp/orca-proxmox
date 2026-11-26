// "Connect via Orca": sets a Proxmox VE or Backup Server up for the plugin through the Orca
// connection that already reaches it, in place of the guide's manual steps.
//
// 1. Orca's servers (SSH targets, paired servers) are listed; a read-only check, run on one in a
//    terminal of it, says what it runs (PVE, PBS, PDM) and whether the shell may act as root.
// 2. Connect generates the exact script (script.ts) and shows it; nothing runs until the person
//    confirms that very plan (single use, 10 minutes).
// 3. The script runs in a terminal of that host (runner.ts), closed afterwards whatever happens.
//    It creates the read-only token, optionally the restricted tunnel account with the plugin's
//    own key, reads the API certificate and SSH host key fingerprints on the server itself, and
//    prints the token secret only encrypted to the run's one-time key (keys.ts).
// 4. The plugin decrypts the secret in memory, wipes the one-time key, tests the connection
//    (through the pinned tunnel when there is one) and only then saves it, sealed.
// 5. What the host reported creating is kept (no secret) for Undo, which reverses only that.
import { randomBytes } from 'node:crypto'
import type { ConnectionConfig } from '../model'
import type { ConnectionInput, SetupDetection, SetupHost, SetupHostsAnswer, SetupPlan, SetupPlanInput, SetupRecord, SetupRunAnswer, TestAnswer } from '../protocol'
import { safeIp, safeTarget } from '../features/targets'
import { readOrcaInventory, type CliRunner } from '../orca/inventory'
import { newTunnelKey, oneTimeKey, type OneTimeKey } from './keys'
import { hostShell, runScript, type HostShell } from './runner'
import {
  anythingToUndo,
  apiPortOf,
  clientAddress,
  detectScript,
  KEY_COMMENT,
  productLabel,
  receiptOf,
  said,
  ScriptError,
  setupScript,
  tokenIdOf,
  TUNNEL_USER,
  undoScript,
  valueOf,
  type ScriptAnswer,
  type SetupProduct,
  type SetupReceipt,
  type SetupRequest
} from './script'

export type SetupDeps = {
  cli: () => CliRunner
  storage: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> }
  /** The tunnel's private key, sealed in the plugin's secrets under `ref`. */
  sealKey(ref: string, pem: string): Promise<void>
  dropKey(ref: string): Promise<void>
  connections(): Promise<ConnectionConfig[]>
  test(input: ConnectionInput): Promise<TestAnswer>
  save(input: ConnectionInput): Promise<ConnectionConfig>
  /** Removes a connection the setup saved, when it is still as saved. */
  remove(connection: ConnectionConfig): Promise<void>
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
const HOST_KEY = /^(ssh-ed25519|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521) [A-Za-z0-9+/]+={0,2}$/

/** A setup's receipt as stored: what it created, where, and the connection it saved. */
type StoredRecord = { hostKey: string; at: number; receipt: SetupReceipt; connectionId?: string; keyRef?: string; complete: boolean }

type Plan = {
  id: string
  action: 'setup' | 'undo'
  hostKey: string
  shell: HostShell
  script: string
  expiresAt: number
  request?: SetupRequest
  oneTime?: OneTimeKey
  keyPem?: string
  keyRef?: string
  input?: { product: SetupProduct; name: string; address: string; sshPort: number; enrichOnly: boolean }
  record?: StoredRecord
}

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
  const out: SetupDetection = { at, root: root === 'yes' || root === 'sudo' ? root : 'no', products, sshd: valueOf(answer, 'sshd') === 'yes', hostname }
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

export class SetupService {
  private plans = new Map<string, Plan>()
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

  private async records(): Promise<StoredRecord[]> {
    const stored = await this.deps.storage.get(RECORDS_KEY)
    return Array.isArray(stored) ? (stored.filter((r) => isRecord(r) && typeof r.hostKey === 'string' && isRecord(r.receipt)) as StoredRecord[]) : []
  }

  private async writeRecords(list: StoredRecord[]): Promise<void> {
    await this.deps.storage.set(RECORDS_KEY, JSON.parse(JSON.stringify(list)))
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
    const records = await this.records()
    const hosts: SetupHost[] = inventory.hosts
      .filter((h) => h.kind !== 'local')
      .map((h) => {
        const shell = hostShell(h, inventory.workspaces)
        const mine = records.filter((r) => r.hostKey === h.key)
        return {
          key: h.key,
          name: h.name,
          kind: h.kind as 'ssh' | 'environment',
          ...(typeof h.connected === 'boolean' ? { connected: h.connected } : {}),
          ...('error' in shell ? { unavailable: shell.error } : { where: shell.where }),
          ...(this.detected.has(h.key) ? { detection: this.detected.get(h.key) } : {}),
          records: mine.map(
            (r): SetupRecord => ({
              product: r.receipt.product,
              runId: r.receipt.runId,
              at: r.at,
              tunnel: !!r.receipt.tunnel,
              replacedToken: r.receipt.replacedToken,
              complete: r.complete,
              ...(r.connectionId ? { connectionId: r.connectionId } : {})
            })
          )
        }
      })
    return { hosts, busy: this.running }
  }

  private async shellOf(hostKey: string): Promise<{ shell: HostShell; name: string }> {
    const inventory = await readOrcaInventory(this.deps.cli())
    const host = inventory.hosts.find((h) => h.key === hostKey)
    if (!host) throw new SetupInputError('That Orca host is not known (any more).')
    const shell = hostShell(host, inventory.workspaces)
    if ('error' in shell) throw new SetupInputError(shell.error)
    return { shell, name: host.name }
  }

  /** One script at a time: a second Connect or check waits for none, it is refused. */
  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.running) throw new SetupInputError('Another setup step is running; wait for it to finish.')
    this.running = true
    try {
      return await work()
    } finally {
      this.running = false
    }
  }

  async detect(hostKey: string): Promise<SetupHostsAnswer> {
    await this.load()
    await this.exclusive(async () => {
      const { shell } = await this.shellOf(hostKey)
      const runId = randomBytes(8).toString('hex')
      const answer = await runScript(this.runDeps(), shell, detectScript(runId), runId, 'Proxmox check', DETECT_MS)
      const detection = detectionOf(answer, this.deps.now())
      if (!detection) {
        this.deps.log(`Setup check on ${hostKey}: no answer${answer.timedOut ? ' (timed out)' : ''}`)
        throw new SetupInputError(answer.unread ? 'The check’s terminal could not be read; try again.' : answer.timedOut ? 'The check got no answer from that host in time; is its shell a POSIX shell (sh, bash)?' : 'The check did not finish on that host.')
      }
      this.detected.set(hostKey, detection)
      await this.deps.storage.set(DETECTED_KEY, JSON.parse(JSON.stringify(Object.fromEntries(this.detected))))
      this.deps.log(`Setup check on ${hostKey}: ${Object.keys(detection.products).join(', ') || 'no Proxmox product'}; root: ${detection.root}`)
    })
    return this.hosts()
  }

  private runDeps() {
    return { run: this.deps.cli(), sleep: this.deps.sleep, now: this.deps.now, log: this.deps.log }
  }

  private dropExpired(): void {
    for (const [id, plan] of this.plans) {
      if (plan.expiresAt <= this.deps.now()) {
        plan.oneTime?.wipe()
        this.plans.delete(id)
      }
    }
  }

  /** The setup script for one host and product, shown before it runs. */
  async plan(input: SetupPlanInput): Promise<SetupPlan> {
    await this.load()
    this.dropExpired()
    const product: SetupProduct | null = input.product === 'pbs' || input.product === 'pve' ? input.product : null
    if (!product) throw new SetupInputError('Choose Proxmox VE or Backup Server; for PDM, see the guide’s PDM token steps.')
    const detection = this.detected.get(input.hostKey)
    if (!detection) throw new SetupInputError('Check the host first.')
    if (!detection.products[product]) throw new SetupInputError(`The check found no ${productLabel(product)} on this host.`)
    if (detection.root === 'no') throw new SetupInputError('Orca’s shell on this host is not root and may not use sudo without a password; nothing can be set up from it.')
    const tunnel = input.tunnel === true
    if (tunnel && !detection.sshd) throw new SetupInputError('The check found no SSH server (sshd) on this host for a tunnel.')
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
    const records = await this.records()
    if (records.some((r) => r.hostKey === input.hostKey && r.receipt.product === product && !r.complete && r.receipt.tunnel) && tunnel) {
      throw new SetupInputError('An earlier setup of this host made the tunnel account; undo it first.')
    }
    const enrichOnly = product === 'pve' && (await this.deps.pdmCovers(detection.hostname))
    const runId = randomBytes(8).toString('hex')
    const oneTime = oneTimeKey()
    let keyPem: string | undefined
    let request: SetupRequest
    try {
      const key = tunnel ? newTunnelKey(KEY_COMMENT) : undefined
      keyPem = key?.privatePem
      request = {
        product,
        runId,
        resultKey: oneTime.publicPem,
        replace: input.replace === true,
        ...(key ? { tunnel: { keyLine: key.publicLine, clientAddr: clientAddress(detection.via?.client) } } : {})
      }
    } catch (error) {
      oneTime.wipe()
      throw error
    }
    let script: string
    try {
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
      ...(keyPem ? { keyPem, keyRef: `k-${randomBytes(8).toString('hex')}` } : {}),
      input: { product, name, address, sshPort: detection.via?.port ?? 22, enrichOnly }
    }
    this.plans.set(plan.id, plan)
    const p = productLabel(product)
    return {
      planId: plan.id,
      action: 'setup',
      hostKey: input.hostKey,
      hostName,
      where: shell.where,
      script,
      expiresAt: plan.expiresAt,
      summary: [
        `Runs on ${hostName} in a terminal of ${shell.where}, as root${detection.root === 'sudo' ? ' (sudo -n)' : ''}; the terminal is closed afterwards.`,
        `Creates ${tokenIdOf(product)} with ${product === 'pve' ? 'PVEAuditor' : 'Audit'} on / for the user and the token (privilege separation): it can read, not change.`,
        input.replace ? 'Replaces an earlier token of that name: the old one stops working, and Undo cannot bring it back.' : 'Stops without changing anything if that token exists already (choose Replace to make a new one).',
        ...(request.tunnel
          ? [`Creates the account ${TUNNEL_USER} (no password, no shell) that may only forward to 127.0.0.1:${port}, verifies sshd’s effective rules before and after the reload, then installs the plugin’s own key (made here, kept sealed).`]
          : []),
        'Reads the API certificate’s fingerprint on the server itself, and the SSH host key when there is a tunnel; the plugin pins both.',
        'The token secret is printed only encrypted to a one-time key held by the plugin; no secret is ever in the terminal.',
        enrichOnly ? 'PDM already shows this node: the connection is saved as enrich only.' : 'Saved as a direct connection once its test passes.'
      ],
      connection: {
        kind: product,
        name,
        baseUrl,
        tokenId: tokenIdOf(product),
        enrichOnly,
        ...(request.tunnel ? { tunnel: `${TUNNEL_USER}@${address}:${detection.via?.port ?? 22} → 127.0.0.1:${port}` } : {})
      }
    }
  }

  /** The Undo script for what a setup created on a host. */
  async undoPlan(hostKey: string, product: SetupProduct): Promise<SetupPlan> {
    this.dropExpired()
    const record = (await this.records()).filter((r) => r.hostKey === hostKey && r.receipt.product === product).at(-1)
    if (!record) throw new SetupInputError('The plugin set nothing up for that product on this host.')
    const runId = randomBytes(8).toString('hex')
    let script: string
    try {
      script = undoScript(record.receipt, runId)
    } catch (error) {
      throw new SetupInputError(error instanceof ScriptError ? error.message : 'The Undo script could not be generated.')
    }
    const { shell, name } = await this.shellOf(hostKey)
    const plan: Plan = { id: runId, action: 'undo', hostKey, shell, script, expiresAt: this.deps.now() + PLAN_MS, record }
    this.plans.set(plan.id, plan)
    const r = record.receipt
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
        'Reverses only what that setup reported creating, each step checked, stopping at the first that fails:',
        ...(r.tunnel ? [`the key file (only while it holds exactly the plugin’s key), ${TUNNEL_USER}’s processes, the Match block (only while sshd_config is exactly the backup plus that block), the account`] : []),
        r.createdToken ? `the token ${tokenIdOf(r.product)} and its permission` : 'no token (that setup created none)',
        r.createdUser ? 'the user, when it has no other token left' : r.addedUserAcl ? 'the user’s permission, when it has no other token left' : 'not the user (it existed before)',
        ...(record.connectionId ? ['Then removes the connection it saved here, and the plugin’s own key.'] : []),
        ...(r.replacedToken ? ['The token that setup replaced cannot be brought back.'] : [])
      ]
    }
  }

  /** Runs a plan the person was shown, once. */
  async run(planId: string, hostKey: string): Promise<SetupRunAnswer> {
    this.dropExpired()
    const plan = this.plans.get(planId)
    if (!plan || plan.hostKey !== hostKey) throw new SetupInputError('This script is no longer valid (shown too long ago, already run, or for another host); show it again.')
    // Single use, from here on.
    this.plans.delete(planId)
    try {
      return await this.exclusive(() => (plan.action === 'setup' ? this.runSetup(plan) : this.runUndo(plan)))
    } finally {
      plan.oneTime?.wipe()
      plan.keyPem = undefined
    }
  }

  private async runSetup(plan: Plan): Promise<SetupRunAnswer> {
    const request = plan.request!
    const input = plan.input!
    const answer = await runScript(this.runDeps(), plan.shell, plan.script, plan.id, 'Proxmox setup', RUN_MS)
    const receipt = receiptOf(request, answer)
    const steps = answer.pairs.map(([k]) => k).filter((k) => /^(created|added|replaced|backup)/.test(k))
    const record: StoredRecord = { hostKey: plan.hostKey, at: this.deps.now(), receipt, complete: false, ...(plan.keyRef ? { keyRef: plan.keyRef } : {}) }
    const keep = async () => {
      if (anythingToUndo(receipt)) await this.writeRecords([...(await this.records()), record])
    }
    if (answer.end !== 'ok') {
      await keep()
      const why = answer.stop
        ? `The host stopped: ${answer.stop}.`
        : answer.unread
          ? 'The terminal could not be read to the end, so what the script did is not fully known: look at the host (the guide’s way back lists what to check).'
          : answer.timedOut
            ? 'The script did not finish in time (is the shell root, or may it use sudo without a password?).'
            : 'The script did not finish.'
      this.deps.log(`Setup on ${plan.hostKey}: ${why}`)
      return { ok: false, stage: 'script', message: `${why}${anythingToUndo(receipt) ? ' Undo reverses what it created.' : ' Nothing was created.'}`, steps, undo: anythingToUndo(receipt) }
    }
    const cipher = answer.pairs.filter(([k]) => k === 'secret').map(([, v]) => v).join('')
    const secret = plan.oneTime!.open(cipher)
    const fingerprint = (valueOf(answer, 'api_fp') ?? '').toUpperCase()
    const hostKey = valueOf(answer, 'ssh_hostkey') ?? ''
    if (!secret || !SECRET.test(secret) || !FINGERPRINT.test(fingerprint) || (request.tunnel && !HOST_KEY.test(hostKey))) {
      await keep()
      return { ok: false, stage: 'secret', message: 'The host’s answer was incomplete (secret, certificate fingerprint or SSH host key); nothing was saved. Undo reverses what it created.', steps, undo: true }
    }
    this.deps.secretSeen(secret)
    if (plan.keyRef && plan.keyPem) await this.deps.sealKey(plan.keyRef, plan.keyPem)
    const connection: ConnectionInput = {
      id: 'new',
      kind: input.product,
      name: input.name,
      baseUrl: `https://${urlHost(input.address)}:${apiPortOf(input.product)}`,
      tokenId: tokenIdOf(input.product),
      fingerprint,
      secret,
      ...(input.enrichOnly ? { enrichOnly: true } : {}),
      ...(request.tunnel && plan.keyRef
        ? { tunnel: { host: input.address, port: input.sshPort, user: TUNNEL_USER, identityFile: '', keyRef: plan.keyRef, target: `127.0.0.1:${apiPortOf(input.product)}`, hostKey } }
        : {})
    }
    const test = await this.deps.test(connection)
    if (!test.ok) {
      await keep()
      if (plan.keyRef) await this.deps.dropKey(plan.keyRef).catch(() => undefined)
      return { ok: false, stage: 'test', message: `The connection test failed: ${test.error.message}. Nothing was saved; Undo reverses what was created on the host.`, test, steps, undo: true }
    }
    const saved = await this.deps.save(connection)
    record.connectionId = saved.id
    record.complete = true
    await this.writeRecords([...(await this.records()), record])
    this.deps.log(`Setup on ${plan.hostKey}: saved the ${input.product.toUpperCase()} connection to ${connection.baseUrl}${input.enrichOnly ? ' (enrich only)' : ''}`)
    return { ok: true, stage: 'saved', message: `Connected: ${productLabel(input.product)} ${test.version}, ${test.remotes} ${test.unit ?? 'nodes'} visible${input.enrichOnly ? ', adding to what PDM shows' : ''}.`, test, steps, undo: true }
  }

  private async runUndo(plan: Plan): Promise<SetupRunAnswer> {
    const record = plan.record!
    const answer = await runScript(this.runDeps(), plan.shell, plan.script, plan.id, 'Proxmox undo', RUN_MS)
    const steps = answer.pairs.map(([k]) => k).filter((k) => /^(removed|kept)/.test(k))
    // What was reversed is no longer to undo, even when a later step stopped.
    const r = record.receipt
    const left: SetupReceipt = {
      ...r,
      createdToken: r.createdToken && !said(answer, 'removed_token'),
      createdUser: r.createdUser && !said(answer, 'removed_user'),
      addedUserAcl: r.addedUserAcl && !said(answer, 'removed_user_acl') && !said(answer, 'removed_user'),
      ...(r.tunnel
        ? {
            tunnel: {
              ...r.tunnel,
              createdKeyFile: r.tunnel.createdKeyFile && !said(answer, 'removed_keyfile'),
              addedPolicy: r.tunnel.addedPolicy && !said(answer, 'removed_policy'),
              createdAccount: r.tunnel.createdAccount && !said(answer, 'removed_account')
            }
          }
        : {})
    }
    const others = (await this.records()).filter((x) => !(x.hostKey === record.hostKey && x.receipt.runId === r.runId))
    if (answer.end !== 'ok') {
      await this.writeRecords([...others, { ...record, receipt: left }])
      const why = answer.stop ? `The host stopped: ${answer.stop}.` : 'The Undo did not finish in time.'
      return { ok: false, stage: 'script', message: `${why} What was reversed is no longer listed; run Undo again once that is fixed.`, steps, undo: true }
    }
    // The connection it saved, still as saved; and the plugin's own key.
    let note = ''
    if (record.connectionId) {
      const c = (await this.deps.connections()).find((x) => x.id === record.connectionId)
      if (c && c.tokenId === tokenIdOf(r.product)) await this.deps.remove(c)
      else if (c) note = ' The connection was changed since; it was kept, remove it in Settings.'
    }
    if (record.keyRef) await this.deps.dropKey(record.keyRef).catch(() => undefined)
    await this.writeRecords(others)
    const kept = valueOf(answer, 'kept_user')
    this.deps.log(`Undo on ${record.hostKey}: done`)
    return { ok: true, stage: 'undone', message: `Undone on the host${kept ? `; the user was kept (${kept})` : ''}.${note}`, steps, undo: false }
  }
}
