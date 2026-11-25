// Strict checks for the network targets PDM reports (node and guest addresses, hostnames). They
// end up in ssh commands and links, so anything that is not plainly an IP address or a DNS name
// is dropped where it is read, and checked again where a command is built. Pure.

/** Dotted IPv4, each octet 0-255, no leading zeros. */
export function isIpv4(value: string): boolean {
  const parts = value.split('.')
  return parts.length === 4 && parts.every((p) => /^(0|[1-9]\d{0,2})$/.test(p) && Number(p) <= 255)
}

/** IPv6 in its usual text forms (`::` once, an IPv4 tail allowed), no zone or brackets. */
export function isIpv6(value: string): boolean {
  if (value.length < 2 || value.length > 45 || !/^[0-9A-Fa-f:.]+$/.test(value) || !value.includes(':')) return false
  const halves = value.split('::')
  if (halves.length > 2) return false
  const groups = (half: string): string[] | null => {
    if (half === '') return []
    const list = half.split(':')
    return list.every((g) => g !== '') ? list : null
  }
  const head = groups(halves[0])
  const tail = halves.length === 2 ? groups(halves[1]) : []
  if (!head || !tail) return false
  const all = [...head, ...tail]
  let count = 0
  for (let i = 0; i < all.length; i++) {
    const g = all[i]
    if (i === all.length - 1 && g.includes('.')) {
      if (!isIpv4(g)) return false
      count += 2
    } else if (/^[0-9A-Fa-f]{1,4}$/.test(g)) count += 1
    else return false
  }
  return halves.length === 2 ? count < 8 : count === 8
}

export function isIp(value: string): boolean {
  return isIpv4(value) || isIpv6(value)
}

/** An RFC 1123 host or domain name: letters, digits and inner hyphens per label, 253 at most. */
export function isHostname(value: string): boolean {
  const name = value.endsWith('.') ? value.slice(0, -1) : value
  if (!name || name.length > 253) return false
  const labels = name.split('.')
  if (labels.every((l) => /^\d+$/.test(l))) return false // digits only: a malformed IPv4, not a name
  return labels.every((l) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(l))
}

/** The value when it is an IP address or a DNS name, else undefined. */
export function safeTarget(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const v = value.trim()
  return isIp(v) || isHostname(v) ? v : undefined
}

/** The value when it is an IP address, else undefined. */
export function safeIp(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const v = value.trim()
  return isIp(v) ? v : undefined
}

/** A Unix user name as ssh takes it. */
export function isUser(value: string): boolean {
  return /^[a-z_][a-z0-9_-]{0,31}$/.test(value)
}
