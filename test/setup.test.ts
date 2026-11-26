// Connect via Orca: the generated scripts, what refuses to be generated, how answers are read back
// from a terminal (strictly framed, kept across reads, checked against their checksum), sealed
// records, and whole runs through the worker with a fake Orca CLI whose "server" answers like the
// real scripts (encrypting the token secret to the script's one-time key, as openssl does there).
// The secret must never be in what the terminal shows, the typed command, an answer, a log or
// storage. Example data only.
import { constants, createHash, publicEncrypt } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { after } from 'node:test'
import { afterEach, assert, mockHost, mountWorker, test, type TestWorker } from 'orca/testing'
import type { CliRunner } from '../src/orca/inventory'
import type { SetupRunAnswer } from '../src/protocol'
import { oneTimeKey } from '../src/setup/keys'
import { commandLine, logicalLines } from '../src/setup/runner'
import { AnswerReader, cipherOf, detectScript, setupScript, undoScript, type SetupRequest } from '../src/setup/script'
import { validRecord } from '../src/setup/service'
import { memoryVault } from '../src/vault'
import * as main from '../src/worker'
import { pveRoutes } from './fixtures/direct'
import { mockTransport } from './fixtures/pdm'

const NOW = Date.UTC(2026, 10, 25, 12, 0, 0)
const PIN = 'EC:7A:EF:38:FF:F7:59:92:C1:E3:B0:4C:1D:22:FF:C9:67:C6:91:C8:74:48:53:13:12:1A:C0:42:D1:5B:37:05'
const SECRET = '6f1c2b3a-4d5e-4f60-8a71-92b3c4d5e6f7'
const RUN = '0123456789abcdef'
const key = oneTimeKey()
const request = (over: Partial<SetupRequest> = {}): SetupRequest => ({ product: 'pve', runId: RUN, resultKey: key.publicPem, replace: false, ...over })
const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex')
after(() => key.wipe())

/** What a script prints for these answers: numbered lines and the checksummed end. */
function frame(runId: string, pairs: [string, string][], status: 'ok' | 'stop' = 'ok'): string[] {
  const lines = pairs.map(([k, v], i) => `ORCA-SETUP-${runId} ${i + 1} ${k} ${v}`)
  return [...lines, `ORCA-SETUP-${runId} ${pairs.length + 1} end ${status} ${sha(pairs.map(([k, v]) => `${k} ${v}\n`).join(''))}`, '']
}
const read = (runId: string, ...reads: string[][]) => {
  const r = new AnswerReader(runId)
  for (const lines of reads) r.add(lines)
  return r.answer(sha)
}

test('the setup script holds only public values, and the secret leaves the host only encrypted', () => {
  const script = setupScript(request())
  assert.ok(script.includes(key.publicPem.trim()))
  assert.ok(!script.includes('PRIVATE KEY'))
  assert.match(script, /printf '%s' "\$S" \| openssl pkeyutl -encrypt -pubin/)
  assert.match(script, /say secret "\$I \$L"/)
  for (const line of script.split('\n').filter((l) => /\bsay\b/.test(l) && !/^say\(\)/.test(l.trim()))) assert.ok(!/\$S\b|\$OUT\b/.test(line), line)
  // Everything it creates carries the run id; each change is recorded on the host first.
  assert.ok(script.includes('UC="Read-only, Orca plugin $R"; TC="Orca plugin $R"'))
  for (const item of ['user', 'token', 'user_acl', 'token_acl']) assert.ok(script.includes(`mark intent ${item}`) && script.includes(`mark done ${item}`), item)
  // Every list read is checked, never hidden in a pipeline.
  assert.ok(script.includes('UL=$(pveum user list --output-format json) || stop'))
  assert.ok(script.includes('TL=$(pveum user token list "$U" --output-format json) || stop'))
  // Only the read-only token: nothing of an SSH account, sshd or keys.
  assert.ok(!/sshd|useradd|authorized_keys|orca-tunnel|Match User/.test(script))
  assert.deepEqual(script.split('\n').filter((l) => /\bexit\b/.test(l) && !/^stop\(\)/.test(l) && !/trap|exit 0|exit 1; \}; \}|awk/.test(l)), [])
  assert.ok(script.includes('choose Replace') && !script.includes('pveum user token remove'))
  assert.ok(setupScript(request({ replace: true })).includes('pveum user token remove "$U" "$T"'))
})

test('PBS: only the subcommands and options its CLI has, checked before anything changes', () => {
  const pbs = setupScript(request({ product: 'pbs' }))
  // generate-token is the API method itself: no --output-format, a --comment.
  assert.ok(pbs.includes('OUT=$(proxmox-backup-manager user generate-token "$U" "$T" --comment "$TC")'))
  assert.ok(!/user generate-token "\$U"[^\n]*--output-format/.test(pbs))
  for (const used of ['user list --output-format json', 'user list-tokens "$U" --output-format json', 'user create "$U" --comment "$UC"', 'acl list --output-format json', 'acl update / Audit --auth-id "$U!$T"']) assert.ok(pbs.includes(used), used)
  // The preflight covers every subcommand and option the scripts use, deletions included.
  for (const checked of ["'user generate-token:--comment'", "'acl update:--delete'", "'acl update:--auth-id'", "'user delete-token:delete-token'", "'user remove:remove'", "'user list-tokens:--output-format'"]) assert.ok(pbs.includes(checked), checked)
  // Its JSON is read whether printed compact or pretty, with "Result:" before it.
  assert.ok(pbs.includes(`tr ',{}' '\\n\\n\\n'`))
  assert.ok(pbs.indexOf("'user generate-token:--comment'") < pbs.indexOf('mark intent user'), 'the preflight comes before any change')
  assert.ok(pbs.includes('127.0.0.1:8007') && !pbs.includes('8006'))
})

test('anything not exactly as expected is refused before a script exists', () => {
  const refused = (over: Partial<SetupRequest>, re: RegExp) => assert.throws(() => setupScript(request(over)), re)
  refused({ runId: 'abc; rm -rf /' }, /run id/)
  refused({ product: 'pdm' as never }, /Proxmox VE or Backup Server/)
  refused({ resultKey: "x'\nrm -rf /\n" }, /PEM public key/)
  refused({ replace: 'yes' as never }, /Replace/)
  assert.throws(() => detectScript('nope'), /run id/)
  // Undo takes the stored run id only in its exact form: no line break gets through.
  assert.throws(() => undoScript('pve', `${RUN}\nrm -rf /`, 'fedcba9876543210'), /run id/)
  assert.throws(() => undoScript('pdm' as never, RUN, 'fedcba9876543210'), /Unknown product/)
})

test('a stored record is used only exactly as written', () => {
  const ok = { hostKey: 'ssh:ssh-example-x1', runId: RUN, product: 'pve', at: NOW, status: 'saved', connection: { id: 'c-1', revision: 'r-1' } }
  assert.ok(validRecord(ok, ok.hostKey, RUN))
  assert.equal(validRecord({ ...ok, runId: `${RUN}\nrm -rf /` }, ok.hostKey, RUN), null)
  assert.equal(validRecord(ok, ok.hostKey, 'fedcba9876543210'), null, 'bound to the run it is stored under')
  assert.equal(validRecord({ ...ok, extra: 1 }, ok.hostKey, RUN), null)
  assert.equal(validRecord({ ...ok, tunnel: { keyLine: 'x' } }, ok.hostKey, RUN), null, 'no tunnel field any more')
  assert.equal(validRecord({ ...ok, status: 'done' }, ok.hostKey, RUN), null)
  assert.equal(validRecord({ ...ok, product: 'pdm' }, ok.hostKey, RUN), null)
})

test('answers: only whole numbered lines of this run, kept across reads, complete and matching their checksum', () => {
  const pairs: [string, string][] = [['created_user', '1'], ['api_fp', PIN], ['hostname', 'pve-x1']]
  const full = frame(RUN, pairs)
  // The typed line can never pass for an answer.
  assert.ok(!commandLine(setupScript(request())).includes(`ORCA-SETUP-${RUN}`))
  const a = read(RUN, [commandLine(setupScript(request())), ...full])
  assert.equal(a.end, 'ok')
  assert.deepEqual(a.pairs, pairs)
  // A later, shorter tail (older lines dropped) loses nothing seen before.
  assert.equal(read(RUN, full.slice(0, 3), full.slice(1)).end, 'ok')
  // Wrapped rows are joined; a still-growing last line is not taken.
  const wrapped = logicalLines({ terminal: { tail: [full[0], full[1].slice(0, 40), full[1].slice(40), ...full.slice(2)], tailRows: [{}, {}, { wrapped: true }, {}, {}, {}] } })
  assert.equal(read(RUN, wrapped).end, 'ok')
  const growing = read(RUN, [full[0], full[1].slice(0, 30)])
  assert.deepEqual(growing.pairs.map(([k]) => k), ['created_user'])
  assert.equal(growing.end, undefined)
  // Missing, altered, repeated or foreign lines never make a complete answer.
  assert.equal(read(RUN, [full[0], ...full.slice(2)]).end, undefined, 'a gap')
  const altered = [...full]
  altered[1] = altered[1].replace(PIN, PIN.replace('EC', 'AA'))
  assert.ok(read(RUN, altered).invalid)
  assert.ok(read(RUN, full, altered).invalid, 'a line that changed between reads')
  assert.ok(read(RUN, frame(RUN, [['hostname', 'a'], ['hostname', 'b']])).invalid, 'a key twice')
  assert.ok(read(RUN, frame(RUN, [['made_up', '1']])).invalid, 'an unknown key')
  assert.ok(read(RUN, frame(RUN, [['created_keyfile', '1']])).invalid, 'nothing of a tunnel is an answer any more')
  assert.ok(read(RUN, [`echo ORCA-SETUP-${RUN} 1 created_user 1`, ...full]).invalid, 'a marker that does not start its line')
  assert.equal(read(RUN, frame('ffffffffffffffff', pairs)).end, undefined, 'another run')
  const stopped = read(RUN, frame(RUN, [['created_token', '1'], ['stop', 'the token’s permission could not be set']], 'stop'))
  assert.equal(stopped.end, 'stop')
  assert.equal(stopped.stop, 'the token’s permission could not be set')
  // The secret's chunks in order only.
  assert.equal(cipherOf({ pairs: [['secret', '1 QUJD'], ['secret', '2 REVG']] }), 'QUJDREVG')
  assert.equal(cipherOf({ pairs: [['secret', '2 REVG'], ['secret', '1 QUJD']] }), null)
})

test('Undo owns only what the run recorded as done, never what it found there; one script at a time per host', () => {
  const setup = setupScript(request())
  // What was there before is recorded as such; the token's permission is journaled too.
  assert.ok(setup.includes('  mark existing user\n  say reused_user 1'))
  assert.ok(setup.includes('else\n  mark existing user_acl\nfi'))
  assert.ok(setup.includes('mark intent token_acl') && setup.includes('mark done token_acl'))
  const undo = undoScript('pve', RUN, 'fedcba9876543210')
  assert.ok(undo.includes('made() { grep -q "^done $1') && undo.includes('&& ! grep -qx "existing $1" "$STATE"; }'))
  for (const item of ['token', 'user', 'user_acl']) assert.ok(undo.includes(`made ${item} && ! undone ${item}`), item)
  assert.ok(!/\bdid (token|user|user_acl) &&/.test(undo), 'intent alone never removes anything')
  // The permissions are read (checked) before anything about the user's permission is decided.
  assert.ok(undo.indexOf('AL=$(pveum acl list --output-format json) || stop') > 0 && undo.indexOf('AL=$(pveum acl list --output-format json) || stop') < undo.indexOf('if made user_acl'))
  assert.ok(undo.includes('say unconfirmed "$UNSURE"'))
  // Setup and Undo take the same host-side lock, without waiting, before touching the journal.
  for (const script of [setup, undo]) {
    const lock = script.indexOf('flock -n 9 || stop')
    assert.ok(lock > 0 && lock < script.indexOf('STATE='), 'lock first')
    assert.ok(script.includes('[ "$(stat -c %u "$D")" = 0 ]'), 'the state folder must be root’s own')
  }
  assert.ok(setup.includes('( set -C; : > "$STATE" )'), 'a run’s journal is created exclusively')
})

test('a user permission is undone only while it is exactly the entry the run made; PBS loses none to a removed user', () => {
  for (const product of ['pve', 'pbs'] as const) {
    const setup = setupScript(request({ product }))
    // The grant as it stood right after the run made it: path, role, propagate and user, journaled.
    assert.ok(setup.indexOf('mark acl "$A"') > setup.indexOf('mark done user_acl'))
    assert.ok(setup.includes('the user\'s new permission could not be read back'))
    const undo = undoScript(product, RUN, 'fedcba9876543210')
    assert.ok(undo.includes("REC=$(sed -n 's/^acl //p' \"$STATE\" | head -n 1)"))
    assert.ok(undo.includes('elif [ -n "$REC" ] && [ "$MINE" = "$REC" ]; then\n    ACL=1'))
    assert.ok(undo.includes('CHANGED="$CHANGED user_acl"') && undo.includes('say changed "$CHANGED"'))
    // The user only when its permissions are exactly that one entry; the permission removed first
    // (PBS keeps a removed user's permissions), and none left for the user or its token afterwards.
    assert.ok(undo.includes('elif [ -n "$ALLU" ] && [ "$ALLU" != "$REC" ]; then'))
    const branch = undo.slice(undo.indexOf('if [ -n "$UEX" ] && made user'))
    const del = product === 'pve' ? 'pveum user delete' : 'proxmox-backup-manager user remove'
    const aclDel = product === 'pve' ? 'pveum acl delete / --users' : 'proxmox-backup-manager acl update / Audit --auth-id "$U" --delete true'
    assert.ok(branch.indexOf(aclDel) > 0 && branch.indexOf(aclDel) < branch.indexOf(del), product)
    assert.ok(branch.indexOf('grep -qF -e "$UG" -e "\\"ugid\\":\\"$U!" && stop') > branch.indexOf(del))
    // A PVE user added to a group since is kept: deleting it would drop the membership.
    assert.equal(undo.includes('pveum group list --output-format json'), product === 'pve')
  }
})

test('Undo removes only what carries the run’s label, from the host’s own record', () => {
  const undo = undoScript('pve', RUN, 'fedcba9876543210')
  assert.ok(undo.includes(`STATE=/var/lib/orca-proxmox-setup/$S`))
  assert.ok(undo.includes(`has "$TL" '"tokenid":"orca"' "\\"comment\\":\\"Orca plugin $S\\""`))
  assert.ok(undo.includes(`"\\"comment\\":\\"Read-only, Orca plugin $S\\""`))
  assert.ok(undo.includes('UL=$(pveum user list --output-format json) || stop'))
  assert.ok(undo.includes('TL=$(pveum user token list "$U" --output-format json) || stop'))
  assert.ok(!/userdel|sshd|authorized_keys|pkill/.test(undo))
  assert.ok(undo.indexOf('pveum user token remove') > 0 && undo.indexOf('pveum user delete') > undo.indexOf('pveum user token remove'))
})

test('the API permission list: every listed privilege counts, whatever its propagate bit; any other shape is refused', () => {
  // PVE answers 1/0, PBS true/false: 0 and false mean "not inherited further", not "not granted".
  assert.deepEqual(main.privilegeNames({ '/': { 'Sys.Audit': 1, 'VM.Audit': 1 }, '/vms/100': { 'VM.Audit': 1, 'VM.PowerMgmt': 0 } }), ['Sys.Audit', 'VM.Audit', 'VM.PowerMgmt'])
  assert.deepEqual(main.privilegeNames({ '/datastore/store1': { 'Datastore.Modify': false }, '/': { 'Sys.Audit': true } }), ['Datastore.Modify', 'Sys.Audit'])
  assert.deepEqual(main.privilegeNames({}), [])
  for (const bad of [null, [], 'x', { '/': ['VM.Audit'] }, { '/': null }, { vms: { 'VM.Audit': 1 } }, { '/': { 'VM.Audit': 'yes' } }, { '/': { 'bad name': 1 } }]) {
    assert.throws(() => main.privilegeNames(bad), /unexpected shape/)
  }
})

type Server = (script: string, runId: string) => string[]

/** An Orca CLI with one connected SSH target (with a workspace) whose terminals act like that server. */
function fakeOrca(server: Server, opts: { failRead?: boolean; shrink?: boolean } = {}) {
  const typed: string[] = []
  const shown: string[] = []
  const closed: string[] = []
  const terminals = new Map<string, { script: string; runId: string; reads: number; output?: string[] }>()
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
      const script = gunzipSync(Buffer.from(/printf %s ([A-Za-z0-9+/=]+) \|/.exec(line)![1], 'base64')).toString('utf8')
      const handle = `term_${terminals.size + 1}`
      terminals.set(handle, { script, runId: /^R=([0-9a-f]{16})$/m.exec(script)![1], reads: 0 })
      return { terminal: { handle } }
    }
    if (cmd === 'terminal read') {
      if (opts.failRead) throw new Error('the terminal went away')
      const t = terminals.get(arg('terminal')!)!
      t.reads += 1
      // What the host printed, once (the secret's ciphertext differs on every encryption).
      t.output ??= server(t.script, t.runId)
      let out = [typed.at(-1)!, ...t.output]
      // A terminal that keeps less on every read: the first read had everything but the end.
      if (opts.shrink) out = t.reads === 1 ? out.slice(0, -2) : out.slice(3)
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

/** The server's side, as the real scripts print it. */
function server(opts: { stopAt?: string; garble?: boolean; unconfirmed?: boolean; changed?: boolean } = {}): Server {
  return (script, runId) => {
    if (script.includes('detect what this host runs')) {
      return frame(runId, [['root', 'yes'], ['pve', '9.1.2'], ['hostname', 'pve-x1'], ['fqdn', 'pve-x1.example.test'], ['via', '198.51.100.7 50122 198.51.100.21 22']])
    }
    if (script.includes('undo what the setup run')) {
      if (opts.changed) return frame(runId, [['removed_token', '1'], ['kept_user', 'its permission was changed since the run'], ['changed', ' user_acl']])
      return frame(runId, opts.unconfirmed ? [['removed_token', '1'], ['unconfirmed', ' user_acl']] : [['removed_token', '1'], ['removed_user_acl', '1'], ['removed_user', '1']])
    }
    const pem = /<<'ORCA_KEY'\n([\s\S]+?)\nORCA_KEY/.exec(script)![1]
    const cipher = publicEncrypt({ key: pem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(SECRET)).toString('base64')
    const steps: [string, string][] = [['created_user', '1'], ['created_token', '1'], ['added_user_acl', '1']]
    if (opts.stopAt) return frame(runId, [...steps.slice(0, 2), ['stop', opts.stopAt]], 'stop')
    const lines = frame(runId, [...steps, ['api_fp', PIN], ['hostname', 'pve-x1'], ...cipher.match(/.{1,64}/g)!.map((c, i): [string, string] => ['secret', `${i + 1} ${c}`])])
    if (opts.garble) lines[lines.length - 2] = lines[lines.length - 2].replace(/ [0-9a-f]{64}$/, ` ${'0'.repeat(64)}`)
    return lines
  }
}

let worker: TestWorker | undefined
afterEach(async () => {
  await worker?.deactivate()
  worker = undefined
})

const READ_ONLY = { '/': { 'Sys.Audit': 1, 'VM.Audit': 1, 'Datastore.Audit': 1, 'VM.GuestAgent.Audit': 1 } }

async function mounted(srv: Server, opts: { failRead?: boolean; shrink?: boolean; privileges?: unknown; storage?: Record<string, never> } = {}) {
  const orca = fakeOrca(srv, opts)
  const routes = { ...pveRoutes(NOW), '/access/permissions': opts.privileges ?? READ_ONLY }
  main.useTestDoubles({ transport: mockTransport(routes as never), probe: async () => PIN, now: () => NOW, vault: memoryVault(), orcaCli: orca.cli })
  const host = mockHost(opts.storage ? { storage: opts.storage } : undefined)
  worker = await mountWorker(main, { host })
  return { orca, host }
}

const X1 = 'ssh:ssh-example-x1'
async function runJob(planId: string): Promise<SetupRunAnswer> {
  const { jobId } = await worker!.request('setup.run', { planId, hostKey: X1 })
  for (let i = 0; i < 400; i += 1) {
    const job = await worker!.request('setup.job', { jobId })
    if (!job.running) return job.answer
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('the job did not end')
}
const plan = (over: Record<string, unknown> = {}) =>
  worker!.request('setup.plan', { hostKey: X1, product: 'pve', replace: false, address: 'pve-x1.example.test', name: 'pve-x1', ...over } as never)

test('Connect via Orca end to end: check, show, run, checks from this machine, save; Undo of that run', async () => {
  const { orca, host } = await mounted(server())
  const checked = await worker!.request('setup.detect', { hostKey: X1 })
  assert.deepEqual(checked.hosts[0].detection?.via, { client: '198.51.100.7', server: '198.51.100.21', port: 22 })
  const shown = await plan()
  assert.ok(!/orca-tunnel|sshd/.test(shown.script))
  assert.equal(orca.typed.length, 1, 'nothing runs before Run')
  const answer = await runJob(shown.planId)
  assert.equal(answer.ok, true, JSON.stringify(answer))
  assert.match(answer.message, /read rights only/)
  assert.equal(gunzipSync(Buffer.from(/printf %s ([A-Za-z0-9+/=]+) \|/.exec(orca.typed[1])![1], 'base64')).toString(), shown.script)
  assert.deepEqual(orca.closed, ['term_1', 'term_2'])
  const config = await worker!.request('config.get')
  const saved = config.connections[0]
  assert.deepEqual([saved.kind, saved.baseUrl, saved.tokenId, saved.fingerprint, saved.hasSecret, saved.tunnel], ['pve', 'https://pve-x1.example.test:8006', 'orca-monitor@pve!orca', PIN, true, undefined])
  // Records are sealed: storage holds no readable record.
  const stored = host.data().storage['setup.records'] as { sealed: string }[]
  assert.equal(stored.length, 1)
  assert.ok(!JSON.stringify(stored).includes('pve-x1.example.test'))
  const listed = await worker!.request('setup.hosts')
  assert.equal(listed.hosts[0].records[0].status, 'saved')
  // The secret never in the terminal, the typed lines, answers, logs or storage.
  const all = JSON.stringify([worker!.logs, host.data().storage, orca.typed, orca.shown, answer, listed, config])
  assert.ok(!all.includes(SECRET) && !all.includes(SECRET.slice(0, 8)) && !all.includes('PRIVATE KEY'))
  const secrets = JSON.stringify(host.data().secrets)
  assert.ok(!secrets.includes(SECRET), 'secrets are only stored sealed')
  // Undo of exactly that run: removes the connection that run saved, and its record.
  const undo = await worker!.request('setup.undoPlan', { hostKey: X1, runId: listed.hosts[0].records[0].runId })
  assert.match(undo.script, /flock -n 9/)
  const undone = await runJob(undo.planId)
  assert.equal(undone.ok, true, JSON.stringify(undone))
  assert.equal((await worker!.request('config.get')).connections.length, 0)
  assert.deepEqual((await worker!.request('setup.hosts')).hosts[0].records, [])
})

test('a token with more than read rights is not saved, even a write privilege on one guest that does not propagate', async () => {
  await mounted(server(), { privileges: { '/': { 'Sys.Audit': 1, 'VM.Audit': 1 }, '/vms/100': { 'VM.PowerMgmt': 0 } } })
  await worker!.request('setup.detect', { hostKey: X1 })
  const rights = await runJob((await plan()).planId)
  assert.equal(rights.ok, false)
  assert.equal(rights.stage, 'rights')
  assert.match(rights.message, /more than read rights \(VM\.PowerMgmt\)/)
  assert.equal((await worker!.request('config.get')).connections.length, 0)
  assert.equal((await worker!.request('setup.hosts')).hosts[0].records[0].status, 'failed')
  await worker!.deactivate()

  // PBS answers booleans; false still means granted there.
  await mounted(server(), { privileges: { '/': { 'Sys.Audit': true }, '/datastore/store1': { 'Datastore.Modify': false } } })
  await worker!.request('setup.detect', { hostKey: X1 })
  assert.match((await runJob((await plan()).planId)).message, /Datastore\.Modify/)
  await worker!.deactivate()

  // A permission list in an unexpected shape is never taken for "no rights".
  await mounted(server(), { privileges: { '/': ['Sys.Audit', 'VM.PowerMgmt'] } })
  await worker!.request('setup.detect', { hostKey: X1 })
  const odd = await runJob((await plan()).planId)
  assert.equal(odd.stage, 'rights')
  assert.match(odd.message, /could not be read: The permission list has an unexpected shape/)
})

test('an answer seen only in parts is assembled; one that does not check out is of unknown outcome, and recorded', async () => {
  // Every read keeps less, but together they hold everything: complete.
  await mounted(server(), { shrink: true })
  await worker!.request('setup.detect', { hostKey: X1 })
  const ok = await runJob((await plan()).planId)
  assert.equal(ok.ok, true, JSON.stringify(ok))
  await worker!.deactivate()

  await mounted(server({ garble: true }))
  await worker!.request('setup.detect', { hostKey: X1 })
  const garbled = await runJob((await plan()).planId)
  assert.equal(garbled.outcome, 'unknown')
  assert.match(garbled.message, /could not be trusted.*checksum/)
  const record = (await worker!.request('setup.hosts')).hosts[0].records[0]
  assert.equal(record.status, 'unknown')
  assert.equal((await worker!.request('config.get')).connections.length, 0)
  // Undo is offered for it: it works from the host's own record.
  assert.match((await worker!.request('setup.undoPlan', { hostKey: X1, runId: record.runId })).script, /STATE=\/var\/lib\/orca-proxmox-setup/)
})

test('Undo that finds something only started, not done, keeps it and the record, and says so', async () => {
  await mounted(server({ unconfirmed: true }))
  await worker!.request('setup.detect', { hostKey: X1 })
  assert.equal((await runJob((await plan()).planId)).ok, true)
  const record = (await worker!.request('setup.hosts')).hosts[0].records[0]
  const undone = await runJob((await worker!.request('setup.undoPlan', { hostKey: X1, runId: record.runId })).planId)
  assert.equal(undone.ok, false)
  assert.match(undone.message, /not recorded as done: user_acl/)
  const kept = (await worker!.request('setup.hosts')).hosts[0].records
  assert.equal(kept.length, 1)
  assert.match(kept[0].message ?? '', /Kept on the host, not recorded as done: user_acl/)
  assert.equal((await worker!.request('config.get')).connections.length, 0, 'the connection that run saved is removed all the same')
})

test('a run that stops, or whose save fails, keeps its record; Undo keeps a connection edited since', async () => {
  await mounted(server({ stopAt: 'the token’s permission could not be set' }))
  await worker!.request('setup.detect', { hostKey: X1 })
  const stopped = await runJob((await plan()).planId)
  assert.equal(stopped.outcome, 'stopped')
  assert.equal((await worker!.request('setup.hosts')).hosts[0].records[0].status, 'stopped')
  await worker!.deactivate()

  // Saving fails (another connection took that URL meanwhile): the record says so.
  await mounted(server())
  await worker!.request('setup.detect', { hostKey: X1 })
  const shown = await plan()
  await worker!.request('config.save', { id: 'new', kind: 'pve', name: 'other', baseUrl: 'https://pve-x1.example.test:8006', tokenId: 'monitor@pve!x', fingerprint: PIN, secret: '33333333-3333-4333-8333-333333333333' })
  const failed = await runJob(shown.planId)
  assert.equal(failed.stage, 'save')
  const record = (await worker!.request('setup.hosts')).hosts[0].records[0]
  assert.equal(record.status, 'failed')
  await worker!.request('config.clear', { id: (await worker!.request('config.get')).connections[0].id, revision: (await worker!.request('config.get')).connections[0].revision })

  // Saved, then edited in Settings: Undo leaves that connection alone.
  const again = await runJob((await plan({ replace: true })).planId)
  assert.equal(again.ok, true, JSON.stringify(again))
  const c = (await worker!.request('config.get')).connections[0]
  await worker!.request('config.save', { id: c.id, kind: 'pve', name: 'renamed', baseUrl: c.baseUrl, tokenId: c.tokenId, fingerprint: c.fingerprint })
  const records = (await worker!.request('setup.hosts')).hosts[0].records
  const latest = records.find((r) => r.status === 'saved')!
  const undone = await runJob((await worker!.request('setup.undoPlan', { hostKey: X1, runId: latest.runId })).planId)
  assert.match(undone.message, /changed since; it was kept/)
  assert.equal((await worker!.request('config.get')).connections.length, 1)
  // The other run's record is still there, with its own Undo.
  assert.deepEqual((await worker!.request('setup.hosts')).hosts[0].records.map((r) => r.runId), [record.runId])
})

test('refusals: altered records, no check, no product, wrong host, a used plan, a terminal that fails', async () => {
  const forged = { 'setup.records': [{ hostKey: X1, runId: RUN, sealed: 'sealed:v2:AAAA' }] }
  const { orca } = await mounted(server(), { storage: forged as never })
  const hosts = await worker!.request('setup.hosts')
  assert.equal(hosts.ignoredRecords, 1)
  assert.deepEqual(hosts.hosts[0].records, [])
  await assert.rejects(worker!.request('setup.undoPlan', { hostKey: X1, runId: RUN }), /no \(valid\) record/)
  await assert.rejects(worker!.request('setup.undoPlan', { hostKey: X1, runId: `${RUN}\nrm -rf /` }), /Name the setup run/)
  await assert.rejects(plan(), /Check the host first/)
  await worker!.request('setup.detect', { hostKey: X1 })
  await assert.rejects(plan({ product: 'pbs' }), /no Proxmox Backup Server/)
  await assert.rejects(plan({ product: 'pdm' }), /guide’s PDM token steps/)
  await assert.rejects(plan({ address: 'pve-x1.example.test; reboot' }), /DNS name or an IP/)
  await assert.rejects(plan({ name: '../x' }), /letters, digits/)
  await assert.rejects(worker!.request('setup.detect', { hostKey: 'local' }), /hostKey must name/)
  const shown = await plan()
  await assert.rejects(worker!.request('setup.run', { planId: shown.planId, hostKey: 'ssh:ssh-example-other' }), /no longer valid/)
  await runJob(shown.planId)
  await assert.rejects(worker!.request('setup.run', { planId: shown.planId, hostKey: X1 }), /no longer valid/)
  assert.equal(orca.typed.length, 2)
  await worker!.deactivate()

  const failing = await mounted(server(), { failRead: true })
  await assert.rejects(worker!.request('setup.detect', { hostKey: X1 }), /terminal could not be read/)
  assert.deepEqual(failing.orca.closed, ['term_1'])
})

test('Undo that finds the run’s permission changed since keeps it and the record, and says so', async () => {
  await mounted(server({ changed: true }))
  await worker!.request('setup.detect', { hostKey: X1 })
  assert.equal((await runJob((await plan()).planId)).ok, true)
  const record = (await worker!.request('setup.hosts')).hosts[0].records[0]
  const undone = await runJob((await worker!.request('setup.undoPlan', { hostKey: X1, runId: record.runId })).planId)
  assert.equal(undone.ok, false)
  assert.match(undone.message, /changed since the run \(an administrator's now\): user_acl/)
  const kept = (await worker!.request('setup.hosts')).hosts[0].records
  assert.equal(kept.length, 1)
  assert.match(kept[0].message ?? '', /changed since the run/)
})
