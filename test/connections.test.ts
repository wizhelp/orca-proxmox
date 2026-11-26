// Several connections in the worker: PDM plus a PVE and a PBS reached directly, each with its own
// sealed, endpoint-bound secret; added, tested, read as one estate and removed one by one.
import { afterEach, assert, mockHost, mountWorker, test, type TestWorker } from 'orca/testing'
import { estateScope } from '../src/model'
import type { HttpRequest } from '../src/proxmox/http'
import { memoryVault } from '../src/vault'
import * as main from '../src/worker'
import { pbsRoutes, pveRoutes } from './fixtures/direct'
import { mockTransport, pdmRoutes } from './fixtures/pdm'

const NOW = Date.UTC(2026, 10, 25, 12, 0, 0)
const PIN = 'EC:7A:EF:38:FF:F7:59:92:C1:E3:B0:4C:1D:22:FF:C9:67:C6:91:C8:74:48:53:13:12:1A:C0:42:D1:5B:37:05'
const PDM = { baseUrl: 'https://pdm.example.test:8443', tokenId: 'monitor@pdm!orca', fingerprint: PIN, secret: '11111111-1111-4111-8111-111111111111' }
const PVE = { id: 'new', kind: 'pve' as const, name: 'lab', baseUrl: 'https://pve.example.test:8006', tokenId: 'monitor@pve!orca', fingerprint: PIN, secret: '22222222-2222-4222-8222-222222222222' }
const PBS = { id: 'new', kind: 'pbs' as const, name: 'backup-x', baseUrl: 'https://pbs.example.test:8007', tokenId: 'monitor@pbs!orca', fingerprint: PIN, secret: '33333333-3333-4333-8333-333333333333' }

let worker: TestWorker | undefined
afterEach(async () => {
  await worker?.deactivate()
  worker = undefined
})

/** One fake transport for three servers, by host. */
function estateTransport() {
  const byHost: Record<string, ReturnType<typeof mockTransport>> = {
    'pdm.example.test:8443': mockTransport(pdmRoutes(NOW)),
    'pve.example.test:8006': mockTransport(pveRoutes(NOW) as never),
    'pbs.example.test:8007': mockTransport(pbsRoutes(NOW) as never)
  }
  const requests: HttpRequest[] = []
  const transport = async (request: HttpRequest) => {
    requests.push(request)
    const t = byHost[request.url.host]
    if (!t) throw new Error(`unknown host ${request.url.host}`)
    return t(request)
  }
  return { transport, requests }
}

async function mounted() {
  const { transport, requests } = estateTransport()
  main.useTestDoubles({ transport, probe: async () => PIN, now: () => NOW, vault: memoryVault() })
  const host = mockHost()
  worker = await mountWorker(main, { host })
  return { host, requests }
}

test('PDM plus a direct PVE and PBS: each tested and saved with its own secret, read as one estate', async () => {
  const { host, requests } = await mounted()
  await worker!.request('config.save', PDM)
  const pveTest = await worker!.request('connection.test', PVE)
  assert.deepEqual(pveTest, { ok: true, version: '9.1.2', remotes: 2, unit: 'nodes' })
  await worker!.request('config.save', PVE)
  const config = await worker!.request('config.save', PBS)
  assert.deepEqual(config.connections.map((c) => [c.kind, c.name ?? '', c.hasSecret]), [['pdm', '', true], ['pve', 'lab', true], ['pbs', 'backup-x', true]])
  assert.equal(new Set(config.connections.map((c) => c.id)).size, 3)
  const secrets = Object.keys(host.data().secrets).filter((k) => k.startsWith('token-secret:'))
  assert.equal(secrets.length, 3, 'one sealed secret per connection')

  const answer = await worker!.request('estate.get', {})
  assert.equal(answer.state, 'ok')
  if (answer.state !== 'ok') return
  assert.equal(answer.snapshot.connectionId, estateScope(config.connections))
  const remotes = answer.snapshot.remotes.map((r) => r.id)
  assert.ok(remotes.includes('lab (direct)') && remotes.includes('backup-x (direct)') && remotes.includes('pve-fsn'), remotes.join(','))
  assert.ok(answer.snapshot.guests.some((g) => g.key === 'lab (direct)/501'))
  assert.equal(answer.snapshot.pdmUrl, 'https://pdm.example.test:8443')
  // Each server only ever saw its own token, in its own header form.
  const auth = (host: string) => new Set(requests.filter((r) => r.url.host === host).map((r) => r.headers.Authorization))
  assert.deepEqual([...auth('pve.example.test:8006')], [`PVEAPIToken=monitor@pve!orca=${PVE.secret}`])
  assert.deepEqual([...auth('pbs.example.test:8007')], [`PBSAPIToken=monitor@pbs!orca:${PBS.secret}`])
  assert.deepEqual([...auth('pdm.example.test:8443')], [`PDMAPIToken=monitor@pdm!orca:${PDM.secret}`])

  // Removing one keeps the others and their secrets.
  const pveId = config.connections.find((c) => c.kind === 'pve')!.id
  const after = await worker!.request('config.clear', { id: pveId })
  assert.deepEqual(after.connections.map((c) => c.kind), ['pdm', 'pbs'])
  assert.equal(Object.keys(host.data().secrets).filter((k) => k.startsWith('token-secret:')).length, 2)
  assert.ok(after.connections.every((c) => c.hasSecret))
})

test('editing one connection keeps the others; a URL can be used once; names are plain', async () => {
  await mounted()
  await worker!.request('config.save', PDM)
  const saved = await worker!.request('config.save', PVE)
  const pve = saved.connections.find((c) => c.kind === 'pve')!
  const edited = await worker!.request('config.save', { ...PVE, id: pve.id, name: 'lab-2', secret: '' })
  assert.equal(edited.connections.find((c) => c.id === pve.id)!.name, 'lab-2')
  assert.equal(edited.connections.find((c) => c.id === pve.id)!.hasSecret, true, 'same URL, token and pin: the secret carries over')
  assert.equal(edited.connections.length, 2)
  await assert.rejects(worker!.request('config.save', { ...PBS, baseUrl: PVE.baseUrl }), /already uses this URL/)
  await assert.rejects(worker!.request('config.save', { ...PBS, name: 'bad name!' }), /The name may hold/)
  await assert.rejects(worker!.request('config.save', { ...PDM, id: 'new', baseUrl: 'https://pdm2.example.test:8443', name: 'x' }), /PDM connection has no name/)
  // One PDM at most: its remotes keep PDM's ids, which a second PDM could repeat.
  await assert.rejects(worker!.request('config.save', { ...PDM, id: 'new', baseUrl: 'https://pdm2.example.test:8443' }), /There is a PDM connection already/)
})

test('a connection without its secret is one unreachable remote; the others still load', async () => {
  await mounted()
  await worker!.request('config.save', PDM)
  await worker!.request('config.save', { ...PVE, secret: '' })
  const answer = await worker!.request('estate.get', {})
  assert.equal(answer.state, 'ok')
  if (answer.state !== 'ok') return
  const lab = answer.snapshot.remotes.find((r) => r.id === 'lab (direct)')!
  assert.equal(lab.online, false)
  assert.ok(answer.snapshot.remotes.some((r) => r.id === 'pve-fsn' && r.online))
})
