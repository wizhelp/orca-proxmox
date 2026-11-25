// Example answers layered on the recorded estate (test/fixtures/recorded-pdm-renamed.ts) for what
// the recording lacks: a task list, PDM update summaries, notes and a remote web URL. Shapes as PDM
// serializes them; all names, ids and addresses are examples.
import { renamedRoutes } from './recorded-pdm-renamed'

const HOUR = 3600

/** One PDM task entry; `upid` carries the remote as `<type>:<remote>!UPID:…`. */
function task(remote: string, node: string, type: string, id: string, ago: number, took: number, status: string | null, kind = 'pve', user = 'root@pam') {
  const start = ago
  const upid =
    kind === 'pbs'
      ? `pbs:${remote}!UPID:${node}:000003EB:000001E9:00000016:${start.toString(16).toUpperCase()}:${type}:${id.replace(/:/g, '\\x3a')}:${user}:`
      : `pve:${remote}!UPID:${node}:00001528:00000F7E:${start.toString(16).toUpperCase()}:${type}:${id}:${user}:`
  return {
    upid,
    node,
    pid: 5416,
    pstart: 3966,
    starttime: start,
    ...(status === null ? {} : { endtime: start + took, status }),
    user,
    worker_type: type,
    worker_id: kind === 'pbs' ? id : null
  }
}

/** The extra routes, with times relative to `now` (epoch ms). */
export function exampleExtras(now: number): Record<string, unknown> {
  const t = Math.floor(now / 1000)
  const remotes = (renamedRoutes['/remotes/remote'] as { id: string }[]).map((r) =>
    r.id === 'pve-b' ? { ...r, 'web-url': 'https://pve-b.example.com:8006' } : r
  )
  const config = (path: string, notes: string) => ({ ...(renamedRoutes[path] as object), description: notes })
  const TAGS: Record<string, string[]> = {
    'pve-a/320': ['infra', 'pdm'],
    'pve-a/430': ['automation'],
    'pve-a/431': ['automation'],
    'pve-b/332': ['prod', 'web'],
    'pve-b/350': ['appliance', 'network'],
    'pve-b/351': ['appliance']
  }
  type Entry = { remote: string; resources?: { type: string; vmid?: number; tags?: unknown }[] }
  const resources = (renamedRoutes['/resources/list?max-age=30'] as Entry[]).map((entry) => ({
    ...entry,
    resources: entry.resources?.map((r) => (r.vmid !== undefined && TAGS[`${entry.remote}/${r.vmid}`] ? { ...r, tags: TAGS[`${entry.remote}/${r.vmid}`] } : r))
  }))
  return {
    '/resources/list?max-age=30': resources,
    '/remotes/remote': remotes,
    '/remotes/tasks/list': [
      task('pve-a', 'pve-a', 'qmstart', '314', t - 120, 3, null),
      task('pve-b', 'pve-b', 'vzdump', '332', t - 2 * HOUR, 610, 'job errors'),
      task('pve-backup-pbs', 'localhost', 'backup', 'main:vm/332', t - 2 * HOUR, 600, 'unexpected EOF', 'pbs', 'beta@pbs!pve'),
      task('pve-backup-pbs', 'localhost', 'backup', 'main:vm/411', t - 3 * HOUR, 95, 'OK', 'pbs', 'delta@pbs!pve'),
      task('pve-lab', 'pve-lab', 'vzdump', '411', t - 3 * HOUR, 310, 'OK'),
      task('pve-a', 'pve-a', 'vzshutdown', '431', t - 5 * HOUR, 12, 'OK'),
      task('pve-a', 'pve-a', 'vzstart', '431', t - 5 * HOUR + 30, 4, 'WARNINGS: 1'),
      task('pve-b', 'pve-b', 'aptupdate', '', t - 8 * HOUR, 40, 'OK')
    ],
    '/pve/remotes/pve-a/updates': {
      'remote-type': 'pve',
      status: 'success',
      nodes: { 'pve-a': { 'number-of-updates': 12, 'last-refresh': t - 6 * HOUR, status: 'success', versions: [] } }
    },
    '/pve/remotes/pve-b/updates': { 'remote-type': 'pve', status: 'success', nodes: { 'pve-b': { 'number-of-updates': 0, 'last-refresh': t - 6 * HOUR, status: 'success' } } },
    '/pve/remotes/pve-backup/updates': { 'remote-type': 'pve', status: 'unknown', nodes: {} },
    '/pve/remotes/pve-lab/updates': { 'remote-type': 'pve', status: 'unknown', nodes: {} },
    '/pve/remotes/pve-a/nodes/pve-a/config': { description: 'Main node. Runs the PDM VM and the automation containers.' },
    '/pve/remotes/pve-a/qemu/320/config?state=active': config('/pve/remotes/pve-a/qemu/320/config?state=active', 'Proxmox Datacenter Manager.\nBack up before upgrades.'),
    '/pve/remotes/pve-b/qemu/332/config?state=active': config('/pve/remotes/pve-b/qemu/332/config?state=active', 'Production web app. Owner: web team.')
  }
}

/** The recorded estate with the example extras on top. */
export function exampleRoutes(now: number): Record<string, unknown> {
  return { ...renamedRoutes, ...exampleExtras(now) }
}
