// Strict address checks: what PDM reports reaches ssh commands and links only when it is plainly
// an IP address or a DNS name.
import { assert, test } from 'orca/testing'
import { guestSsh, hostSsh, httpsBase, isSafeSshCommand, sshArgs, webBase } from '../src/features/links'
import { isHostname, isIpv4, isIpv6, safeTarget } from '../src/features/targets'
import type { Guest, Host } from '../src/model'
import { guestNetwork, nodeAddress, nodePort } from '../src/proxmox/pdm'

const HOSTILE = [
  '203.0.113.1;id',
  '203.0.113.1 && id',
  '$(id)',
  '`id`',
  '-oProxyCommand=id',
  'host name',
  'a|b',
  "pve'1",
  'pve"1',
  'pve\n1',
  '256.1.1.1',
  '01.2.3.4',
  '1.2.3',
  'fe80::1%eth0',
  '[::1]',
  '-pve',
  'pve-',
  '',
  'x'.repeat(64) + '.example'
]

test('IP addresses and DNS names, strictly', () => {
  for (const ok of ['203.0.113.1', '10.0.0.1', '0.0.0.0', '255.255.255.255']) assert.ok(isIpv4(ok), ok)
  for (const ok of ['::1', '2001:db8::1', 'fe80::1', '2001:db8:0:0:0:0:0:1', '::ffff:192.0.2.1', '::']) assert.ok(isIpv6(ok), ok)
  for (const bad of ['2001:db8:::1', '1:2:3:4:5:6:7:8:9', '2001:db8::g', ':::', '1::2::3']) assert.ok(!isIpv6(bad), bad)
  for (const ok of ['pve1', 'pve-1.example.test', 'a.b.c', 'PVE.example.test.']) assert.ok(isHostname(ok), ok)
  for (const bad of HOSTILE) assert.equal(safeTarget(bad), undefined, JSON.stringify(bad))
})

test('PDM values that are not addresses are dropped where they are read', () => {
  assert.equal(nodeAddress('203.0.113.1;id:8006,fingerprint=AA'), undefined)
  assert.equal(nodeAddress('hostname=$(id),fingerprint=AA'), undefined)
  assert.equal(nodeAddress('[2001:db8::1]:8006'), '2001:db8::1')
  assert.equal(nodePort('[2001:db8::1]:8006'), 8006)
  assert.equal(nodePort('10.0.0.1:99999'), undefined)
  assert.equal(nodePort('pve1'), undefined)
  const net = guestNetwork({ net0: 'name=eth0,ip=10.0.0.5/24', net1: 'name=eth1,ip=10.0.0.6;id/24', ipconfig0: 'ip=$(id)/24', hostname: 'ct;id' })
  assert.deepEqual(net, { addresses: ['10.0.0.5'] })
})

const host = (addresses: string[]): Host => ({ key: 'r/n', remote: 'r', remoteType: 'pve', node: 'n', online: true, status: 'online', addresses })
const guest = (addresses: string[]): Guest =>
  ({ key: 'r/100', remote: 'r', node: 'n', vmid: 100, type: 'lxc', name: 'ct', status: 'running', template: false, tags: [], cpu: 0, maxcpu: 1, mem: 0, maxmem: 1, disk: 0, maxdisk: 1, uptime: 0, backupState: 'unknown', addresses }) as Guest

test('ssh commands only from valid targets, with structured arguments', () => {
  assert.equal(hostSsh(host(['203.0.113.1'])), 'ssh root@203.0.113.1')
  assert.equal(guestSsh(guest(['10.0.0.5']), host(['203.0.113.1'])), 'ssh -J root@203.0.113.1 root@10.0.0.5')
  assert.deepEqual(sshArgs('root', '2001:db8::5'), ['ssh', 'root@2001:db8::5'])
  // An IPv6 jump host would need brackets in -J: the guest is offered directly instead.
  assert.deepEqual(sshArgs('root', '10.0.0.5', '2001:db8::1'), ['ssh', 'root@10.0.0.5'])
  for (const bad of HOSTILE) {
    assert.equal(hostSsh(host([bad])), undefined, JSON.stringify(bad))
    assert.equal(guestSsh(guest([bad]), host(['203.0.113.1'])), undefined, JSON.stringify(bad))
    // A hostile node is never used as the jump host.
    const viaBad = guestSsh(guest(['10.0.0.5']), host([bad]))
    assert.ok(viaBad === undefined || viaBad === 'ssh root@10.0.0.5', JSON.stringify(bad))
  }
  assert.equal(sshArgs('root;id', '203.0.113.1'), undefined)
  assert.ok(isSafeSshCommand('ssh root@203.0.113.1'))
  assert.ok(isSafeSshCommand('ssh -J root@203.0.113.1 root@10.0.0.5'))
  for (const bad of ['ssh root@203.0.113.1;id', 'ssh -J root@$(id) root@10.0.0.5', 'ssh -oProxyCommand=id root@x', 'ssh  root@x', 'sh root@x', 'ssh -J admin@a root@b']) {
    assert.ok(!isSafeSshCommand(bad), bad)
  }
})

test('links only from https URLs and valid addresses', () => {
  assert.equal(httpsBase('https://pve.example.test:8006/'), 'https://pve.example.test:8006')
  assert.equal(httpsBase('javascript:alert(1)'), undefined)
  assert.equal(httpsBase('https://user:pw@pve.example.test'), undefined)
  assert.equal(webBase({ id: 'x', type: 'pve', online: true, webUrl: 'javascript:alert(1)', nodeAddress: 'pve1.lan' }), 'https://pve1.lan:8006')
  assert.equal(webBase({ id: 'x', type: 'pve', online: true, nodeAddress: '2001:db8::1', nodePort: 9006 }), 'https://[2001:db8::1]:9006')
  assert.equal(webBase({ id: 'x', type: 'pve', online: true, nodeAddress: 'x;id' }), undefined)
})
