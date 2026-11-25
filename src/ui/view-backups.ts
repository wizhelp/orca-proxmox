// Backups: the verdict, each datastore's use with its day of history, every guest's backup age as
// a bar against the stale limit, and snapshots whose guest is gone.
import { formatBytes, formatPercent, type EstateSnapshot } from '../model'
import { actions, app } from './app'
import { meter, sparkline } from './charts'
import { datastoreForecast } from '../features/capacity'
import { h } from './dom'
import { icon } from './icons'
import { ago, BACKUP_LABEL, BACKUP_RANK, BACKUP_TONE, backupAge, guestKind, guestName } from './logic'
import { button, callout, chip } from './parts'

/** Age against the stale limit: full at the limit, red past it. */
function ageBar(fraction: number | null, label: string): HTMLElement {
  const f = fraction === null ? 1 : Math.min(1, fraction)
  const level = fraction === null || fraction > 1 ? 'bad' : fraction > 0.75 ? 'warn' : 'ok'
  return h('span', { class: 'meter age', role: 'img', 'aria-label': label, title: label }, h('span', { class: `meter-fill ${level}`, style: `width:${(f * 100).toFixed(1)}%` }))
}

export function backupsView(snap: EstateSnapshot): HTMLElement {
  const b = snap.backups
  const now = Date.now()
  const guests = snap.guests
    .filter((g) => !g.template)
    .sort((x, y) => BACKUP_RANK[x.backupState] - BACKUP_RANK[y.backupState] || (x.lastBackup ?? 0) - (y.lastBackup ?? 0))
  return h(
    'div',
    { class: 'view stack' },
    b.error
      ? callout('warn', 'Backups could not be checked', b.error)
      : b.missing > 0
        ? callout(
            'bad',
            `${b.missing} guest${b.missing > 1 ? 's' : ''} without a backup in ${b.staleHours} h`,
            button('Show them', () => {
              app.guestFilter = { ...app.guestFilter, needsBackup: true }
              actions.setTab('guests')
            }, { icon: 'search' })
          )
        : callout('ok', `Every guest has a backup from the last ${b.staleHours} h`),
    b.fetchedAt ? h('div', { class: 'muted small' }, icon('clock', 12), ` Snapshot lists read ${ago(b.fetchedAt, now)}`) : null,
    b.incomplete ? h('div', { class: 'warn-text small', role: 'note' }, icon('alert', 12), ` ${b.incomplete}`) : null,
    h('h3', null, 'Datastores'),
    snap.datastores.length === 0
      ? h('div', { class: 'muted' }, 'No PBS datastore is visible.')
      : snap.datastores.map((d) =>
          h(
            'article',
            { class: 'card' },
            h('header', { class: 'card-head' }, icon('drive', 16), h('span', { class: 'card-title' }, d.name), d.maintenance ? chip(d.maintenance, 'warn') : chip(formatPercent(d.usage), d.usage >= 0.9 ? 'bad' : d.usage >= 0.8 ? 'warn' : 'ok')),
            h('div', { class: 'card-meta muted' }, `${formatBytes(d.used)} of ${formatBytes(d.total)} on ${d.remote}`),
            meter(d.usage, `${d.name} ${formatPercent(d.usage)} used`),
            datastoreForecast(d) !== undefined ? h('div', { class: `${(datastoreForecast(d) ?? 99) < 14 ? 'warn' : 'muted'}-text small` }, `At the last day's rate, full in about ${Math.max(1, Math.round(datastoreForecast(d)!))} days.`) : null,
            d.usageHistory?.some((v) => v !== null)
              ? h('div', { class: 'metric' }, h('span', { class: 'metric-label' }, 'Day'), sparkline(d.usageHistory, { label: `${d.name} use over the last day`, tone: 'disk', width: 160, height: 22 }), h('span', { class: 'metric-value muted' }, 'last 24 h'))
              : null
          )
        ),
    h('h3', null, 'Guests by backup age'),
    h(
      'ul',
      { class: 'age-list', 'aria-label': 'Last backup per guest' },
      guests.map((g) => {
        const age = backupAge(g, now, b.staleHours)
        const when = g.lastBackup ? ago(g.lastBackup, now) : g.backupState === 'unknown' ? 'unknown' : 'never'
        return h(
          'li',
          { class: 'age-row' },
          icon(g.type === 'qemu' ? 'monitor' : 'box', 13),
          h('span', { class: 'age-name', title: `${guestKind(g)} ${guestName(g)} · ${g.remote}` }, guestName(g)),
          ageBar(age, `Last backup ${when}; the limit is ${b.staleHours} h`),
          h('span', { class: 'age-when' }, when),
          chip(BACKUP_LABEL[g.backupState] + (g.backupAmbiguous ? '?' : ''), BACKUP_TONE[g.backupState])
        )
      })
    ),
    b.orphans.length
      ? h(
          'details',
          { class: 'fold' },
          h('summary', null, icon('archive', 14), ` ${b.orphans.length} backup${b.orphans.length > 1 ? 's' : ''} without a guest`),
          h('p', { class: 'muted small' }, 'The guest was destroyed or moved; its snapshots stay on PBS until pruned.'),
          h(
            'ul',
            { class: 'age-list', 'aria-label': 'Backups without a guest' },
            b.orphans.map((o) => h('li', { class: 'age-row' }, icon(o.type === 'qemu' ? 'monitor' : 'box', 13), h('span', { class: 'age-name' }, `${o.type === 'qemu' ? 'VM' : 'CT'} ${o.vmid}${o.remote ? ` · ${o.remote}` : ''}`), h('span', { class: 'age-when' }, ago(o.lastBackup, now)), h('span', { class: 'muted small' }, o.where)))
          )
        )
      : null
  )
}
