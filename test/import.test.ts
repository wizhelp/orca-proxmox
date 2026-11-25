// The one-shot import file an agent writes: imported like the Settings form, sealed and bound to
// its endpoint, then deleted; refused when others could read it, when it is not a plain file, or
// when it is not exactly the expected JSON. Synthetic values only.
import { afterEach, assert, mockHost, mountWorker, test, type TestWorker } from 'orca/testing'
import { chmod, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { takeImport } from '../src/importer'
import { memoryVault } from '../src/vault'
import * as main from '../src/worker'
import { mockTransport, pdmRoutes } from './fixtures/pdm'

const NOW = Date.UTC(2026, 10, 25, 12, 0, 0)
const SECRET = '6f1c2a9e-0b7d-4c3e-9a51-2d8e4f7b1c30'
const PIN = 'EC:7A:EF:38:FF:F7:59:92:C1:E3:B0:4C:1D:22:FF:C9:67:C6:91:C8:74:48:53:13:12:1A:C0:42:D1:5B:37:05'
const GOOD = { baseUrl: 'https://pdm.example.test:8443', tokenId: 'monitor@pdm!orca', fingerprint: PIN, secret: SECRET }

let worker: TestWorker | undefined
afterEach(async () => {
  await worker?.deactivate()
  worker = undefined
})

/** A private file where the OS allows it; else (Windows) the permission check does not apply. */
async function privateFile(content: string): Promise<{ path: string; platform: NodeJS.Platform }> {
  const dir = await mkdtemp(join(tmpdir(), 'pdm-import-'))
  const path = join(dir, 'connection-import.json')
  await writeFile(path, content, { mode: 0o600 })
  await chmod(path, 0o600)
  const posixPrivate = ((await stat(path)).mode & 0o077) === 0
  return { path, platform: posixPrivate ? process.platform : 'win32' }
}

async function mounted(path: string, platform: NodeJS.Platform, routes = pdmRoutes(NOW)) {
  const transport = mockTransport(routes)
  const vault = memoryVault()
  main.useTestDoubles({ transport, probe: async () => PIN, now: () => NOW, vault, importPath: path, importPlatform: platform })
  const host = mockHost()
  worker = await mountWorker(main, { host })
  return { host, transport, vault }
}

test('a private import file is saved like the Settings form, sealed and bound, then deleted', async () => {
  const { path, platform } = await privateFile(JSON.stringify(GOOD))
  const { host, transport } = await mounted(path, platform)
  const config = await worker!.request('config.import')
  assert.equal(config.connection?.baseUrl, GOOD.baseUrl)
  assert.equal(config.connection?.hasSecret, true)
  assert.equal(config.importStatus?.ok, true)
  assert.match(config.importStatus!.message, /Imported the connection to https:\/\/pdm\.example\.test:8443 as monitor@pdm!orca, pinned \((start|panel)\)\. Connection test: PDM 1\.0\.2, 4 remotes visible\./)
  assert.ok(!existsSync(path), 'the file is deleted')
  // Sealed, never plain; nothing of the secret in storage, logs or the answer.
  const stored = Object.entries(host.data().secrets).filter(([k]) => k.startsWith('token-secret:'))
  assert.equal(stored.length, 1)
  assert.ok(String(stored[0][1]).startsWith('sealed:v2:'))
  const everything = JSON.stringify({ storage: host.data().storage, logs: worker!.logs, config })
  assert.ok(!everything.includes(SECRET))
  assert.ok(worker!.logs.some((l) => /Import: Imported the connection/.test(l)))
  // It is used: the estate loads with the imported token.
  assert.equal((await worker!.request('estate.get', {})).state, 'ok')
  assert.ok(transport.requests.every((r) => r.headers.Authorization === `PDMAPIToken=monitor@pdm!orca:${SECRET}`))
  // Rewriting the imported settings in storage still makes the secret unusable (endpoint binding).
  const saved = (host.data().storage.connections as Record<string, unknown>[])[0]
  ;(host as unknown as { respond(m: string, r: unknown): void }).respond('storage.get', (p: { key: string }) => ({
    value: p.key === 'connections' ? [{ ...saved, baseUrl: 'https://elsewhere.example.test:8443' }] : (host.data().storage[p.key] ?? null)
  }))
  const tampered = await worker!.request('estate.get', { force: true })
  assert.equal(tampered.state === 'error' && tampered.error.kind, 'not-configured')
})

test('the import runs when the worker starts, and through the palette command', async () => {
  const { path, platform } = await privateFile(JSON.stringify(GOOD))
  await mounted(path, platform)
  let imported: string | undefined
  for (let i = 0; i < 100 && !imported; i++) {
    await new Promise((r) => setTimeout(r, 20))
    imported = (await worker!.request('config.get')).connection?.baseUrl
  }
  assert.equal(imported, GOOD.baseUrl, 'imported on start')
  // The file is gone: the command finds nothing (or reports the start-up import it joined).
  assert.match(String(await worker!.command('proxmox.importConnection')), /No import file|Imported the connection/)
  assert.match(String(await worker!.command('proxmox.importConnection')), /No import file/)
})

test('a file others can read is refused and left for the person to fix', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pdm-import-'))
  const path = join(dir, 'connection-import.json')
  await writeFile(path, JSON.stringify(GOOD), { mode: 0o644 })
  await chmod(path, 0o644)
  // Judged as on POSIX: on Windows the mode reads as 0o666, readable by all.
  const { host } = await mounted(path, 'linux')
  const config = await worker!.request('config.import')
  assert.equal(config.connection, null)
  assert.equal(config.importStatus?.ok, false)
  assert.match(config.importStatus!.message, /can be read by other users.*chmod 600/)
  assert.equal(await readFile(path, 'utf8'), JSON.stringify(GOOD), 'kept, unread')
  assert.deepEqual(Object.keys(host.data().secrets), [])
})

test('bad JSON, wrong fields and bad values are refused; the file is deleted', async () => {
  for (const [content, why] of [
    ['{"baseUrl": "https://pdm.example.test:8443", "secret": ', /not valid JSON/],
    [JSON.stringify([GOOD]), /must be a JSON object/],
    [JSON.stringify({ ...GOOD, extra: 'x' }), /must be a JSON object/],
    [JSON.stringify({ ...GOOD, secret: 42 }), /must be a JSON object/],
    [JSON.stringify({ ...GOOD, secret: '' }), /no token secret/],
    [JSON.stringify({ ...GOOD, baseUrl: 'http://pdm.example.test:8443' }), /read but not saved: .*https/i],
    [JSON.stringify({ ...GOOD, tokenId: 'monitor' }), /read but not saved: .*user@realm!tokenname/]
  ] as const) {
    const { path, platform } = await privateFile(content)
    await mounted(path, platform)
    const config = await worker!.request('config.import')
    assert.equal(config.importStatus?.ok, false, content)
    assert.match(config.importStatus!.message, why, content)
    assert.ok(!config.importStatus!.message.includes(SECRET))
    assert.equal(config.connection, null, content)
    assert.ok(!existsSync(path), `${content}: deleted`)
    await worker!.deactivate()
    worker = undefined
  }
})

test('a link or a folder in place of the file is not followed', async () => {
  const { path: target } = await privateFile(JSON.stringify(GOOD))
  const dir = await mkdtemp(join(tmpdir(), 'pdm-import-'))
  const link = join(dir, 'connection-import.json')
  let linked = true
  await symlink(target, link).catch(() => (linked = false)) // Windows may not allow links
  if (linked) {
    const result = await takeImport(link, 'linux')
    assert.equal(result.state === 'refused' && result.kept, true)
    assert.ok(existsSync(target), 'the link target is untouched')
  }
  const folder = await takeImport(dir, 'linux')
  assert.equal(folder.state, 'refused')
  assert.equal((await takeImport(join(dir, 'missing.json'))).state, 'none')
})
