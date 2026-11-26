// The panel's state and the actions views call. One module, so views stay plain functions of it.
import { ORDER_KEY } from '../arrange'
import type { EstateResponse, EstateSnapshot } from '../model'
import type { ConfigAnswer, ConnectionInput, TestAnswer } from '../protocol'
import type { ExportMode } from '../features/insights'
import type { Confirmation } from './confirm'
import { NO_FILTER, type GuestFilter, type GuestSort, type Tone } from './logic'

export type Tab = 'hosts' | 'guests' | 'backups' | 'tasks' | 'orca' | 'settings'

/** Plugin storage keys for what the panel remembers between runs. */
export const KEYS = {
  tab: 'ui.tab',
  hostsLayout: 'ui.hostsLayout',
  collapsed: 'ui.collapsed',
  treeGuestSort: 'ui.treeGuestSort',
  guestSort: 'ui.guestSort',
  order: ORDER_KEY
} as const

export const app = {
  response: null as EstateResponse | null,
  /** The newest good snapshot: the current one, or the last before an error. */
  snap: null as EstateSnapshot | null,
  config: null as ConfigAnswer | null,
  workerError: null as string | null,
  loading: false,

  tab: 'hosts' as Tab,
  hostsLayout: 'cards' as 'cards' | 'tree',
  order: [] as string[],
  collapsed: new Set<string>(),
  treeGuestSort: 'manual',
  /** The guest whose details are open, in the tree or the guests table. */
  selectedGuest: null as string | null,

  /** The host whose actions and notes are open in the tree. */
  selectedHost: null as string | null,
  taskFilter: 'all',
  /** The VM the placement planner sizes. */
  plan: { cores: 2, memGiB: 4, diskGiB: 32 },
  planOpen: false,
  /** "Copy for AI": the mode being previewed, or null when the preview is closed. */
  aiPreview: null as ExportMode | null,
  guestFilter: { ...NO_FILTER } as GuestFilter,
  guestSort: { column: 'name', direction: 'asc' } as GuestSort,

  form: { baseUrl: '', tokenId: '', fingerprint: '', secret: '' } as ConnectionInput,
  formDirty: false,
  /** The connection form is shown: after Edit or Add, or while there is no connection yet. */
  formOpen: false,
  /** A destructive action waiting for its in-panel confirmation (confirm.ts). */
  confirm: null as Confirmation | null,
  testResult: null as TestAnswer | null,
  settingsMessage: null as { tone: Tone; text: string } | null,
  busy: null as 'test' | 'save' | 'clear' | 'import' | 'dismiss' | null
}

type Actions = {
  render: () => void
  refresh: (force?: boolean) => Promise<void>
  /** Any refresh still in flight is dropped when it answers (the connection was removed). */
  discardRefresh: () => void
  setTab: (tab: Tab) => void
  /** Saves the order (all levels) and re-renders. */
  saveOrder: (order: string[]) => void
  remember: (key: string, value: unknown) => void
  loadConfig: () => Promise<void>
}

/** Filled in by main.ts; views call through it. */
export const actions: Actions = {
  render: () => undefined,
  refresh: async () => undefined,
  discardRefresh: () => undefined,
  setTab: () => undefined,
  saveOrder: () => undefined,
  remember: () => undefined,
  loadConfig: async () => undefined
}

export function failure(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
