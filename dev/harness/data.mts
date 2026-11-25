// Writes the harness's data.json: the recorded, scrubbed estate with Orca placed on it, as the
// worker would answer it. No server is contacted. The recording's times are moved to the present
// (the fixtures keep them at an arbitrary offset), so backup ages and charts look as they did.
import { writeFileSync } from 'node:fs'
import { fixtureConfig, renamedEstate } from '../../test/fixtures/estate'
import { RENAMED_AT } from '../../test/fixtures/recorded-pdm-renamed'

const TIME_KEYS = /^(fetchedAt|lastBackup|start|end|until|lastActivityAt)$/
function shift<T>(value: T, delta: number): T {
  const walk = (v: unknown, key = ''): unknown => {
    if (typeof v === 'number' && TIME_KEYS.test(key) && v > 1e12) return v + delta
    if (Array.isArray(v)) return v.map((x) => walk(x))
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]))
    return v
  }
  return walk(value) as T
}

const now = Date.now()
const snap = shift(await renamedEstate(), now - RENAMED_AT)
const out = process.argv[2]
writeFileSync(out, JSON.stringify({ estate: { state: 'ok', snapshot: { ...snap, fetchedAt: now - 20000 }, refreshSeconds: 30 }, config: fixtureConfig(true) }))
console.log(`wrote ${out}`)
