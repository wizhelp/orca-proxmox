// The background loop (status bar, alerts), the terminal plan and the worker's terminal and
// open-panel actions, with the orca CLI and the host faked.
import { afterEach, assert, mockHost, mountWorker, test, type TestWorker } from 'orca/testing'
import { Background, type BackgroundDeps } from '../src/background'
import { DEFAULT_SETTINGS, type EstateResponse, type EstateSnapshot } from '../src/model'
import { switchArgs, terminalPlan, worktreeSelector } from '../src/orca/terminal'
import { cardOffer, estateRevision } from '../src/presence'
import * as main from '../src/worker'
import { FIXTURE_PIN, recordedCli, renamedEstate } from './fixtures/estate'
import { exampleRoutes } from './fixtures/extras'
import { mockTransport } from './fixtures/pdm'
import { RENAMED_AT } from './fixtures/recorded-pdm-renamed'

const clone = (s: EstateSnapshot): EstateSnapshot => JSON.parse(JSON.stringify(s))

function fakeDeps(answers: EstateResponse[], settings = DEFAULT_SETTINGS) {
  const bar: { text: string; tone: string; visible: boolean }[] = []
  const told: string[] = []
  let state: unknown = null
  const deps: BackgroundDeps = {
    load: async () => answers.shift()!,
    settings: async () => settings,
    statusBar: async (line) => void bar.push({ text: line.text, tone: line.tone, visible: line.visible }),
    notify: async (title) => void told.push(title),
    readState: async () => state as never,
    writeState: async (s) => void (state = s),
    log: () => undefined
  }
  return { deps, bar, told }
}

test('the status bar follows the estate; alerts come once, after the baseline', async () => {
  const snap = await renamedEstate()
  const down = clone(snap)
  down.remotes.find((r) => r.id === 'pve-lab')!.online = false
  const ok = (s: EstateSnapshot): EstateResponse => ({ state: 'ok', snapshot: s, refreshSeconds: 30 })
  const at = (s: EstateSnapshot, t: number) => ({ ...clone(s), fetchedAt: t })
  const { deps, bar, told } = fakeDeps([ok(snap), ok(at(down, 1)), ok(at(down, 2)), ok(at(down, 3)), { state: 'error', refreshSeconds: 30, error: { kind: 'auth', message: 'token rejected' } }])
  const loop = new Background(deps)
  for (let i = 0; i < 5; i++) await loop.tick()
  assert.match(bar[0].text, /^● 5\/5/)
  assert.equal(bar[0].tone, 'warning')
  assert.match(bar[1].text, /^● 4\/5/)
  assert.equal(bar[1].tone, 'danger')
  assert.deepEqual(bar[4], { text: 'Proxmox: error', tone: 'danger', visible: true })
  assert.deepEqual(told, ['pve-lab is unreachable'], 'confirmed on the second refresh, told once')
})

test('muted alerts and a hidden status bar', async () => {
  const snap = await renamedEstate()
  const down = clone(snap)
  down.remotes.find((r) => r.id === 'pve-lab')!.online = false
  const ok = (s: EstateSnapshot): EstateResponse => ({ state: 'ok', snapshot: s, refreshSeconds: 30 })
  const at = (s: EstateSnapshot, t: number) => ({ ...clone(s), fetchedAt: t })
  const { deps, bar, told } = fakeDeps([ok(snap), ok(at(down, 1)), ok(at(down, 2))], { ...DEFAULT_SETTINGS, alertRemoteOffline: false, statusBar: false })
  const loop = new Background(deps)
  for (let i = 0; i < 3; i++) await loop.tick()
  assert.deepEqual(told, [])
  assert.ok(bar.every((b) => b.visible === false))
})

test('an outage is confirmed by two measured snapshots: not a cached one, not across a gap', async () => {
  const snap = await renamedEstate()
  const down = clone(snap)
  down.remotes.find((r) => r.id === 'pve-lab')!.online = false
  const ok = (s: EstateSnapshot, t: number): EstateResponse => ({ state: 'ok', snapshot: { ...clone(s), fetchedAt: t }, refreshSeconds: 30 })
  const failed: EstateResponse = { state: 'error', refreshSeconds: 30, error: { kind: 'unreachable', message: 'timeout' } }
  // Baseline, down, the same snapshot again (cached), a failed refresh, down, down.
  const { deps, told } = fakeDeps([ok(snap, 1), ok(down, 2), ok(down, 2), failed, ok(down, 3), ok(down, 4)])
  const loop = new Background(deps)
  for (let i = 0; i < 4; i++) await loop.tick()
  assert.deepEqual(told, [], 'one measured snapshot, a cached copy and a gap confirm nothing')
  await loop.tick()
  assert.deepEqual(told, [], 'the gap started the count over')
  await loop.tick()
  assert.deepEqual(told, ['pve-lab is unreachable'])
})

test('a backup seen running and then failed is told once; another configuration starts a new baseline', async () => {
  const snap = await renamedEstate()
  const backup = (state: 'running' | 'failed', upid: string, end?: number) => ({
    key: upid, remote: 'pve-lab', remoteType: 'pve' as const, node: 'pve-lab', type: 'vzdump', user: 'root@pam', id: '105', start: 1000, state, ...(end ? { end, status: 'job errors' } : {})
  })
  const withTasks = (t: number, tasks: ReturnType<typeof backup>[], scope = snap.connectionId): EstateResponse => ({ state: 'ok', snapshot: { ...clone(snap), connectionId: scope, fetchedAt: t, tasks }, refreshSeconds: 30 })
  const { deps, told } = fakeDeps([
    withTasks(1, []),
    withTasks(2, [backup('running', 'UPID:a')]),
    // Two backups failing in the same second are two alerts.
    withTasks(3, [backup('failed', 'UPID:a', 3000), backup('failed', 'UPID:b', 3000)]),
    withTasks(4, [backup('failed', 'UPID:a', 3000), backup('failed', 'UPID:b', 3000)]),
    // The connection was saved again: what is listed now is the new baseline.
    withTasks(5, [backup('failed', 'UPID:c', 5000)], 'default@other')
  ])
  const loop = new Background(deps)
  for (let i = 0; i < 5; i++) await loop.tick()
  assert.equal(told.length, 2, 'two UPIDs, two alerts; none for the new baseline')
})

test('a terminal opens in the Orca server’s workspace, else with ssh', async () => {
  const snap = await renamedEstate()
  const main1 = snap.orca!.hosts.find((h) => h.name === 'pve-a')!
  const plan = terminalPlan(main1.key, snap.orca, snap)
  assert.ok(!('error' in plan) && plan.how === 'workspace')
  if ('error' in plan) return
  // A plain workspace first, not the bot's home.
  const ws = snap.orca!.workspaces.find((w) => w.hostKey === main1.key && !w.bot)!
  // By the server's id, each value joined to its flag (`--flag=value`).
  assert.deepEqual(plan.args.slice(0, 4), ['terminal', 'create', `--environment=${ws.environment}`, `--worktree=${worktreeSelector(ws.worktreeId!)}`])
  assert.match(ws.environment!, /^[0-9a-f-]{36}$/)
  assert.equal(plan.environment, ws.environment)
  assert.match(plan.where, /workspace of server-a in Orca's sidebar$/)
  // No workspace on it: ssh to the node through a local terminal.
  const bare = clone(snap)
  bare.orca!.workspaces = bare.orca!.workspaces.filter((w) => w.hostKey !== main1.key)
  // Placed automatically: no local root ssh, and why.
  const auto = terminalPlan(main1.key, bare.orca, bare)
  assert.ok('error' in auto && /place it by hand in the Orca view/.test(auto.error), JSON.stringify(auto))
  // Placed by hand: a local terminal running ssh to the node.
  bare.orca!.hosts.find((h) => h.key === main1.key)!.match = 'manual'
  const ssh = terminalPlan(main1.key, bare.orca, bare)
  // In a workspace of this machine named by id: `active` would mean the worker's own folder.
  const local = bare.orca!.workspaces.filter((w) => w.hostKey === 'local' && !w.bot && w.worktreeId)
  const newest = local.sort((x, y) => (y.lastActivityAt ?? 0) - (x.lastActivityAt ?? 0))[0]
  assert.ok(newest, 'the fixture has a plain local workspace')
  assert.deepEqual(ssh, {
    how: 'ssh',
    where: `the ${newest.name} workspace in Orca's sidebar, a tab named pve-a`,
    args: ['terminal', 'create', `--worktree=${worktreeSelector(newest.worktreeId!)}`, '--title=pve-a', '--command=ssh root@203.0.113.1', '--focus']
  })
  // No local workspace known: the caller's own.
  const none = clone(bare)
  none.orca!.workspaces = none.orca!.workspaces.filter((w) => w.hostKey !== 'local')
  const fallback = terminalPlan(main1.key, none.orca, none)
  assert.ok(!('error' in fallback) && fallback.args[2] === '--worktree=active')
  // An address that is not strictly an IP or a DNS name is never typed into a shell.
  const evil = clone(bare)
  const node = evil.hosts.find((h) => h.key === main1.runsOn!.key)!
  node.addresses = ['203.0.113.1;touch /tmp/x', '$(id)', '--oProxyCommand=x']
  assert.deepEqual(terminalPlan(main1.key, evil.orca, evil), { error: 'pve-a has no Orca workspace and no valid address to ssh to.' })
  // Titles are only text.
  const titled = terminalPlan(main1.key, bare.orca, bare, 'a\u001b]0;x\u0007b')
  assert.ok(!('error' in titled) && titled.args.includes('--title=a ]0;x b'))
  // The switch goes to the server that issued the handle, or to this machine.
  assert.deepEqual(switchArgs('t1', 'env-id'), ['terminal', 'switch', '--environment=env-id', '--terminal=t1'])
  assert.deepEqual(switchArgs('t1'), ['terminal', 'switch', '--terminal=t1'])
  assert.deepEqual(terminalPlan('ssh:nope', snap.orca, snap), { error: 'This Orca host is not known (any more).' })
  assert.equal(worktreeSelector('folder:abc'), 'folder:abc')
  assert.equal(worktreeSelector('repo::/root'), 'id:repo::/root')
})

let worker: TestWorker | undefined
afterEach(async () => {
  await worker?.deactivate()
  worker = undefined
})

test('the worker opens terminals and the panel through the orca CLI', async () => {
  const recorded = recordedCli()
  const calls: string[][] = []
  let switched = true
  const cli = async (args: string[], timeout: number) => {
    calls.push(args)
    // As a paired server answers: a background handle, shown only once switched to.
    if (args[0] === 'terminal' && args[1] === 'create') return { terminal: { handle: 't1', surface: 'background' } }
    if (args[0] === 'terminal' && args[1] === 'switch') return { focus: { handle: 't1', navigated: switched } }
    if (args[0] === 'plugin' && args[1] === 'list') return { plugins: [{ pluginKey: 'example.other' }, { pluginKey: 'local.proxmox-visualizer' }] }
    if (args[0] === 'plugin' && args[1] === 'open') return { opened: true }
    return recorded(args, timeout)
  }
  main.useTestDoubles({ transport: mockTransport(exampleRoutes(RENAMED_AT)), probe: async () => null, now: () => RENAMED_AT, orcaCli: cli })
  const host = mockHost()
  worker = await mountWorker(main, { host })
  await worker.request('config.save', { baseUrl: 'https://pdm.example.test:8443', tokenId: 'monitor@pdm!orca', fingerprint: FIXTURE_PIN, secret: 's' })
  const snap = ((await worker.request('estate.get', {})) as { snapshot: EstateSnapshot }).snapshot
  const lab = snap.orca!.hosts.find((h) => h.name === 'pve-lab')!
  // What the card at lab's place shows, sent back as the panel does.
  const place = `${lab.runsOn!.kind}:${lab.runsOn!.key}`
  const offer = cardOffer(snap, place)!
  assert.deepEqual([offer.route, offer.host?.key], ['workspace', lab.key])
  const card = { place, route: offer.route as 'workspace', hostKey: lab.key, destination: offer.destination, revision: estateRevision(snap), title: 'pve-lab', scope: snap.connectionId }
  type Opened = { how: 'workspace' | 'ssh'; navigated: boolean; where: string }
  const opened = (answer: Opened | { stale: string }): Opened => {
    assert.ok(!('stale' in answer), JSON.stringify(answer))
    return answer as Opened
  }
  const shown = opened(await worker.request('orca.terminal', card))
  assert.equal(shown.how, 'workspace')
  assert.equal(shown.navigated, true)
  const terminalCalls = calls.filter((c) => c[0] === 'terminal')
  const labEnv = snap.orca!.workspaces.find((w) => w.hostKey === lab.key && w.environment)!.environment!
  assert.deepEqual(terminalCalls[0].slice(0, 3), ['terminal', 'create', `--environment=${labEnv}`])
  assert.deepEqual(terminalCalls[1], ['terminal', 'switch', `--environment=${labEnv}`, '--terminal=t1'])
  // Orca did not navigate: not reported as shown, with where to find it.
  switched = false
  const hidden = opened(await worker.request('orca.terminal', card))
  assert.equal(hidden.navigated, false)
  assert.match(hidden.where, /server-lab/)
  // The plugin keeps the handles it opened, to tell them apart later.
  const kept = host.data().storage.terminals as { handle: string; environment: string }[]
  assert.deepEqual(kept.map((k) => [k.handle, k.environment]), [['t1', labEnv], ['t1', labEnv]])
  // Anything but what the card offers now opens nothing: another host, route or destination, or a
  // card from an estate this worker did not build.
  const before = calls.length
  for (const changed of [{ hostKey: 'ssh:nope' }, { route: 'ssh' as const }, { destination: 'ssh ssh root@203.0.113.9' }, { revision: `${snap.connectionId}@1/1` }, { place: 'node:nowhere/x' }]) {
    const answer = await worker.request('orca.terminal', { ...card, ...changed })
    assert.ok('stale' in answer && /changed since it was shown, so nothing was opened/.test(answer.stale), JSON.stringify(changed))
  }
  // Moved to another place since the card was drawn (same connection): stale too.
  await worker.request('orca.link', { hostKey: lab.key, link: 'none', scope: snap.connectionId })
  const moved = await worker.request('orca.terminal', card)
  assert.ok('stale' in moved)
  assert.equal(calls.length, before, 'no terminal created for a stale card')

  assert.equal(await worker.command('proxmox.openPanel'), 'Opened the Proxmox panel.')
  assert.deepEqual(calls[calls.length - 1], ['plugin', 'open', 'local.proxmox-visualizer', '--panel=proxmox'])
  assert.deepEqual(worker.refusals, [])
})
