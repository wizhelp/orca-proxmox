// Small actions on a host or guest: copy an address, VMID or ssh command, open it in PDM or the
// Proxmox web interface, open an Orca terminal where Orca runs. Nothing here writes to Proxmox.
import type { EstateSnapshot, Guest, Host } from '../model'
import type { OrcaPresence } from '../presence'
import { consoleLink, guestAddress, guestSsh, hostAddress, hostSsh, pdmLink, proxmoxLink } from '../features/links'
import { safeTarget } from '../features/targets'
import { app } from './app'
import { h } from './dom'
import { icon, type IconName } from './icons'

let toastTimer: ReturnType<typeof setTimeout> | undefined

/** A short message at the bottom of the panel. */
export function toast(text: string, tone: 'ok' | 'bad' = 'ok', ms = 1800): void {
  let node = document.getElementById('toast')
  if (!node) {
    node = h('div', { id: 'toast', role: 'status', 'aria-live': 'polite' })
    document.body.appendChild(node)
  }
  node.className = `toast ${tone} show`
  node.textContent = text
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => node!.classList.remove('show'), ms)
}

/** Copies text; the clipboard API first, the selection fallback where a frame refuses it. */
export async function copyText(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast(`Copied ${what}`)
    return
  } catch {
    // Fall through: some frames block the async clipboard.
  }
  const area = h('textarea', { value: text, style: 'position:fixed;left:-9999px;top:0', 'aria-hidden': 'true' })
  document.body.appendChild(area)
  area.select()
  const ok = document.execCommand('copy')
  area.remove()
  if (ok) toast(`Copied ${what}`)
  else showForCopy(text, what)
}

/** Where the clipboard is refused: the text, selected, to copy by hand. */
function showForCopy(text: string, what: string): void {
  document.getElementById('copy-dialog')?.remove()
  const area = h('textarea', { class: 'copy-area', readOnly: true, value: text, 'aria-label': what })
  const close = () => dialog.remove()
  const dialog = h(
    'div',
    { id: 'copy-dialog', class: 'copy-dialog', role: 'dialog', 'aria-label': `Copy ${what}`, onKeydown: (e: KeyboardEvent) => e.key === 'Escape' && close() },
    h('div', { class: 'copy-head' }, h('strong', null, `Copy ${what}`), h('span', { class: 'muted small' }, 'Press Ctrl+C (⌘C), then close.')),
    area,
    h('button', { type: 'button', class: 'btn', onClick: close }, 'Close')
  )
  document.body.appendChild(dialog)
  area.focus()
  area.select()
}

/** Opens a URL in the default browser (Orca asks before a new host). */
export async function openLink(url: string): Promise<void> {
  try {
    const shell = (orca as unknown as { shell?: { openExternal(u: string): Promise<{ opened: boolean }> } }).shell
    if (shell) {
      const result = await shell.openExternal(url)
      if (!result.opened) toast('Not opened', 'bad')
      return
    }
  } catch (error) {
    toast(`Could not open the link: ${error instanceof Error ? error.message : String(error)}`, 'bad')
    return
  }
  window.open(url, '_blank', 'noopener')
}

/** Opens a terminal on the machine an Orca host runs on, through the worker. */
export async function openTerminal(hostKey: string, label: string): Promise<void> {
  try {
    const answer = await orca.plugin.request('orca.terminal', { hostKey, title: label, scope: app.snap?.connectionId ?? '' }, { timeoutMs: 60000 })
    if (answer.navigated) toast(answer.how === 'workspace' ? `Terminal opened on ${label}` : `Terminal opened with ssh to ${label}`)
    else toast(`Terminal started on ${label}, but Orca did not switch to it: open ${answer.where}`, 'bad', 8000)
  } catch (error) {
    toast(`No terminal: ${error instanceof Error ? error.message : String(error)}`, 'bad')
  }
}

function mini(label: string, iconName: IconName, title: string, run: () => void): HTMLButtonElement {
  return h('button', { type: 'button', class: 'btn mini', title, onClick: (e: MouseEvent) => (e.stopPropagation(), run()) }, icon(iconName, 12), label)
}

/** Whether PDM has a page for this remote: not for one reached directly. */
function inPdm(snap: EstateSnapshot, remote: string): boolean {
  return !snap.remotes.find((r) => r.id === remote)?.direct
}

function bar(buttons: (HTMLButtonElement | null)[]): HTMLElement {
  return h('div', { class: 'actions', role: 'toolbar', 'aria-label': 'Actions' }, buttons)
}

export function hostActions(snap: EstateSnapshot, host: Host, presence: OrcaPresence | undefined): HTMLElement {
  const ip = hostAddress(host)
  const ssh = hostSsh(host)
  const pdm = inPdm(snap, host.remote) ? pdmLink(snap.pdmUrl, host.remote, host.remoteType === 'pve' ? { node: host.node } : undefined) : undefined
  const web = proxmoxLink(snap, { host })
  const orcaHost = presence?.hosts[0]
  return bar([
    ip ? mini('IP', 'copy', `Copy ${ip}`, () => void copyText(ip, ip)) : null,
    ssh ? mini('SSH', 'terminal', `Copy: ${ssh}`, () => void copyText(ssh, 'the ssh command')) : null,
    pdm ? mini('PDM', 'external', `Open in Proxmox Datacenter Manager: ${pdm}`, () => void openLink(pdm)) : null,
    web ? mini(host.remoteType === 'pbs' ? 'PBS' : 'PVE', 'external', `Open in the Proxmox web interface: ${web}`, () => void openLink(web)) : null,
    orcaHost ? mini('Terminal', 'terminal', `Open an Orca terminal on ${orcaHost.name}`, () => void openTerminal(orcaHost.key, orcaHost.name)) : null
  ])
}

export function guestActions(snap: EstateSnapshot, guest: Guest, presence: OrcaPresence | undefined): HTMLElement {
  const host = snap.hosts.find((x) => x.remote === guest.remote && x.node === guest.node)
  const ips = (guest.addresses ?? []).filter((a) => safeTarget(a) === a)
  const ip = guestAddress(guest)
  const ssh = guestSsh(guest, host)
  const pdm = inPdm(snap, guest.remote) ? pdmLink(snap.pdmUrl, guest.remote, { vmid: guest.vmid }) : undefined
  const web = proxmoxLink(snap, { guest })
  const consoleUrl = guest.status === 'running' ? consoleLink(snap, guest) : undefined
  const orcaHost = presence?.hosts[0]
  return bar([
    ip ? mini('IP', 'copy', `Copy ${ips.join(', ')}`, () => void copyText(ips.join(' '), ips.length > 1 ? 'the addresses' : ip)) : null,
    mini('VMID', 'hash', `Copy ${guest.vmid}`, () => void copyText(String(guest.vmid), `VMID ${guest.vmid}`)),
    ssh ? mini('SSH', 'terminal', `Copy: ${ssh}`, () => void copyText(ssh, 'the ssh command')) : null,
    pdm ? mini('PDM', 'external', `Open in Proxmox Datacenter Manager: ${pdm}`, () => void openLink(pdm)) : null,
    web ? mini('PVE', 'external', `Open in the Proxmox web interface: ${web}`, () => void openLink(web)) : null,
    consoleUrl ? mini('Console', 'monitor', 'Open the console in the Proxmox web interface', () => void openLink(consoleUrl)) : null,
    orcaHost ? mini('Terminal', 'terminal', `Open an Orca terminal on ${orcaHost.name}`, () => void openTerminal(orcaHost.key, orcaHost.name)) : null
  ])
}
