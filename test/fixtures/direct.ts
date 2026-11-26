// A PVE cluster and a PBS reached directly, without PDM: example answers in the shapes PVE and PBS
// serialize (the `data` of each GET, keyed by path and query after /api2/json). All names, ids,
// addresses and times are examples; times are relative to `now`.
const GiB = 1024 ** 3

/** An RRD series of `n` minutes ending at `t` (seconds), PVE's field names. */
function rrd(t: number, n: number, point: (i: number) => Record<string, number>) {
  return Array.from({ length: n }, (_, i) => ({ time: t - (n - 1 - i) * 60, ...point(i) }))
}

/** A PVE task list entry (a bare UPID, as PVE gives it). */
function pveTask(node: string, type: string, id: string, start: number, took: number | null, status?: string) {
  const upid = `UPID:${node}:0000A1B2:00C3D4E5:${start.toString(16).toUpperCase()}:${type}:${id}:root@pam:`
  return { upid, node, type, id, user: 'root@pam', starttime: start, ...(took === null ? {} : { endtime: start + took, status }) }
}

export function pveRoutes(now: number): Record<string, unknown> {
  const t = Math.floor(now / 1000)
  const hour = '?timeframe=hour&cf=AVERAGE'
  return {
    '/version': { version: '9.1.2', release: '9.1', repoid: '0000000000000000' },
    '/cluster/status': [
      { type: 'cluster', name: 'lab', nodes: 2, quorate: 1 },
      { type: 'node', name: 'pve-x1', online: 1, ip: '198.51.100.21' },
      { type: 'node', name: 'pve-x2', online: 1, ip: '198.51.100.22' }
    ],
    '/cluster/resources?type=node': [
      { id: 'node/pve-x1', type: 'node', node: 'pve-x1', status: 'online' },
      { id: 'node/pve-x2', type: 'node', node: 'pve-x2', status: 'online' }
    ],
    '/cluster/resources': [
      { id: 'node/pve-x1', type: 'node', node: 'pve-x1', status: 'online', cpu: 0.08, maxcpu: 16, mem: 20 * GiB, maxmem: 64 * GiB, disk: 12 * GiB, maxdisk: 100 * GiB, uptime: 864000 },
      { id: 'node/pve-x2', type: 'node', node: 'pve-x2', status: 'online', cpu: 0.03, maxcpu: 8, mem: 9 * GiB, maxmem: 32 * GiB, disk: 10 * GiB, maxdisk: 100 * GiB, uptime: 432000 },
      { id: 'qemu/501', type: 'qemu', vmid: 501, name: 'web-x', node: 'pve-x1', status: 'running', cpu: 0.05, maxcpu: 4, mem: 3 * GiB, maxmem: 8 * GiB, disk: 0, maxdisk: 64 * GiB, uptime: 86400, template: 0, tags: 'prod;web' },
      { id: 'qemu/502', type: 'qemu', vmid: 502, name: 'db-x', node: 'pve-x1', status: 'running', cpu: 0.2, maxcpu: 4, mem: 6 * GiB, maxmem: 8 * GiB, disk: 0, maxdisk: 128 * GiB, uptime: 86400, template: 0 },
      { id: 'lxc/503', type: 'lxc', vmid: 503, name: 'dns-x', node: 'pve-x2', status: 'running', cpu: 0.01, maxcpu: 1, mem: 0.2 * GiB, maxmem: 0.5 * GiB, disk: 3.6 * GiB, maxdisk: 4 * GiB, uptime: 172800, template: 0, tags: 'infra' },
      { id: 'qemu/504', type: 'qemu', vmid: 504, name: 'old-x', node: 'pve-x2', status: 'stopped', cpu: 0, maxcpu: 2, mem: 0, maxmem: 4 * GiB, disk: 0, maxdisk: 32 * GiB, uptime: 0, template: 0 },
      { id: 'storage/pve-x1/local', type: 'storage', storage: 'local', node: 'pve-x1', status: 'available', shared: 0, disk: 12 * GiB, maxdisk: 100 * GiB, content: 'iso,vztmpl,backup' },
      { id: 'storage/pve-x1/local-lvm', type: 'storage', storage: 'local-lvm', node: 'pve-x1', status: 'available', shared: 0, disk: 300 * GiB, maxdisk: 800 * GiB, content: 'images,rootdir' },
      { id: 'storage/pve-x2/local-lvm', type: 'storage', storage: 'local-lvm', node: 'pve-x2', status: 'available', shared: 0, disk: 100 * GiB, maxdisk: 400 * GiB, content: 'images,rootdir' },
      { id: 'pool/lab', type: 'pool', pool: 'lab' }
    ],
    '/nodes/pve-x1/status': { pveversion: 'pve-manager/9.1.2/0000000000000000', uptime: 864000, rootfs: { used: 12 * GiB, total: 100 * GiB, avail: 88 * GiB } },
    '/nodes/pve-x2/status': { pveversion: 'pve-manager/9.1.1/0000000000000000', uptime: 432000, rootfs: { used: 10 * GiB, total: 100 * GiB, avail: 90 * GiB } },
    [`/nodes/pve-x1/rrddata${hour}`]: rrd(t, 60, (i) => ({ cpu: 0.05 + (i % 10) / 200, memused: 20 * GiB, memtotal: 64 * GiB, netin: 2000 + i * 10, netout: 1500 })),
    [`/nodes/pve-x2/rrddata${hour}`]: rrd(t, 60, () => ({ cpu: 0.03, memused: 9 * GiB, memtotal: 32 * GiB, netin: 800, netout: 600 })),
    [`/nodes/pve-x1/qemu/501/rrddata${hour}`]: rrd(t, 60, (i) => ({ cpu: 0.04 + (i % 5) / 100, mem: 3 * GiB, maxmem: 8 * GiB, netin: 500, netout: 900 })),
    [`/nodes/pve-x1/qemu/502/rrddata${hour}`]: rrd(t, 60, () => ({ cpu: 0.2, mem: 6 * GiB, maxmem: 8 * GiB, netin: 300, netout: 300 })),
    [`/nodes/pve-x2/lxc/503/rrddata${hour}`]: rrd(t, 60, () => ({ cpu: 0.01, mem: 0.2 * GiB, maxmem: 0.5 * GiB, netin: 50, netout: 40 })),
    '/cluster/tasks': [
      pveTask('pve-x1', 'vzdump', '501', t - 7200, 300, 'OK'),
      pveTask('pve-x1', 'vzdump', '502', t - 7000, 120, 'job errors'),
      pveTask('pve-x2', 'vzstart', '503', t - 600, 2, 'OK'),
      pveTask('pve-x1', 'qmstart', '501', t - 60, null)
    ],
    '/nodes/pve-x1/apt/update': [{ Package: 'pve-manager' }, { Package: 'qemu-server' }],
    '/nodes/pve-x2/apt/update': [],
    '/nodes/pve-x1/network': [{ iface: 'vmbr0', address: '198.51.100.21', cidr: '198.51.100.21/24' }, { iface: 'lo', address: '127.0.0.1' }],
    '/nodes/pve-x2/network': [{ iface: 'vmbr0', address: '198.51.100.22' }],
    '/nodes/pve-x1/config': { description: 'Lab node one.' },
    '/nodes/pve-x2/config': {},
    '/nodes/pve-x1/qemu/501/config': { name: 'web-x', agent: '1', ipconfig0: 'ip=10.20.0.11/24,gw=10.20.0.1', description: 'Public web front end.' },
    '/nodes/pve-x1/qemu/502/config': { name: 'db-x', ipconfig0: 'ip=10.20.0.12/24' },
    '/nodes/pve-x2/lxc/503/config': { hostname: 'dns-x', net0: 'name=eth0,bridge=vmbr0,ip=10.20.0.13/24' },
    '/nodes/pve-x2/qemu/504/config': { name: 'old-x' },
    // The guest agent of 501 answers; 502 has none (PVE answers 500).
    '/nodes/pve-x1/qemu/501/agent/get-fsinfo': {
      result: [
        { name: 'sda1', mountpoint: '/', type: 'ext4', 'total-bytes': 60 * GiB, 'used-bytes': 21 * GiB },
        { name: 'tmpfs', mountpoint: '/run', type: 'tmpfs', 'total-bytes': 1 * GiB, 'used-bytes': 0 }
      ]
    },
    '/nodes/pve-x1/qemu/502/agent/get-fsinfo': { status: 500, body: '{"data":null}' }
  }
}

export function pbsRoutes(now: number): Record<string, unknown> {
  const t = Math.floor(now / 1000)
  const snap = (type: string, id: string, hoursAgo: number, owner = 'backup@pbs!lab') => ({ 'backup-type': type, 'backup-id': id, 'backup-time': t - hoursAgo * 3600, owner, size: 1024 })
  return {
    '/version': { version: '4.1', release: '2', repoid: '0000000000000000' },
    '/nodes/localhost/status': { cpu: 0.02, cpuinfo: { cpus: 4 }, memory: { used: 3 * GiB, total: 16 * GiB }, root: { used: 8 * GiB, total: 60 * GiB }, uptime: 900000 },
    '/status/datastore-usage': [{ store: 'store-x', used: 1200 * GiB, total: 2000 * GiB, avail: 800 * GiB }],
    '/admin/datastore': [{ store: 'store-x' }],
    '/admin/datastore/store-x/namespace': [{ ns: '' }],
    '/admin/datastore/store-x/snapshots': [snap('vm', '501', 2), snap('ct', '503', 3), snap('vm', '502', 40), snap('vm', '599', 300)],
    '/nodes/localhost/rrd?timeframe=hour&cf=AVERAGE': rrd(t, 60, () => ({ cpu: 0.02, memused: 3 * GiB, memtotal: 16 * GiB, netin: 100, netout: 4000 })),
    '/admin/datastore/store-x/rrd?timeframe=day&cf=AVERAGE': rrd(t, 96, (i) => ({ used: (1100 + i) * GiB, total: 2000 * GiB })),
    '/nodes/localhost/tasks?limit=50': [
      { upid: `UPID:backup-x:0000A1B2:00C3D4E5:${(t - 7000).toString(16).toUpperCase()}:backup:store-x\\x3avm/502:backup@pbs!lab:`, worker_type: 'backup', worker_id: 'store-x:vm/502', user: 'backup@pbs!lab', starttime: t - 7000, endtime: t - 6900, status: 'unexpected EOF' }
    ],
    '/nodes/localhost/apt/update': [{ Package: 'proxmox-backup-server' }],
    '/nodes/localhost/network': [{ iface: 'eth0', address: '198.51.100.30' }]
  }
}
