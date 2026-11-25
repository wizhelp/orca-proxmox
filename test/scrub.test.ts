// What leaves the worker: credential-shaped text replaced, scrubbed before it is cut.
import { assert, test } from 'orca/testing'
import { redactDeep, scrubLine, scrubText } from '../src/scrub'

const SECRET = '794239b2-4e1e-4ebe-bd97-3d3dc098207e'

test('credential-shaped text is replaced', () => {
  for (const leak of [
    `Authorization: PDMAPIToken=monitor@pdm!orca:${SECRET}`,
    `PVEAPIToken=root@pam!x=${SECRET}`,
    'Cookie: PVEAuthCookie=PVE:root@pam:ABCDEF::sig',
    'Bearer abcdefghijklmnopqrstuvwxyz0123',
    'password=hunter22',
    'https://admin:hunter22@pdm.example.test/',
    `upstream: ${SECRET}`
  ]) {
    const out = scrubText(leak)
    assert.ok(!/hunter22|abcdefghijklmnop|ABCDEF::sig/.test(out), out)
    assert.ok(!out.includes(SECRET), out)
  }
  assert.equal(scrubText('plain words stay'), 'plain words stay')
  assert.equal(scrubText('a\u001b[31mb‮c'), 'a [31mb c')
})

test('a known secret is replaced before the text is cut', () => {
  const secret = 'Zq9-known-secret-value'
  const line = scrubLine(`${'x'.repeat(290)} ${secret}`, [secret], 300)
  assert.ok(!line.includes('Zq9-known'), line)
  assert.deepEqual(redactDeep({ a: [`k ${secret}`], n: 1 }, [secret]), { a: ['k [redacted]'], n: 1 })
})
