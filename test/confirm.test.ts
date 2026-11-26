// In-panel confirmations: bound to the action and its exact target, short-lived and used once.
import { assert, test } from 'orca/testing'
import { ask, CONFIRM_MS, connectionTarget, mayAct, orderTarget, pending } from '../src/ui/confirm'

test('a confirmation acts once, for its own action and target, while it is fresh', () => {
  const t0 = 1_000_000
  const target = connectionTarget({ id: 'c-1', revision: 'r1' })
  let confirm = ask('remove', target, t0)
  const nonce = confirm.nonce
  assert.ok(mayAct(confirm, nonce, 'remove', target, target, t0 + 1000))
  // Another confirmation, another action, another target, or the target changed meanwhile: no.
  assert.ok(!mayAct(confirm, nonce + 1, 'remove', target, target, t0))
  assert.ok(!mayAct(confirm, nonce, 'reset-order', target, target, t0))
  assert.ok(!mayAct(confirm, nonce, 'remove', connectionTarget({ id: 'c-2', revision: 'r1' }), target, t0))
  assert.ok(!mayAct(confirm, nonce, 'remove', target, connectionTarget({ id: 'c-1', revision: 'r2' }), t0), 'the credential was replaced')
  assert.ok(!mayAct(confirm, nonce, 'remove', target, undefined, t0), 'the connection is gone')
  // Late: expired.
  assert.ok(!mayAct(confirm, nonce, 'remove', target, target, t0 + CONFIRM_MS + 1))
  assert.equal(pending(confirm, t0 + CONFIRM_MS + 1), null)
  // Used once: the caller clears it before acting, so a second or replayed click finds nothing.
  confirm = null as never
  assert.ok(!mayAct(confirm, nonce, 'remove', target, target, t0 + 1000))
  // A new confirmation does not revive an old button.
  const again = ask('remove', target, t0)
  assert.ok(!mayAct(again, nonce, 'remove', target, target, t0))
})

test('a reset of the order is bound to the order as it was', () => {
  const before = orderTarget(['node|a', 'node|b'])
  const confirm = ask('reset-order', before, 0)
  assert.ok(mayAct(confirm, confirm.nonce, 'reset-order', before, orderTarget(['node|a', 'node|b']), 1))
  assert.ok(!mayAct(confirm, confirm.nonce, 'reset-order', before, orderTarget(['node|b', 'node|a']), 1), 'reordered since')
})
