// Orca: which Orca hosts run where on the estate, with their bots and workspaces; the place cards
// drag like host cards and share their order. Placement can be set by hand.
import { applyOrder, withLevel } from '../arrange'
import type { EstateSnapshot, OrcaHost, OrcaView } from '../model'
import { orcaByPlace, orcaElsewhere, presenceLabel } from '../presence'
import { actions, app, failure } from './app'
import { h } from './dom'
import { grip, icon } from './icons'
import { ago, MATCH_LABEL, orcaHostLabel, orcaKindLabel, orcaTone, placeName, placementOptions, placementValue } from './logic'
import { callout, chip, dot, emptyState, select } from './parts'
import { makeSortable } from './sortable'

/** Place refs (`node:k`, `guest:k`) and order keys (`node|k`, `guest|k`) name the same thing. */
const orderKey = (ref: string) => ref.replace(/^(node|guest):/, '$1|')

async function link(hostKey: string, value: string): Promise<void> {
  try {
    await orca.plugin.request('orca.link', { hostKey, link: value === 'auto' ? null : value, scope: app.snap?.connectionId ?? '' })
    await actions.refresh(false)
  } catch (error) {
    app.workerError = failure(error)
    actions.render()
  }
}

function hostBlock(host: OrcaHost, view: OrcaView): HTMLElement {
  const workspaces = view.workspaces.filter((w) => w.hostKey === host.key)
  const bots = view.bots.filter((b) => b.hostKey === host.key)
  return h(
    'div',
    { class: 'orca-host' },
    h(
      'div',
      { class: 'chips' },
      h('strong', null, host.name),
      chip(orcaKindLabel(host), 'plain', host.paired || host.kind === 'environment' ? 'server' : host.kind === 'ssh' ? 'link' : 'monitor'),
      host.paired && host.paired.name !== host.name ? h('span', { class: 'muted small' }, `paired as ${host.paired.name}`) : null,
      host.connected === true ? chip('connected', 'ok') : host.connected === false ? chip('disconnected', 'warn') : null,
      bots.map((b) => chip(`bot ${b.name}${b.paused ? ' (paused)' : ''}`, b.paused ? 'off' : 'info', 'bot'))
    ),
    host.match ? h('div', { class: 'muted small' }, MATCH_LABEL[host.match]) : null,
    workspaces.length
      ? h(
          'ul',
          { class: 'ws-list', 'aria-label': `Workspaces on ${host.name}` },
          workspaces.map((w) =>
            h(
              'li',
              { class: 'ws-line' },
              icon(w.bot ? 'bot' : 'branch', 13),
              dot(orcaTone(w.status), w.status),
              h('span', null, w.name),
              h('span', { class: 'muted small' }, ` ${[w.repo !== w.name ? w.repo : '', w.status, w.agents.map((a) => `${a.agent} ${a.state}`).join(', ')].filter(Boolean).join(' · ')}`)
            )
          )
        )
      : h('div', { class: 'muted small' }, 'No workspaces.')
  )
}

export function orcaView(snap: EstateSnapshot): HTMLElement {
  const view = snap.orca
  if (!view) return emptyState('bot', 'Orca awareness is off', 'Turn on “Show where Orca runs” under Settings → Plugins → Proxmox.')
  const places = orcaByPlace(view)
  const elsewhere = orcaElsewhere(view)
  // This machine, and hosts set to "not on Proxmox" by hand, are where they belong; every other
  // host without a place is listed apart, each with its own Place selector.
  const settled = elsewhere.filter((o) => o.kind === 'local' || o.match === 'manual')
  const unplaced = elsewhere.filter((o) => !settled.includes(o))
  const working = view.workspaces.reduce((n, w) => n + w.agents.filter((a) => a.state === 'working').length, 0)
  const refs = applyOrder([...places.keys()], orderKey, app.order)

  const cards = h(
    'div',
    { class: 'cards' },
    refs.map((ref) => {
      const presence = places.get(ref)!
      return h(
        'article',
        { class: 'card', dataset: { sortKey: orderKey(ref) }, tabIndex: 0 },
        h(
          'header',
          { class: 'card-head' },
          h('span', { class: 'grip', 'aria-hidden': 'true' }, grip()),
          icon(ref.startsWith('node:') ? 'database' : 'monitor', 16),
          h('span', { class: 'card-title' }, placeName(snap, ref)),
          chip(presenceLabel(presence), presence.working ? 'info' : 'plain', 'bot')
        ),
        presence.hosts.map((o) => hostBlock(o, view))
      )
    })
  )
  makeSortable({ container: cards, handle: '.card-head', onDrop: (keys) => actions.saveOrder(withLevel(app.order, keys)) })
  const options = placementOptions(snap)

  return h(
    'div',
    { class: 'view stack' },
    view.error ? callout('warn', "Orca's hosts could not be read", view.error) : null,
    h(
      'div',
      { class: 'chips' },
      chip(`${view.hosts.length} Orca hosts`, 'plain', 'bot'),
      chip(`${view.hosts.filter((x) => x.runsOn).length} on Proxmox`, 'plain', 'database'),
      chip(`${view.bots.length} bots`),
      chip(`${view.workspaces.length} workspaces`, 'plain', 'branch'),
      working ? chip(`${working} agent${working === 1 ? '' : 's'} working`, 'info', 'activity') : null
    ),
    cards,
    unplaced.length
      ? h(
          'article',
          { class: 'card unplaced' },
          h('header', { class: 'card-head' }, icon('alert', 16), h('span', { class: 'card-title' }, 'Not placed yet'), chip(String(unplaced.length), 'warn')),
          h('div', { class: 'muted small' }, 'Orca does not say where these run, and no node or guest matched them. Paired servers without an SSH target are asked once for their own host name and addresses; place any that remain here.'),
          unplaced.map((o) =>
            h(
              'div',
              { class: 'stack-sm' },
              hostBlock(o, view),
              o.identity ? h('div', { class: 'muted small' }, `${o.identity.from === 'server' ? 'It reports' : 'Its endpoint is'} ${[...o.identity.names, ...o.identity.addresses].join(', ')}; no node or guest has that name or address.`) : null,
              select(`place-now-${o.key}`, `Place ${orcaHostLabel(o)} on`, placementValue(o), options, (value) => void link(o.key, value), false)
            )
          )
        )
      : null,
    settled.length
      ? h('article', { class: 'card' }, h('header', { class: 'card-head' }, icon('monitor', 16), h('span', { class: 'card-title' }, 'Not on Proxmox')), h('div', { class: 'muted small' }, 'This machine, and Orca hosts set as not on Proxmox.'), settled.map((o) => hostBlock(o, view)))
      : null,
    h(
      'details',
      { class: 'fold' },
      h('summary', null, icon('link', 14), ' Placement'),
      h('p', { class: 'muted small' }, 'Where each Orca host runs; set it by hand when automatic placement is wrong.'),
      h('div', { class: 'stack-sm' }, view.hosts.map((o) => select(`place-${o.key}`, `${orcaHostLabel(o)} runs on`, placementValue(o), options, (value) => void link(o.key, value), false)))
    ),
    view.warnings.length ? h('details', { class: 'fold' }, h('summary', null, icon('alert', 14), ` ${view.warnings.length} Orca warning${view.warnings.length > 1 ? 's' : ''}`), view.warnings.map((w) => h('div', { class: 'muted small' }, w))) : null,
    h('div', { class: 'muted small' }, `Orca inventory read ${ago(view.fetchedAt, Date.now())}`)
  )
}
