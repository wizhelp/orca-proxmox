// Which Terminal a node or guest card offers, for a setup like this one: PDM with three nodes on
// private addresses, and Orca SSH targets to two of them named by a DNS name and by a public IP,
// with no workspace on them. Example data only.
import { assert, test } from 'orca/testing'
import type { EstateSnapshot, Guest, Host, OrcaHost, OrcaView, OrcaWorkspace } from '../src/model'
import type { CliRunner } from '../src/orca/inventory'
import { placeOrcaHosts, type OrcaLinks } from '../src/orca/match'
import { OrcaService } from '../src/orca/service'
import { offerPlan, terminalPlan } from '../src/orca/terminal'
import { cardOffer, orcaByPlace, terminalOffer } from '../src/presence'

const node = (name: string, address: string): Host => ({ key: `cl/${name}`, remote: 'cl', remoteType: 'pve', node: name, online: true, status: 'online', addresses: [address] }) as Host
const estate = { hosts: [node('pve-x1', '10.20.0.11'), node('pve-x2', '10.20.0.12'), node('pve-x3', '10.20.0.13')], guests: [] as Guest[] }
const snap = estate as unknown as EstateSnapshot
const target = (id: string, name: string, over: Partial<OrcaHost> = {}): OrcaHost => ({ key: `ssh:${id}`, kind: 'ssh', name, connected: true, ...over })
const ws = (hostKey: string, over: Partial<OrcaWorkspace> = {}): OrcaWorkspace => ({ key: `${hostKey}|w`, hostKey, name: 'root', repo: 'root', status: 'active', agents: [], worktreeId: `folder:${hostKey}`, ...over })
const view = (hosts: OrcaHost[], workspaces: OrcaWorkspace[] = [], links: OrcaLinks = {}): OrcaView => ({ fetchedAt: 0, hosts: placeOrcaHosts(hosts, estate, links), workspaces, bots: [], warnings: [] })
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
  assert.deepEqual([resolved.runsOn, resolved.match], [{ kind: 'node', key: 'cl/pve-x3' }, 'resolved'])
  // Addresses that point to two nodes place nothing.
  assert.equal(placeOrcaHosts([target('a', 'lab.example.test', { resolved: ['10.20.0.13', '10.20.0.12'] })], estate)[0].runsOn, undefined)
  // A paired server deployed over it keeps that provenance.
  const server: OrcaHost = { key: 'env:s1', kind: 'environment', name: 'server-1', viaSsh: 'ssh:a' }
  const both = placeOrcaHosts([target('a', 'lab.example.test', { resolved: ['10.20.0.13'] }), server], estate)
  assert.deepEqual(both.map((h) => h.match), ['resolved', 'resolved'])
  // Through the Orca view: resolved once, kept a while; IP-named targets are not resolved.
  const calls: string[] = []
  const answers: Record<string, string[]> = {
    'lab.example.test': ['10.20.0.13'],
    // A 17th answer that points elsewhere is not dropped before agreement is checked: too many
    // answers place nothing.
    'many.example.test': [...Array.from({ length: 16 }, () => '10.20.0.13'), '10.20.0.12']
  }
  const cli: CliRunner = async (args) => {
    const cmd = args.slice(0, 2).join(' ')
    if (cmd === 'host list') return { hosts: [{ kind: 'ssh', id: 'a', name: 'lab.example.test', connected: true }, { kind: 'ssh', id: 'b', name: '203.0.113.12', connected: true }, { kind: 'ssh', id: 'c', name: 'many.example.test', connected: true }] }
    if (cmd === 'worktree ps') return { worktrees: [] }
    return cmd === 'environment list' ? { environments: [] } : { bots: [] }
  }
  const service = new OrcaService(() => cli, () => 1000, undefined, async (name) => (calls.push(name), answers[name] ?? []))
  const first = await service.view(snap, {})
  await service.view(snap, {}, true)
  assert.deepEqual(first.hosts.map((h) => h.runsOn?.key ?? '-'), ['cl/pve-x3', '-', '-'])
  assert.deepEqual(calls, ['lab.example.test', 'many.example.test'])
  // The panel gets the placement and how it was made, not the answers.
  assert.deepEqual([first.hosts[0].match, first.hosts.some((h) => 'resolved' in h)], ['resolved', false])
})

test('a DNS-derived placement never offers a local root ssh, in the card or the worker', () => {
  const v = view([target('a', 'lab.example.test', { resolved: ['10.20.0.13'] })])
  const offer = offerFor(v, 'pve-x3')!
  assert.deepEqual([offer.route, offer.destination], ['none', ''])
  assert.match(offer.title, /placed by what its DNS name resolves to here, which is not enough to open a root SSH session/)
  const plan = terminalPlan('ssh:a', v, snap)
  assert.ok('error' in plan && /not enough to open a root SSH session/.test(plan.error), JSON.stringify(plan))
  // A forged offer for it is refused where it is run, too.
  const forged = offerPlan({ host: v.hosts[0], route: 'ssh', ssh: 'ssh root@10.20.0.13', destination: 'ssh ssh root@10.20.0.13', title: '' }, v)
  assert.ok('error' in forged)
  // Through its Orca workspace it works (Orca's own connection), said to be placed by DNS.
  const withWs = offerFor(view([target('a', 'lab.example.test', { resolved: ['10.20.0.13'] })], [ws('ssh:a')]), 'pve-x3')!
  assert.equal(withWs.route, 'workspace')
  assert.match(withWs.title, /through Orca \(its root workspace\) \(placed on this node by what its DNS name resolves to here\)/)
  // Placed by hand on that node: the labelled local ssh.
  const manual = offerFor(view([target('a', 'lab.example.test', { resolved: ['10.20.0.13'] })], [], { 'ssh:a': 'node:cl/pve-x3' }), 'pve-x3')!
  assert.deepEqual([manual.route, manual.destination], ['ssh', 'ssh ssh root@10.20.0.13'])
})

test('a target placed by hand without a workspace offers a clearly labelled local ssh; placed automatically, none', () => {
  // Matched by name: no local ssh, and what to do.
  const auto = offerFor(view([target('a', 'pve-x2')]), 'pve-x2')!
  assert.equal(auto.route, 'none')
  assert.match(auto.title, /Orca has no workspace on pve-x2\. Open a folder on it in Orca \(e\.g\. \/root\) for a terminal through Orca, or place it by hand/)
  const v = view([target('a', 'pve-x2')], [], { 'ssh:a': 'node:cl/pve-x2' })
  const offer = offerFor(v, 'pve-x2')!
  assert.equal(offer.route, 'ssh')
  assert.match(offer.title, /Orca has no workspace on pve-x2: this opens a local terminal running “ssh root@10\.20\.0\.12” to the node you placed it on\. Open a folder on pve-x2 in Orca/)
  // No address to ssh to: no Terminal, and why.
  const none = offerFor(v, 'pve-x2', '')!
  assert.deepEqual([none.route, /no valid address to ssh to/.test(none.title)], ['none', true])
  // With a workspace: through Orca.
  const withWs = offerFor(view([target('a', 'pve-x2')], [ws('ssh:a')]), 'pve-x2')!
  assert.deepEqual([withWs.route, withWs.host?.key], ['workspace', 'ssh:a'])
})

test('the card and the worker pick the same workspace, and any change makes the card stale', () => {
  // A bot's home listed first, a plain folder newer: both pick the plain folder.
  const spaces = [ws('ssh:a', { key: 'bot', bot: 'b1', worktreeId: 'folder:bot', lastActivityAt: 9 }), ws('ssh:a', { key: 'plain', worktreeId: 'folder:plain', lastActivityAt: 5 })]
  const v = view([target('a', 'pve-x2')], spaces)
  const snapWith = { ...estate, orca: v } as unknown as EstateSnapshot
  const offer = cardOffer(snapWith, 'node:cl/pve-x2')!
  assert.equal(offer.destination, 'workspace local folder:plain')
  const plan = offerPlan(offer, v)
  assert.ok(!('error' in plan) && plan.args.includes('--worktree=folder:plain'), JSON.stringify(plan))
  // The workspace went away (same connection): the card's offer is no longer the one shown.
  const gone = cardOffer({ ...snapWith, orca: view([target('a', 'pve-x2')], [], { 'ssh:a': 'node:cl/pve-x2' }) } as unknown as EstateSnapshot, 'node:cl/pve-x2')!
  assert.deepEqual([gone.route, gone.destination === offer.destination], ['ssh', false])
  // A DNS refresh moved the target to another node: nothing on the old card any more.
  const before = { ...estate, orca: view([target('d', 'lab.example.test', { resolved: ['10.20.0.12'] })], [ws('ssh:d')]) } as unknown as EstateSnapshot
  const after = { ...estate, orca: view([target('d', 'lab.example.test', { resolved: ['10.20.0.11'] })], [ws('ssh:d')]) } as unknown as EstateSnapshot
  assert.equal(cardOffer(before, 'node:cl/pve-x2')!.route, 'workspace')
  assert.equal(cardOffer(after, 'node:cl/pve-x2')!.route, 'none')
})

test('an Orca route on the same node is preferred over a local ssh, whichever host comes first', () => {
  const server: OrcaHost = { key: 'env:s1', kind: 'environment', name: 'server-2', viaSsh: 'ssh:other' }
  const v = view([target('a', 'pve-x2'), { ...server, name: 'pve-x2' }], [ws('env:s1', { environment: 's1', ownRuntime: true })])
  const offer = offerFor(v, 'pve-x2')!
  assert.deepEqual([offer.route, offer.host?.key], ['workspace', 'env:s1'])
})
