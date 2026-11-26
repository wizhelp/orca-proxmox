// Building blocks the views share: chips, status dots, callouts, controls, the guest details card.
import { formatBytes, formatPercent, formatUptime, formatUsage, type EstateSnapshot, type Guest, type SourceError } from '../model'
import { presenceLabel, type OrcaPresence } from '../presence'
import { lastValue, meter, sparkline } from './charts'
import { guestActions } from './actions'
import { GUEST_DISK_LIMIT } from '../features/capacity'
import { h, type Child } from './dom'
import { icon, type IconName } from './icons'
import { ago, BACKUP_LABEL, BACKUP_TONE, diskShare, diskUnknownText, guestKind, guestName, orcaHostLabel, orcaKindLabel, orcaTone, statusTone, type Tone } from './logic'

export function dot(tone: Tone, label?: string): HTMLElement {
  return h('span', { class: `dot ${tone}`, title: label, 'aria-hidden': label ? undefined : 'true' })
}

export function chip(text: string, tone: Tone | 'plain' = 'plain', iconName?: IconName, title?: string): HTMLElement {
  return h('span', { class: `chip ${tone}`, title }, iconName ? icon(iconName, 12) : null, text)
}

export function callout(tone: Tone, title: string, ...body: Child[]): HTMLElement {
  return h(
    'div',
    { class: `callout ${tone}`, role: tone === 'bad' ? 'alert' : 'status' },
    icon(tone === 'ok' ? 'check' : 'alert', 16, 'icon callout-icon'),
    h('div', { class: 'callout-body' }, h('div', { class: 'callout-title' }, title), body)
  )
}

export function button(
  label: string,
  onClick: () => void,
  opts: { icon?: IconName; variant?: 'primary' | 'ghost' | 'danger' | 'plain'; disabled?: boolean; title?: string; id?: string; iconOnly?: boolean } = {}
): HTMLButtonElement {
  return h(
    'button',
    {
      type: 'button',
      id: opts.id,
      class: `btn ${opts.variant ?? 'plain'}${opts.iconOnly ? ' icon-only' : ''}`,
      disabled: opts.disabled,
      title: opts.title ?? (opts.iconOnly ? label : undefined),
      'aria-label': opts.iconOnly ? label : undefined,
      onClick: () => onClick()
    },
    opts.icon ? icon(opts.icon, 14) : null,
    opts.iconOnly ? null : label
  )
}

export function select(
  id: string,
  label: string,
  value: string,
  options: { value: string; label: string }[],
  onChange: (value: string) => void,
  hideLabel = true
): HTMLElement {
  const control = h(
    'select',
    { id, class: 'select', onChange: (e: Event) => onChange((e.target as HTMLSelectElement).value), 'aria-label': hideLabel ? label : undefined },
    options.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label))
  )
  return hideLabel ? control : h('label', { class: 'field-inline' }, h('span', { class: 'muted' }, label), control)
}

/** Two-way switch between options, e.g. Cards | Tree. */
export function segmented(label: string, value: string, options: { value: string; label: string; icon?: IconName }[], onChange: (v: string) => void): HTMLElement {
  return h(
    'div',
    { class: 'segmented', role: 'radiogroup', 'aria-label': label },
    options.map((o) =>
      h(
        'button',
        {
          type: 'button',
          role: 'radio',
          'aria-checked': String(o.value === value),
          class: o.value === value ? 'on' : '',
          onClick: () => onChange(o.value)
        },
        o.icon ? icon(o.icon, 13) : null,
        o.label
      )
    )
  )
}

export function emptyState(iconName: IconName, title: string, description?: string, action?: HTMLElement): HTMLElement {
  return h('div', { class: 'empty' }, icon(iconName, 28, 'icon empty-icon'), h('div', { class: 'empty-title' }, title), description ? h('div', { class: 'muted' }, description) : null, action)
}

export function keyValue(items: [string, Child][]): HTMLElement {
  return h('dl', { class: 'kv' }, items.map(([k, v]) => [h('dt', null, k), h('dd', null, v)]))
}

export const ERROR_TITLES: Record<SourceError['kind'], string> = {
  'not-configured': 'Not set up yet',
  'invalid-config': 'The connection settings are invalid',
  'secrets-unavailable': 'Secrets cannot be stored on this machine',
  unreachable: 'Proxmox Datacenter Manager is unreachable',
  timeout: 'Proxmox Datacenter Manager did not answer in time',
  tls: 'The server certificate is not trusted',
  'fingerprint-mismatch': 'The certificate does not match the pinned fingerprint',
  auth: 'The API token was rejected',
  forbidden: 'The API token lacks permission',
  http: 'Proxmox Datacenter Manager answered with an error',
  protocol: 'Unexpected answer from the server'
}

export function errorCallout(error: SourceError, actions: { pin: (fp: string) => void; openSettings: () => void }): HTMLElement {
  return callout(
    error.kind === 'not-configured' ? 'warn' : 'bad',
    ERROR_TITLES[error.kind],
    h('div', null, error.message),
    error.hint ? h('div', { class: 'muted' }, error.hint) : null,
    error.presentedFingerprint
      ? h(
          'div',
          { class: 'stack-sm' },
          h('div', null, 'The server presented:'),
          h('code', { class: 'block' }, error.presentedFingerprint),
          button('Review and pin this fingerprint', () => actions.pin(error.presentedFingerprint!), { icon: 'check' })
        )
      : null,
    error.kind === 'auth' || error.kind === 'forbidden' || error.kind === 'not-configured'
      ? button('Open settings', actions.openSettings, { icon: 'settings', variant: 'ghost' })
      : null
  )
}

/** CPU, memory and network over the last hour, larger, with the current values. */
export function metricsBlock(metrics: Guest['metrics'], current: { cpu?: number; mem?: number; maxmem?: number; maxcpu?: number }): HTMLElement {
  const cpuNow = current.cpu ?? lastValue(metrics?.cpu)
  const memShare = current.maxmem ? (current.mem ?? 0) / current.maxmem : lastValue(metrics?.mem)
  const netNow = lastValue(metrics?.net)
  const row = (label: string, chart: Element, value: string) => h('div', { class: 'metric' }, h('span', { class: 'metric-label' }, label), chart, h('span', { class: 'metric-value' }, value))
  return h(
    'div',
    { class: 'metrics' },
    row('CPU', sparkline(metrics?.cpu, { label: `CPU over the last hour, now ${formatPercent(cpuNow)}`, tone: 'cpu', width: 140, height: 26 }), `${formatPercent(cpuNow)}${current.maxcpu ? ` of ${current.maxcpu}` : ''}`),
    row('RAM', sparkline(metrics?.mem, { label: `Memory over the last hour, now ${formatPercent(memShare)}`, tone: 'mem', width: 140, height: 26 }), current.maxmem ? formatUsage(current.mem, current.maxmem) : formatPercent(memShare)),
    row('Net', sparkline(metrics?.net, { label: `Network over the last hour, now ${formatBytes(netNow)}/s`, tone: 'net', width: 140, height: 26 }), netNow === undefined ? '-' : `${formatBytes(netNow)}/s`)
  )
}

export function guestDetails(guest: Guest, snap: EstateSnapshot, presence: OrcaPresence | undefined, now: number): HTMLElement {
  const state = guest.backupState
  return h(
    'div',
    { class: 'details' },
    h(
      'div',
      { class: 'details-head' },
      icon(guest.type === 'qemu' ? 'monitor' : 'box', 16),
      h('strong', null, `${guestKind(guest)} ${guestName(guest)}`),
      chip(guest.status, statusTone(guest.status)),
      guest.template ? chip('template') : null
    ),
    guestActions(snap, guest, presence),
    guest.tags.length ? h('div', { class: 'chips' }, guest.tags.map((t) => chip(t, 'plain', 'tag'))) : null,
    guest.notes ? h('div', { class: 'notes', title: 'Proxmox notes' }, icon('note', 13), h('span', null, guest.notes)) : null,
    guest.status === 'running' ? metricsBlock(guest.metrics, guest) : null,
    (diskShare(guest) ?? 0) > GUEST_DISK_LIMIT ? h('div', { class: 'warn-text' }, `Disk ${formatPercent(diskShare(guest)!)} full.`) : null,
    keyValue([
      ['Host', `${guest.remote}/${guest.node}`],
      [
        'Disk',
        guest.diskUsage
          ? `${formatUsage(guest.diskUsage.used, guest.diskUsage.total)}${guest.diskUsage.from === 'agent' ? ` (guest agent; ${formatBytes(guest.maxdisk)} allocated)` : ''}${guest.diskUsage.asOf !== undefined ? `, last measured ${ago(guest.diskUsage.asOf, now)} while running` : ''}`
          : `${formatBytes(guest.maxdisk)} allocated; use ${diskUnknownText(guest)}`
      ],
      ['Uptime', formatUptime(guest.uptime)],
      ...(guest.hostname ? ([['Hostname', guest.hostname]] as [string, Child][]) : []),
      ...(guest.addresses?.length ? ([['Addresses', h('code', null, guest.addresses.join(', '))]] as [string, Child][]) : []),
      [
        'Backup',
        h(
          'span',
          null,
          chip(BACKUP_LABEL[state], BACKUP_TONE[state]),
          guest.lastBackup ? ` ${ago(guest.lastBackup, now)}` : '',
          guest.lastBackupWhere ? h('span', { class: 'muted' }, ` · ${guest.lastBackupWhere}`) : ''
        )
      ]
    ]),
    state === 'stale' ? h('div', { class: 'warn-text' }, `Older than ${snap.backups.staleHours} h.`) : null,
    state === 'none' && !guest.template ? h('div', { class: 'bad-text' }, 'No backup found on any visible PBS datastore.') : null,
    guest.backupAmbiguous
      ? h('div', { class: 'muted' }, `Another remote has a guest with VMID ${guest.vmid}, so this backup may be theirs. Keep each cluster's backups in a PBS namespace or owner named after its PDM remote.`)
      : null,
    presence
      ? h(
          'div',
          { class: 'stack-sm' },
          h('div', { class: 'chips' }, chip(presenceLabel(presence), presence.working ? 'info' : 'plain', 'bot'), presence.hosts.map((o) => chip(`${orcaKindLabel(o)} ${orcaHostLabel(o)}`))),
          presence.workspaces.map((w) =>
            h('div', { class: 'ws-line' }, dot(orcaTone(w.status)), h('span', null, w.name), h('span', { class: 'muted' }, ` ${w.status}${w.agents.length ? ` · ${w.agents.map((a) => `${a.agent} ${a.state}`).join(', ')}` : ''}`))
          )
        )
      : null
  )
}

export { meter }
