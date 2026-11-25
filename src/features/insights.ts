// Version drift, task labels, the status-bar line and the Markdown estate summary. Pure.
import type { EstateSnapshot, Host, Task } from '../model'
import { guestAddress, hostAddress } from './links'
import { isIpv6 } from './targets'
import { diskWarnings } from './capacity'

// ---- versions ----

function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0)
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d
  }
  return 0
}

export type Drift = { host: Host; version: string; newest: string }

/** Hosts running an older PVE (or PBS) version than the newest of their kind in the estate. */
export function versionDrift(hosts: readonly Host[]): Drift[] {
  const out: Drift[] = []
  for (const kind of ['pve', 'pbs'] as const) {
    const mine = hosts.filter((h) => h.remoteType === kind && h.version)
    const newest = mine.map((h) => h.version!).sort(compareVersions).pop()
    if (!newest) continue
    for (const h of mine) if (compareVersions(h.version!, newest) < 0) out.push({ host: h, version: h.version!, newest })
  }
  return out
}

// ---- tasks ----

const TASK_NAMES: Record<string, string> = {
  qmstart: 'VM start',
  qmstop: 'VM stop',
  qmshutdown: 'VM shutdown',
  qmreboot: 'VM reboot',
  qmcreate: 'VM create',
  qmdestroy: 'VM destroy',
  qmigrate: 'VM migrate',
  qmclone: 'VM clone',
  vzstart: 'CT start',
  vzstop: 'CT stop',
  vzshutdown: 'CT shutdown',
  vzreboot: 'CT reboot',
  vzcreate: 'CT create',
  vzdestroy: 'CT destroy',
  vzmigrate: 'CT migrate',
  vzdump: 'Backup',
  backup: 'PBS backup',
  verify: 'Verify',
  prune: 'Prune',
  garbage_collection: 'Garbage collection',
  sync: 'Sync',
  startall: 'Start all',
  stopall: 'Stop all',
  aptupdate: 'Package list update',
  vncshell: 'Shell',
  resize: 'Disk resize',
  imgcopy: 'Disk copy'
}

export function taskLabel(t: Task): string {
  return TASK_NAMES[t.type] ?? t.type
}

/** Backup tasks: PVE's vzdump and PBS's backup. */
export function isBackupTask(t: Task): boolean {
  return t.type === 'vzdump' || t.type === 'backup'
}

// ---- status-bar line ----

export type StatusLine = { text: string; tooltip: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }

/** `● 5/5 · 1 backup stale`, short enough for the status bar. */
export function statusLine(snap: EstateSnapshot | null, error?: string): StatusLine {
  if (!snap) return { text: error ? 'Proxmox: error' : 'Proxmox', tooltip: error ?? 'Not connected yet', tone: error ? 'danger' : 'neutral' }
  const up = snap.remotes.filter((r) => r.online).length
  const issues: string[] = []
  const stale = snap.guests.filter((g) => !g.template && g.backupState === 'stale').length
  const none = snap.guests.filter((g) => !g.template && g.backupState === 'none').length
  if (stale) issues.push(`${stale} backup${stale > 1 ? 's' : ''} stale`)
  if (none) issues.push(`${none} never backed up`)
  const failed = (snap.tasks ?? []).filter((t) => t.state === 'failed' && Date.now() - t.start < 86_400_000).length
  if (failed) issues.push(`${failed} failed task${failed > 1 ? 's' : ''}`)
  const disks = diskWarnings(snap).length
  if (disks) issues.push(`${disks} disk${disks > 1 ? 's' : ''} filling`)
  const down = snap.remotes.length - up
  const text = [`● ${up}/${snap.remotes.length}`, ...issues.slice(0, 1)].join(' · ')
  const tooltip = [`${up} of ${snap.remotes.length} remotes up`, ...issues].join('\n')
  return { text, tooltip, tone: down ? 'danger' : issues.length ? 'warning' : 'success' }
}

// ---- Markdown summary ----

const fmtBytes = (n: number | undefined) => (n === undefined ? '-' : n >= 1024 ** 4 ? `${(n / 1024 ** 4).toFixed(1)} TiB` : `${(n / 1024 ** 3).toFixed(1)} GiB`)
const pct = (f: number | undefined) => (f === undefined ? '-' : `${Math.round(f * 100)}%`)

/** What "Copy for AI" includes: everything, no endpoints, or no endpoints and no names. */
export type ExportMode = 'full' | 'no-addresses' | 'anonymized'

/**
 * Text from the estate (names, tags) as plain Markdown text: normalized, without control or
 * direction characters, one line, short, and with Markdown and HTML syntax escaped, so a name
 * cannot add markup or links. Its words still reach the agent as written: escaping does not stop
 * a name or tag from reading like an instruction.
 */
export function plainText(value: string, max = 80): string {
  const one = normalizeText(value)
  const cut = one.length > max ? `${one.slice(0, max - 1)}…` : one
  return cut.replace(/[\\`*_{}\[\]<>()#+!|~]/g, (c) => `\\${c}`)
}

/**
 * Text as it is compared and shown: NFKC (full-width digits and letters become plain ones),
 * dash- and dot-like characters as `-` and `.`, no control or direction characters, one line.
 * Filtering runs on this form, so a look-alike character cannot slip an address past it.
 */
export function normalizeText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\u2010-\u2015\u2212\ufe63\uff0d]/g, '-')
    .replace(/[\u00b7\u2022\u2027\u2219\u22c5\u30fb\uff65\u3002\uff61]/g, '.')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Also inside names (`backup-198-51-100-7`, `db_10.0-0_5`, `db10.0.0.5`): any separators, mixed too.
const IPV4_ANY = /(?<!\d)(?<!\d[-_.])(\d{1,3})[-_.](\d{1,3})[-_.](\d{1,3})[-_.](\d{1,3})(?![0-9]|[-_.]\d)/g
/**
 * Where an absolute file path starts: Unix (`/var`), home (`~/`), a Windows drive (`C:\\`,
 * `C:/`) or UNC (`\\\\server`). Paths may hold spaces, so everything from there to the end of
 * the field is taken as the path.
 */
const PATH_START = /(?<![\w.~:/\\-])(?:~[/\\]|\/(?=[\w.@%+=,~$-])|[A-Za-z]:[/\\]|\\\\(?=[\w.$-]))/
const IPV6_CANDIDATE = /(?<![\w:])\[?((?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}(?:%[\w.-]+)?)\]?(?![\w:])/g
const URL_ANY = /\b[a-z][a-z0-9+.-]*:\/\/[^\s|)]+/gi
const DNS_NAME = /(?<![\w.-])(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z][A-Za-z0-9-]{0,61}[A-Za-z0-9](?![\w-]|\.\w)/g

/** Every endpoint out of a text: URLs, IPv4 (in any separator form), IPv6 and DNS names. */
export function stripEndpoints(text: string): string {
  return text
    .replace(URL_ANY, '[url]')
    .replace(IPV6_CANDIDATE, (whole, ip: string) => (isIpv6(ip.split('%')[0]) ? '[address]' : whole))
    .replace(IPV4_ANY, (whole, a, b, c, d) => ([a, b, c, d].every((o) => Number(o) <= 255) ? '[address]' : whole))
    .replace(DNS_NAME, '[host]')
}

/**
 * A name or tag without endpoints or paths, best effort: normalized first, URLs out, then from
 * the start of an absolute path to the end of the field, then IP addresses and DNS names.
 */
export function stripValue(text: string): string {
  let out = normalizeText(text).replace(URL_ANY, '[url]')
  const path = PATH_START.exec(out)
  if (path) out = `${out.slice(0, path.index)}[path]`
  return stripEndpoints(out)
}

const STATUSES = new Set(['running', 'stopped', 'paused', 'suspended', 'prelaunch', 'online', 'offline', 'unknown', 'unreachable', 'available', 'active', 'inactive', 'disabled'])
/** A status as Proxmox names them, else `other`: a status is not free text. */
export function statusWord(value: string): string {
  return STATUSES.has(value) ? value : 'other'
}

/** Stable aliases: `remote-1`, `node-2`, `guest-3`, in the order first seen. */
function aliases() {
  const maps = new Map<string, Map<string, string>>()
  return (kind: string, value: string) => {
    const map = maps.get(kind) ?? new Map<string, string>()
    maps.set(kind, map)
    if (!map.has(value)) map.set(value, `${kind}-${map.size + 1}`)
    return map.get(value)!
  }
}

/**
 * A Markdown summary of the estate to paste into an agent: hosts, guests with state, tags and
 * (optionally) addresses, backups, warnings and where Orca runs. Never a server's error text.
 * `no-addresses` filters URLs, IP addresses, DNS names and paths out of names and tags, best
 * effort (a filter cannot recognize every way of writing them);
 * `anonymized` does that and replaces remote, node, guest, datastore and Orca names by aliases
 * and leaves tags out.
 */
export function estateMarkdown(snap: EstateSnapshot, opts: { mode?: ExportMode; includeIps?: boolean; now?: number }): string {
  const mode: ExportMode = opts.mode ?? (opts.includeIps === false ? 'no-addresses' : 'full')
  const full = mode === 'full'
  const anon = mode === 'anonymized'
  const now = opts.now ?? Date.now()
  const alias = aliases()
  /** A name or tag from the estate: in the reduced modes with endpoints and paths taken out first. */
  const text = (value: string, max = 80) => plainText(full ? value : stripValue(value), max)
  const name = (kind: string, value: string) => (anon ? alias(kind, value) : text(value))
  const remote = (id: string) => name('remote', id)
  const node = (r: string, n: string) => (anon ? alias('node', `${r}/${n}`) : text(n))
  const lines: string[] = ['# Proxmox estate', '']
  lines.push(`Snapshot from ${new Date(snap.fetchedAt).toISOString()}. Read-only view through Proxmox Datacenter Manager.`, '')
  if (!full) lines.push(anon ? 'Addresses, host names and other names are replaced by placeholders.' : 'Addresses, host names and paths are filtered out of names and tags, best effort.', '')
  lines.push('## Hosts', '', `| Host | Remote | Type | Status | CPU | RAM | Root disk | Version${full ? ' | Address' : ''} |`, `|---|---|---|---|---|---|---|---${full ? '|---' : ''}|`)
  for (const h of snap.hosts.filter((x) => x.node)) {
    lines.push(
      `| ${node(h.remote, h.node)} | ${remote(h.remote)} | ${h.remoteType.toUpperCase()} | ${statusWord(h.status)} | ${pct(h.cpu)} of ${h.maxcpu ?? '-'} cores | ${fmtBytes(h.mem)} / ${fmtBytes(h.maxmem)} | ${fmtBytes(h.disk)} / ${fmtBytes(h.maxdisk)} | ${h.version && /^[\d.-]{1,20}$/.test(h.version) ? h.version : '-'}${full ? ` | ${plainText(hostAddress(h) ?? '-', 60)}` : ''} |`
    )
  }
  // Only which remotes are down: their error text is the server's, so it stays out.
  const down = snap.remotes.filter((r) => !r.online)
  if (down.length) lines.push('', `Unreachable remotes: ${down.map((r) => remote(r.id)).join(', ')}.`)
  lines.push('', '## Guests', '', `| Guest | VMID | Kind | Host | Status | Tags | Last backup${full ? ' | Address' : ''} |`, `|---|---|---|---|---|---|---${full ? '|---' : ''}|`)
  for (const g of [...snap.guests].sort((a, b) => a.remote.localeCompare(b.remote) || a.vmid - b.vmid)) {
    const backup = g.template ? 'template' : g.lastBackup ? `${g.backupState}, ${Math.round((now - g.lastBackup) / 3_600_000)} h ago` : g.backupState
    const tags = anon ? '-' : g.tags.map((t) => text(t, 30)).join(', ') || '-'
    lines.push(
      `| ${anon ? alias('guest', g.key) : text(g.name)} | ${anon ? '-' : g.vmid} | ${g.type === 'qemu' ? 'VM' : 'CT'} | ${remote(g.remote)}/${node(g.remote, g.node)} | ${statusWord(g.status)} | ${tags} | ${backup}${full ? ` | ${plainText(guestAddress(g) ?? '-', 60)}` : ''} |`
    )
  }
  lines.push('', '## Backups', '')
  for (const d of snap.datastores) lines.push(`- Datastore ${anon ? alias('datastore', d.key) : text(d.name)} on ${remote(d.remote)}: ${pct(d.usage)} used (${fmtBytes(d.used)} of ${fmtBytes(d.total)}).`)
  lines.push(`- ${snap.backups.missing} guest(s) without a backup in the last ${snap.backups.staleHours} h.`)
  if (snap.backups.incomplete) lines.push('- Not every datastore could be read, so some guests have an unknown backup state.')
  const warnings = diskWarnings(snap)
  if (warnings.length && !anon) {
    lines.push('', '## Disk warnings', '')
    for (const w of warnings) lines.push(`- ${text(w.label, 120)}: ${pct(w.usage)} used${w.fullInDays !== undefined ? `, full in about ${Math.round(w.fullInDays)} days` : ''}.`)
  } else if (warnings.length) {
    lines.push('', '## Disk warnings', '', `- ${warnings.length} disk(s) or datastore(s) over their warning level.`)
  }
  const orca = snap.orca
  if (orca && orca.hosts.length) {
    lines.push('', '## Where Orca runs', '')
    for (const o of orca.hosts) {
      const place = o.runsOn ? (anon ? o.runsOn.kind : `${o.runsOn.kind} ${text(o.runsOn.key)}`) : 'not on Proxmox'
      const ws = orca.workspaces.filter((w) => w.hostKey === o.key).length
      const bots = orca.bots.filter((b) => b.hostKey === o.key).map((b) => (anon ? alias('bot', b.id) : text(b.name, 40)))
      const label = anon ? alias('orca', o.key) : `${text(o.name)}${o.paired ? ` (paired as ${text(o.paired.name)})` : ''}`
      lines.push(`- ${label}: ${place}; ${ws} workspace(s)${bots.length ? `; bots ${bots.join(', ')}` : ''}.`)
    }
  }
  const out = `${lines.join('\n')}\n`
  // Names can be endpoints too (a server paired by its IP or FQDN): none stay in when asked.
  return full ? out : stripEndpoints(out)
}
