// Ordering remotes, nodes and guests by hand: the pure helpers behind the panel's Arrange mode.
import { assert, test } from 'orca/testing'
import { applyOrder, edges, moveKey, ordered, placeKey } from '../src/arrange'

const id = (k: string) => k

test('unknown keys keep their natural order after the known ones', () => {
  assert.deepEqual(applyOrder(['a', 'b', 'c', 'd'], id, ['c', 'a']), ['c', 'a', 'b', 'd'])
  assert.deepEqual(applyOrder(['a', 'b'], id, []), ['a', 'b'])
})

test('moving among siblings leaves other levels alone', () => {
  const order = ['remote|x', 'node|1']
  const siblings = ['node|1', 'node|2', 'node|3']
  assert.deepEqual(moveKey(order, siblings, 'node|3', 'up'), ['remote|x', 'node|1', 'node|3', 'node|2'])
  assert.deepEqual(moveKey(order, siblings, 'node|3', 'top'), ['remote|x', 'node|3', 'node|1', 'node|2'])
  assert.deepEqual(moveKey(order, siblings, 'node|1', 'bottom'), ['remote|x', 'node|2', 'node|3', 'node|1'])
  // At an edge, or for a key that is not a sibling, nothing changes.
  assert.deepEqual(moveKey(order, siblings, 'node|1', 'up'), order)
  assert.deepEqual(moveKey(order, siblings, 'node|9', 'down'), order)
})

test('a new node shows up after the ones already arranged', () => {
  const order = moveKey([], ['n1', 'n2'], 'n2', 'up')
  assert.deepEqual(applyOrder(['n1', 'n2', 'n3'], id, order), ['n2', 'n1', 'n3'])
  assert.deepEqual(edges(order, ['n1', 'n2', 'n3'], 'n2'), { first: true, last: false })
  assert.deepEqual(edges(order, ['n1', 'n2', 'n3'], 'n3'), { first: false, last: true })
})

test('a drop lands only among its own level', () => {
  const guests = ['guest|a/1', 'guest|a/2', 'guest|a/3']
  // Before a sibling, or at the end.
  assert.deepEqual(placeKey([], guests, 'guest|a/3', 'guest|a/1'), ['guest|a/3', 'guest|a/1', 'guest|a/2'])
  assert.deepEqual(placeKey([], guests, 'guest|a/1', null), ['guest|a/2', 'guest|a/3', 'guest|a/1'])
  // Another level's key, as the dragged item or the target, changes nothing.
  assert.deepEqual(placeKey(['x'], guests, 'guest|b/9', 'guest|a/1'), ['x'])
  assert.deepEqual(placeKey(['x'], guests, 'guest|a/1', 'node|a/n'), ['x'])
  // Other levels' saved keys survive.
  assert.deepEqual(placeKey(['remote|r', 'guest|a/2'], guests, 'guest|a/1', null), ['remote|r', 'guest|a/2', 'guest|a/3', 'guest|a/1'])
})

test('the estate in the saved order, guests sortable', async () => {
  const { renamedEstate } = await import('./fixtures/estate')
  const snap = await renamedEstate()
  const order = ['remote|pve-lab', 'guest|pve-a/431']
  const sorted = ordered(snap, order)
  assert.equal(sorted.remotes[0].id, 'pve-lab')
  const main1 = snap.hosts.find((h) => h.key === 'pve-a/pve-a')!
  assert.deepEqual(sorted.guestsOf(main1).map((g) => g.vmid), [431, 310, 314, 320, 430])
  assert.deepEqual(ordered(snap, order, 'name').guestsOf(main1).map((g) => g.vmid), [430, 431, 310, 314, 320])
})
