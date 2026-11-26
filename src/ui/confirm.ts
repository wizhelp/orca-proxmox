// In-panel confirmations for destructive actions (remove a connection, reset the order). A
// confirmation is bound to its action and its exact target (a connection's id and revision, the
// saved order as it was), lasts a short while and is used once: a late, repeated or replayed
// click, or one after the target changed, does nothing. Pure, so it is tested in Node.

export type Confirmation = { action: 'remove' | 'reset-order'; target: string; nonce: number; expires: number }

/** How long a confirmation stays valid. */
export const CONFIRM_MS = 20_000

let seq = 0

export function ask(action: Confirmation['action'], target: string, now: number): Confirmation {
  seq += 1
  return { action, target, nonce: seq, expires: now + CONFIRM_MS }
}

/** The pending confirmation, or null once it has expired. */
export function pending(confirm: Confirmation | null, now: number): Confirmation | null {
  return confirm && confirm.expires > now ? confirm : null
}

/**
 * Whether a click on a confirm button made for `nonce` may act: the same confirmation is still
 * pending, unexpired, for this action and this target, and the target is unchanged now
 * (`current`). The caller clears the confirmation before acting, so it can act only once.
 */
export function mayAct(confirm: Confirmation | null, nonce: number, action: Confirmation['action'], target: string, current: string | undefined, now: number): boolean {
  const live = pending(confirm, now)
  return !!live && live.nonce === nonce && live.action === action && live.target === target && current === target
}

/** A connection as a confirmation target: its id and revision. */
export const connectionTarget = (c: { id: string; revision?: string }): string => `${c.id}@${c.revision ?? ''}`

/** The saved order as a confirmation target. */
export const orderTarget = (order: readonly string[]): string => JSON.stringify(order)
