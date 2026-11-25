// What deserves an Orca notification between two refreshes, debounced. Pure: the worker keeps the
// state between calls and shows the alerts.
import type { EstateSnapshot } from '../model'
import { isBackupTask, taskLabel } from './insights'

export type AlertKind = 'remoteOffline' | 'guestStopped' | 'backupFailed' | 'backupStale'

export type Alert = { kind: AlertKind; key: string; title: string; body: string }

/** What the detector remembers: how many refreshes in a row each problem was seen, and what was told. */
export type AlertState = {
  /** Problem key -> consecutive refreshes it was seen. */
  seen: Record<string, number>
  /** Problem keys already notified; cleared when the problem goes away. */
  told: string[]
  /** Guests seen running last time, to notice one that stops. */
  running: string[]
  /** Newest task start seen (kept for states saved before `done`). */
  tasksSince: number
  /** UPIDs of the listed tasks already seen finished: a task is judged once, when it ends. */
  done?: string[]
  /** Whether a first snapshot was seen: the first one only sets the baseline. */
  primed: boolean
  /** The configuration (connectionScope) this state belongs to. */
  scope?: string
}

export const EMPTY_ALERT_STATE: AlertState = { seen: {}, told: [], running: [], tasksSince: 0, done: [], primed: false }

/** Refreshes in a row a problem must be seen before it is told (a blip is not an outage). */
const CONFIRM = 2

export function detectAlerts(state: AlertState, snap: EstateSnapshot, muted: Partial<Record<AlertKind, boolean>> = {}): { alerts: Alert[]; state: AlertState } {
  const problems = new Map<string, Alert>()
  for (const r of snap.remotes) {
    if (!r.online) problems.set(`remote|${r.id}`, { kind: 'remoteOffline', key: `remote|${r.id}`, title: `${r.id} is unreachable`, body: 'PDM cannot reach this remote; the Proxmox panel shows why.' })
  }
  const runningNow = new Set(snap.guests.filter((g) => g.status === 'running').map((g) => g.key))
  const onlineRemotes = new Set(snap.remotes.filter((r) => r.online).map((r) => r.id))
  // A guest that was running and now is not (on a remote that is still reachable).
  const stoppedNow = [...state.running, ...Object.keys(state.seen).filter((k) => k.startsWith('stopped|')).map((k) => k.slice(8))]
  for (const key of new Set(stoppedNow)) {
    const g = snap.guests.find((x) => x.key === key)
    if (!g || runningNow.has(key) || !onlineRemotes.has(g.remote)) continue
    problems.set(`stopped|${key}`, { kind: 'guestStopped', key: `stopped|${key}`, title: `${g.type === 'qemu' ? 'VM' : 'CT'} ${g.name} (${g.vmid}) stopped`, body: `It was running on ${g.remote}/${g.node}; now it is ${g.status}.` })
  }
  for (const g of snap.guests) {
    // A backup that went stale; guests never backed up are not news.
    if (g.template || g.backupState !== 'stale') continue
    {
      problems.set(`stale|${g.key}`, { kind: 'backupStale', key: `stale|${g.key}`, title: `Backup of ${g.name} (${g.vmid}) is stale`, body: `No backup in the last ${snap.backups.staleHours} h${g.lastBackupWhere ? `; the newest is in ${g.lastBackupWhere}` : ''}.` })
    }
  }

  const alerts: Alert[] = []
  const seen: Record<string, number> = {}
  const told = new Set(state.told)
  for (const [key, alert] of problems) {
    seen[key] = (state.seen[key] ?? 0) + 1
    // Stale backups need no confirmation: they come from slow scans, not a single refresh.
    const confirmed = alert.kind === 'backupStale' || seen[key] >= CONFIRM
    if (state.primed && confirmed && !told.has(key)) {
      told.add(key)
      if (!muted[alert.kind]) alerts.push(alert)
    }
  }
  for (const key of [...told]) if (!problems.has(key) && !key.startsWith('task|')) told.delete(key)

  // Failed backup tasks, each once, when they finish: by UPID, not by start time, so a backup
  // seen running on one refresh and failed on the next is still told. Two failing in the same
  // second are two UPIDs, so two alerts.
  const tasks = snap.tasks ?? []
  const newest = tasks.reduce((m, t) => Math.max(m, t.start), state.tasksSince)
  const finished = tasks.filter((t) => t.state !== 'running')
  // States from before `done`: tasks that started before the old watermark count as handled.
  const done = new Set(state.done ?? finished.filter((t) => t.start <= state.tasksSince).map((t) => t.key))
  for (const t of finished) {
    if (done.has(t.key)) continue
    done.add(t.key)
    if (!state.primed || !isBackupTask(t) || t.state !== 'failed') continue
    const key = `task|${t.key}`
    if (told.has(key)) continue
    told.add(key)
    if (!muted.backupFailed) alerts.push({ kind: 'backupFailed', key, title: `${taskLabel(t)} failed on ${t.remote}`, body: `${t.id ? `Guest ${t.id}: ` : ''}the task ended with an error; the Proxmox panel's Tasks tab shows it.` })
  }
  // Keep the told list short: task keys only matter while the task can still show up.
  const taskKeys = new Set(tasks.map((t) => `task|${t.key}`))
  const keep = [...told].filter((k) => !k.startsWith('task|') || taskKeys.has(k))

  return {
    alerts,
    // Only UPIDs still listed: one that dropped off the list cannot come back.
    state: { seen, told: keep, running: [...runningNow], tasksSince: newest, done: finished.map((t) => t.key).filter((k) => done.has(k)), primed: true }
  }
}

/** Many alerts at once become one summary, so a big outage is one notification, not twenty. */
export function bundle(alerts: Alert[], max = 3): Alert[] {
  if (alerts.length <= max) return alerts
  return [
    {
      kind: alerts[0].kind,
      key: 'bundle',
      title: `${alerts.length} Proxmox alerts`,
      body: alerts
        .slice(0, 5)
        .map((a) => a.title)
        .join('; ') + (alerts.length > 5 ? '; …' : '')
    }
  ]
}
