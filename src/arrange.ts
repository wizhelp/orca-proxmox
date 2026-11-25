// The person's own order for remotes, nodes and guests, kept as one list of keys. Only the order
// among siblings matters: keys the list does not know keep their natural order after the known ones.
// Pure, shared by both panels and tests.
import type { EstateSnapshot, Guest, Host } from './model'
import { guestsOf } from './presence'

/** Plugin storage key of the order, shared by the Proxmox panel and the map. */
export const ORDER_KEY = 'layout.order'

export type Move = 'up' | 'down' | 'top' | 'bottom'

/** `items` in the saved order; unknown ones follow, in their own order. */
export function applyOrder<T>(items: readonly T[], keyOf: (item: T) => string, order: readonly string[]): T[] {
  const rank = new Map(order.map((key, i) => [key, i]))
  return items
    .map((item, i) => ({ item, i, r: rank.get(keyOf(item)) }))
    .sort((a, b) => {
      if (a.r !== undefined && b.r !== undefined) return a.r - b.r
      if (a.r !== undefined) return -1
      if (b.r !== undefined) return 1
      return a.i - b.i
    })
    .map((x) => x.item)
}

/**
 * The saved order after moving `key` among `siblings` (all keys of its level, in their natural
 * order). Other levels' keys are kept as they are.
 */
export function moveKey(order: readonly string[], siblings: readonly string[], key: string, move: Move): string[] {
  const current = applyOrder(siblings, (k) => k, order)
  const from = current.indexOf(key)
  if (from < 0) return [...order]
  const to = move === 'top' ? 0 : move === 'bottom' ? current.length - 1 : move === 'up' ? from - 1 : from + 1
  if (to < 0 || to >= current.length || to === from) return [...order]
  const next = [...current]
  next.splice(from, 1)
  next.splice(to, 0, key)
  const level = new Set(siblings)
  return [...order.filter((k) => !level.has(k)), ...next]
}

/** Whether `key` is first or last among `siblings` in the saved order. */
export function edges(order: readonly string[], siblings: readonly string[], key: string): { first: boolean; last: boolean } {
  const current = applyOrder(siblings, (k) => k, order)
  return { first: current[0] === key, last: current[current.length - 1] === key }
}

/**
 * The saved order after dropping `key` just before `before` (or at the end when null), both
 * among `siblings`. A key from another level is refused: nothing changes.
 */
export function placeKey(order: readonly string[], siblings: readonly string[], key: string, before: string | null): string[] {
  if (!siblings.includes(key) || (before !== null && !siblings.includes(before)) || key === before) return [...order]
  const current = applyOrder(siblings, (k) => k, order).filter((k) => k !== key)
  const at = before === null ? current.length : current.indexOf(before)
  current.splice(at, 0, key)
  const level = new Set(siblings)
  return [...order.filter((k) => !level.has(k)), ...current]
}

// ---- the estate in the person's order ----

export const remoteKey = (id: string) => `remote|${id}`
export const hostKey = (h: Host) => `node|${h.key}`
export const guestKey = (g: Guest) => `guest|${g.key}`

const BACKUP_RANK: Record<Guest['backupState'], number> = { none: 0, stale: 1, unknown: 2, ok: 3 }

const GUEST_SORTS: Record<string, (a: Guest, b: Guest) => number> = {
  name: (a, b) => a.name.localeCompare(b.name),
  status: (a, b) => a.status.localeCompare(b.status) || a.vmid - b.vmid,
  cpu: (a, b) => b.cpu - a.cpu,
  memory: (a, b) => b.mem - a.mem,
  backup: (a, b) => BACKUP_RANK[a.backupState] - BACKUP_RANK[b.backupState] || (a.lastBackup ?? 0) - (b.lastBackup ?? 0)
}

/** Remotes, nodes and guests in the person's order (guests by `guestSort` unless `manual`). */
export function ordered(snap: EstateSnapshot, order: readonly string[], guestSort = 'manual') {
  const byVmid = (list: Guest[]) => [...list].sort((a, b) => a.vmid - b.vmid)
  return {
    remotes: applyOrder(snap.remotes, (r) => remoteKey(r.id), order),
    hosts: applyOrder(snap.hosts, hostKey, order),
    guestsOf: (host: Host): Guest[] => {
      const guests = guestsOf(snap, host)
      const sort = GUEST_SORTS[guestSort]
      return sort ? [...guests].sort(sort) : applyOrder(byVmid(guests), guestKey, order)
    }
  }
}

/** The saved order with one level set to `keys` (in that order); other levels are kept. */
export function withLevel(order: readonly string[], keys: readonly string[]): string[] {
  const level = new Set(keys)
  return [...order.filter((k) => !level.has(k)), ...keys]
}
