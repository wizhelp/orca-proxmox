// What the worker does on its own while the plugin is enabled, panel open or not: keep the
// status-bar item current and raise alerts. Dependencies are passed in, so tests drive it.
import type { EstateResponse, PluginSettings } from './model'
import { bundle, detectAlerts, EMPTY_ALERT_STATE, type AlertKind, type AlertState } from './features/alerts'
import { statusLine, type StatusLine } from './features/insights'

export type BackgroundDeps = {
  /** The estate as the panel would get it (cached refreshes are fine). */
  load: () => Promise<EstateResponse>
  settings: () => Promise<PluginSettings>
  statusBar: (line: StatusLine & { visible: boolean }) => Promise<void>
  notify: (title: string, body: string) => Promise<void>
  readState: () => Promise<AlertState | null>
  writeState: (state: AlertState) => Promise<void>
  log: (message: string) => void
}

export function mutedKinds(settings: PluginSettings): Partial<Record<AlertKind, boolean>> {
  return {
    remoteOffline: !settings.alertRemoteOffline,
    guestStopped: !settings.alertGuestStopped,
    backupFailed: !settings.alertBackupFailed,
    backupStale: !settings.alertBackupStale
  }
}

export class Background {
  private state: AlertState | null = null
  /** `fetchedAt` of the last snapshot judged: a cached read of it is no new observation. */
  private judged: number | undefined
  /** A refresh failed since the last judged snapshot. */
  private gap = false

  constructor(private readonly deps: BackgroundDeps) {}

  /** The connection changed: start over from a fresh baseline. */
  reset(): void {
    this.state = null
    this.judged = undefined
    this.gap = false
  }

  /** One round: read the estate, update the status bar, tell what changed. */
  async tick(): Promise<void> {
    const settings = await this.deps.settings()
    const answer = await this.deps.load()
    const snap = answer.state === 'ok' ? answer.snapshot : answer.state === 'error' ? (answer.lastGood ?? null) : null
    const error = answer.state === 'error' ? answer.error.message : answer.state === 'unconfigured' ? 'Not set up yet: open the Proxmox panel.' : undefined
    const line = statusLine(answer.state === 'ok' ? snap : null, error)
    await this.deps.statusBar({ ...line, visible: settings.statusBar }).catch((e: unknown) => this.deps.log(`Status bar: ${String(e)}`))
    if (answer.state !== 'ok') {
      if (answer.state === 'error') this.gap = true
      return
    }
    const fresh = answer.snapshot
    if (fresh.fetchedAt === this.judged) return
    this.judged = fresh.fetchedAt

    let prior = this.state ?? (await this.deps.readState().catch(() => null)) ?? EMPTY_ALERT_STATE
    // State of another configuration (another estate, or the same one saved again): a new baseline.
    if (prior.scope !== undefined && prior.scope !== fresh.connectionId) prior = EMPTY_ALERT_STATE
    // After a failed refresh the "seen twice in a row" count starts over: an outage is confirmed
    // by two consecutive measured snapshots, never across a gap.
    if (this.gap) {
      prior = { ...prior, seen: Object.fromEntries(Object.keys(prior.seen).map((k) => [k, 0])) }
      this.gap = false
    }
    const { alerts, state } = detectAlerts(prior, fresh, mutedKinds(settings))
    this.state = { ...state, scope: fresh.connectionId }
    await this.deps.writeState(this.state).catch(() => undefined)
    for (const alert of bundle(alerts)) {
      await this.deps.notify(alert.title, alert.body).catch((e: unknown) => this.deps.log(`Notification: ${String(e)}`))
    }
  }
}
