// Small charts: sparklines for the last hour, meters for current use, a stacked bar for counts.
// The geometry (sparkPath) is pure and tested; the rest only wraps it in SVG.
import { h } from './dom'
import type { Tone } from './logic'

const SVG = 'http://www.w3.org/2000/svg'

export type SparkGeometry = {
  /** Line path through the recorded points; gaps (null) break it. */
  line: string
  /** Same, closed to the baseline, for the soft fill. */
  area: string
  last?: { x: number; y: number }
}

/**
 * Path data for `values` drawn in a `width`×`height` box, `max` at the top. A null breaks the line,
 * so a gap in the history shows as a gap.
 */
export function sparkPath(values: readonly (number | null)[], width: number, height: number, max: number): SparkGeometry {
  const n = values.length
  const top = 1
  const usable = height - 2
  const x = (i: number) => (n <= 1 ? width : (i / (n - 1)) * width)
  const y = (v: number) => top + usable - Math.min(1, Math.max(0, max > 0 ? v / max : 0)) * usable
  const runs: { x: number; y: number }[][] = []
  let run: { x: number; y: number }[] = []
  values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) {
      if (run.length) runs.push(run)
      run = []
    } else run.push({ x: x(i), y: y(v) })
  })
  if (run.length) runs.push(run)
  const fmt = (p: { x: number; y: number }) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`
  const line = runs.map((r) => `M${r.map(fmt).join('L')}`).join('')
  const base = (top + usable).toFixed(1)
  const area = runs.map((r) => `M${r[0].x.toFixed(1)},${base}L${r.map(fmt).join('L')}L${r[r.length - 1].x.toFixed(1)},${base}Z`).join('')
  const lastRun = runs[runs.length - 1]
  return { line, area, last: lastRun ? lastRun[lastRun.length - 1] : undefined }
}

/** The scale top for a series: shares get at least `floor`, so a quiet host is not a flat line at the top. */
export function scaleMax(values: readonly (number | null)[], kind: 'share' | 'fixed' | 'auto', floor = 0.05): number {
  const real = values.filter((v): v is number => v !== null && Number.isFinite(v))
  const peak = real.length ? Math.max(...real) : 0
  if (kind === 'fixed') return 1
  if (kind === 'share') return Math.min(1, Math.max(floor, peak * 1.15))
  return peak > 0 ? peak * 1.15 : 1
}

export function sparkline(
  values: readonly (number | null)[] | undefined,
  opts: { label: string; tone?: 'cpu' | 'mem' | 'net' | 'disk'; width?: number; height?: number; max?: number }
): SVGSVGElement | HTMLElement {
  const width = opts.width ?? 72
  const height = opts.height ?? 18
  if (!values || values.every((v) => v === null)) {
    return h('span', { class: 'spark-empty', style: `width:${width}px;height:${height}px`, title: `${opts.label}: no history yet` })
  }
  const max = opts.max ?? scaleMax(values, opts.tone === 'mem' || opts.tone === 'disk' ? 'fixed' : opts.tone === 'net' ? 'auto' : 'share')
  const geo = sparkPath(values, width, height, max)
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
  svg.setAttribute('width', String(width))
  svg.setAttribute('height', String(height))
  svg.setAttribute('class', `spark spark-${opts.tone ?? 'cpu'}`)
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', opts.label)
  const title = document.createElementNS(SVG, 'title')
  title.textContent = opts.label
  const area = document.createElementNS(SVG, 'path')
  area.setAttribute('d', geo.area)
  area.setAttribute('class', 'spark-area')
  const line = document.createElementNS(SVG, 'path')
  line.setAttribute('d', geo.line)
  line.setAttribute('class', 'spark-line')
  svg.append(title, area, line)
  if (geo.last) {
    const dot = document.createElementNS(SVG, 'circle')
    dot.setAttribute('cx', geo.last.x.toFixed(1))
    dot.setAttribute('cy', geo.last.y.toFixed(1))
    dot.setAttribute('r', '1.8')
    dot.setAttribute('class', 'spark-dot')
    svg.appendChild(dot)
  }
  return svg
}

/**
 * A thin bar: `fraction` filled. For use, amber past 80 % and red past 90 %; for free space
 * (`kind: 'free'`), green, amber under 20 % and red under 10 %.
 */
export function meter(fraction: number | undefined, label: string, width?: number, kind: 'used' | 'free' = 'used'): HTMLElement {
  const f = fraction === undefined || !Number.isFinite(fraction) ? 0 : Math.min(1, Math.max(0, fraction))
  const level = kind === 'free' ? (f < 0.1 ? 'bad' : f < 0.2 ? 'warn' : 'free') : f >= 0.9 ? 'bad' : f >= 0.8 ? 'warn' : 'ok'
  return h(
    'span',
    { class: 'meter', style: width ? `width:${width}px` : undefined, role: 'meter', 'aria-label': label, 'aria-valuenow': Math.round(f * 100), 'aria-valuemin': 0, 'aria-valuemax': 100, title: label },
    h('span', { class: `meter-fill ${level}`, style: `width:${(f * 100).toFixed(1)}%` })
  )
}

/** Proportional segments, e.g. running vs stopped guests. */
export function stackBar(parts: { value: number; tone: Tone; label: string }[], width = 56): HTMLElement {
  const total = parts.reduce((n, p) => n + p.value, 0)
  const label = parts.map((p) => `${p.value} ${p.label}`).join(', ')
  return h(
    'span',
    { class: 'stackbar', style: `width:${width}px`, role: 'img', 'aria-label': label, title: label },
    parts
      .filter((p) => p.value > 0)
      .map((p) => h('span', { class: `stack-part ${p.tone}`, style: `width:${total ? ((p.value / total) * 100).toFixed(1) : 0}%` }))
  )
}

/** The last recorded value of a series. */
export function lastValue(values: readonly (number | null)[] | undefined): number | undefined {
  if (!values) return undefined
  for (let i = values.length - 1; i >= 0; i--) if (values[i] !== null) return values[i] as number
  return undefined
}
