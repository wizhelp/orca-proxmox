// The worker over a mock Orca host and recorded PDM answers: where the secret goes, what the
// panel gets back, and the error states.
import { afterEach, assert, mockHost, mountWorker, test, type TestWorker } from 'orca/testing'
import { memoryVault, type Binding } from '../src/vault'
import * as main from '../src/worker'
import { assertPlainJson } from './fixtures/estate'
import { mockTransport, pdmRoutes } from './fixtures/pdm'

const NOW = Date.UTC(2026, 10, 25, 12, 0, 0)
const SECRET = '794239b2-4e1e-4ebe-bd97-3d3dc098207e'
const PIN = 'EC:7A:EF:38:FF:F7:59:92:C1:E3:B0:4C:1D:22:FF:C9:67:C6:91:C8:74:48:53:13:12:1A:C0:42:D1:5B:37:05'
const input = { baseUrl: 'https://pdm.example.test:8443/', tokenId: 'monitor@pdm!orca', fingerprint: PIN.toLowerCase() }

let worker: TestWorker | undefined
afterEach(async () => {
  await worker?.deactivate()
  worker = undefined
})

/** The worker's key, in memory: what it seals, the tests can open. */
const vault = memoryVault()

function useRoutes(routes = pdmRoutes(NOW)) {
  const transport = mockTransport(routes)
  main.useTestDoubles({ transport, probe: async () => PIN, now: () => NOW, vault })
  return transport
}

/** The binding of a stored connection (or of the saved one). */
function bindingOf(c: Record<string, unknown>): Binding {
  return { id: String(c.id), revision: c.revision as string | undefined, kind: String(c.kind), baseUrl: String(c.baseUrl), tokenId: String(c.tokenId), fingerprint: String(c.fingerprint) }
}

/**
 * The keyring entries holding a token secret, each opened with the binding of the connection
 * whose revision its key names; each must be sealed, never plain.
 */
async function secretEntries(host: ReturnType<typeof mockHost>, connections: Record<string, unknown>[] = []): Promise<Record<string, unknown>> {
  const known = [...connections, ...((host.data().storage.connections as Record<string, unknown>[] | undefined) ?? [])]
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(host.data().secrets)) {
    if (!k.startsWith('token-secret:')) continue
    assert.ok(typeof v === 'string' && v.startsWith('sealed:v2:'), `${k} is stored unsealed`)
    const owner = known.find((c) => k === `token-secret:${c.id}:${c.revision}`)
    out[k] = owner ? await vault.open(v as string, bindingOf(owner)) : 'unopened'
  }
  return out
}

function everything(w: TestWorker, host: ReturnType<typeof mockHost>): string {
  return JSON.stringify({ storage: host.data().storage, settings: host.data().settings, logs: w.logs, posts: w.posts })
}

test('starts unconfigured', async () => {
  useRoutes()
  worker = await mountWorker(main)
  assert.deepEqual(await worker.request('estate.get', {}), { state: 'unconfigured', refreshSeconds: 30 })
  const config = await worker.request('config.get')
  assert.equal(config.connection, null)
  assert.deepEqual(config.settings, {
    refreshSeconds: 30,
    backupStaleHours: 26,
    backupRefreshMinutes: 5,
    orcaAwareness: true,
    statusBar: true,
    alertRemoteOffline: true,
    alertGuestStopped: true,
    alertBackupFailed: true,
    alertBackupStale: true
  })
  assert.deepEqual(worker.refusals, [])
})

test('saves the secret in Orca secrets only, and never hands it back or logs it', async () => {
  const transport = useRoutes()
  const host = mockHost()
  worker = await mountWorker(main, { host })
  const saved = await worker.request('config.save', { ...input, secret: `  ${SECRET} ` })
  const revision = saved.connection?.revision
  assert.match(revision ?? '', /^[0-9a-f-]{36}$/)
  assert.deepEqual(saved.connection, {
    id: 'default',
    kind: 'pdm',
    baseUrl: 'https://pdm.example.test:8443',
    tokenId: 'monitor@pdm!orca',
    fingerprint: PIN,
    revision,
    hasSecret: true
  })
  // One entry, bound to this saved configuration.
  assert.deepEqual(await secretEntries(host), { [`token-secret:default:${revision}`]: SECRET })

  const answer = await worker.request('estate.get', {})
  assert.equal(answer.state, 'ok')
  assertPlainJson(answer)
  assert.ok(transport.requests.length > 0)
  assert.ok(transport.requests.every((r) => r.fingerprint === PIN))
  assert.ok(transport.requests.every((r) => r.headers.Authorization === `PDMAPIToken=monitor@pdm!orca:${SECRET}`))

  // Saving without a secret carries it over to the new configuration, and retires the old entry.
  const again = await worker.request('config.save', { ...input, secret: '' })
  assert.equal(again.connection?.hasSecret, true)
  assert.notEqual(again.connection?.revision, revision)
  assert.deepEqual(await secretEntries(host), { [`token-secret:default:${again.connection!.revision}`]: SECRET })

  assert.ok(!everything(worker, host).includes(SECRET), 'secret leaked into storage, settings, logs or posts')
  assert.ok(!JSON.stringify(answer).includes(SECRET))
  assert.ok(!JSON.stringify(await worker.request('config.get')).includes(SECRET))
  assert.deepEqual(worker.refusals, [])
})

test('moving to another server drops the stored secret', async () => {
  useRoutes()
  const host = mockHost()
  worker = await mountWorker(main, { host })
  await worker.request('config.save', { ...input, secret: SECRET })
  const moved = await worker.request('config.save', { ...input, baseUrl: 'https://other.example.test:8443' })
  assert.equal(moved.connection?.hasSecret, false)
  assert.deepEqual(await secretEntries(host), {})
  const answer = await worker.request('estate.get', {})
  assert.equal(answer.state === 'error' && answer.error.kind, 'not-configured')
})

test('another path or token on the same server does not get the stored secret', async () => {
  useRoutes()
  const host = mockHost()
  worker = await mountWorker(main, { host })
  await worker.request('config.save', { ...input, baseUrl: 'https://pdm.example.test:8443/tenant-a', secret: SECRET })
  const path = await worker.request('config.save', { ...input, baseUrl: 'https://pdm.example.test:8443/tenant-b' })
  assert.equal(path.connection?.hasSecret, false)
  await worker.request('config.save', { ...input, secret: SECRET })
  const token = await worker.request('config.save', { ...input, tokenId: 'other@pdm!orca' })
  assert.equal(token.connection?.hasSecret, false)
  assert.deepEqual(await secretEntries(host), {})
})

test('a refresh running while the connection is replaced never sends the new secret to the old server', async () => {
  const OTHER = '11111111-2222-4333-8444-555555555555'
  const routes = pdmRoutes(NOW)
  const base = mockTransport(routes)
  let hold: (() => void) | undefined
  const held = new Promise<void>((resolve) => (hold = resolve))
  let first = true
  const seen: { host: string; auth: string }[] = []
  main.useTestDoubles({
    transport: async (request) => {
      seen.push({ host: new URL(request.url).host, auth: String(request.headers.Authorization) })
      // The first read of the old server waits until the new configuration is saved.
      if (first) {
        first = false
        await held
      }
      return base(request)
    },
    probe: async () => PIN,
    now: () => NOW,
    vault
  })
  const host = mockHost()
  worker = await mountWorker(main, { host })
  await worker.request('config.save', { ...input, secret: SECRET })
  const old = worker.request('estate.get', { force: true })
  await new Promise((r) => setTimeout(r, 10))
  const saved = await worker.request('config.save', { ...input, baseUrl: 'https://new.example.test:8443', secret: OTHER })
  hold!()
  const answer = await old
  // The old server only ever saw the old secret; the old answer is not shown for the new one.
  for (const s of seen.filter((s) => s.host === 'pdm.example.test:8443')) assert.ok(!s.auth.includes(OTHER), 'replacement secret sent to the old server')
  assert.ok(answer.state !== 'ok' || answer.snapshot.connectionId.endsWith(saved.connection!.revision!))
  // Once the old read settled, only the new configuration's secret is left.
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(await secretEntries(host), { [`token-secret:default:${saved.connection!.revision}`]: OTHER })
})

test('a secret stored before endpoint binding is never trusted: it must be entered again', async () => {
  const transport = useRoutes()
  const legacy = { id: 'default', kind: 'pdm', baseUrl: 'https://pdm.example.test:8443', tokenId: 'monitor@pdm!orca', fingerprint: PIN }
  const host = mockHost({ storage: { connections: [legacy] }, secrets: { 'token-secret:default': SECRET } })
  worker = await mountWorker(main, { host })
  const answer = await worker.request('estate.get', {})
  assert.equal(answer.state === 'error' && answer.error.kind, 'not-configured')
  assert.equal(transport.requests.length, 0, 'nothing sent with an unbound secret')
  const saved = await worker.request('config.save', { ...input, secret: '' })
  assert.equal(saved.connection?.hasSecret, false)
  // Entering it again binds it; the old entry is retired.
  const again = await worker.request('config.save', { ...input, secret: SECRET })
  assert.equal(again.connection?.hasSecret, true)
  assert.deepEqual(await secretEntries(host), { [`token-secret:default:${again.connection!.revision}`]: SECRET })
})

test('settings rewritten in shared storage (the panel can write it) never get the sealed token', async () => {
  for (const change of [{ baseUrl: 'https://attacker.example.test:8443' }, { fingerprint: '' }, { tokenId: 'other@pdm!orca' }, { revision: 'forged' }]) {
    const transport = useRoutes()
    const host = mockHost()
    worker = await mountWorker(main, { host })
    await worker.request('config.save', { ...input, secret: SECRET })
    const stored = (host.data().storage.connections as Record<string, unknown>[])[0]
    // What panel code could do: rewrite the connection in place, bypassing config.save.
    const before = transport.requests.length
    await worker.request('estate.get', { force: true })
    assert.ok(transport.requests.length > before, 'baseline refresh reached the server')
    const at = transport.requests.length
    ;(host as unknown as { respond(m: string, r: unknown): void }).respond('storage.get', (p: { key: string }) =>
      ({ value: p.key === 'connections' ? [{ ...stored, ...change }] : (host.data().storage[p.key] ?? null) })
    )
    const answer = await worker.request('estate.get', { force: true })
    assert.equal(answer.state === 'error' && answer.error.kind, 'not-configured', JSON.stringify(change))
    assert.equal(transport.requests.length, at, `no request after ${JSON.stringify(change)}`)
    await worker.deactivate()
    worker = undefined
  }
})

test('refuses invalid settings with a reason', async () => {
  useRoutes()
  worker = await mountWorker(main)
  for (const bad of [
    { ...input, baseUrl: 'http://pdm:8443' },
    { ...input, tokenId: 'monitor@pdm' },
    { ...input, fingerprint: 'AB:CD' },
    { ...input, secret: 'has space' }
  ]) {
    await assert.rejects(worker.request('config.save', bad), (error: unknown) => (error as { code?: string }).code === 'invalid_params')
  }
})

test('will not store a secret when Orca cannot encrypt it', async () => {
  useRoutes()
  const host = mockHost({ results: { 'secrets.protection': { status: 'unavailable' } } })
  worker = await mountWorker(main, { host })
  await assert.rejects(worker.request('config.save', { ...input, secret: SECRET }), /will not store the token in plain text/)
  assert.deepEqual(host.data().secrets, {})
})

test('a rejected token is an auth error that keeps the last good estate', async () => {
  const routes = pdmRoutes(NOW)
  useRoutes(routes)
  worker = await mountWorker(main)
  await worker.request('config.save', { ...input, secret: SECRET })
  const good = await worker.request('estate.get', {})
  assert.equal(good.state, 'ok')

  routes['/remotes/remote'] = { status: 401, body: 'authentication failed' }
  const bad = await worker.request('estate.get', { force: true })
  assert.equal(bad.state, 'error')
  if (bad.state !== 'error') return
  assert.equal(bad.error.kind, 'auth')
  assert.ok(bad.lastGood && bad.lastGood.guests.length === 7)
  assert.ok(worker.logs.some((line) => line.includes('auth')))
  assert.ok(worker.logs.every((line) => !line.includes(SECRET)))
})

test('tests a connection before saving it', async () => {
  useRoutes()
  worker = await mountWorker(main)
  const missing = await worker.request('connection.test', input)
  assert.equal(missing.ok, false)
  const ok = await worker.request('connection.test', { ...input, secret: SECRET })
  assert.deepEqual(ok, { ok: true, version: '1.0.2', remotes: 4 })
  assert.equal((await worker.request('config.get')).connection, null, 'testing saves nothing')
})

test('an unpinned self-signed server reports its fingerprint for review', async () => {
  main.useTestDoubles({
    transport: async () => {
      const { TransportError } = await import('../src/proxmox/http')
      throw new TransportError('tls', 'TLS verification failed for pdm.example.test:8443: DEPTH_ZERO_SELF_SIGNED_CERT')
    },
    probe: async () => PIN,
    now: () => NOW
  })
  worker = await mountWorker(main)
  const answer = await worker.request('connection.test', { ...input, fingerprint: '', secret: SECRET })
  assert.equal(answer.ok, false)
  if (answer.ok) return
  assert.equal(answer.error.kind, 'tls')
  assert.equal(answer.error.presentedFingerprint, PIN)
})

test('a stored secret cannot be read without the worker’s key', async () => {
  useRoutes()
  const host = mockHost()
  worker = await mountWorker(main, { host })
  await worker.request('config.save', { ...input, secret: SECRET })
  const stored = Object.values(host.data().secrets).find((v) => typeof v === 'string' && v.startsWith('sealed:')) as string
  assert.ok(stored && !stored.includes(SECRET))
  // Another key (a lost or replaced key file) cannot open it: the person enters the secret again.
  const saved = (host.data().storage.connections as Record<string, unknown>[])[0]
  assert.equal(await vault.open(stored, bindingOf(saved)), SECRET)
  assert.equal(await memoryVault().open(stored, bindingOf(saved)), null)
})

test('server text in a successful estate is scrubbed before it reaches the panel', async () => {
  const routes = pdmRoutes(NOW)
  // A proxy echoing the request's Authorization header in a node's error.
  const leaky = `upstream said: Authorization: PDMAPIToken=monitor@pdm!orca:${SECRET}`
  const list = routes['/resources/list?max-age=30'] as { remote: string; error?: string }[]
  list[0] = { remote: list[0].remote, error: leaky }
  useRoutes(routes)
  const host = mockHost()
  worker = await mountWorker(main, { host })
  await worker.request('config.save', { ...input, secret: SECRET })
  const answer = await worker.request('estate.get', {})
  assert.equal(answer.state, 'ok')
  const text = JSON.stringify(answer)
  assert.ok(!text.includes(SECRET), 'secret in the estate')
  assert.ok(!text.includes(SECRET.slice(0, 18)), 'part of the secret in the estate')
  assert.ok(!everything(worker, host).includes(SECRET))
})

test('a version a server makes up never reaches the panel', async () => {
  const routes = pdmRoutes(NOW)
  routes['/version'] = { version: `PDMAPIToken=monitor@pdm!orca:${SECRET}`, release: '1' }
  useRoutes(routes)
  worker = await mountWorker(main)
  const answer = await worker.request('connection.test', { ...input, secret: SECRET })
  assert.deepEqual(answer, { ok: true, version: 'unknown', remotes: 4 })
  const { formatVersion, pveVersion } = await import('../src/proxmox/pdm')
  assert.equal(formatVersion({ version: '1.1', release: '10' }), '1.1.10')
  assert.equal(formatVersion({ version: '9.2.32<img>' }), undefined)
  assert.equal(pveVersion('pve-manager/9.2.32/abc'), '9.2.32')
  assert.equal(pveVersion('pve-manager/evil.example.test/abc'), undefined)
})
