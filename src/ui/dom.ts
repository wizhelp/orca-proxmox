// A tiny element builder. Text is always set as text: names from Proxmox or Orca never become HTML.

export type Child = Node | string | number | null | undefined | false | Child[]

type Handler = (event: never) => void
export type Props = {
  class?: string
  style?: string
  title?: string
  dataset?: Record<string, string>
  /** Properties set directly: value, checked, disabled, type, placeholder, tabIndex, id, htmlFor… */
  [key: string]: unknown
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    if (Array.isArray(child)) append(parent, child)
    else parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)))
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') node.className = String(value)
    else if (key === 'style') node.style.cssText = String(value)
    else if (key === 'dataset') Object.assign(node.dataset, value)
    else if (/^on[A-Z]/.test(key)) node.addEventListener(key.slice(2).toLowerCase(), value as Handler as EventListener)
    else if (key.startsWith('aria-') || key === 'role' || key === 'for') node.setAttribute(key, String(value))
    else (node as unknown as Record<string, unknown>)[key] = value
  }
  append(node, children)
  return node
}

/** `class` from a list, skipping falsy entries. */
export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(' ')
}
