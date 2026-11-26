// Hosts: a card per node, or the tree remote → node → Orca hosts and guests. Both reorder by drag
// and drop, each level only among itself, and share one saved order with the Orca view.
import { guestKey, hostKey, ordered, remoteKey, withLevel } from '../arrange'
import { formatBytes, formatPercent, formatUptime, formatUsage, type EstateSnapshot, type Guest, type Host } from '../model'
import { backupRollup, guestRef, nodeRef, orcaByPlace, presenceLabel, type OrcaPresence } from '../presence'
import { actions, app, KEYS } from './app'
import { lastValue, meter, sparkline, stackBar } from './charts'
import { cx, h } from './dom'
import { grip, icon } from './icons'
import { BACKUP_LABEL, BACKUP_TONE, guestKind, guestName, hostLabel, orcaKindLabel, statusTone } from './logic'
import { button, callout, chip, dot, emptyState, guestDetails, segmented, select } from './parts'
import { makeSortable, recentlyDragged } from './sortable'
import { hostActions } from './actions'
import { warningsBlock } from './view-insights'
import { ask, CONFIRM_MS, mayAct, orderTarget, pending } from './confirm'
import { versionDrift } from '../features/insights'

function saveLevel(keys: string[]): void {
  actions.saveOrder(withLevel(app.order, keys))
}

function gripHandle(name: string): HTMLElement {
  return h('span', { class: 'grip', title: `Drag to move ${name}`, 'aria-hidden': 'true' }, grip())
}

// ---- cards ----

function metricRow(label: string, chart: Element, value: string): HTMLElement {
  return h('div', { class: 'metric' }, h('span', { class: 'metric-label' }, label), chart, h('span', { class: 'metric-value' }, value))
}

function hostCard(snap: EstateSnapshot, host: Host, places: Map<string, OrcaPresence>): HTMLElement {
  const guests = ordered(snap, app.order).guestsOf(host)
  const running = guests.filter((g) => g.status === 'running').length
  const backups = backupRollup(guests)
  const presence = places.get(nodeRef(host))
  const orcaInGuests = guests.filter((g) => places.has(guestRef(g))).length
  const m = host.metrics
  const memShare = host.maxmem ? (host.mem ?? 0) / host.maxmem : undefined
  const netNow = lastValue(m?.net)
  return h(
    'article',
    { class: 'card host-card', dataset: { sortKey: hostKey(host) }, tabIndex: 0, 'aria-label': `${hostLabel(host)}, ${host.status}` },
    h(
      'header',
      { class: 'card-head' },
      gripHandle(hostLabel(host)),
      icon(host.remoteType === 'pbs' ? 'server' : 'database', 16),
      h('span', { class: 'card-title' }, hostLabel(host)),
      chip(`${host.remoteType.toUpperCase()}${host.version ? ` ${host.version}` : ''}`),
      h('span', { class: 'status' }, dot(statusTone(host.status)), host.status)
    ),
    h('div', { class: 'card-meta muted' }, `${host.remote} · up ${formatUptime(host.uptime)}`),
    host.status === 'unreachable'
      ? callout('bad', 'Unreachable', host.detailError ?? 'PDM cannot reach this remote.')
      : h(
          'div',
          { class: 'metrics' },
          metricRow('CPU', sparkline(m?.cpu, { label: `CPU over the last hour, now ${formatPercent(host.cpu)}`, tone: 'cpu', width: 110, height: 22 }), `${formatPercent(host.cpu)}${host.maxcpu ? ` · ${host.maxcpu} cores` : ''}`),
          metricRow('RAM', sparkline(m?.mem, { label: `Memory over the last hour, now ${formatPercent(memShare)}`, tone: 'mem', width: 110, height: 22 }), formatUsage(host.mem, host.maxmem)),
          metricRow('Disk', meter(host.maxdisk ? (host.disk ?? 0) / host.maxdisk : undefined, `Root disk ${formatUsage(host.disk, host.maxdisk)}`, 110), formatUsage(host.disk, host.maxdisk)),
          metricRow('Net', sparkline(m?.net, { label: `Network over the last hour, now ${formatBytes(netNow)}/s`, tone: 'net', width: 110, height: 22 }), netNow === undefined ? '-' : `${formatBytes(netNow)}/s`)
        ),
    host.status === 'unreachable'
      ? null
      : h(
          'div',
          { class: 'chips' },
          host.remoteType === 'pve'
            ? h(
                'span',
                { class: 'chip plain' },
                stackBar([
                  { value: running, tone: 'ok', label: 'running' },
                  { value: guests.length - running, tone: 'off', label: 'not running' }
                ], 34),
                `${running}/${guests.length} guests`
              )
            : null,
          host.remoteType === 'pve' && guests.some((g) => !g.template)
            ? backups.unknown
              ? chip('backups unknown', 'off', 'download')
              : backups.needing
                ? chip(`${backups.needing} need backup`, 'warn', 'download')
                : chip('backups ok', 'ok', 'download')
            : null,
          presence ? chip(presenceLabel(presence), presence.working ? 'info' : 'plain', 'bot') : null,
          orcaInGuests ? chip(`Orca in ${orcaInGuests} guest${orcaInGuests > 1 ? 's' : ''}`, 'plain', 'bot') : null,
          host.detailError ? chip('details unavailable', 'warn', 'alert', host.detailError) : null,
          ...hostBadges(snap, host)
        ),
    host.notes ? h('div', { class: 'notes clamp', title: host.notes }, icon('note', 13), h('span', null, host.notes)) : null,
    host.status === 'unreachable' ? null : hostActions(snap, host, presence)
  )
}

/** Pending updates and version drift. */
function hostBadges(snap: EstateSnapshot, host: Host): HTMLElement[] {
  const out: HTMLElement[] = []
  if (host.pendingUpdates) out.push(chip(`${host.pendingUpdates} update${host.pendingUpdates > 1 ? 's' : ''}`, 'warn', 'update', 'Pending package updates, as PDM last checked'))
  const drift = versionDrift(snap.hosts).find((d) => d.host.key === host.key)
  if (drift) out.push(chip(`behind ${drift.newest}`, 'warn', 'update', `${host.node} runs ${drift.version}; the newest in this estate is ${drift.newest}`))
  return out
}

function cardsView(snap: EstateSnapshot): HTMLElement {
  const places = orcaByPlace(snap.orca)
  const list = h('div', { class: 'cards' }, ordered(snap, app.order).hosts.map((host) => hostCard(snap, host, places)))
  makeSortable({ container: list, handle: '.card-head, .card-meta, .grip', onDrop: saveLevel })
  return list
}

// ---- tree ----

function toggle(key: string): void {
  if (app.collapsed.has(key)) app.collapsed.delete(key)
  else app.collapsed.add(key)
  actions.remember(KEYS.collapsed, [...app.collapsed])
  actions.render()
}

type Row = {
  key: string
  iconName: Parameters<typeof icon>[0]
  label: string
  desc: string
  tone: ReturnType<typeof statusTone>
  chart?: Element
  chips?: (HTMLElement | null)[]
  sortable: boolean
  expandable: boolean
  expanded: boolean
  onActivate?: () => void
  selected?: boolean
}

function treeRow(r: Row): HTMLElement {
  return h(
    'div',
    {
      class: cx('row', r.selected && 'selected'),
      tabIndex: 0,
      role: 'treeitem',
      'aria-expanded': r.expandable ? String(r.expanded) : undefined,
      'aria-selected': r.selected ? 'true' : undefined,
      onClick: (event: MouseEvent) => {
        if (recentlyDragged() || (event.target as Element).closest('button, .grip')) return
        r.onActivate?.()
      },
      onKeydown: (event: KeyboardEvent) => {
        if (event.altKey) return
        if ((event.key === 'Enter' || event.key === ' ') && r.onActivate) {
          event.preventDefault()
          r.onActivate()
        } else if (r.expandable && (event.key === 'ArrowRight' || event.key === 'ArrowLeft') && (event.key === 'ArrowRight') !== r.expanded) {
          event.preventDefault()
          toggle(r.key)
        }
      }
    },
    r.expandable
      ? h(
          'button',
          { type: 'button', class: 'twisty', 'aria-label': r.expanded ? 'Collapse' : 'Expand', tabIndex: -1, onClick: () => toggle(r.key) },
          icon(r.expanded ? 'chevronDown' : 'chevronRight', 14)
        )
      : h('span', { class: 'twisty' }),
    r.sortable ? gripHandle(r.label) : h('span', { class: 'grip-space' }),
    icon(r.iconName, 15, 'icon row-icon'),
    dot(r.tone),
    h('span', { class: 'row-label' }, r.label),
    h('span', { class: 'row-desc' }, r.desc),
    r.chart ?? null,
    (r.chips ?? []).filter(Boolean)
  )
}

function orcaItems(presence: OrcaPresence | undefined, parent: string): HTMLElement[] {
  if (!presence) return []
  return presence.hosts.map((o) => {
    const workspaces = presence.workspaces.filter((w) => w.hostKey === o.key)
    const working = workspaces.reduce((n, w) => n + w.agents.filter((a) => a.state === 'working').length, 0)
    return h(
      'li',
      { class: 'tnode orca-node' },
      treeRow({
        key: `${parent}|orca|${o.key}`,
        iconName: 'bot',
        label: `Orca: ${o.name}`,
        desc: `${orcaKindLabel(o)}${o.paired && o.paired.name !== o.name ? ` (paired as ${o.paired.name})` : ''} · ${workspaces.length} workspace${workspaces.length === 1 ? '' : 's'}${working ? ` · ${working} working` : ''}`,
        tone: working ? 'info' : 'off',
        chips: presence.bots.filter((b) => b.hostKey === o.key).map((b) => chip(`bot ${b.name}`, b.paused ? 'off' : 'info')),
        sortable: false,
        expandable: false,
        expanded: false
      })
    )
  })
}

function guestItem(snap: EstateSnapshot, g: Guest, places: Map<string, OrcaPresence>, now: number): HTMLElement {
  const presence = places.get(guestRef(g))
  const selected = app.selectedGuest === g.key
  return h(
    'li',
    { class: 'tnode', dataset: { sortKey: guestKey(g) } },
    treeRow({
      key: guestKey(g),
      iconName: g.type === 'qemu' ? 'monitor' : 'box',
      label: `${guestKind(g)} ${guestName(g)}`,
      desc: [g.status === 'running' ? `${formatPercent(g.cpu)} CPU · ${g.maxmem ? formatPercent(g.mem / g.maxmem) : '-'} RAM` : g.status, g.tags.length ? `#${g.tags.join(' #')}` : ''].filter(Boolean).join(' · '),
      tone: statusTone(g.status),
      chart: g.status === 'running' ? sparkline(g.metrics?.cpu, { label: `CPU of ${g.name} over the last hour`, tone: 'cpu', width: 48, height: 14 }) : undefined,
      chips: [
        g.template ? chip('template') : chip(BACKUP_LABEL[g.backupState], BACKUP_TONE[g.backupState], 'download', `Backup ${BACKUP_LABEL[g.backupState]}`),
        presence ? chip(presence.working ? `Orca · ${presence.working} working` : 'Orca', presence.working ? 'info' : 'plain', 'bot', presenceLabel(presence)) : null
      ],
      sortable: true,
      expandable: false,
      expanded: false,
      selected,
      onActivate: () => {
        app.selectedGuest = selected ? null : g.key
        actions.render()
      }
    }),
    selected ? guestDetails(g, snap, presence, now) : null,
    presence ? h('ul', { class: 'children', role: 'group' }, orcaItems(presence, g.key)) : null
  )
}

function treeView(snap: EstateSnapshot): HTMLElement {
  const places = orcaByPlace(snap.orca)
  const sorted = ordered(snap, app.order, app.treeGuestSort)
  const now = Date.now()
  const tree = h('ul', { class: 'tree', role: 'tree', 'aria-label': 'Estate' })
  for (const remote of sorted.remotes) {
    const nodes = sorted.hosts.filter((h2) => h2.remote === remote.id && h2.node)
    const rKey = remoteKey(remote.id)
    const rOpen = !app.collapsed.has(rKey)
    const nodeList = h('ul', { class: 'children', role: 'group' })
    if (rOpen) {
      for (const host of nodes) {
        const guests = sorted.guestsOf(host)
        const nKey = hostKey(host)
        const nOpen = !app.collapsed.has(nKey)
        const presence = places.get(nodeRef(host))
        const backups = backupRollup(guests)
        const guestList = h('ul', { class: 'children', role: 'group' })
        if (nOpen) {
          guestList.append(...orcaItems(presence, host.key), ...guests.map((g) => guestItem(snap, g, places, now)))
          if (app.treeGuestSort === 'manual') makeSortable({ container: guestList, handle: '.row', ghostOf: (li) => li.querySelector(':scope > .row')!, onDrop: saveLevel })
        }
        nodeList.append(
          h(
            'li',
            { class: 'tnode', dataset: { sortKey: nKey } },
            treeRow({
              key: nKey,
              iconName: host.remoteType === 'pbs' ? 'server' : 'database',
              label: hostLabel(host),
              desc: `${formatPercent(host.cpu)} CPU · ${host.maxmem ? formatPercent((host.mem ?? 0) / host.maxmem) : '-'} RAM${host.remoteType === 'pve' ? ` · ${guests.length} guests` : host.version ? ` · PBS ${host.version}` : ''}`,
              tone: statusTone(host.status),
              chart: sparkline(host.metrics?.cpu, { label: `CPU of ${hostLabel(host)} over the last hour`, tone: 'cpu', width: 48, height: 14 }),
              chips: [
                backups.needing ? chip(`${backups.needing} need backup`, 'warn', 'download') : null,
                presence ? chip(presence.working ? `Orca · ${presence.working} working` : 'Orca', presence.working ? 'info' : 'plain', 'bot', presenceLabel(presence)) : null
              ],
              sortable: true,
              expandable: guests.length > 0 || !!presence,
              expanded: nOpen,
              selected: app.selectedHost === host.key,
              onActivate: () => {
                app.selectedHost = app.selectedHost === host.key ? null : host.key
                actions.render()
              }
            }),
            app.selectedHost === host.key
              ? h(
                  'div',
                  { class: 'details' },
                  hostActions(snap, host, presence),
                  h('div', { class: 'chips' }, hostBadges(snap, host)),
                  host.notes ? h('div', { class: 'notes' }, icon('note', 13), h('span', null, host.notes)) : null
                )
              : null,
            nOpen ? guestList : null
          )
        )
      }
      makeSortable({ container: nodeList, handle: '.row', ghostOf: (li) => li.querySelector(':scope > .row')!, onDrop: saveLevel })
    }
    tree.append(
      h(
        'li',
        { class: 'tnode remote', dataset: { sortKey: rKey } },
        treeRow({
          key: rKey,
          iconName: remote.type === 'pbs' ? 'archive' : 'cloud',
          label: remote.id,
          desc: remote.online ? `${remote.type.toUpperCase()} · ${nodes.length} node${nodes.length === 1 ? '' : 's'}` : `unreachable: ${remote.error ?? ''}`,
          tone: remote.online ? 'ok' : 'bad',
          sortable: true,
          expandable: nodes.length > 0,
          expanded: rOpen,
          onActivate: () => toggle(rKey)
        }),
        rOpen ? nodeList : null
      )
    )
  }
  makeSortable({ container: tree, handle: '.row', ghostOf: (li) => li.querySelector(':scope > .row')!, onDrop: saveLevel })
  return tree
}

// ---- the tab ----

/** A reset of the order waiting for its confirmation, for the order as it is now. */
function resetAsked(): boolean {
  const live = pending(app.confirm, Date.now())
  return live?.action === 'reset-order' && live.target === orderTarget(app.order)
}

function askReset(): void {
  app.confirm = ask('reset-order', orderTarget(app.order), Date.now())
  setTimeout(() => actions.render(), CONFIRM_MS + 50)
  actions.render()
}

/** Bound to this confirmation and this order: a late or repeated click, or a changed order, resets nothing. */
function confirmReset(): () => void {
  const nonce = app.confirm?.nonce ?? -1
  const target = orderTarget(app.order)
  return () => {
    const ok = mayAct(app.confirm, nonce, 'reset-order', target, orderTarget(app.order), Date.now())
    app.confirm = null
    if (ok) void actions.saveOrder([])
    else actions.render()
  }
}

export function hostsView(snap: EstateSnapshot): HTMLElement {
  const down = snap.remotes.filter((r) => !r.online)
  const offline = snap.hosts.filter((x) => x.node && !x.online)
  const layout = app.hostsLayout
  return h(
    'div',
    { class: 'view stack' },
    down.length ? callout('bad', `${down.length} remote${down.length > 1 ? 's' : ''} unreachable`, down.map((r) => r.id).join(', ')) : null,
    offline.length ? callout('warn', `${offline.length} node${offline.length > 1 ? 's' : ''} offline`, offline.map((x) => `${x.remote}/${x.node}`).join(', ')) : null,
    h(
      'div',
      { class: 'toolbar' },
      segmented('Layout', layout, [
        { value: 'cards', label: 'Cards', icon: 'grid' },
        { value: 'tree', label: 'Tree', icon: 'tree' }
      ], (value) => {
        app.hostsLayout = value as 'cards' | 'tree'
        actions.remember(KEYS.hostsLayout, value)
        actions.render()
      }),
      layout === 'tree'
        ? select('tree-guest-sort', 'Order guests', app.treeGuestSort, [
            { value: 'manual', label: 'Guests: my order' },
            { value: 'name', label: 'Guests by name' },
            { value: 'status', label: 'Guests by status' },
            { value: 'cpu', label: 'Guests by CPU' },
            { value: 'memory', label: 'Guests by memory' },
            { value: 'backup', label: 'Guests by backup age' }
          ], (value) => {
            app.treeGuestSort = value
            actions.remember(KEYS.treeGuestSort, value)
            actions.render()
          })
        : null,
      app.order.length && !resetAsked() ? button('Reset order…', askReset, { icon: 'undo', variant: 'ghost', title: "Go back to PDM's order" }) : null
    ),
    resetAsked()
      ? h(
          'div',
          { class: 'confirm', role: 'alertdialog', 'aria-label': 'Confirm reset' },
          h('div', null, h('strong', null, 'Reset to the default order?'), ' Your own order of remotes, nodes and guests is forgotten.'),
          h(
            'div',
            { class: 'toolbar' },
            button('Reset', confirmReset(), { icon: 'undo', variant: 'danger', id: 'confirm-reset' }),
            button('Keep it', () => ((app.confirm = null), actions.render()), { variant: 'ghost' })
          )
        )
      : null,
    h('p', { class: 'hint' }, layout === 'tree' && app.treeGuestSort !== 'manual'
      ? 'Guests are sorted; choose “my order” to drag them. Remotes and nodes still drag.'
      : 'Drag to reorder, within the same level only. Alt+↑/↓ moves the focused item.'),
    warningsBlock(snap),
    snap.hosts.length === 0
      ? snap.remotes.length === 0
        ? emptyState('database', 'No remotes', 'PDM lists no remotes for this token: none are added in PDM yet, or the token may not see them (it needs the Auditor role on /resource).')
        : emptyState('database', 'No hosts', `PDM lists ${snap.remotes.length} remote${snap.remotes.length > 1 ? 's' : ''}, but no nodes or guests of them are visible: give the token the Auditor role on /resource (or on each remote).`)
      : layout === 'tree'
        ? treeView(snap)
        : cardsView(snap)
  )
}
