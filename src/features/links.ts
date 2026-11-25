// Deep links into PDM and the Proxmox web interfaces, and ready-to-paste ssh commands. Pure.
// Addresses come from PDM, so only strictly valid IPs and DNS names are used (see targets.ts).
import type { Datastore, EstateSnapshot, Guest, Host, Remote } from '../model'
import { isHostname, isIpv4, isIpv6, isUser, safeTarget } from './targets'

/** RFC 1918, loopback, link-local and CGNAT: addresses a laptop usually cannot reach directly. */
export function isPrivate(ip: string): boolean {
  if (!isIpv4(ip)) return /^fe80:/i.test(ip) || /^f[cd]/i.test(ip) || ip === '::1'
  const [a, b] = ip.split('.').map(Number)
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)
}

/** The address to reach a node from outside: a public one if it has one, else its first. */
export function hostAddress(host: Host): string | undefined {
  const all = (host.addresses ?? []).filter((a) => safeTarget(a) === a)
  return all.find((a) => isIpv4(a) && !isPrivate(a)) ?? all.find((a) => isIpv4(a)) ?? all[0]
}

export function guestAddress(guest: Guest): string | undefined {
  const all = (guest.addresses ?? []).filter((a) => safeTarget(a) === a)
  return all.find((a) => isIpv4(a)) ?? all[0]
}

/**
 * The ssh arguments for a target: each one only letters, digits and `_.:@-`, none starting with
 * `-` but the `-J` flag itself, so the joined text means the same in any shell it is typed into.
 */
export function sshArgs(user: string, target: string, jump?: string): string[] | undefined {
  if (!isUser(user) || safeTarget(target) !== target) return undefined
  const args = ['ssh']
  // ssh -J takes [user@]host[:port], so an IPv6 jump host would need brackets: not offered.
  if (jump && safeTarget(jump) === jump && (isIpv4(jump) || isHostname(jump))) args.push('-J', `${user}@${jump}`)
  args.push(`${user}@${target}`)
  return args.every((a, i) => /^[A-Za-z0-9_.:@-]+$/.test(a) && (!a.startsWith('-') || (a === '-J' && i === 1))) ? args : undefined
}

/**
 * An ssh command for a guest. A guest on a private address behind a node with a public one is
 * reached through that node as a jump host.
 */
export function guestSsh(guest: Guest, host: Host | undefined, user = 'root'): string | undefined {
  const ip = guestAddress(guest)
  if (!ip) return undefined
  const jump = host ? hostAddress(host) : undefined
  return sshArgs(user, ip, isPrivate(ip) && jump && !isPrivate(jump) ? jump : undefined)?.join(' ')
}

export function hostSsh(host: Host, user = 'root'): string | undefined {
  const ip = hostAddress(host)
  return ip ? sshArgs(user, ip)?.join(' ') : undefined
}

/** True only for text sshArgs builds: checked again right before it is typed into a shell. */
export function isSafeSshCommand(text: string): boolean {
  const parts = text.split(' ')
  const jumped = parts[1] === '-J'
  if (parts[0] !== 'ssh' || parts.length !== (jumped ? 4 : 2)) return false
  const at = (part: string): [string, string] => [part.slice(0, part.indexOf('@')), part.slice(part.indexOf('@') + 1)]
  const [user, target] = at(parts[parts.length - 1])
  const jump = jumped ? at(parts[2]) : undefined
  if (jump && jump[0] !== user) return false
  return sshArgs(user, target, jump?.[1])?.join(' ') === text
}

// ---- PDM ----

/** The PDM page of a remote, node, guest or datastore (PDM routes by URL hash). */
export function pdmLink(pdmUrl: string | undefined, remote: string, target?: { node?: string; vmid?: number; datastore?: string }): string | undefined {
  if (!pdmUrl) return undefined
  const base = `${pdmUrl.replace(/\/+$/, '')}/#/remote-${encodeURIComponent(remote)}/`
  if (target?.vmid !== undefined) return `${base}guest+${target.vmid}`
  if (target?.datastore) return `${base}${encodeURIComponent(target.datastore)}`
  if (target?.node) return `${base}node+${encodeURIComponent(target.node)}`
  return base
}

// ---- Proxmox VE / PBS web interfaces ----

/** An http(s) URL without credentials, as origin and path; else undefined. */
export function httpsBase(raw: string): string | undefined {
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return undefined
    return `${url.origin}${url.pathname}`.replace(/\/+$/, '')
  } catch {
    return undefined
  }
}

const hostPort = (address: string, port: number) => `https://${isIpv6(address) ? `[${address}]` : address}:${port}`

/**
 * The remote's own web interface: its PDM `web-url` when set, else a node's public address, else
 * the address PDM uses (which may be internal). Same choice as PDM's own "Open Web UI".
 */
export function webBase(remote: Remote, host?: Host): string | undefined {
  const port = remote.type === 'pbs' ? 8007 : 8006
  const nodePort = Number.isInteger(remote.nodePort) && remote.nodePort! > 0 && remote.nodePort! < 65536 ? remote.nodePort! : port
  const web = remote.webUrl ? httpsBase(remote.webUrl) : undefined
  if (web) return web
  const pub = host ? hostAddress(host) : undefined
  if (pub && !isPrivate(pub)) return hostPort(pub, port)
  const node = remote.nodeAddress ? safeTarget(remote.nodeAddress) : undefined
  if (node) return hostPort(node, nodePort)
  return pub ? hostPort(pub, port) : undefined
}

export function proxmoxLink(snap: EstateSnapshot, target: { guest?: Guest; host?: Host; datastore?: Datastore }): string | undefined {
  const remoteId = target.guest?.remote ?? target.host?.remote ?? target.datastore?.remote
  const remote = snap.remotes.find((r) => r.id === remoteId)
  if (!remote) return undefined
  const host = target.host ?? snap.hosts.find((h) => h.remote === remote.id && (!target.guest || h.node === target.guest.node))
  const base = webBase(remote, host)
  if (!base) return undefined
  if (target.guest) return `${base}/#v1::=${target.guest.type}/${target.guest.vmid}`
  if (target.datastore) return `${base}/#DataStore-${encodeURIComponent(target.datastore.name)}`
  if (target.host && remote.type === 'pve') return `${base}/#v1::=node/${encodeURIComponent(target.host.node)}`
  return `${base}/`
}

/** The guest's console in the Proxmox web interface (noVNC for VMs, xterm.js for containers). */
export function consoleLink(snap: EstateSnapshot, guest: Guest): string | undefined {
  const remote = snap.remotes.find((r) => r.id === guest.remote)
  if (!remote || remote.type !== 'pve') return undefined
  const base = webBase(remote, snap.hosts.find((h) => h.remote === guest.remote && h.node === guest.node))
  if (!base) return undefined
  const kind = guest.type === 'qemu' ? 'console=kvm&novnc=1' : 'console=lxc&xtermjs=1'
  return `${base}/?${kind}&vmid=${guest.vmid}&vmname=${encodeURIComponent(guest.name)}&node=${encodeURIComponent(guest.node)}&resize=off&cmd=`
}
