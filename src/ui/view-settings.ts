// Settings: the PDM connection. The secret goes straight to the worker, which keeps it in Orca's
// encrypted secrets; the panel never gets it back.
import type { ConnectionInput } from '../protocol'
import { actions, app, failure } from './app'
import { h } from './dom'
import { icon } from './icons'
import { button, callout, errorCallout } from './parts'

function edit(patch: Partial<ConnectionInput>): void {
  app.form = { ...app.form, ...patch }
  app.formDirty = true
  app.testResult = null
  app.settingsMessage = null
  actions.render()
}

export function fillForm(): void {
  const c = app.config?.connection
  app.form = { baseUrl: c?.baseUrl ?? '', tokenId: c?.tokenId ?? '', fingerprint: c?.fingerprint ?? '', secret: '' }
  app.formDirty = false
}

async function run(kind: 'test' | 'save' | 'clear'): Promise<void> {
  app.busy = kind
  app.settingsMessage = null
  actions.render()
  try {
    if (kind === 'test') {
      app.testResult = await orca.plugin.request('connection.test', app.form, { timeoutMs: 60000 })
    } else if (kind === 'save') {
      app.config = await orca.plugin.request('config.save', app.form)
      fillForm()
      app.settingsMessage = { tone: 'ok', text: app.config.connection?.hasSecret ? 'Saved.' : 'Saved. Enter the token secret to connect.' }
      app.snap = null
      app.response = null
      if (app.config.connection?.hasSecret) {
        actions.setTab('hosts')
        await actions.refresh(true)
      }
    } else {
      app.config = await orca.plugin.request('config.clear')
      actions.discardRefresh()
      fillForm()
      app.snap = null
      app.response = null
      app.testResult = null
      app.settingsMessage = { tone: 'off', text: 'The connection and its token secret were removed.' }
    }
  } catch (error) {
    app.settingsMessage = { tone: 'bad', text: failure(error) }
  } finally {
    app.busy = null
    actions.render()
  }
}

/** Puts a presented fingerprint into the form; the person still compares it and saves. */
export function pinFingerprint(fingerprint: string): void {
  edit({ fingerprint })
  actions.setTab('settings')
}

function field(id: string, label: string, help: string, input: HTMLElement): HTMLElement {
  return h('div', { class: 'field' }, h('label', { for: id }, label), input, h('div', { class: 'muted small' }, help))
}

function text(id: string, value: string, placeholder: string, onInput: (v: string) => void, type = 'text'): HTMLInputElement {
  return h('input', { id, type, value, placeholder, autocomplete: 'off', spellcheck: false, onInput: (e: Event) => onInput((e.target as HTMLInputElement).value) })
}

const HELP: [string, string][] = [
  ['Create a token', 'In Proxmox Datacenter Manager: Configuration → Access Control → API Token. Add one for a user, e.g. monitor@pdm!orca, and copy the secret: PDM shows it once.'],
  ['Make it read-only', 'Under Permissions, add the Auditor role on /resource (or per remote, /resource/<remote>) for both the user and the token. It can then read but never change anything.'],
  ['Pin the certificate', 'Copy the SHA-256 fingerprint from Certificates and paste it below.']
]

export function settingsView(): HTMLElement {
  const f = app.form
  const cfg = app.config
  const hasSecret = cfg?.connection?.hasSecret ?? false
  const test = app.testResult
  const busy = app.busy
  return h(
    'div',
    { class: 'view stack settings' },
    field('set-url', 'Base URL', 'Proxmox Datacenter Manager, usually https://host:8443', text('set-url', f.baseUrl, 'https://pdm.example.com:8443', (v) => edit({ baseUrl: v }))),
    field('set-token', 'API token ID', 'user@realm!tokenname', text('set-token', f.tokenId, 'monitor@pdm!orca', (v) => edit({ tokenId: v }))),
    field(
      'set-secret',
      'API token secret',
      hasSecret ? 'A secret is stored in Orca’s encrypted secrets. Leave empty to keep it.' : 'Stored in Orca’s encrypted secrets, never in plugin storage or logs.',
      text('set-secret', f.secret ?? '', hasSecret ? '•••••••• (stored)' : 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx', (v) => edit({ secret: v }), 'password')
    ),
    field(
      'set-fp',
      'Pinned certificate fingerprint (SHA-256)',
      "Optional. Needed for Proxmox's default self-signed certificate; leave empty for a certificate from a trusted CA.",
      text('set-fp', f.fingerprint, 'AA:BB:CC:…', (v) => edit({ fingerprint: v }))
    ),
    cfg?.secretsProtection === 'unavailable'
      ? callout('bad', 'Orca cannot encrypt secrets on this machine', 'There is no OS keyring, so the token secret cannot be saved. This plugin will not store it in plain text.')
      : null,
    h(
      'div',
      { class: 'toolbar' },
      button(busy === 'save' ? 'Saving…' : 'Save', () => void run('save'), { icon: 'check', variant: 'primary', disabled: busy !== null }),
      button(busy === 'test' ? 'Testing…' : 'Test connection', () => void run('test'), { icon: 'plug', disabled: busy !== null }),
      cfg?.connection ? button('Remove', () => void run('clear'), { icon: 'trash', variant: 'danger', disabled: busy !== null }) : null
    ),
    app.settingsMessage ? h('div', { class: `${app.settingsMessage.tone}-text`, role: 'status' }, app.settingsMessage.text) : null,
    test?.ok
      ? callout('ok', 'Connected', `Proxmox Datacenter Manager ${test.version}; the token sees ${test.remotes} remote${test.remotes === 1 ? '' : 's'}.${test.remotes === 0 ? ' Give it the Auditor role on /resource to see your estate.' : ''}`)
      : test
        ? errorCallout(test.error, { pin: pinFingerprint, openSettings: () => actions.setTab('settings') })
        : null,
    h(
      'details',
      { class: 'fold', open: !cfg?.connection },
      h('summary', null, icon('settings', 14), ' How to create a read-only token'),
      h('ol', { class: 'help' }, HELP.map(([title, body]) => h('li', null, h('strong', null, title), ': ', body)))
    )
  )
}
