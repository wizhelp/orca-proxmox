// The Proxmox panel: an HTML panel (Orca's components panels cannot drag and drop). It never talks
// to Proxmox: every call goes through the worker, which holds the token. It polls the worker on
// the refresh interval while visible, and keeps the person's choices in plugin storage.
import { connectionScope, type EstateResponse } from '../model'
import { orcaByPlace } from '../presence'
import { actions, app, failure, KEYS, type Tab } from './app'
import { stackBar } from './charts'
import { h } from './dom'
import { icon, type IconName } from './icons'
import { ago } from './logic'
import { button, chip, emptyState, errorCallout } from './parts'
import { isDragging } from './sortable'
import { backupsView } from './view-backups'
import { guestsView } from './view-guests'
import { hostsView } from './view-hosts'
import { orcaView } from './view-orca'
import { tasksView } from './view-tasks'
import { copyText } from './actions'
import { estateMarkdown, type ExportMode } from '../features/insights'
import { fillForm, pinFingerprint, settingsView } from './view-settings'

const root = document.getElementById('app')!

const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: 'hosts', label: 'Hosts', icon: 'gauge' },
  { id: 'guests', label: 'Guests', icon: 'layers' },
  { id: 'backups', label: 'Backups', icon: 'download' },
  { id: 'tasks', label: 'Tasks', icon: 'activity' },
  { id: 'orca', label: 'Orca', icon: 'bot' },
  { id: 'settings', label: 'Settings', icon: 'settings' }
]

let renderPending = false

function summary(): HTMLElement | null {
  const snap = app.snap
  if (!snap) return null
  const down = snap.remotes.filter((r) => !r.online).length
  const running = snap.guests.filter((g) => g.status === 'running').length
  const places = orcaByPlace(snap.orca)
  const working = [...places.values()].some((p) => p.working > 0)
  return h(
    'div',
    { class: 'chips summary' },
    chip(`${snap.remotes.length - down}/${snap.remotes.length} remotes up`, down ? 'bad' : 'ok', 'cloud'),
    h(
      'span',
      { class: 'chip plain' },
      stackBar([
        { value: running, tone: 'ok', label: 'running' },
        { value: snap.guests.length - running, tone: 'off', label: 'not running' }
      ], 30),
      `${running}/${snap.guests.length} guests`
    ),
    snap.backups.missing ? chip(`${snap.backups.missing} need backup`, 'warn', 'download') : null,
    snap.orca ? chip(`Orca on ${places.size} hosts`, working ? 'info' : 'plain', 'bot') : null
  )
}

function placeholder(): HTMLElement {
  if (!app.config?.connection) {
    return emptyState('plug', 'Connect to Proxmox Datacenter Manager', 'Add the PDM URL and a read-only API token.', button('Open settings', () => actions.setTab('settings'), { icon: 'settings', variant: 'primary' }))
  }
  if (app.loading || !app.response) return h('div', { class: 'skeleton', 'aria-label': 'Loading the estate' }, h('div'), h('div'), h('div'))
  return emptyState('alert', 'No data', 'The last refresh failed; see the error above.')
}

function view(): HTMLElement {
  if (app.tab === 'settings') return settingsView()
  const snap = app.snap
  if (!snap) return placeholder()
  if (app.tab === 'guests') return guestsView(snap)
  if (app.tab === 'backups') return backupsView(snap)
  if (app.tab === 'orca') return orcaView(snap)
  if (app.tab === 'tasks') return tasksView(snap)
  return hostsView(snap)
}

function render(): void {
  if (isDragging()) {
    renderPending = true
    return
  }
  renderPending = false
  // Keep focus and the caret across a re-render (the search box, a form field, a row).
  const active = document.activeElement as HTMLElement | null
  const focusId = active?.id
  const focusKey = active?.closest<HTMLElement>('[data-sort-key]')?.dataset.sortKey
  const caret = active instanceof HTMLInputElement ? [active.selectionStart, active.selectionEnd] : null
  const scroll = window.scrollY

  const answer = app.response
  const parts: (Node | null)[] = [
    h(
      'header',
      { class: 'top' },
      h(
        'div',
        { class: 'title-row' },
        h('h1', null, icon('cloud', 18), 'Proxmox'),
        h('span', { class: 'updated muted small', id: 'updated' }, updatedText()),
        app.snap ? aiMenu() : null,
        button('Refresh now', () => void actions.refresh(true), { icon: 'refresh', variant: 'ghost', iconOnly: true, disabled: app.loading || !app.config?.connection, id: 'refresh' })
      ),
      summary()
    ),
    app.workerError ? h('div', { class: 'callout bad', role: 'alert' }, icon('alert', 16, 'icon callout-icon'), h('div', { class: 'callout-body' }, h('div', { class: 'callout-title' }, 'The plugin worker failed'), app.workerError)) : null,
    aiPreviewPanel(),
    answer?.state === 'error' ? errorCallout(answer.error, { pin: pinFingerprint, openSettings: () => actions.setTab('settings') }) : null,
    app.snap?.warnings.length
      ? h('details', { class: 'fold' }, h('summary', null, icon('alert', 14), ` ${app.snap.warnings.length} warning${app.snap.warnings.length > 1 ? 's' : ''}`), app.snap.warnings.map((w) => h('div', { class: 'muted small' }, w)))
      : null,
    h(
      'nav',
      { class: 'tabs', role: 'tablist', 'aria-label': 'Views' },
      TABS.map((t) =>
        h(
          'button',
          {
            type: 'button',
            role: 'tab',
            id: `tab-${t.id}`,
            title: t.label,
            'aria-label': t.label,
            'aria-selected': String(app.tab === t.id),
            class: app.tab === t.id ? 'on' : '',
            onClick: () => actions.setTab(t.id)
          },
          icon(t.icon, 14),
          h('span', { class: 'tab-label' }, t.label)
        )
      )
    ),
    h('main', { role: 'tabpanel', 'aria-labelledby': `tab-${app.tab}` }, view())
  ]
  root.replaceChildren(...parts.filter((p): p is Node => p !== null))

  if (focusId) {
    const again = document.getElementById(focusId)
    again?.focus()
    if (again instanceof HTMLInputElement && caret) again.setSelectionRange(caret[0], caret[1])
  } else if (focusKey) {
    root.querySelector<HTMLElement>(`[data-sort-key="${CSS.escape(focusKey)}"] .row, [data-sort-key="${CSS.escape(focusKey)}"]`)?.focus()
  }
  window.scrollTo(0, scroll)
}

const EXPORT_MODES: { mode: ExportMode; label: string; hint: string }[] = [
  { mode: 'full', label: 'With addresses', hint: 'Names, tags and the addresses of hosts and guests.' },
  { mode: 'no-addresses', label: 'Without addresses', hint: 'A best-effort filter: IP addresses, DNS names, URLs and file paths are taken out of names and tags, other words stay. For a sensitive estate use Anonymized.' },
  { mode: 'anonymized', label: 'Anonymized', hint: 'Every name replaced by a placeholder, no tags, VMIDs or addresses: the mode for a sensitive estate.' }
]

function preview(mode: ExportMode): void {
  app.aiPreview = mode
  render()
}

/** "Copy for AI": the estate as Markdown, shown first, then copied. */
function aiMenu(): HTMLElement {
  return h(
    'details',
    { class: 'menu' },
    h('summary', { class: 'btn ghost', title: 'Preview and copy a Markdown summary of the estate for an AI agent' }, icon('sparkles', 14), h('span', { class: 'menu-label' }, 'Copy for AI')),
    h(
      'div',
      { class: 'menu-items', role: 'menu' },
      EXPORT_MODES.map((m) => button(m.label, () => preview(m.mode), { icon: 'copy', variant: 'ghost', title: m.hint }))
    )
  )
}

/** The text exactly as it will be copied, with the mode to change and the copy button. */
function aiPreviewPanel(): HTMLElement | null {
  const mode = app.aiPreview
  if (!mode || !app.snap) return null
  const text = estateMarkdown(app.snap, { mode })
  const current = EXPORT_MODES.find((m) => m.mode === mode)!
  return h(
    'section',
    { class: 'card ai-preview', 'aria-label': 'Copy for AI preview' },
    h('header', { class: 'card-head' }, icon('sparkles', 16), h('span', { class: 'card-title' }, 'Copy for AI'), h('span', { class: 'muted small' }, `${text.length.toLocaleString()} characters`)),
    h(
      'div',
      { class: 'seg', role: 'radiogroup', 'aria-label': 'What to include' },
      EXPORT_MODES.map((m) =>
        h('button', { type: 'button', class: `btn ${m.mode === mode ? 'primary' : 'ghost'}`, role: 'radio', 'aria-checked': String(m.mode === mode), title: m.hint, onClick: () => preview(m.mode) }, m.label)
      )
    ),
    h('p', { class: 'muted small' }, current.hint, ' Server error texts are never included.'),
    h('pre', { class: 'ai-text', tabIndex: 0, 'aria-label': 'The text to copy' }, text),
    h(
      'div',
      { class: 'actions' },
      button('Copy', () => void copyText(text, mode === 'full' ? 'the estate summary' : `the estate summary (${current.label.toLowerCase()})`), { icon: 'copy', variant: 'primary' }),
      button('Close', () => {
        app.aiPreview = null
        render()
      }, { icon: 'x', variant: 'ghost' })
    )
  )
}

function updatedText(): string {
  if (!app.snap) return ''
  return `${app.loading ? 'Refreshing… · ' : ''}updated ${ago(app.snap.fetchedAt, Date.now())}${app.response?.state === 'error' ? ' (stale)' : ''}`
}

/** Bumped by each refresh: only the newest one's answer is applied. */
let refreshSeq = 0

async function refresh(force = false): Promise<void> {
  // A forced refresh (after saving the connection) does not wait for one still running.
  if (app.loading && !force) return
  const seq = ++refreshSeq
  const scope = app.config?.connection ? connectionScope(app.config.connection) : null
  app.loading = true
  const label = document.getElementById('updated')
  if (label) label.textContent = updatedText()
  try {
    const answer = (await orca.plugin.request('estate.get', { force }, { timeoutMs: 120000 })) as EstateResponse
    if (seq !== refreshSeq) return
    // An estate of a configuration replaced meanwhile is never shown for the new one.
    const mine = (connectionId: string | undefined) => scope !== null && connectionId === scope
    if (answer.state === 'ok' && !mine(answer.snapshot.connectionId)) return
    app.response = answer
    app.workerError = null
    if (answer.state === 'ok') app.snap = answer.snapshot
    else if (answer.state === 'error') app.snap = answer.lastGood && mine(answer.lastGood.connectionId) ? answer.lastGood : app.snap
    else app.snap = null
  } catch (error) {
    if (seq === refreshSeq) app.workerError = failure(error)
  } finally {
    if (seq === refreshSeq) {
      app.loading = false
      render()
    }
  }
}

async function loadConfig(): Promise<void> {
  try {
    app.config = await orca.plugin.request('config.get')
    if (!app.formDirty) fillForm()
    if (!app.config.connection) app.tab = 'settings'
  } catch (error) {
    app.workerError = failure(error)
  }
}

function remember(key: string, value: unknown): void {
  void orca.storage.set(key, value as never).catch(() => undefined)
}

async function readOrder(): Promise<void> {
  const stored = await orca.storage.get(KEYS.order).catch(() => null)
  app.order = Array.isArray(stored) ? stored.filter((k): k is string => typeof k === 'string') : []
}

/** A refresh in flight is answered for a connection that is gone: its answer is not applied. */
function discardRefresh(): void {
  refreshSeq += 1
  app.loading = false
}

Object.assign(actions, {
  render,
  refresh,
  discardRefresh,
  loadConfig,
  remember,
  setTab: (tab: Tab) => {
    app.tab = tab
    remember(KEYS.tab, tab)
    render()
    window.scrollTo(0, 0)
  },
  saveOrder: (order: string[]) => {
    app.order = order
    render()
    void orca.storage.set(KEYS.order, order).catch((error: unknown) => {
      app.workerError = `The order could not be saved: ${failure(error)}`
      render()
    })
  }
})

async function start(): Promise<void> {
  const get = (key: string) => orca.storage.get(key).catch(() => null)
  const [tab, layout, collapsed, treeSort, guestSort] = await Promise.all([get(KEYS.tab), get(KEYS.hostsLayout), get(KEYS.collapsed), get(KEYS.treeGuestSort), get(KEYS.guestSort)])
  await readOrder()
  if (typeof tab === 'string' && ['hosts', 'guests', 'backups', 'tasks', 'orca', 'settings'].includes(tab)) app.tab = tab as Tab
  if (layout === 'tree' || layout === 'cards') app.hostsLayout = layout
  if (Array.isArray(collapsed)) app.collapsed = new Set(collapsed.filter((k): k is string => typeof k === 'string'))
  if (typeof treeSort === 'string') app.treeGuestSort = treeSort
  if (guestSort && typeof guestSort === 'object' && !Array.isArray(guestSort) && 'column' in guestSort) app.guestSort = guestSort as typeof app.guestSort

  // Another run of this panel changed the order: take the stored value (not the event's), so
  // the echo of an older write never undoes a newer move. The connection changed (here or in
  // another panel): what this one shows belongs to the old one, so it goes.
  const subscription = orca.storage.onDidChange(({ key }) => {
    if (key === KEYS.order) void readOrder().then(render)
    if (key === CONNECTIONS_KEY) void connectionChanged()
  })

  render()
  await loadConfig()
  render()
  if (app.config?.connection) await refresh(false)

  // Timers run only while the panel is visible, and are released when it is hidden or closed.
  let tickTimer: ReturnType<typeof setTimeout> | undefined
  let clockTimer: ReturnType<typeof setInterval> | undefined
  const seconds = () => (app.response?.refreshSeconds ?? app.config?.settings.refreshSeconds ?? 30) * 1000
  const tick = async () => {
    tickTimer = undefined
    if (document.visibilityState !== 'visible') return
    if (app.config?.connection && !isDragging()) await refresh(false)
    else if (renderPending && !isDragging()) render()
    if (document.visibilityState === 'visible' && tickTimer === undefined) tickTimer = setTimeout(() => void tick(), seconds())
  }
  const stop = () => {
    clearTimeout(tickTimer)
    clearInterval(clockTimer)
    tickTimer = clockTimer = undefined
  }
  const resume = () => {
    stop()
    tickTimer = setTimeout(() => void tick(), seconds())
    // "updated 2m ago" stays current without re-rendering.
    clockTimer = setInterval(() => {
      const label = document.getElementById('updated')
      if (label) label.textContent = updatedText()
      if (renderPending && !isDragging()) render()
    }, 10000)
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return stop()
    resume()
    // Back from hidden: catch up now if the estate is older than the interval.
    if (app.config?.connection && (!app.snap || Date.now() - app.snap.fetchedAt > seconds())) void refresh(false)
  })
  window.addEventListener('pagehide', () => {
    stop()
    subscription?.dispose?.()
  })
  if (document.visibilityState === 'visible') resume()
}

/** The worker's storage key of the connection (the panel only watches it, never writes it). */
const CONNECTIONS_KEY = 'connections'

/** The connection was saved or removed, maybe in another panel: drop the old estate and its actions. */
async function connectionChanged(): Promise<void> {
  const scopeOf = () => (app.config?.connection ? connectionScope(app.config.connection) : null)
  const before = scopeOf()
  await loadConfig()
  if (scopeOf() === before) return
  discardRefresh()
  app.snap = null
  app.response = null
  app.aiPreview = null
  app.selectedGuest = null
  app.selectedHost = null
  render()
  if (app.config?.connection) await refresh(true)
}

void start()
