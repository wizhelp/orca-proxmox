// Scrubbing for everything that leaves the worker (panel answers, logs, notifications) and for the
// "Copy for AI" text. Pure. Always scrub first and cut to length after, so a cut never leaves
// half of a secret behind.
import type { EstateSnapshot } from './model'

const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g

/**
 * Text from a server (errors, task status): known secrets and anything shaped like a credential
 * replaced, control and direction characters removed.
 */
export function scrubText(text: string, secrets: Iterable<string> = []): string {
  let out = String(text)
  for (const secret of secrets) if (secret && secret.length >= 4) out = out.split(secret).join('[redacted]')
  out = out
    .replace(/\b(PDMAPIToken|PVEAPIToken|PBSAPIToken)\b\s*[=:]?\s*[^\s"',;]+/gi, '$1=[redacted]')
    .replace(/\b(authorization|proxy-authorization|cookie|set-cookie|csrfpreventiontoken|x-api-key)\b(["']?\s*[:=]\s*)[^\r\n,;]+/gi, '$1$2[redacted]')
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]')
    .replace(/\b(PVEAuthCookie|PBSAuthCookie|PDMAuthCookie)=[^\s;]+/gi, '$1=[redacted]')
    .replace(/\b(secret|password|passwd|token|ticket)(["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi, '$1$2[redacted]')
    // A token secret is a UUID: none belongs in an error message.
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[redacted]')
    .replace(/:\/\/[^/\s:@]+:[^/\s@]+@/g, '://[redacted]@')
    .replace(CONTROL, ' ')
  return out
}

/** scrubText, then cut to `max` characters. */
export function scrubLine(text: string, secrets: Iterable<string> = [], max = 300): string {
  const out = scrubText(text, secrets).replace(/\s+/g, ' ').trim()
  return out.length > max ? `${out.slice(0, max - 1)}…` : out
}

/** Every string in `value` with the known secrets replaced; the shape is kept. */
export function redactDeep<T>(value: T, secrets: readonly string[]): T {
  const list = secrets.filter((s) => s && s.length >= 4)
  if (list.length === 0) return value
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      let out = v
      for (const s of list) if (out.includes(s)) out = out.split(s).join('[redacted]')
      return out
    }
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    return v
  }
  return walk(value) as T
}

/** Notes reach the panel up to this length (cut after scrubbing). */
export const NOTES_MAX = 2000

/**
 * The snapshot as it may leave the worker: known secrets out of every string, server text
 * (remote errors, per-host diagnostics, warnings, task status) scrubbed, then notes cut.
 */
export function outboundSnapshot(snap: EstateSnapshot, secrets: readonly string[]): EstateSnapshot {
  const s = redactDeep(snap, secrets)
  const line = (t: string, max = 300) => scrubLine(t, secrets, max)
  const cut = (t: string) => (t.length > NOTES_MAX ? `${t.slice(0, NOTES_MAX - 1)}…` : t)
  for (const r of s.remotes) if (r.error) r.error = line(r.error)
  for (const h of s.hosts) {
    if (h.detailError) h.detailError = line(h.detailError)
    if (h.notes) h.notes = cut(h.notes.replace(CONTROL, ' '))
  }
  for (const g of s.guests) if (g.notes) g.notes = cut(g.notes.replace(CONTROL, ' '))
  s.warnings = s.warnings.map((w) => line(w, 400))
  if (s.backups.error) s.backups.error = line(s.backups.error, 400)
  if (s.backups.incomplete) s.backups.incomplete = line(s.backups.incomplete, 400)
  for (const t of s.tasks ?? []) if (t.status) t.status = line(t.status, 200)
  if (s.orca?.error) s.orca.error = line(s.orca.error)
  if (s.orca?.warnings) s.orca.warnings = s.orca.warnings.map((w) => line(w))
  return s
}
