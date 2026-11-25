// Animated reordering by drag and drop, one level at a time.
//
// A container's direct children with `data-sort-key` are its items; they reorder only among
// themselves, so nothing can move to another level (another remote's nodes, another node's
// guests). While dragging:
//   - a "ghost" copy follows the pointer, see-through, lifted with a shadow, nudged to the side
//     and tilted a little, leaning further the way it is moved;
//   - the item itself stays in the list as a faded placeholder that slides to where it would land,
//     while its neighbours glide out of the way (FLIP animations);
//   - leaving the list far enough cancels: everything glides back.
// On release the ghost settles into place. Alt+↑/↓ moves the focused item the same way.
// Pointer events, so mouse, pen and touch behave alike (touch starts only on the grip, to keep
// scrolling). Motion is cut to nothing for people who ask for reduced motion.

export type SortableOptions = {
  container: HTMLElement
  /** Where a drag may start inside an item (default: anywhere except controls). */
  handle?: string
  /** The part of an item the ghost copies (default: the item), e.g. a tree row without its subtree. */
  ghostOf?: (item: HTMLElement) => HTMLElement
  /** The new order of the container's keys, after a drop that changed it. */
  onDrop: (keys: string[], moved: string) => void
}

const THRESHOLD = 4
/** Distance outside the list, in px, after which a release cancels. */
const OUTSIDE = 32
const EASE = 'cubic-bezier(.2,.8,.2,1)'
/** The sideways nudge and resting tilt of a lifted item. */
const NUDGE_X = 6
const NUDGE_Y = 3
const TILT = 1.6

let active = false
let endedAt = 0

/** True right after a drag ended: the click that ends a drag is not a click on the item. */
export function recentlyDragged(): boolean {
  return Date.now() - endedAt < 350
}

/** Whether a drag is under way, anywhere: re-rendering then would pull the list from under it. */
export function isDragging(): boolean {
  return active
}

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
const duration = (ms: number) => (reducedMotion() ? 0 : ms)

/**
 * Where an item dragged to `y` lands among siblings whose vertical midpoints are `mids` (the
 * dragged item excluded, in order): the index of the first one below the pointer, else the end.
 */
export function dropIndex(mids: readonly number[], y: number): number {
  const i = mids.findIndex((mid) => y < mid)
  return i < 0 ? mids.length : i
}

function itemsOf(container: HTMLElement): HTMLElement[] {
  return Array.from(container.children).filter((c): c is HTMLElement => c instanceof HTMLElement && !!c.dataset.sortKey)
}

/** Runs `mutate` (a DOM move) and animates every item from where it was to where it is now. */
function flip(container: HTMLElement, mutate: () => void, ms = 180): void {
  const items = itemsOf(container)
  const before = new Map(items.map((el) => [el, el.getBoundingClientRect().top]))
  mutate()
  if (!duration(ms)) return
  for (const el of items) {
    const delta = (before.get(el) ?? 0) - el.getBoundingClientRect().top
    if (Math.abs(delta) < 0.5) continue
    el.animate([{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }], { duration: duration(ms), easing: EASE })
  }
}

const INTERACTIVE = 'button, input, select, textarea, a, summary, label, [contenteditable]'

export function makeSortable(opts: SortableOptions): void {
  const { container } = opts
  container.classList.add('sortable')

  container.addEventListener('keydown', (event) => {
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
    const item = (event.target as Element).closest<HTMLElement>('[data-sort-key]')
    if (!item || item.parentElement !== container) return
    event.preventDefault()
    event.stopPropagation()
    const items = itemsOf(container)
    const i = items.indexOf(item)
    const j = event.key === 'ArrowUp' ? i - 1 : i + 1
    if (j < 0 || j >= items.length) return
    flip(container, () => container.insertBefore(item, event.key === 'ArrowUp' ? items[j] : items[j].nextSibling))
    opts.onDrop(itemsOf(container).map((el) => el.dataset.sortKey!), item.dataset.sortKey!)
  })

  container.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || active) return
    const target = event.target as Element
    const item = target.closest<HTMLElement>('[data-sort-key]')
    if (!item || item.parentElement !== container) return
    if (target.closest(INTERACTIVE)) return
    if (opts.handle && !target.closest(opts.handle)) return
    // Touch and pen drag only by the grip, so the list still scrolls.
    if (event.pointerType !== 'mouse' && !target.closest('.grip')) return
    event.stopPropagation()
    track(item, event)
  })

  function track(item: HTMLElement, down: PointerEvent): void {
    const startX = down.clientX
    const startY = down.clientY
    const pointer = down.pointerId
    const originalNext = item.nextSibling
    const originalKeys = itemsOf(container).map((el) => el.dataset.sortKey!)
    let ghost: HTMLElement | null = null
    let origin: DOMRect | null = null
    let tilt = TILT
    /** Wide rows tilt less: the far end should dip a few pixels, not a few dozen. */
    let lean = 1
    let lastX = startX
    let outside = false

    const begin = () => {
      active = true
      const source = opts.ghostOf?.(item) ?? item
      origin = source.getBoundingClientRect()
      lean = Math.min(1, 320 / Math.max(1, origin.width))
      ghost = source.cloneNode(true) as HTMLElement
      ghost.classList.add('drag-ghost')
      ghost.removeAttribute('id')
      ghost.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'))
      Object.assign(ghost.style, {
        position: 'fixed',
        left: `${origin.left}px`,
        top: `${origin.top}px`,
        width: `${origin.width}px`,
        height: `${origin.height}px`,
        margin: '0',
        pointerEvents: 'none',
        zIndex: '1000',
        transformOrigin: `${startX - origin.left}px ${startY - origin.top}px`
      })
      document.body.appendChild(ghost)
      // Lift: from flat to see-through, nudged and tilted.
      ghost.animate(
        [
          { transform: 'translate(0,0) rotate(0deg) scale(1)', opacity: 1, boxShadow: '0 0 0 rgba(0,0,0,0)' },
          { transform: `translate(${NUDGE_X}px, ${NUDGE_Y}px) rotate(${(TILT * lean).toFixed(2)}deg) scale(1.02)`, opacity: 0.72, boxShadow: '0 10px 24px rgba(0,0,0,.22)' }
        ],
        { duration: duration(140), easing: EASE }
      )
      item.classList.add('drag-placeholder')
      document.body.classList.add('is-dragging')
      container.classList.add('drag-active')
      container.setPointerCapture?.(pointer)
    }

    const move = (event: PointerEvent) => {
      if (event.pointerId !== pointer) return
      if (!ghost) {
        if (Math.hypot(event.clientX - startX, event.clientY - startY) < THRESHOLD) return
        begin()
      }
      event.preventDefault()
      // Lean into the motion a little, then ease back to the resting tilt.
      const vx = event.clientX - lastX
      lastX = event.clientX
      const want = Math.max(-1.5, Math.min(4, TILT + vx * 0.3))
      tilt += (want - tilt) * 0.35
      ghost!.style.transform = `translate(${event.clientX - startX + NUDGE_X}px, ${event.clientY - startY + NUDGE_Y}px) rotate(${(tilt * lean).toFixed(2)}deg) scale(1.02)`
      ghost!.style.opacity = '0.72'

      const box = container.getBoundingClientRect()
      outside =
        event.clientY < box.top - OUTSIDE || event.clientY > box.bottom + OUTSIDE || event.clientX < box.left - OUTSIDE || event.clientX > box.right + OUTSIDE
      document.body.classList.toggle('drag-outside', outside)
      if (!outside) {
        const others = itemsOf(container).filter((el) => el !== item)
        const mids = others.map((el) => {
          const r = (opts.ghostOf?.(el) ?? el).getBoundingClientRect()
          return r.top + r.height / 2
        })
        const at = dropIndex(mids, event.clientY)
        const want = others[at] ?? null
        const items = itemsOf(container)
        const nextItem = items[items.indexOf(item) + 1] ?? null
        if (nextItem !== want) flip(container, () => container.insertBefore(item, want ?? lastItemNext(container)))
      }
      autoScroll(event.clientY)
    }

    let finished = false
    const finish = (commit: boolean) => {
      if (finished) return
      finished = true
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('pointerup', up, true)
      window.removeEventListener('pointercancel', cancel, true)
      window.removeEventListener('keydown', escape, true)
      container.removeEventListener('lostpointercapture', lost)
      if (!ghost) return
      endedAt = Date.now()
      const landing = ghost
      if (!commit || outside) flip(container, () => container.insertBefore(item, originalNext))
      const target = (opts.ghostOf?.(item) ?? item).getBoundingClientRect()
      const settle = landing.animate(
        [
          { transform: landing.style.transform, opacity: 0.72 },
          { transform: `translate(${target.left - origin!.left}px, ${target.top - origin!.top}px) rotate(0deg) scale(1)`, opacity: 1, boxShadow: '0 0 0 rgba(0,0,0,0)' }
        ],
        { duration: duration(200), easing: EASE, fill: 'forwards' }
      )
      const done = () => {
        landing.remove()
        item.classList.remove('drag-placeholder')
        document.body.classList.remove('is-dragging', 'drag-outside')
        container.classList.remove('drag-active')
        active = false
        const keys = itemsOf(container).map((el) => el.dataset.sortKey!)
        if (commit && !outside && keys.join('\n') !== originalKeys.join('\n')) opts.onDrop(keys, item.dataset.sortKey!)
      }
      settle.onfinish = done
      settle.oncancel = done
      if (!duration(200)) done()
    }
    const up = (event: PointerEvent) => {
      if (event.pointerId === pointer) finish(true)
    }
    const cancel = () => finish(false)
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && ghost) {
        event.preventDefault()
        finish(false)
      }
    }
    // Capture lost without a release (the frame lost the pointer): keep where it is now.
    const lost = () => finish(true)
    container.addEventListener('lostpointercapture', lost)
    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerup', up, true)
    window.addEventListener('pointercancel', cancel, true)
    window.addEventListener('keydown', escape, true)
  }
}

/** The node after the container's last item: items may be followed by other children. */
function lastItemNext(container: HTMLElement): ChildNode | null {
  const items = itemsOf(container)
  return items.length ? items[items.length - 1].nextSibling : null
}

function autoScroll(y: number): void {
  const edge = 36
  if (y < edge) window.scrollBy(0, -Math.ceil((edge - y) / 3))
  else if (y > window.innerHeight - edge) window.scrollBy(0, Math.ceil((y - (window.innerHeight - edge)) / 3))
}
