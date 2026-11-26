// Guests: search, filters, a sortable table with a CPU sparkline and memory bar per row, details
// below the row it belongs to.
import { formatBytes, formatPercent, formatUptime, type EstateSnapshot, type Guest } from '../model'
import { GUEST_DISK_LIMIT } from '../features/capacity'
import { guestRef, orcaByPlace } from '../presence'
import { actions, app, KEYS } from './app'
import { meter, sparkline } from './charts'
import { cx, h } from './dom'
import { icon } from './icons'
import { allTags, BACKUP_LABEL, BACKUP_TONE, diskShare, diskUnknownText, filterGuests, guestKind, guestName, nextSort, placeOptions, sortGuests, statusTone, type GuestSort } from './logic'
import { chip, dot, guestDetails, select } from './parts'

const COLUMNS: { key: GuestSort['column']; label: string; className?: string }[] = [
  { key: 'name', label: 'Guest' },
  { key: 'status', label: 'Status', className: 'col-status' },
  { key: 'cpu', label: 'CPU' },
  { key: 'mem', label: 'RAM', className: 'col-mem' },
  { key: 'disk', label: 'Disk', className: 'col-disk' },
  { key: 'uptime', label: 'Uptime', className: 'col-uptime' },
  { key: 'node', label: 'Host', className: 'col-host' },
  { key: 'backup', label: 'Backup' }
]

/** Used / size with a bar where use is known; else the allocated size and why use is unknown. */
function diskCell(g: Guest): HTMLElement {
  const share = diskShare(g)
  if (share === undefined) {
    return h('td', { class: 'col-disk cell-disk muted', title: `${formatBytes(g.maxdisk)} allocated; use ${diskUnknownText(g)}` }, h('span', null, `${formatBytes(g.maxdisk)}`), h('span', { class: 'small' }, ' ?'))
  }
  const used = g.type === 'lxc' ? g.disk : g.diskUsage!.used
  const total = g.type === 'lxc' ? g.maxdisk : g.diskUsage!.total
  return h(
    'td',
    { class: cx('col-disk cell-disk', share > GUEST_DISK_LIMIT && 'warn-text'), title: `${formatBytes(used)} of ${formatBytes(total)} used${g.type === 'qemu' ? ' (guest agent)' : ''}` },
    meter(share, `Disk ${formatPercent(share)}`, 40),
    h('span', null, formatPercent(share))
  )
}

function setFilter(patch: Partial<typeof app.guestFilter>): void {
  app.guestFilter = { ...app.guestFilter, ...patch }
  actions.render()
}

export function guestsView(snap: EstateSnapshot): HTMLElement {
  const f = app.guestFilter
  const places = orcaByPlace(snap.orca)
  const filtered = sortGuests(filterGuests(snap.guests, f), app.guestSort)
  const running = snap.guests.filter((g) => g.status === 'running').length
  const now = Date.now()

  const header = h(
    'tr',
    null,
    COLUMNS.map((c) => {
      const active = app.guestSort.column === c.key
      return h(
        'th',
        { class: c.className, 'aria-sort': active ? (app.guestSort.direction === 'asc' ? 'ascending' : 'descending') : 'none', scope: 'col' },
        h(
          'button',
          {
            type: 'button',
            class: cx('th-btn', active && 'active'),
            onClick: () => {
              app.guestSort = nextSort(app.guestSort, c.key)
              actions.remember(KEYS.guestSort, app.guestSort)
              actions.render()
            }
          },
          c.label,
          active ? icon(app.guestSort.direction === 'asc' ? 'chevronDown' : 'chevronRight', 12, `icon sort-${app.guestSort.direction}`) : null
        )
      )
    })
  )

  const rows = filtered.flatMap((g) => {
    const open = app.selectedGuest === g.key
    const presence = places.get(guestRef(g))
    const toggleRow = () => {
      app.selectedGuest = open ? null : g.key
      actions.render()
    }
    const row = h(
      'tr',
      {
        class: cx('guest-row', open && 'selected'),
        tabIndex: 0,
        'aria-expanded': String(open),
        onClick: toggleRow,
        onKeydown: (e: KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            toggleRow()
          }
        }
      },
      h(
        'td',
        null,
        h(
          'div',
          { class: 'cell-name' },
          icon(g.type === 'qemu' ? 'monitor' : 'box', 14),
          h('span', { class: 'name', title: `${guestKind(g)} ${guestName(g)}` }, guestName(g)),
          g.template ? chip('template') : null,
          g.tags.slice(0, 2).map((t) => h('span', { class: 'tag' }, `#${t}`)),
          presence ? h('span', { class: 'orca-mark', title: 'Orca runs here' }, icon('bot', 12)) : null
        )
      ),
      h('td', { class: 'col-status' }, dot(statusTone(g.status), g.status), h('span', { class: 'muted' }, ` ${g.status}`)),
      h(
        'td',
        { class: 'cell-cpu' },
        g.status === 'running' ? sparkline(g.metrics?.cpu, { label: `CPU of ${g.name} over the last hour`, tone: 'cpu', width: 44, height: 14 }) : null,
        h('span', null, g.status === 'running' ? formatPercent(g.cpu) : '-')
      ),
      h(
        'td',
        { class: 'col-mem cell-mem' },
        g.status === 'running' && g.metrics ? sparkline(g.metrics.mem, { label: `Memory of ${g.name} over the last hour`, tone: 'mem', width: 44, height: 14 }) : meter(g.maxmem ? g.mem / g.maxmem : 0, `Memory ${formatPercent(g.maxmem ? g.mem / g.maxmem : 0)}`, 40),
        h('span', null, g.status === 'running' && g.maxmem ? formatPercent(g.mem / g.maxmem) : '-')
      ),
      diskCell(g),
      h('td', { class: 'col-uptime muted' }, formatUptime(g.uptime)),
      h('td', { class: 'col-host muted' }, `${g.remote}/${g.node}`),
      h('td', null, g.template ? '-' : chip(BACKUP_LABEL[g.backupState] + (g.backupAmbiguous ? '?' : ''), BACKUP_TONE[g.backupState]))
    )
    return open ? [row, h('tr', { class: 'details-row' }, h('td', { colSpan: COLUMNS.length }, guestDetails(g, snap, presence, now)))] : [row]
  })

  return h(
    'div',
    { class: 'view stack' },
    h(
      'div',
      { class: 'search' },
      icon('search', 14),
      h('input', {
        id: 'guest-search',
        type: 'search',
        placeholder: 'Search name, VMID, tag, host, address',
        'aria-label': 'Search guests',
        value: f.search,
        onInput: (e: Event) => setFilter({ search: (e.target as HTMLInputElement).value })
      })
    ),
    h(
      'div',
      { class: 'toolbar' },
      select('guest-type', 'Type', f.type, [
        { value: 'all', label: 'VMs and CTs' },
        { value: 'qemu', label: 'VMs' },
        { value: 'lxc', label: 'Containers' }
      ], (type) => setFilter({ type })),
      select('guest-status', 'Status', f.status, [
        { value: 'all', label: 'Any status' },
        { value: 'running', label: 'Running' },
        { value: 'stopped', label: 'Not running' }
      ], (status) => setFilter({ status })),
      select('guest-place', 'Host', f.place, placeOptions(snap), (place) => setFilter({ place })),
      allTags(snap.guests).length
        ? select('guest-tag', 'Tag', f.tag, [{ value: 'all', label: 'Any tag' }, ...allTags(snap.guests).map((t) => ({ value: t, label: `#${t}` }))], (tag) => setFilter({ tag }))
        : null,
      h(
        'label',
        { class: 'check' },
        h('input', { id: 'guest-needs-backup', type: 'checkbox', checked: f.needsBackup, onChange: (e: Event) => setFilter({ needsBackup: (e.target as HTMLInputElement).checked }) }),
        'Needs a backup'
      )
    ),
    h('div', { class: 'muted small' }, `${filtered.length} of ${snap.guests.length} guests · ${running} running`),
    h(
      'div',
      { class: 'table-wrap' },
      h('table', { class: 'table', 'aria-label': 'Guests' }, h('thead', null, header), h('tbody', null, rows.length ? rows : h('tr', null, h('td', { colSpan: COLUMNS.length, class: 'muted empty-cell' }, 'No guest matches the filters.'))))
    )
  )
}
