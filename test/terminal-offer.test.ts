// Which Terminal a node or guest card offers, for a setup like this one: PDM with three nodes on
// private addresses, and Orca SSH targets to two of them named by a DNS name and by a public IP,
// with no workspace on them. Example data only.
import { assert, test } from 'orca/testing'
import type { EstateSnapshot, Guest, Host, OrcaHost, OrcaView, OrcaWorkspace } from '../src/model'
import type { CliRunner } from '../src/orca/inventory'
import { placeOrcaHosts } from '../src/orca/match'
import { OrcaService } from '../src/orca/service'
import { orcaByPlace, terminalOffer } from '../src/presence'

const node = (name: string, address: string): Host => ({ key: `cl/${name}`, remote: 'cl', remoteType: 'pve', node: name, online: true, status: 'online', addresses: [address] }) as Host
const estate = { hosts: [node('pve-x1', '10.20.0.11'), node('pve-x2', '10.20.0.12'), node('pve-x3', '10.20.0.13')], guests: [] as Guest[] }
const snap = estate as unknown as EstateSnapshot
const target = (id: string, name: string, over: Partial<OrcaHost> = {}): OrcaHost => ({ key: `ssh:${id}`, kind: 'ssh', name, connected: true, ...over })
const ws = (hostKey: string, over: Partial<OrcaWorkspace> = {}): OrcaWorkspace => ({ key: `${hostKey}|w`, hostKey, name: 'root', repo: 'root', status: 'active', agents: [], worktreeId: `folder:${hostKey}`, ...over })
const view = (hosts: OrcaHost[], workspaces: OrcaWorkspace[] = []): OrcaView => ({ fetchedAt: 0, hosts: placeOrcaHosts(hosts, estate), workspaces, bots: [], warnings: [] })
const offerFor = (v: OrcaView, nodeName: string, ssh = `ssh root@${estate.hosts.find((h) => h.node === nodeName)!.addresses![0]}`) =>
  terminalOffer(v, orcaByPlace(v).get(`node:cl/${nodeName}`), ssh, 'node')

test('targets named unlike the nodes are not placed: their nodes say why there is no Terminal', () => {
  const v = view([target('a', 'lab.example.test'), target('b', '203.0.113.12')])
  assert.equal(v.hosts.filter((h) => h.runsOn).length, 0)
  const offer = offerFor(v, 'pve-x3')!
  assert.equal(offer.route, 'none')
  assert.match(offer.title, /No Orca host is placed on this node\. 2 Orca hosts are not placed yet \(lab\.example\.test, 203\.0\.113\.12\): place one in the Orca view/)
  // Orca awareness off: no button at all.
  assert.equal(terminalOffer(undefined, undefined, 'ssh root@10.20.0.13', 'node'), undefined)
})

test('a target named by a DNS name is placed by what the name resolves to here', async () => {
  const resolved = placeOrcaHosts([target('a', 'lab.example.test', { resolved: ['10.20.0.13'] })], estate)[0]
  assert.deepEqual([resolved.runsOn, resolved.match], [{ kind: 'node', key: 'cl/pve-x3' }, 'address'])
  // Addresses that point to two nodes place nothing.
  assert.equal(placeOrcaHosts([target('a', 'lab.example.test', { resolved: ['10.20.0.13', '10.20.0.12'] })], estate)[0].runsOn, undefined)
  // Through the Orca view: resolved once, kept a while; IP-named targets are not resolved.
  const calls: string[] = []
  const cli: CliRunner = async (args) => {
    const cmd = args.slice(0, 2).join(' ')
    if (cmd === 'host list') return { hosts: [{ kind: 'ssh', id: 'a', name: 'lab.example.test', connected: true }, { kind: 'ssh', id: 'b', name: '203.0.113.12', connected: true }] }
    if (cmd === 'worktree ps') return { worktrees: [] }
    return cmd === 'environment list' ? { environments: [] } : { bots: [] }
  }
  const service = new OrcaService(() => cli, () => 1000, undefined, async (name) => (calls.push(name), name === 'lab.example.test' ? ['10.20.0.13'] : []))
  const first = await service.view(snap, {})
  await service.view(snap, {}, true)
  assert.deepEqual(first.hosts.map((h) => h.runsOn?.key ?? '-'), ['cl/pve-x3', '-'])
  assert.deepEqual(calls, ['lab.example.test'])
})

test('a placed target without a workspace offers a clearly labelled local ssh, never as if it were Orca’s own', () => {
  const v = view([target('a', 'pve-x2')])
  const offer = offerFor(v, 'pve-x2')!
  assert.equal(offer.route, 'ssh')
  assert.match(offer.title, /Orca has no workspace on pve-x2: this opens a local terminal running “ssh root@10\.20\.0\.12”\. Open a folder on pve-x2 in Orca/)
  // No address to ssh to: no Terminal, and why.
  const none = offerFor(v, 'pve-x2', '')!
  assert.deepEqual([none.route, /no address to ssh to/.test(none.title)], ['none', true])
  // With a workspace: through Orca.
  const withWs = offerFor(view([target('a', 'pve-x2')], [ws('ssh:a')]), 'pve-x2')!
  assert.deepEqual([withWs.route, withWs.host?.key], ['workspace', 'ssh:a'])
})

test('an Orca route on the same node is preferred over a local ssh, whichever host comes first', () => {
  const server: OrcaHost = { key: 'env:s1', kind: 'environment', name: 'server-2', viaSsh: 'ssh:other' }
  const v = view([target('a', 'pve-x2'), { ...server, name: 'pve-x2' }], [ws('env:s1', { environment: 's1', ownRuntime: true })])
  const offer = offerFor(v, 'pve-x2')!
  assert.deepEqual([offer.route, offer.host?.key], ['workspace', 'env:s1'])
})
