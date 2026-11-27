// Places Orca hosts on the Proxmox estate. Pure, so tests drive it with plain data.
//
// In order, the first that applies wins:
//   1. manual: a link the person set in the panel (or "not on Proxmox");
//   2. via-ssh: a paired server runs where the SSH target its orcad was deployed over runs;
//   3. identified: a paired server's own addresses, then names (its endpoint's host, or what it
//      reported itself: orca/identify.ts), as below;
//   4. address: the host's name is an IP address one node or guest has;
//   5. name: the host's name is a node's, a single-node remote's, a guest's name or hostname.
// Only a unique match counts: a name or private address shared by two guests places nothing.
import type { Guest, Host, OrcaHost, OrcaMatch, ProxmoxRef } from '../model'

/** Manual links by Orca host key: `node:<remote/node>`, `guest:<remote/vmid>` or `none`. */
export type OrcaLinks = Record<string, string>

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/

function isAddress(name: string): boolean {
  return IPV4.test(name) || (name.includes(':') && /^[0-9a-f:]+$/i.test(name))
}

/** Lowercase, domain dropped (`pve1.example.com` -> `pve1`), unless it is an address. */
export function normalizeName(name: string): string {
  const lower = name.trim().toLowerCase()
  return isAddress(lower) ? lower : lower.split('.')[0]
}

/** Equal, or equal but for a plural `s` (`pve-backups` and `pve-backup`). */
function sameName(a: string, b: string): boolean {
  return a === b || `${a}s` === b || `${b}s` === a
}

export function parseLink(link: string | undefined): ProxmoxRef | 'none' | undefined {
  if (!link) return undefined
  if (link === 'none') return 'none'
  const match = /^(node|guest):(.+)$/.exec(link)
  return match ? { kind: match[1] as 'node' | 'guest', key: match[2] } : undefined
}

export function linkOf(ref: ProxmoxRef): string {
  return `${ref.kind}:${ref.key}`
}

function unique<T>(items: T[]): T | undefined {
  return items.length === 1 ? items[0] : undefined
}

export function placeOrcaHosts(
  orcaHosts: readonly OrcaHost[],
  estate: { hosts: readonly Host[]; guests: readonly Guest[] },
  links: OrcaLinks = {}
): OrcaHost[] {
  const nodes = estate.hosts.filter((h) => h.node && h.remoteType === 'pve')
  const allNodes = estate.hosts.filter((h) => h.node)
  const nodesPerRemote = new Map<string, number>()
  for (const n of nodes) nodesPerRemote.set(n.remote, (nodesPerRemote.get(n.remote) ?? 0) + 1)
  const exists = (ref: ProxmoxRef) =>
    ref.kind === 'node' ? allNodes.some((h) => h.key === ref.key) : estate.guests.some((g) => g.key === ref.key)

  const byName = (name: string): ProxmoxRef | undefined => {
    const wanted = normalizeName(name)
    const node = unique(
      nodes.filter(
        (n) =>
          sameName(normalizeName(n.node), wanted) || (nodesPerRemote.get(n.remote) === 1 && sameName(normalizeName(n.remote), wanted))
      )
    )
    if (node) return { kind: 'node', key: node.key }
    const guest = unique(
      estate.guests.filter((g) => normalizeName(g.name) === wanted || (g.hostname && normalizeName(g.hostname) === wanted))
    )
    return guest ? { kind: 'guest', key: guest.key } : undefined
  }

  const byAddress = (name: string): ProxmoxRef | undefined => {
    const address = name.trim().toLowerCase()
    if (!isAddress(address)) return undefined
    const node = unique(allNodes.filter((n) => n.addresses?.includes(address)))
    if (node) return { kind: 'node', key: node.key }
    const guest = unique(estate.guests.filter((g) => g.addresses?.includes(address)))
    return guest ? { kind: 'guest', key: guest.key } : undefined
  }

  const placed = new Map<string, OrcaHost>()
  const place = (host: OrcaHost): OrcaHost => {
    const out: OrcaHost = { ...host }
    delete out.runsOn
    delete out.match
    const set = (ref: ProxmoxRef | undefined, match: OrcaMatch) => {
      if (!ref || out.runsOn) return
      out.runsOn = ref
      out.match = match
    }
    // A link set on a paired server before it was merged into its SSH target still counts.
    const link = parseLink(links[host.key] ?? (host.paired ? links[host.paired.key] : undefined))
    if (link === 'none') {
      out.match = 'manual'
      return out
    }
    if (link && exists(link)) set(link, 'manual')
    if (host.viaSsh) {
      const via = placed.get(host.viaSsh)
      if (via?.runsOn) set(via.runsOn, 'via-ssh')
    }
    for (const address of host.identity?.addresses ?? []) set(byAddress(address), 'identified')
    for (const name of host.identity?.names ?? []) set(byAddress(name) ?? byName(name), 'identified')
    set(byAddress(host.name), 'address')
    set(byName(host.name), 'name')
    return out
  }
  // SSH targets first, so paired servers can follow the target they were deployed over.
  const order = [...orcaHosts].sort((a, b) => Number(a.kind === 'environment') - Number(b.kind === 'environment'))
  for (const host of order) placed.set(host.key, place(host))
  return orcaHosts.map((h) => placed.get(h.key)!)
}
