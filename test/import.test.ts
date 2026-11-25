// The one-shot import file an agent writes: claimed, checked through one handle, tested against
// PDM before it replaces anything, then overwritten and deleted, with an honest outcome. Synthetic
// values only.
import { afterEach, assert, mockHost, mountWorker, test, type TestWorker } from 'orca/testing'
import { chmod, mkdir, mkdtemp, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanupText, decodeImport, takeImport } from '../src/importer'
import { memoryVault } from '../src/vault'
import * as main from '../src/worker'
import { mockTransport, pdmRoutes } from './fixtures/pdm'

const NOW = Date.UTC(2026, 10, 25, 12, 0, 0)
const SECRET = '6f1c2a9e-0b7d-4c3e-9a51-2d8e4f7b1c30'
const OLD_SECRET = '0a9b8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d'
const PIN = 'EC:7A:EF:38:FF:F7:59:92:C1:E3:B0:4C:1D:22:FF:C9:67:C6:91:C8:74:48:53:13:12:1A:C0:42:D1:5B:37:05'
const GOOD = { baseUrl: 'https://pdm.example.test:8443', tokenId: 'monitor@pdm!orca', fingerprint: PIN, secret: SECRET }
const ON_WINDOWS = process.platform === 'win32'

let worker: TestWorker | undefined
afterEach(async () => {
  await worker?.deactivate()
  worker = undefined
})

/** A private folder and file where the OS allows it; on Windows the POSIX checks do not apply. */
async function privateFile(content: string | Buffer): Promise<{ path: string; env: { platform: NodeJS.Platform; uid: number | undefined } }> {
  const dir = await mkdtemp(join(tmpdir(), 'pdm-import-'))
  await chmod(dir, 0o700)
  const path = join(dir, 'connection-import.json')
  await writeFile(path, content, { mode: 0o600 })
  await chmod(path, 0o600)
  const posixPrivate = !ON_WINDOWS && ((await stat(path)).mode & 0o077) === 0
  return { path, env: { platform: posixPrivate ? process.platform : 'win32', uid: posixPrivate && process.getuid ? process.getuid() : undefined } }
}

async function mounted(path: string, env: { platform: NodeJS.Platform }, routes = pdmRoutes(NOW)) {
  const transport = mockTransport(routes)
  main.useTestDoubles({ transport, probe: async () => PIN, now: () => NOW, vault: memoryVault(), importPath: path, importPlatform: env.platform })
  const host = mockHost()
  worker = await mountWorker(main, { host })
  return { host, transport }
}

const leftovers = async (path: string) => (await readdir(join(path, '..'))).filter((f) => f.includes('connection-import'))

test('a private import file is tested, saved sealed and bound, then overwritten and deleted', async () => {
  const { path, env } = await privateFile(JSON.stringify(GOOD))
  const { host, transport } = await mounted(path, env)
  const config = await worker!.request('config.import')
  assert.equal(config.connection?.baseUrl, GOOD.baseUrl)
  assert.equal(config.connection?.hasSecret, true)
  assert.equal(config.importStatus?.ok, true)
  assert.match(config.importStatus!.message, /Imported the connection to https:\/\/pdm\.example\.test:8443 as monitor@pdm!orca, pinned \((start|panel)\)\. Connection test: PDM 1\.0\.2, 4 remotes visible\. The file was overwritten and deleted\./)
  assert.deepEqual(await leftovers(path), [], 'nothing left, claimed copy included')
  const stored = Object.entries(host.data().secrets).filter(([k]) => k.startsWith('token-secret:'))
  assert.equal(stored.length, 1)
  assert.ok(String(stored[0][1]).startsWith('sealed:v2:'))
  assert.ok(!JSON.stringify({ storage: host.data().storage, logs: worker!.logs, config }).includes(SECRET))
  assert.equal((await worker!.request('estate.get', {})).state, 'ok')
  assert.ok(transport.requests.every((r) => r.headers.Authorization === `PDMAPIToken=monitor@pdm!orca:${SECRET}`))
  // Rewriting the imported settings in storage makes the secret unusable (endpoint binding).
  const saved = (host.data().storage.connections as Record<string, unknown>[])[0]
  ;(host as unknown as { respond(m: string, r: unknown): void }).respond('storage.get', (p: { key: string }) => ({
    value: p.key === 'connections' ? [{ ...saved, baseUrl: 'https://elsewhere.example.test:8443' }] : (host.data().storage[p.key] ?? null)
  }))
  const tampered = await worker!.request('estate.get', { force: true })
  assert.equal(tampered.state === 'error' && tampered.error.kind, 'not-configured')
})

test('Windows PowerShell 5.1 files (UTF-8 with a byte-order mark, or UTF-16) are read', async () => {
  const json = JSON.stringify(GOOD)
  assert.equal(decodeImport(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(json)])), json)
  assert.equal(decodeImport(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(json, 'utf16le')])), json)
  const { path, env } = await privateFile(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(json)]))
  await mounted(path, env)
  assert.equal((await worker!.request('config.import')).importStatus?.ok, true)
})

test('the import runs when the worker starts, and through the palette command', async () => {
  const { path, env } = await privateFile(JSON.stringify(GOOD))
  await mounted(path, env)
  let imported: string | undefined
  for (let i = 0; i < 100 && !imported; i++) {
    await new Promise((r) => setTimeout(r, 20))
    imported = (await worker!.request('config.get')).connection?.baseUrl
  }
  assert.equal(imported, GOOD.baseUrl, 'imported on start')
  assert.match(String(await worker!.command('proxmox.importConnection')), /No import file|Imported the connection/)
  assert.match(String(await worker!.command('proxmox.importConnection')), /No import file/)
})

test('a connection that fails its test does not replace the working one', async () => {
  const routes = pdmRoutes(NOW)
  const { path, env } = await privateFile(JSON.stringify(GOOD))
  // Mounted with a working connection first; the file appears afterwards.
  const raw = await readFile(path)
  const { rm } = await import('node:fs/promises')
  await rm(path)
  const { host } = await mounted(path, env, routes)
  await worker!.request('config.save', { baseUrl: 'https://pdm.example.test:8443', tokenId: 'old@pdm!orca', fingerprint: PIN, secret: OLD_SECRET })
  const before = (host.data().storage.connections as Record<string, unknown>[])[0]
  routes['/version'] = { status: 401, body: 'no' }
  await writeFile(path, raw, { mode: 0o600 })
  const config = await worker!.request('config.import')
  assert.equal(config.importStatus?.ok, false)
  assert.match(config.importStatus!.message, /did not pass the connection test \(auth: .*\)\. The current connection was kept\. The file was overwritten and deleted\./)
  assert.deepEqual((host.data().storage.connections as Record<string, unknown>[])[0], before, 'the old connection stays')
  assert.equal(config.connection?.tokenId, 'old@pdm!orca')
  assert.equal(config.connection?.hasSecret, true)
})

test('a save in Settings during an import wins over the import', async () => {
  const routes = pdmRoutes(NOW)
  const base = mockTransport(routes)
  let release: (() => void) | undefined
  const held = new Promise<void>((r) => (release = r))
  let reached: (() => void) | undefined
  const inFlight = new Promise<void>((r) => (reached = r))
  let first = true
  const { path, env } = await privateFile(JSON.stringify(GOOD))
  main.useTestDoubles({
    transport: async (request) => {
      if (first && request.url.pathname.endsWith('/version')) {
        first = false
        reached!()
        await held
      }
      return base(request)
    },
    probe: async () => PIN,
    now: () => NOW,
    vault: memoryVault(),
    importPath: path,
    importPlatform: env.platform
  })
  worker = await mountWorker(main, { host: mockHost() })
  const importing = worker.request('config.import')
  await inFlight // the import's connection test is under way
  await worker.request('config.save', { baseUrl: 'https://pdm.example.test:8443', tokenId: 'manual@pdm!orca', fingerprint: PIN, secret: OLD_SECRET })
  release!()
  const config = await importing
  assert.equal(config.connection?.tokenId, 'manual@pdm!orca')
  assert.equal(config.importStatus?.ok, false)
  assert.match(config.importStatus!.message, /changed in Settings while the file was imported/)
})

test('an import that fails after a save in Settings cannot bring back an old status', async () => {
  const routes = pdmRoutes(NOW)
  const base = mockTransport(routes)
  let release: (() => void) | undefined
  const held = new Promise<void>((r) => (release = r))
  let reached: (() => void) | undefined
  const inFlight = new Promise<void>((r) => (reached = r))
  let first = true
  const { path, env } = await privateFile(JSON.stringify(GOOD))
  main.useTestDoubles({
    transport: async (request) => {
      if (first && request.url.pathname.endsWith('/version')) {
        first = false
        reached!()
        await held
        return { status: 401, contentType: 'application/json', body: '{}' } // the imported token fails
      }
      return base(request)
    },
    probe: async () => PIN,
    now: () => NOW,
    vault: memoryVault(),
    importPath: path,
    importPlatform: env.platform
  })
  worker = await mountWorker(main, { host: mockHost() })
  const importing = worker.request('config.import')
  await inFlight
  const saved = await worker.request('config.save', { baseUrl: 'https://pdm.example.test:8443', tokenId: 'manual@pdm!orca', fingerprint: PIN, secret: OLD_SECRET })
  assert.equal(saved.importStatus, null, 'the save cleared the status')
  release!()
  const config = await importing
  assert.equal(config.connection?.tokenId, 'manual@pdm!orca')
  // Not "did not pass the connection test": that verdict is about a superseded attempt.
  assert.match(config.importStatus!.message, /^The connection was changed in Settings while the file was imported; the import was dropped\. The file was overwritten and deleted\.$/)
})

test('bad values are named by field, never shown; nothing is changed; the file is deleted', async () => {
  for (const [file, why] of [
    [{ ...GOOD, baseUrl: 'hunter2-not-a-url' }, /baseUrl is not an https:\/\/ URL/],
    [{ ...GOOD, baseUrl: 'http://pdm.example.test:8443' }, /baseUrl is not an https:\/\/ URL/],
    [{ ...GOOD, tokenId: 'monitor' }, /tokenId does not look like user@realm!tokenname/],
    [{ ...GOOD, secret: 'with space inside' }, /secret has spaces/],
    [{ ...GOOD, secret: 'x'.repeat(600) }, /too long/],
    [{ ...GOOD, secret: '' }, /secret is empty/],
    [{ ...GOOD, fingerprint: 'AB:CD' }, /fingerprint is not a SHA-256 fingerprint/]
  ] as const) {
    const { path, env } = await privateFile(JSON.stringify(file))
    await mounted(path, env)
    const config = await worker!.request('config.import')
    assert.equal(config.importStatus?.ok, false)
    assert.match(config.importStatus!.message, why)
    assert.match(config.importStatus!.message, /Nothing was changed\. The file was overwritten and deleted\./)
    for (const value of [file.baseUrl, file.secret].filter((v) => v.length > 8)) {
      assert.ok(!JSON.stringify({ config, logs: worker!.logs }).includes(value), 'a value was shown')
    }
    assert.equal(config.connection, null)
    assert.deepEqual(await leftovers(path), [])
    await worker!.deactivate()
    worker = undefined
  }
})

test('bad JSON and wrong fields are refused and deleted', async () => {
  for (const [content, why] of [
    ['{"baseUrl": "https://pdm.example.test:8443", "secret": ', /not valid JSON \(write it completely to a temporary name, then rename it\)/],
    [JSON.stringify([GOOD]), /must be a JSON object/],
    [JSON.stringify({ ...GOOD, extra: 'x' }), /must be a JSON object/],
    [JSON.stringify({ ...GOOD, secret: 42 }), /must be a JSON object/]
  ] as const) {
    const { path, env } = await privateFile(content)
    await mounted(path, env)
    const config = await worker!.request('config.import')
    assert.match(config.importStatus!.message, why)
    assert.match(config.importStatus!.message, /The file was overwritten and deleted\./)
    assert.equal(config.connection, null)
    assert.deepEqual(await leftovers(path), [])
    await worker!.deactivate()
    worker = undefined
  }
})

test('a refused file is never put back: unsafe before the claim it stays, after it it is removed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pdm-import-'))
  const path = join(dir, 'connection-import.json')
  await writeFile(path, JSON.stringify(GOOD), { mode: 0o644 })
  await chmod(path, 0o644)
  // Judged as on Linux. On Windows modes read as 0o666, so the folder is refused before the claim
  // and the file stays untouched; on a real POSIX folder the file is claimed, wiped and removed.
  const result = await takeImport(path, { platform: 'linux', uid: undefined })
  assert.equal(result.state, 'refused')
  if (result.state !== 'refused') return
  assert.match(result.reason, /other users/i)
  if (result.cleanup.untouched) {
    assert.match(cleanupText(result.cleanup), /left as it is at /)
    assert.equal(await readFile(path, 'utf8'), JSON.stringify(GOOD), 'never claimed, so untouched')
  } else {
    assert.deepEqual(result.cleanup, { overwritten: true, removed: true })
    assert.match(result.reason, /The file was overwritten and deleted./)
    assert.ok(!existsSync(path), 'not put back under its name')
  }
  assert.deepEqual((await readdir(dir)).filter((f) => f.endsWith('.claimed')), [], 'no claimed copy left')
})

test('a file with another hard link is unlinked, never written, and never put back', async () => {
  const { path, env } = await privateFile(JSON.stringify(GOOD))
  const elsewhere = join(await mkdtemp(join(tmpdir(), 'pdm-other-')), 'unrelated.json')
  const { link } = await import('node:fs/promises')
  await link(path, elsewhere)
  const result = await takeImport(path, env)
  assert.equal(result.state, 'refused')
  if (result.state !== 'refused') return
  assert.match(result.reason, /other hard links/)
  assert.deepEqual(result.cleanup, { overwritten: false, removed: true })
  assert.equal(await readFile(elsewhere, 'utf8'), JSON.stringify(GOOD), 'the other link is not overwritten')
  assert.ok(!existsSync(path), 'and nothing is put back under the public name')
})

test('only one taker gets a file; links and folders are not followed', async () => {
  const { path, env } = await privateFile(JSON.stringify(GOOD))
  const [a, b] = await Promise.all([takeImport(path, env), takeImport(path, env)])
  assert.deepEqual([a.state, b.state].sort(), ['imported', 'none'])

  const { path: target } = await privateFile(JSON.stringify(GOOD))
  const dir = await mkdtemp(join(tmpdir(), 'pdm-import-'))
  await chmod(dir, 0o700)
  const linkPath = join(dir, 'connection-import.json')
  let linked = true
  await symlink(target, linkPath).catch(() => (linked = false)) // Windows may not allow links
  if (linked) {
    const result = await takeImport(linkPath, env)
    assert.equal(result.state, 'refused')
    if (result.state === 'refused') assert.deepEqual(result.cleanup, { overwritten: false, removed: true })
    assert.equal(await readFile(target, 'utf8'), JSON.stringify(GOOD), 'the link target is untouched')
  }
  const folder = join(dir, 'sub')
  await mkdir(folder)
  assert.equal((await takeImport(folder, env)).state, 'refused')
  assert.equal((await takeImport(join(dir, 'missing.json'), env)).state, 'none')
  assert.ok(existsSync(target))
})

test('what the status says about the file comes from its final state', () => {
  assert.equal(cleanupText({ overwritten: true, removed: true }), 'The file was overwritten and deleted.')
  assert.equal(cleanupText({ overwritten: false, removed: true }), 'The file was deleted, but could not be overwritten first.')
  assert.equal(
    cleanupText({ overwritten: true, removed: false, remaining: '/x/.connection-import.json.abc.claimed', code: 'EBUSY' }),
    'The file could NOT be deleted (EBUSY): it is still at /x/.connection-import.json.abc.claimed and holds the token secret; delete it by hand.'
  )
  assert.equal(cleanupText({ untouched: true, path: '/x/connection-import.json' }), 'The file was left as it is at /x/connection-import.json.')
})

test('the documented Windows PowerShell steps write a file the plugin imports', async () => {
  if (!ON_WINDOWS) return
  const { execFile } = await import('node:child_process')
  const ps = (script: string) =>
    new Promise<void>((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], (e, _o, err) => (e ? reject(new Error(String(err))) : resolve())))
  // Exactly the guide's block, with its placeholders filled in.
  const guide = await readFile(new URL('../docs/AGENT_SETUP.md', import.meta.url), 'utf8')
  const block = /```powershell\n([\s\S]*?)```/.exec(guide)![1]
  for (const how of ['documented', 'set-content']) {
    const dir = await mkdtemp(join(tmpdir(), 'pdm-import-ps-'))
    const target = join(dir, 'plugin', 'connection-import.json')
    const secretFile = join(dir, 'secret.txt')
    await writeFile(secretFile, SECRET)
    const fields = `$PdmUrl = '${GOOD.baseUrl}'; $Fp = '${PIN}'; $secretFile = '${secretFile}'\n`
    const script =
      how === 'documented'
        ? fields + block.replace("'<path from the log>'", `'${target}'`)
        : // What people often write instead: Windows PowerShell 5.1 adds a byte-order mark here.
          `${fields}; New-Item -ItemType Directory -Force (Split-Path '${target}') | Out-Null; $secret = (Get-Content -Raw $secretFile).Trim(); @{ baseUrl = $PdmUrl; tokenId = 'monitor@pdm!orca'; fingerprint = $Fp; secret = $secret } | ConvertTo-Json | Set-Content -Encoding utf8 '${target}'`
    await ps(script)
    const left = await readdir(join(dir, 'plugin'))
    assert.deepEqual(left, ['connection-import.json'], `${how}: only the published file, no temporary one`)
    const result = await takeImport(target, { platform: 'win32', uid: undefined })
    assert.equal(result.state, 'imported', how)
    if (result.state === 'imported') assert.deepEqual(result.connection, GOOD, how)
  }
})
