// Connect via Orca: the generated scripts, what refuses to be generated, the answers read back from
// a terminal, and a whole run through the worker with a fake Orca CLI whose "server" encrypts the
// token secret to the script's one-time key, as the real script does with openssl. The secret must
// never be in what the terminal shows, the typed command, an answer or a log. Example data only.
import { constants, publicEncrypt } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import * as net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { after } from 'node:test'
import { afterEach, assert, mockHost, mountWorker, test, type TestWorker } from 'orca/testing'
import type { CliRunner } from '../src/orca/inventory'
import { newTunnelKey, oneTimeKey } from '../src/setup/keys'
import { commandLine, logicalLines } from '../src/setup/runner'
import { authorizedLine, detectScript, parseAnswer, policyBlock, receiptOf, setupScript, undoScript, type SetupReceipt, type SetupRequest } from '../src/setup/script'
import type { TunnelChild } from '../src/proxmox/tunnel'
import { memoryVault } from '../src/vault'
import * as main from '../src/worker'
import { pveRoutes } from './fixtures/direct'
import { mockTransport } from './fixtures/pdm'

const NOW = Date.UTC(2026, 10, 25, 12, 0, 0)
const PIN = 'EC:7A:EF:38:FF:F7:59:92:C1:E3:B0:4C:1D:22:FF:C9:67:C6:91:C8:74:48:53:13:12:1A:C0:42:D1:5B:37:05'
const HOST_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8g'
const SECRET = '6f1c2b3a-4d5e-4f60-8a71-92b3c4d5e6f7'
const RUN = '0123456789abcdef'
const key = oneTimeKey()
const tunnelKey = newTunnelKey('orca-proxmox-tunnel')
const request = (over: Partial<SetupRequest> = {}): SetupRequest => ({ product: 'pve', runId: RUN, resultKey: key.publicPem, replace: false, ...over })
const dir = mkdtempSync(join(tmpdir(), 'orca-setup-'))
after(() => {
  key.wipe()
  rmSync(dir, { recursive: true, force: true })
})

test('the setup script holds only public values, and the secret leaves the server only encrypted', () => {
  const script = setupScript(request({ tunnel: { keyLine: tunnelKey.publicLine, clientAddr: '198.51.100.7' } }))
  assert.ok(script.includes(key.publicPem.trim()))
  assert.ok(script.includes(authorizedLine(tunnelKey.publicLine, 8006)))
  assert.ok(script.includes(policyBlock(8006)))
  assert.ok(!script.includes(tunnelKey.privatePem.split('\n')[1]), 'never the private key')
  assert.ok(!script.includes('PRIVATE KEY'))
  // The secret is only in shell variables, encrypted, then cleared; `say secret` prints the ciphertext.
  assert.match(script, /S=\$\(printf '%s' "\$OUT" \| sed/)
  assert.match(script, /printf '%s' "\$S" \| openssl pkeyutl -encrypt -pubin/)
  assert.match(script, /fold -w 64 \| while read -r L; do say secret "\$L"; done/)
  for (const line of script.split('\n').filter((l) => /\bsay\b/.test(l) && !/^say\(\)/.test(l.trim()))) assert.ok(!/\$S\b|\$OUT\b/.test(line), line)
  // Read-only rights on both the user and the token, privilege separation on.
  assert.ok(script.includes('pveum user token add "$U" "$T" --privsep 1'))
  assert.ok(script.includes('pveum acl modify / --tokens "$U!$T" --roles PVEAuditor'))
  // The key last, after the policy is verified before and after the reload, root's untouched.
  const order = ['policy_ok || stop', 'root_policy)" = "$BEFORE"', 'systemctl reload ssh', 'the rules differ after the reload', 'install -m 600']
  const at = order.map((s) => script.indexOf(s))
  assert.ok(at.every((p, i) => p > 0 && (i === 0 || p > at[i - 1])), JSON.stringify(at))
  assert.ok(script.includes('addr=198.51.100.7'))
  // Never `exit` but through stop(); a token of that name exists: refused unless Replace.
  assert.deepEqual(script.split('\n').filter((l) => /\bexit\b/.test(l) && !/^stop\(\)/.test(l) && !/trap/.test(l)), [])
  assert.ok(script.includes('choose Replace'))
  assert.ok(!script.includes('pveum user token remove'))
  assert.ok(setupScript(request({ replace: true })).includes('pveum user token remove "$U" "$T"'))
  // PBS: its own tool, Audit, port 8007.
  const pbs = setupScript(request({ product: 'pbs', tunnel: { keyLine: tunnelKey.publicLine, clientAddr: '198.51.100.7' } }))
  assert.ok(pbs.includes('proxmox-backup-manager user generate-token "$U" "$T"') && pbs.includes('Audit --auth-id "$U!$T"') && pbs.includes('PermitOpen 127.0.0.1:8007'))
  assert.ok(!pbs.includes('8006'))
})

test('anything not exactly as expected is refused before a script exists', () => {
  const refused = (over: Partial<SetupRequest>, re: RegExp) => assert.throws(() => setupScript(request(over)), re)
  refused({ runId: 'abc; rm -rf /' }, /run id/)
  refused({ product: 'pdm' as never }, /Proxmox VE or Backup Server/)
  refused({ resultKey: "x'\nrm -rf /\n" }, /PEM public key/)
  refused({ tunnel: { keyLine: `${tunnelKey.publicLine}\nssh-rsa AAAA evil`, clientAddr: '198.51.100.7' } }, /plugin’s own Ed25519/)
  refused({ tunnel: { keyLine: `command="sh" ${tunnelKey.publicLine}`, clientAddr: '198.51.100.7' } }, /plugin’s own Ed25519/)
  refused({ tunnel: { keyLine: tunnelKey.publicLine.replace('orca-proxmox-tunnel', "x' ; reboot '"), clientAddr: '198.51.100.7' } }, /plugin’s own Ed25519/)
  refused({ tunnel: { keyLine: tunnelKey.publicLine, clientAddr: '1.2.3.4,user=root' } }, /IP address/)
  assert.throws(() => detectScript('nope'), /run id/)
  const receipt: SetupReceipt = { product: 'pve', runId: RUN, createdUser: true, addedUserAcl: true, createdToken: true, replacedToken: false, tunnel: { keyLine: tunnelKey.publicLine, createdAccount: true, addedPolicy: true, backup: '/etc/ssh/sshd_config; rm -rf /', createdKeyFile: true } }
  assert.throws(() => undoScript(receipt, RUN), /backup is not valid/)
})

test('answers come only from lines with the run id; wrapped rows are joined; values are capped', () => {
  const echo = commandLine(setupScript(request()))
  assert.ok(!echo.includes(`ORCA-SETUP-${RUN}`), 'the typed line can never pass for an answer')
  const lines = logicalLines({
    terminal: {
      tail: [echo, `ORCA-SETUP-${RUN} created_user 1`, `ORCA-SETUP-ffffffffffffffff created_token 1`, `ORCA-SETUP-${RUN} api_fp ${PIN.slice(0, 40)}`, PIN.slice(40), `ORCA-SETUP-${RUN} hostname ${'x'.repeat(900)}\u001b[31m`, `ORCA-SETUP-${RUN} end ok`],
      tailRows: [{}, {}, {}, {}, { wrapped: true }, {}, {}]
    }
  })
  const answer = parseAnswer(lines, RUN)
  assert.deepEqual(answer.pairs.map(([k]) => k), ['created_user', 'api_fp', 'hostname', 'end'])
  assert.equal(answer.pairs[1][1], PIN)
  assert.equal(answer.pairs[2][1].length, 400)
  assert.equal(answer.end, 'ok')
  const stopped = parseAnswer([`ORCA-SETUP-${RUN} created_token 1`, `ORCA-SETUP-${RUN} stop the token could not be created`, `ORCA-SETUP-${RUN} end stop`], RUN)
  assert.equal(stopped.end, 'stop')
  assert.equal(stopped.stop, 'the token could not be created')
  // The receipt keeps what was created even after a stop.
  assert.equal(receiptOf(request(), stopped).createdToken, true)
  assert.equal(receiptOf(request(), stopped).createdUser, false)
})

test('Undo reverses only what that run created, key first, and never a user it did not create', () => {
  const base: SetupReceipt = { product: 'pve', runId: RUN, createdUser: false, addedUserAcl: false, createdToken: true, replacedToken: false }
  const tokenOnly = undoScript(base, 'fedcba9876543210')
  assert.ok(tokenOnly.includes('pveum user token remove "$U" "$T"'))
  assert.ok(!tokenOnly.includes('pveum user delete') && !tokenOnly.includes('--users "$U" --roles PVEAuditor'))
  assert.ok(!tokenOnly.includes('userdel') && !tokenOnly.includes('sshd_config'))
  const full = undoScript({ ...base, createdUser: true, addedUserAcl: true, tunnel: { keyLine: tunnelKey.publicLine, createdAccount: true, addedPolicy: true, backup: '/etc/ssh/sshd_config.orca-backup.20261125-120000', createdKeyFile: true } }, 'fedcba9876543210')
  const order = ['rm -f "$K"', 'pkill -u orca-tunnel', 'cmp -s - /etc/ssh/sshd_config', 'userdel -r orca-tunnel', 'pveum user token remove', 'pveum user delete']
  const at = order.map((s) => full.indexOf(s))
  assert.ok(at.every((p, i) => p > 0 && (i === 0 || p > at[i - 1])), JSON.stringify(at))
  // The key file only while it holds exactly this run's line; sshd_config only while it is exactly backup + block.
  assert.ok(full.includes(`[ "$(cat "$K")" = '${authorizedLine(tunnelKey.publicLine, 8006)}' ]`))
  assert.ok(!/>\s*"\$K"|truncate|: >/.test(full), 'authorized_keys is never truncated or rewritten')
  assert.ok(!/pkill(?! -u orca-tunnel)/.test(full) && !/kill -9|killall|ssh -O/.test(full), 'no other sessions are touched')
  assert.ok(full.includes('[ "$LEFT" = 0 ]'))
  // Not created by this run: not removed.
  const kept = undoScript({ ...base, tunnel: { keyLine: tunnelKey.publicLine, createdAccount: false, addedPolicy: false, createdKeyFile: false } }, 'fedcba9876543210')
  assert.ok(!kept.includes('rm -f "$K"') && !kept.includes('userdel') && !kept.includes('pkill') && !kept.includes('cp -a'))
})

/** An Orca CLI with one connected SSH target (with a workspace) whose terminals act like that server. */
function fakeOrca(server: (script: string, runId: string) => string[], opts: { failRead?: boolean } = {}) {
  const typed: string[] = []
  const shown: string[] = []
  const closed: string[] = []
  const terminals = new Map<string, { script: string; runId: string }>()
  const cli: CliRunner = async (args) => {
    const cmd = args.slice(0, 2).join(' ')
    const arg = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
    if (cmd === 'host list') return { hosts: [{ kind: 'local', id: 'local', name: 'this machine' }, { kind: 'ssh', id: 'ssh-example-x1', name: 'pve-x1', connected: true }] }
    if (cmd === 'environment list') return { environments: [] }
    if (cmd === 'bot list') return { bots: [] }
    if (cmd === 'worktree ps') return { worktrees: [{ worktreeId: 'repo-x::/root/work', hostId: 'ssh:ssh-example-x1', displayName: 'work', repo: 'work', agents: [] }] }
    if (cmd === 'terminal create') {
      const line = arg('command')!
      typed.push(line)
      const b64 = /printf %s ([A-Za-z0-9+/=]+) \|/.exec(line)![1]
      const script = gunzipSync(Buffer.from(b64, 'base64')).toString('utf8')
      const runId = /^R=([0-9a-f]{16})$/m.exec(script)![1]
      const handle = `term_${terminals.size + 1}`
      terminals.set(handle, { script, runId })
      return { terminal: { handle } }
    }
    if (cmd === 'terminal read') {
      if (opts.failRead) throw new Error('the terminal went away')
      const t = terminals.get(arg('terminal')!)!
      // What the terminal shows: the typed line, then the server's output, wrapped at 80 columns.
      const out = [typed.at(-1)!, ...server(t.script, t.runId)]
      shown.push(...out)
      const tail: string[] = []
      const tailRows: { wrapped: boolean }[] = []
      for (const l of out) for (let i = 0; i < Math.max(1, l.length); i += 80) {
        tail.push(l.slice(i, i + 80))
        tailRows.push({ wrapped: i > 0 })
      }
      return { terminal: { handle: arg('terminal'), status: 'running', tail, tailRows } }
    }
    if (cmd === 'terminal close') {
      closed.push(arg('terminal')!)
      return { close: { handle: arg('terminal') } }
    }
    throw new Error(`unexpected orca ${args.join(' ')}`)
  }
  return { cli, typed, shown, closed }
}

const say = (runId: string, ...pairs: [string, string][]) => pairs.map(([k, v]) => `ORCA-SETUP-${runId} ${k} ${v}`)

/** The server's side of a successful run: what the real script would print. */
function pveServer(opts: { stopAt?: string } = {}) {
  return (script: string, runId: string): string[] => {
    if (script.includes('detect what this host runs')) {
      return say(runId, ['root', 'yes'], ['pve', '9.1.2'], ['sshd', 'yes'], ['hostname', 'pve-x1'], ['fqdn', 'pve-x1.example.test'], ['via', '198.51.100.7 50122 198.51.100.21 22'], ['end', 'ok'])
    }
    if (script.includes('undo what the setup run')) {
      return say(runId, ['removed_keyfile', '1'], ['removed_policy', '1'], ['removed_account', '1'], ['removed_token', '1'], ['removed_user', '1'], ['end', 'ok'])
    }
    const pem = /<<'ORCA_KEY'\n([\s\S]+?)\nORCA_KEY/.exec(script)![1]
    const cipher = publicEncrypt({ key: pem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(SECRET)).toString('base64')
    const tunnel = script.includes('Match User orca-tunnel')
    const steps: [string, string][] = [['created_user', '1'], ['created_token', '1'], ['added_user_acl', '1']]
    if (tunnel) steps.push(['backup', '/etc/ssh/sshd_config.orca-backup.20261125-120000'], ['created_account', '1'], ['added_policy', '1'], ['created_keyfile', '1'], ['ssh_hostkey', HOST_KEY])
    if (opts.stopAt) return say(runId, ...steps.slice(0, 2), ['stop', opts.stopAt], ['end', 'stop'])
    return say(runId, ...steps, ['api_fp', PIN], ['hostname', 'pve-x1'], ...(cipher.match(/.{1,64}/g)!.map((c): [string, string] => ['secret', c])), ['end', 'ok'])
  }
}

let worker: TestWorker | undefined
afterEach(async () => {
  await worker?.deactivate()
  worker = undefined
})

/** A fake ssh that says it authenticated and forwards, like ssh -v does; records the key file it was given. */
function fakeSsh() {
  const keys: { path: string; existedAtSpawn: boolean }[] = []
  const spawn = (_cmd: string, args: string[]): TunnelChild => {
    const opt = (name: string) => args.find((a, i) => args[i - 1] === '-o' && a.startsWith(`${name}=`))?.slice(name.length + 1)
    const identity = opt('IdentityFile')!.slice(1, -1).replace(/%%/g, '%').replace(/\\(["\\])/g, '$1')
    keys.push({ path: identity, existedAtSpawn: existsSync(identity) })
    const port = Number(args[args.indexOf('-L') + 1].split(':')[1])
    const say: ((chunk: string) => void)[] = []
    const exit: ((code: number | null, signal: string | null) => void)[] = []
    const server = net.createServer((s) => {
      for (const l of say) l(`debug1: Connection to port ${port} forwarding to 127.0.0.1 port 8006 requested.\n`)
      s.destroy()
    })
    setImmediate(() => {
      for (const l of say) l('debug1: Authenticated to pve-x1.example.test ([198.51.100.21]:22) using "publickey".\n')
      server.listen(port, '127.0.0.1', () => {
        for (const l of say) l(`debug1: Local forwarding listening on 127.0.0.1 port ${port}.\n`)
      })
    })
    return {
      stderr: { on: (_e: 'data', l: (chunk: string) => void) => say.push(l) },
      on: (event: 'exit' | 'error', l: never) => (event === 'exit' ? exit.push(l) : 0),
      kill: () => {
        server.close()
        for (const l of exit.splice(0)) l(null, 'SIGTERM')
        return true
      }
    } as TunnelChild
  }
  return { keys, spawn }
}

async function mounted(server: ReturnType<typeof pveServer>, opts: { failRead?: boolean } = {}) {
  const orca = fakeOrca(server, opts)
  const ssh = fakeSsh()
  main.useTestDoubles({ transport: mockTransport(pveRoutes(NOW) as never), probe: async () => PIN, now: () => NOW, vault: memoryVault(), orcaCli: orca.cli, spawnSsh: ssh.spawn, sshPath: '/usr/bin/ssh', tunnelDir: dir })
  const host = mockHost()
  worker = await mountWorker(main, { host })
  return { orca, ssh, host }
}

const everything = (w: TestWorker, host: ReturnType<typeof mockHost>, extra: unknown[]) => JSON.stringify([w.logs, host.data().storage, ...extra])

test('Connect via Orca end to end: check, show, run, test, save; the secret only ever as ciphertext', async () => {
  const { orca, ssh, host } = await mounted(pveServer())
  const listed = await worker!.request('setup.hosts')
  assert.deepEqual(listed.hosts.map((h) => [h.key, h.where]), [['ssh:ssh-example-x1', 'the work workspace on pve-x1']])
  const checked = await worker!.request('setup.detect', { hostKey: 'ssh:ssh-example-x1' })
  const detection = checked.hosts[0].detection!
  assert.deepEqual([detection.root, detection.products, detection.hostname, detection.via], ['yes', { pve: '9.1.2' }, 'pve-x1', { client: '198.51.100.7', server: '198.51.100.21', port: 22 }])
  // Nothing runs before the person saw the script: the plan only shows it.
  const terminalsBefore = orca.typed.length
  const plan = await worker!.request('setup.plan', { hostKey: 'ssh:ssh-example-x1', product: 'pve', tunnel: true, replace: false, address: 'pve-x1.example.test', name: 'pve-x1' })
  assert.equal(orca.typed.length, terminalsBefore)
  assert.match(plan.script, /Match User orca-tunnel/)
  assert.equal(plan.connection?.baseUrl, 'https://pve-x1.example.test:8006')
  // Run once; the very script shown is the one typed (compressed).
  const result = await worker!.request('setup.run', { planId: plan.planId, hostKey: 'ssh:ssh-example-x1' })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.stage, 'saved')
  assert.equal(gunzipSync(Buffer.from(/printf %s ([A-Za-z0-9+/=]+) \|/.exec(orca.typed.at(-1)!)![1], 'base64')).toString(), plan.script)
  await assert.rejects(worker!.request('setup.run', { planId: plan.planId, hostKey: 'ssh:ssh-example-x1' }), /no longer valid/)
  // Every terminal it opened was closed again.
  assert.equal(orca.closed.length, 2)
  // Saved: pinned certificate and SSH host key, from the server itself; the plugin's own key.
  const config = await worker!.request('config.get')
  const saved = config.connections[0]
  assert.deepEqual([saved.kind, saved.baseUrl, saved.tokenId, saved.fingerprint, saved.hasSecret], ['pve', 'https://pve-x1.example.test:8006', 'orca-monitor@pve!orca', PIN, true])
  assert.equal(saved.tunnel?.hostKey, HOST_KEY)
  assert.equal(saved.tunnel?.identityFile, '')
  assert.match(saved.tunnel?.keyRef ?? '', /^k-[0-9a-f]{16}$/)
  // The test went through the tunnel with the plugin's key, written for ssh and removed once it was in.
  assert.ok(ssh.keys.length >= 1 && ssh.keys.every((k) => k.existedAtSpawn))
  await new Promise((r) => setTimeout(r, 50))
  assert.ok(ssh.keys.every((k) => !existsSync(k.path)), 'the key file is gone after authentication')
  // The secret: never in the terminal, the typed command, an answer, a log or storage; sealed in secrets.
  const all = everything(worker!, host, [orca.typed, orca.shown, listed, checked, plan, result, config])
  assert.ok(!all.includes(SECRET) && !all.includes(SECRET.slice(0, 8)))
  assert.ok(!all.includes('PRIVATE KEY'))
  const secrets = JSON.stringify(host.data().secrets)
  assert.ok(!secrets.includes(SECRET) && !secrets.includes('PRIVATE KEY'), 'secrets are only stored sealed')
  // Undo: shown first, then reverses it on the host and removes the connection and the key.
  const undo = await worker!.request('setup.undoPlan', { hostKey: 'ssh:ssh-example-x1', product: 'pve' })
  assert.match(undo.script, /userdel -r orca-tunnel/)
  const undone = await worker!.request('setup.run', { planId: undo.planId, hostKey: 'ssh:ssh-example-x1' })
  assert.equal(undone.ok, true, JSON.stringify(undone))
  assert.equal((await worker!.request('config.get')).connections.length, 0)
  assert.ok(!Object.keys(host.data().secrets).some((k) => k.startsWith('tunnel-key:')))
  assert.deepEqual((await worker!.request('setup.hosts')).hosts[0].records, [])
  assert.equal(orca.closed.length, 3)
})

test('a run that stops keeps what it created for Undo, saves nothing, and still closes its terminal', async () => {
  const { orca } = await mounted(pveServer({ stopAt: 'the token’s permission could not be set' }))
  await worker!.request('setup.detect', { hostKey: 'ssh:ssh-example-x1' })
  const plan = await worker!.request('setup.plan', { hostKey: 'ssh:ssh-example-x1', product: 'pve', tunnel: false, replace: false, address: '198.51.100.21', name: 'pve-x1' })
  const result = await worker!.request('setup.run', { planId: plan.planId, hostKey: 'ssh:ssh-example-x1' })
  assert.equal(result.ok, false)
  assert.match(result.message, /permission could not be set.*Undo reverses/)
  assert.equal((await worker!.request('config.get')).connections.length, 0)
  const records = (await worker!.request('setup.hosts')).hosts[0].records
  assert.equal(records.length, 1)
  assert.equal(records[0].complete, false)
  const undo = await worker!.request('setup.undoPlan', { hostKey: 'ssh:ssh-example-x1', product: 'pve' })
  assert.ok(undo.script.includes('pveum user token remove') && undo.script.includes('pveum user delete'))
  assert.equal(orca.closed.length, orca.typed.length)
})

test('refusals: no check, no product, no root, a plan for another host, a terminal that fails', async () => {
  const { orca } = await mounted(pveServer(), { failRead: false })
  const plan = (over: Record<string, unknown> = {}) => worker!.request('setup.plan', { hostKey: 'ssh:ssh-example-x1', product: 'pve', tunnel: false, replace: false, address: 'pve-x1.example.test', name: 'pve-x1', ...over } as never)
  await assert.rejects(plan(), /Check the host first/)
  await worker!.request('setup.detect', { hostKey: 'ssh:ssh-example-x1' })
  await assert.rejects(plan({ product: 'pbs' }), /no Proxmox Backup Server/)
  await assert.rejects(plan({ product: 'pdm' }), /guide’s PDM token steps/)
  await assert.rejects(plan({ address: 'pve-x1.example.test; reboot' }), /DNS name or an IP/)
  await assert.rejects(plan({ name: '../x' }), /letters, digits/)
  await assert.rejects(worker!.request('setup.detect', { hostKey: 'local' }), /hostKey must name/)
  const shown = await plan()
  await assert.rejects(worker!.request('setup.run', { planId: shown.planId, hostKey: 'ssh:ssh-example-other' }), /no longer valid/)
  assert.equal(orca.typed.length, 1, 'only the check ran')

  // A terminal whose output cannot be read is still closed.
  await worker!.deactivate()
  const failing = await mounted(pveServer(), { failRead: true })
  await assert.rejects(worker!.request('setup.detect', { hostKey: 'ssh:ssh-example-x1' }), /terminal could not be read/)
  assert.deepEqual(failing.orca.closed, ['term_1'])
})
