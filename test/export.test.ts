// "Copy for AI", Without addresses: a best-effort filter, normalized before it filters, that
// takes paths (with spaces too) to the end of their field. Synthetic values only.
import { assert, test } from 'orca/testing'
import type { EstateSnapshot } from '../src/model'
import { estateMarkdown, normalizeText, stripValue } from '../src/features/insights'
import { renamedEstate } from './fixtures/estate'
import { RENAMED_AT } from './fixtures/recorded-pdm-renamed'

const clone = (s: EstateSnapshot): EstateSnapshot => JSON.parse(JSON.stringify(s))

test('look-alike characters are normalized before filtering', () => {
  assert.equal(normalizeText('１９２．１６８・１‐２'), '192.168.1-2')
  for (const leak of ['db-１０．０．０＿５', 'x_１９２－１６８．1．20', 'db10.0.0.5', 'n‧10‧0‧0‧7']) {
    assert.ok(stripValue(leak).includes('[address]'), `${leak} -> ${stripValue(leak)}`)
  }
})

test('a path is removed from where it starts to the end of the field, spaces and all', () => {
  const cases: [string, string][] = [
    ['store C:\\Program Files\\Backup Data\\Client A', 'store [path]'],
    ['store C:/Program Files/Backup Data', 'store [path]'],
    ['/mnt/Shared Folder/Customer Files', '[path]'],
    ['nfs ~/Customer Files/2026', 'nfs [path]'],
    ['\\\\fileserver\\Finance Team\\Payroll', '[path]'],
    ['dump at /var/lib/vz/dump', 'dump at [path]']
  ]
  for (const [input, expected] of cases) assert.equal(stripValue(input), expected, input)
  // Not paths: our own remote/node form, plain names and tags.
  for (const keep of ['pve-a/pve-a', 'vm-pve-a-320', 'web', 'automation', 'local-lvm']) assert.equal(stripValue(keep), keep)
})

test('the export without addresses holds none of the synthetic secrets', async () => {
  const snap = clone(await renamedEstate())
  snap.datastores[0].name = 'main C:\\Program Files\\Backup Data\\Client A'
  if (snap.datastores[1]) snap.datastores[1].name = '\\\\fileserver\\Finance Team\\Payroll'
  snap.guests[0].name = 'db-１０．０．０＿５'
  snap.guests[1].tags = ['/mnt/Shared Folder/Customer Files']
  snap.guests[2].name = 'web.corp.example.com'
  const md = estateMarkdown(snap, { mode: 'no-addresses', now: RENAMED_AT })
  for (const leak of ['Program Files', 'Backup Data', 'Client A', 'Finance Team', 'Payroll', 'Shared Folder', 'Customer Files', '１０', '10.0.0', 'corp.example']) {
    assert.ok(!md.includes(leak), `${leak} left in`)
  }
  const anon = estateMarkdown(snap, { mode: 'anonymized', now: RENAMED_AT })
  for (const leak of ['Program Files', 'Finance', 'Customer', 'db-', 'corp']) assert.ok(!anon.includes(leak), `anonymized: ${leak}`)
})
