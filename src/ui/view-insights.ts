// Disk warnings (with "full in ~N days") on the Hosts tab, and the placement planner: a tool in
// the header's tools row that opens it as a panel.
import { formatBytes, formatPercent, type EstateSnapshot } from '../model'
import { diskWarnings, placeVm } from '../features/capacity'
import { actions, app } from './app'
import { meter } from './charts'
import { cx, h } from './dom'
import { icon } from './icons'
import { button, callout, chip } from './parts'

export function warningsBlock(snap: EstateSnapshot): HTMLElement | null {
  const warnings = diskWarnings(snap)
  if (!warnings.length) return null
  return callout(
    warnings.some((w) => w.usage >= 0.95 || (w.fullInDays ?? 99) < 3) ? 'bad' : 'warn',
    `${warnings.length} disk${warnings.length > 1 ? 's' : ''} filling up`,
    h(
      'ul',
      { class: 'plain-list' },
      warnings.map((w) =>
        h(
          'li',
          { class: 'warn-line' },
          h('span', { class: 'warn-label' }, w.label),
          meter(w.usage, `${w.label} ${formatPercent(w.usage)} used`, 60),
          h('span', null, formatPercent(w.usage)),
          w.fullInDays !== undefined ? h('span', { class: 'muted small' }, ` full in ~${Math.max(1, Math.round(w.fullInDays))} d`) : null
        )
      )
    )
  )
}

function numberField(id: string, label: string, value: number, unit: string, onChange: (v: number) => void): HTMLElement {
  return h(
    'label',
    { class: 'num', for: id },
    h('span', { class: 'muted small' }, label),
    h('input', {
      id,
      type: 'number',
      min: '1',
      value: String(value),
      onChange: (e: Event) => {
        const v = Number((e.target as HTMLInputElement).value)
        if (Number.isFinite(v) && v > 0) onChange(v)
      }
    }),
    h('span', { class: 'muted small' }, unit)
  )
}

export const PLANNER_TITLE = 'Where should a new VM go?'

/** The tools-row button: an icon whose label opens out on hover and focus; it shows or hides the planner. */
export function plannerTool(): HTMLElement {
  return h(
    'button',
    {
      type: 'button',
      class: cx('btn ghost tool', app.planOpen && 'active'),
      title: PLANNER_TITLE,
      'aria-label': PLANNER_TITLE,
      'aria-expanded': String(app.planOpen),
      'aria-controls': 'planner',
      onClick: () => {
        app.planOpen = !app.planOpen
        actions.render()
      }
    },
    icon('target', 14),
    h('span', { class: 'tool-label', 'aria-hidden': 'true' }, 'Place a VM')
  )
}

export function plannerPanel(snap: EstateSnapshot): HTMLElement | null {
  if (!app.planOpen) return null
  const req = app.plan
  const ranked = placeVm(snap, req)
  const set = (patch: Partial<typeof app.plan>) => {
    app.plan = { ...app.plan, ...patch }
    actions.render()
  }
  return h(
    'section',
    { class: 'card planner', id: 'planner', 'aria-label': PLANNER_TITLE },
    h(
      'header',
      { class: 'card-head' },
      icon('target', 16),
      h('span', { class: 'card-title' }, PLANNER_TITLE),
      button('Close', () => ((app.planOpen = false), actions.render()), { icon: 'x', variant: 'ghost', iconOnly: true, title: 'Close the planner' })
    ),
    h(
      'div',
      { class: 'stack-sm' },
      h(
        'div',
        { class: 'toolbar' },
        numberField('plan-cores', 'CPU', req.cores, 'cores', (cores) => set({ cores })),
        numberField('plan-mem', 'RAM', req.memGiB, 'GiB', (memGiB) => set({ memGiB })),
        numberField('plan-disk', 'Disk', req.diskGiB, 'GiB', (diskGiB) => set({ diskGiB }))
      ),
      ranked.length === 0
        ? h('div', { class: 'muted' }, 'No PVE node is online.')
        : h(
            'ol',
            { class: 'plan-list', 'aria-label': 'Nodes, best place first' },
            ranked.map((p, i) =>
              h(
                'li',
                { class: cx('plan-row', i === 0 && p.confirmed && 'best') },
                h(
                  'div',
                  { class: 'plan-head' },
                  h('strong', null, p.host.node),
                  h('span', { class: 'muted small' }, p.host.remote),
                  // "Best fit" only with verified disk space; otherwise a fit for memory and CPU.
                  p.confirmed ? chip(i === 0 ? 'best fit' : 'fits', 'ok', i === 0 ? 'check' : undefined) : p.fits ? chip('fits RAM and CPU', 'ok') : chip("doesn't fit", 'bad'),
                  p.notes.filter((n) => !n.startsWith('not enough') && !n.startsWith('only')).map((n) => chip(n, 'warn'))
                ),
                h(
                  'div',
                  { class: 'plan-free' },
                  h('span', null, 'RAM free'),
                  meter(p.memTotal ? p.memFree / p.memTotal : 0, `${formatBytes(p.memFree)} of ${formatBytes(p.memTotal)} free`, 70, 'free'),
                  h('span', { class: 'small' }, formatBytes(p.memFree)),
                  h('span', null, 'Disk free'),
                  meter(p.diskTotal ? p.diskFree / p.diskTotal : 0, p.diskCheck === 'unknown' ? 'No storage for guest disks is known on this node' : `${formatBytes(p.diskFree)} of ${formatBytes(p.diskTotal)} free on ${p.diskStorage}${p.diskCheck === 'unverified' ? ' (chosen by name: not verified to hold VM disks)' : ''}`, 70, 'free'),
                  h('span', { class: 'small' }, p.diskCheck === 'unknown' ? 'unknown' : `${formatBytes(p.diskFree)} (${p.diskStorage}${p.diskCheck === 'unverified' ? '?' : ''})`),
                  h('span', null, 'Idle CPU'),
                  meter(p.cores ? p.freeCores / p.cores : 0, `${p.freeCores.toFixed(1)} of ${p.cores} cores idle`, 70, 'free'),
                  h('span', { class: 'small' }, `${p.freeCores.toFixed(1)} / ${p.cores}`)
                ),
                !p.fits ? h('div', { class: 'bad-text small' }, p.notes.join(', ')) : null
              )
            )
          ),
      h('div', { class: 'muted small' }, 'Free memory keeps 10 % for the host; disk counts the roomiest storage for guest disks on each node. PDM’s resource list does not say which storages hold VM disks: a storage chosen by its name is marked with "?" and "disk unverified", and nodes with verified disk space rank first (only those are called a best fit). Running guests that could already claim all memory lower a node. An advisory estimate, not a provisioning check.')
    )
  )
}
