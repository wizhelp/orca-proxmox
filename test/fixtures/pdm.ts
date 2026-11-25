// Recorded-style PDM answers for tests and `orca plugin check`: the shapes PDM serializes, with
// times relative to `now` so a backup is "2 h old" whenever the fixture is built. No test talks
// to a real server: `mockTransport` answers from this table and records what was asked.
import type { HttpRequest, HttpResponse, Transport } from '../../src/proxmox/http'

const GiB = 1024 ** 3
const TiB = 1024 ** 4

type Route = unknown | { status: number; body: string; contentType?: string }

const raw = (status: number, body: string, contentType = 'text/plain'): Route => ({ status, body, contentType })

function guest(
  type: 'pve-qemu' | 'pve-lxc',
  remote: string,
  node: string,
  vmid: number,
  name: string,
  status: 'running' | 'stopped',
  extra: Record<string, unknown> = {}
) {
  const running = status === 'running'
  return {
    type,
    id: `remote/${remote}/guest/${vmid}`,
    vmid,
    name,
    node,
    status,
    cpu: running ? 0.12 : 0,
    maxcpu: 4,
    mem: running ? 3.1 * GiB : 0,
    maxmem: 8 * GiB,
    disk: type === 'pve-lxc' ? 6.4 * GiB : 0,
    maxdisk: 32 * GiB,
    uptime: running ? 864000 : 0,
    template: false,
    tags: [],
    pool: '',
    ...extra
  }
}

/** Every route the PDM source calls, keyed by path and query after `/api2/json`. */
export function pdmRoutes(now: number): Record<string, Route> {
  const ago = (hours: number) => Math.floor((now - hours * 3600 * 1000) / 1000)
  const snap = (type: string, id: string, hoursAgo: number) => ({
    'backup-type': type,
    'backup-id': id,
    'backup-time': ago(hoursAgo),
    size: 12 * GiB,
    protected: false
  })
  return {
    '/version': { version: '1.0', release: '2', repoid: 'abcdef12' },
    '/remotes/remote': [
      { type: 'pve', id: 'pve-fsn', authid: 'pdm@pve!pdm', token: '', nodes: ['hostname=10.0.0.11'] },
      { type: 'pve', id: 'pve-hel', authid: 'pdm@pve!pdm', token: '', nodes: ['hostname=10.0.1.11'] },
      { type: 'pve', id: 'pve-lab', authid: 'pdm@pve!pdm', token: '', nodes: ['hostname=192.168.7.2'] },
      { type: 'pbs', id: 'pbs-main', authid: 'pdm@pbs!pdm', token: '', nodes: ['hostname=10.0.0.50'] }
    ],
    '/resources/list?max-age=30': [
      {
        remote: 'pve-fsn',
        resources: [
          { type: 'pve-node', id: 'remote/pve-fsn/node/fsn-pve1', node: 'fsn-pve1', status: 'online', cpu: 0.23, maxcpu: 32, mem: 98 * GiB, maxmem: 256 * GiB, uptime: 3456000, level: '', 'cgroup-mode': 2 },
          { type: 'pve-node', id: 'remote/pve-fsn/node/fsn-pve2', node: 'fsn-pve2', status: 'online', cpu: 0.61, maxcpu: 32, mem: 201 * GiB, maxmem: 256 * GiB, uptime: 1209600, level: '', 'cgroup-mode': 2 },
          guest('pve-qemu', 'pve-fsn', 'fsn-pve1', 100, 'web-01', 'running', { tags: ['prod', 'web'] }),
          guest('pve-qemu', 'pve-fsn', 'fsn-pve1', 101, 'db-01', 'running', { cpu: 0.71, mem: 7.2 * GiB, tags: ['prod'] }),
          guest('pve-lxc', 'pve-fsn', 'fsn-pve2', 102, 'mail', 'running'),
          guest('pve-qemu', 'pve-fsn', 'fsn-pve2', 103, 'build-runner', 'stopped'),
          guest('pve-qemu', 'pve-fsn', 'fsn-pve2', 9000, 'debian-12-template', 'stopped', { template: true }),
          { type: 'pve-storage', id: 'remote/pve-fsn/storage/fsn-pve1/local', storage: 'local', node: 'fsn-pve1', status: 'available', disk: 10 * GiB, maxdisk: 100 * GiB, shared: false }
        ]
      },
      {
        remote: 'pve-hel',
        resources: [
          { type: 'pve-node', id: 'remote/pve-hel/node/hel-pve1', node: 'hel-pve1', status: 'online', cpu: 0.08, maxcpu: 16, mem: 40 * GiB, maxmem: 128 * GiB, uptime: 86400 * 41, level: '', 'cgroup-mode': 2 },
          guest('pve-qemu', 'pve-hel', 'hel-pve1', 100, 'hel-web', 'running'),
          guest('pve-lxc', 'pve-hel', 'hel-pve1', 200, 'monitoring', 'running', { tags: 'infra;metrics' })
        ]
      },
      { remote: 'pve-lab', error: 'error connecting to https://192.168.7.2:8006/ - tcp connect error: deadline has elapsed' },
      {
        remote: 'pbs-main',
        resources: [
          { type: 'pbs-node', id: 'remote/pbs-main/node/localhost', name: 'pbs-main', cpu: 0.04, maxcpu: 8, mem: 12 * GiB, maxmem: 64 * GiB, uptime: 86400 * 90 },
          { type: 'pbs-datastore', id: 'remote/pbs-main/datastore/store1', name: 'store1', disk: 7.1 * TiB, maxdisk: 10 * TiB, usage: 0.71 },
          { type: 'pbs-datastore', id: 'remote/pbs-main/datastore/offsite', name: 'offsite', disk: 1.8 * TiB, maxdisk: 2 * TiB, usage: 0.9 }
        ]
      }
    ],
    '/pve/remotes/pve-fsn/nodes/fsn-pve1/status': {
      pveversion: 'pve-manager/8.3.2/3e76eec21c4a14a7',
      kversion: 'Linux 6.8.12-5-pve',
      uptime: 3456100,
      cpu: 0.23,
      memory: { total: 256 * GiB, used: 98 * GiB, free: 158 * GiB },
      rootfs: { total: 94 * GiB, used: 21 * GiB, avail: 73 * GiB, free: 73 * GiB }
    },
    '/pve/remotes/pve-fsn/nodes/fsn-pve2/status': {
      pveversion: 'pve-manager/8.3.2/3e76eec21c4a14a7',
      uptime: 1209700,
      memory: { total: 256 * GiB, used: 201 * GiB, free: 55 * GiB },
      rootfs: { total: 94 * GiB, used: 88 * GiB, avail: 6 * GiB, free: 6 * GiB }
    },
    '/pve/remotes/pve-hel/nodes/hel-pve1/status': raw(
      500,
      JSON.stringify({ data: null, message: 'proxy loop detected' }),
      'application/json'
    ),
    '/remotes/remote/pbs-main/version': { version: '3.3', release: '2', repoid: '0123abcd' },
    '/pbs/remotes/pbs-main/status': {
      uptime: 86400 * 90,
      memory: { total: 64 * GiB, used: 12 * GiB, free: 52 * GiB },
      root: { total: 60 * GiB, used: 9 * GiB, avail: 51 * GiB }
    },
    '/pbs/remotes/pbs-main/datastore/store1/namespaces': [{ ns: '' }, { ns: 'pve-fsn' }, { ns: 'pve-hel' }],
    '/pbs/remotes/pbs-main/datastore/store1/snapshots': [],
    '/pbs/remotes/pbs-main/datastore/store1/snapshots?ns=pve-fsn': [
      snap('vm', '100', 2),
      snap('vm', '100', 26),
      snap('vm', '101', 3),
      snap('ct', '102', 5)
    ],
    '/pbs/remotes/pbs-main/datastore/store1/snapshots?ns=pve-hel': [snap('vm', '100', 4), snap('ct', '200', 40)],
    '/pbs/remotes/pbs-main/datastore/offsite/namespaces': [{ ns: '' }],
    // A streaming endpoint may answer a JSON text sequence instead of { data }.
    '/pbs/remotes/pbs-main/datastore/offsite/snapshots': raw(
      200,
      `\x1e${JSON.stringify(snap('vm', '101', 30))}\n\x1e${JSON.stringify(snap('host', 'pbs-main', 12))}\n`,
      'application/json-seq'
    )
  }
}

export type MockTransport = Transport & { requests: HttpRequest[] }

/** Answers from `routes`; an unknown route is a 404, as PDM would answer. */
export function mockTransport(routes: Record<string, Route>): MockTransport {
  const requests: HttpRequest[] = []
  const transport = (async (request: HttpRequest): Promise<HttpResponse> => {
    requests.push(request)
    const key = `${request.url.pathname.replace(/^\/api2\/json/, '')}${request.url.search}`
    if (!(key in routes)) return { status: 404, contentType: 'application/json', body: '{"data":null,"message":"Not found"}' }
    const route = routes[key]
    if (route && typeof route === 'object' && 'status' in route && 'body' in route) {
      const r = route as { status: number; body: string; contentType?: string }
      return { status: r.status, contentType: r.contentType ?? 'application/json', body: r.body }
    }
    return { status: 200, contentType: 'application/json;charset=UTF-8', body: JSON.stringify({ data: route }) }
  }) as MockTransport
  transport.requests = requests
  return transport
}
