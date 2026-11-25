// Tasks: the newest tasks of every remote (PDM's merged list), failures in red, running ones pulsing.
import type { EstateSnapshot, Task } from '../model'
import { isBackupTask, taskLabel } from '../features/insights'
import { actions, app } from './app'
import { cx, h } from './dom'
import { icon } from './icons'
import { ago } from './logic'
import { chip, dot, emptyState, segmented } from './parts'

const STATE_TONE = { running: 'info', ok: 'ok', warning: 'warn', failed: 'bad' } as const

function duration(t: Task, now: number): string {
  const ms = (t.end ?? now) - t.start
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  return `${(ms / 3_600_000).toFixed(1)}h`
}

export function filterTasks(tasks: readonly Task[], filter: string): Task[] {
  if (filter === 'failures') return tasks.filter((t) => t.state === 'failed' || t.state === 'warning')
  if (filter === 'backups') return tasks.filter(isBackupTask)
  return [...tasks]
}

export function tasksView(snap: EstateSnapshot): HTMLElement {
  const now = Date.now()
  const all = snap.tasks ?? []
  const tasks = filterTasks(all, app.taskFilter)
  const failed = all.filter((t) => t.state === 'failed').length
  return h(
    'div',
    { class: 'view stack' },
    h(
      'div',
      { class: 'toolbar' },
      segmented('Show', app.taskFilter, [
        { value: 'all', label: 'All' },
        { value: 'failures', label: failed ? `Problems (${failed})` : 'Problems' },
        { value: 'backups', label: 'Backups', icon: 'download' }
      ], (value) => {
        app.taskFilter = value
        actions.render()
      })
    ),
    tasks.length === 0
      ? emptyState('activity', all.length ? 'Nothing here' : 'No tasks yet', all.length ? 'No task matches this view.' : 'PDM has not reported any tasks.')
      : h(
          'ul',
          { class: 'task-list', 'aria-label': 'Recent tasks' },
          tasks.map((t) =>
            h(
              'li',
              { class: cx('task', t.state) },
              dot(STATE_TONE[t.state], t.state),
              h(
                'div',
                { class: 'task-main' },
                h('div', { class: 'task-title' }, h('strong', null, taskLabel(t)), t.id ? h('span', { class: 'muted' }, ` ${t.id}`) : null),
                h('div', { class: 'muted small' }, `${t.remote}/${t.node} · ${t.user} · ${t.state === 'running' ? 'running' : duration(t, now)}`),
                t.state === 'failed' || t.state === 'warning' ? h('div', { class: `${t.state === 'failed' ? 'bad' : 'warn'}-text small` }, t.status ?? '') : null
              ),
              h('span', { class: 'task-when muted small', title: new Date(t.start).toLocaleString(orca.locale) }, ago(t.start, now)),
              t.state === 'failed' ? chip('failed', 'bad') : t.state === 'running' ? chip('running', 'info') : null
            )
          )
        ),
    h('div', { class: 'muted small' }, icon('clock', 12), ' The newest tasks PDM keeps for each remote, read once a minute.')
  )
}
