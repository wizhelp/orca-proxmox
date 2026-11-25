// Line icons on a 24×24 grid, drawn with the current text colour. Path data from the Lucide icon
// set (ISC licence, some icons MIT via Feather): see THIRD_PARTY_NOTICES.md for both notices.

type Shape = ['path', string] | ['circle', number, number, number] | ['rect', number, number, number, number, number]

const ICONS: Record<string, Shape[]> = {
  gauge: [['path', 'm12 14 4-4'], ['path', 'M3.34 19a10 10 0 1 1 17.32 0']],
  layers: [['path', 'M12 2 2 7l10 5 10-5-10-5z'], ['path', 'm2 17 10 5 10-5'], ['path', 'm2 12 10 5 10-5']],
  download: [['path', 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4'], ['path', 'm7 10 5 5 5-5'], ['path', 'M12 15V3']],
  bot: [['rect', 3, 11, 18, 10, 2], ['circle', 12, 5, 2], ['path', 'M12 7v4'], ['path', 'M8 16h.01'], ['path', 'M16 16h.01']],
  settings: [
    ['path', 'M4 21v-7'], ['path', 'M4 10V3'], ['path', 'M12 21v-9'], ['path', 'M12 8V3'], ['path', 'M20 21v-5'], ['path', 'M20 12V3'],
    ['path', 'M1 14h6'], ['path', 'M9 8h6'], ['path', 'M17 16h6']
  ],
  database: [['path', 'M3 5c0 1.66 4 3 9 3s9-1.34 9-3-4-3-9-3-9 1.34-9 3z'], ['path', 'M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5'], ['path', 'M3 12c0 1.66 4 3 9 3s9-1.34 9-3']],
  cloud: [['path', 'M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z']],
  server: [['rect', 2, 2, 20, 8, 2], ['rect', 2, 14, 20, 8, 2], ['path', 'M6 6h.01'], ['path', 'M6 18h.01']],
  monitor: [['rect', 2, 3, 20, 14, 2], ['path', 'M8 21h8'], ['path', 'M12 17v4']],
  box: [
    ['path', 'M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z'],
    ['path', 'm3.3 7 8.7 5 8.7-5'],
    ['path', 'M12 22V12']
  ],
  drive: [
    ['path', 'M22 12H2'],
    ['path', 'M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z'],
    ['path', 'M6 16h.01'],
    ['path', 'M10 16h.01']
  ],
  refresh: [['path', 'M21 12a9 9 0 1 1-3-6.7L21 8'], ['path', 'M21 3v5h-5']],
  alert: [['path', 'M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z'], ['path', 'M12 9v4'], ['path', 'M12 17h.01']],
  check: [['path', 'M20 6 9 17l-5-5']],
  x: [['path', 'M18 6 6 18'], ['path', 'm6 6 12 12']],
  search: [['circle', 11, 11, 8], ['path', 'm21 21-4.3-4.3']],
  chevronRight: [['path', 'm9 18 6-6-6-6']],
  chevronDown: [['path', 'm6 9 6 6 6-6']],
  plug: [['path', 'M12 22v-5'], ['path', 'M9 8V2'], ['path', 'M15 8V2'], ['path', 'M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z']],
  trash: [['path', 'M3 6h18'], ['path', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6'], ['path', 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2']],
  clock: [['circle', 12, 12, 10], ['path', 'M12 6v6l4 2']],
  link: [
    ['path', 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71'],
    ['path', 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71']
  ],
  branch: [['path', 'M6 3v12'], ['circle', 18, 6, 3], ['circle', 6, 18, 3], ['path', 'M18 9a9 9 0 0 1-9 9']],
  archive: [['rect', 2, 3, 20, 5, 1], ['path', 'M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8'], ['path', 'M10 12h4']],
  grid: [['rect', 3, 3, 7, 7, 1], ['rect', 14, 3, 7, 7, 1], ['rect', 3, 14, 7, 7, 1], ['rect', 14, 14, 7, 7, 1]],
  tree: [['path', 'M3 5h4'], ['path', 'M7 5v14'], ['path', 'M7 12h4'], ['path', 'M7 19h4'], ['rect', 11, 9, 10, 6, 1], ['rect', 11, 16, 10, 6, 1], ['rect', 1, 2, 6, 6, 1]],
  activity: [['path', 'M22 12h-4l-3 9L9 3l-3 9H2']],
  copy: [['rect', 8, 8, 14, 14, 2], ['path', 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2']],
  external: [['path', 'M15 3h6v6'], ['path', 'M10 14 21 3'], ['path', 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6']],
  terminal: [['path', 'm4 17 6-6-6-6'], ['path', 'M12 19h8']],
  tag: [['path', 'M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z'], ['circle', 7.5, 7.5, 1]],
  hash: [['path', 'M4 9h16'], ['path', 'M4 15h16'], ['path', 'M10 3 8 21'], ['path', 'M16 3l-2 18']],
  note: [['path', 'M15.5 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3Z'], ['path', 'M15 3v6h6']],
  sparkles: [['path', 'M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2z'], ['path', 'M19 3v4'], ['path', 'M21 5h-4']],
  update: [['circle', 12, 12, 10], ['path', 'm16 12-4-4-4 4'], ['path', 'M12 16V8']],
  target: [['circle', 12, 12, 10], ['circle', 12, 12, 6], ['circle', 12, 12, 2]],
  undo: [['path', 'M3 7v6h6'], ['path', 'M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13']]
}

export type IconName = keyof typeof ICONS

const SVG = 'http://www.w3.org/2000/svg'

export function icon(name: IconName, size = 14, className = 'icon'): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('class', className)
  for (const shape of ICONS[name] ?? []) {
    const node = document.createElementNS(SVG, shape[0])
    if (shape[0] === 'path') node.setAttribute('d', shape[1])
    else if (shape[0] === 'circle') {
      node.setAttribute('cx', String(shape[1]))
      node.setAttribute('cy', String(shape[2]))
      node.setAttribute('r', String(shape[3]))
    } else {
      const [, x, y, w, hgt, r] = shape
      node.setAttribute('x', String(x))
      node.setAttribute('y', String(y))
      node.setAttribute('width', String(w))
      node.setAttribute('height', String(hgt))
      node.setAttribute('rx', String(r))
    }
    svg.appendChild(node)
  }
  return svg
}

/** The six-dot drag grip. */
export function grip(): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('viewBox', '0 0 10 16')
  svg.setAttribute('width', '8')
  svg.setAttribute('height', '14')
  svg.setAttribute('fill', 'currentColor')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('class', 'grip-dots')
  for (const [x, y] of [[2, 2], [8, 2], [2, 8], [8, 8], [2, 14], [8, 14]]) {
    const dot = document.createElementNS(SVG, 'circle')
    dot.setAttribute('cx', String(x))
    dot.setAttribute('cy', String(y))
    dot.setAttribute('r', '1.5')
    svg.appendChild(dot)
  }
  return svg
}
