// Settings: the connections. PDM, or Proxmox VE and Backup Servers reached directly, each with its
// own URL, token and pin. A secret goes straight to the worker, which keeps it in Orca's encrypted
// secrets; the panel never gets it back.
import type { ConnectionView, SourceKind } from '../model'
import type { ConnectionInput } from '../protocol'
import { actions, app, failure } from './app'
import { h } from './dom'
import { icon } from './icons'
import { button, callout, chip, errorCallout, select } from './parts'

const KIND_LABEL: Record<SourceKind, string> = { pdm: 'Proxmox Datacenter Manager', pve: 'Proxmox VE', pbs: 'Proxmox Backup Server' }
const KIND_SHORT: Record<SourceKind, string> = { pdm: 'PDM', pve: 'PVE', pbs: 'PBS' }
const PLACEHOLDER: Record<SourceKind, { url: string; token: string; port: string }> = {
  pdm: { url: 'https://pdm.example.com:8443', token: 'monitor@pdm!orca', port: '8443' },
  pve: { url: 'https://pve.example.com:8006', token: 'monitor@pve!orca', port: '8006' },
  pbs: { url: 'https://pbs.example.com:8007', token: 'monitor@pbs!orca', port: '8007' }
}

function edit(patch: Partial<ConnectionInput>): void {
  app.form = { ...app.form, ...patch }
  app.formDirty = true
  app.testResult = null
  app.settingsMessage = null
  actions.render()
}

const connections = (): ConnectionView[] => app.config?.connections ?? []
const editing = (): ConnectionView | undefined => connections().find((c) => c.id === app.form.id)

/** Fills the form with a connection (by id), the first one, or a new one of `kind`. */
export function fillForm(id?: string, kind: SourceKind = 'pdm'): void {
  const list = connections()
  const c = id === 'new' ? undefined : (list.find((x) => x.id === (id ?? app.form.id)) ?? (id ? undefined : list[0]))
  app.form = c
    ? { id: c.id, kind: c.kind, name: c.name ?? '', baseUrl: c.baseUrl, tokenId: c.tokenId, fingerprint: c.fingerprint, secret: '' }
    : { id: 'new', kind, name: '', baseUrl: '', tokenId: '', fingerprint: '', secret: '' }
  app.formDirty = false
  app.testResult = null
}

async function run(kind: 'test' | 'save' | 'clear' | 'import'): Promise<void> {
  app.busy = kind
  app.settingsMessage = null
  actions.render()
  try {
    if (kind === 'import') {
      const answer = await orca.plugin.request('config.import', undefined, { timeoutMs: 60000 })
      const { found, ...config } = answer
      app.config = config
      fillForm()
      if (!found) app.settingsMessage = { tone: 'off', text: `No import file at ${config.importPath}.` }
      else if (config.importStatus?.ok) {
        actions.discardRefresh()
        app.snap = null
        app.response = null
        actions.setTab('hosts')
        await actions.refresh(true)
      }
    } else if (kind === 'test') {
      app.testResult = await orca.plugin.request('connection.test', app.form, { timeoutMs: 60000 })
    } else if (kind === 'save') {
      const wasNew = app.form.id === 'new'
      const before = new Set(connections().map((c) => c.id))
      app.config = await orca.plugin.request('config.save', app.form)
      // Keep editing what was just saved (a new connection now has its id).
      const savedId = wasNew ? app.config.connections.find((c) => !before.has(c.id))?.id : app.form.id
      fillForm(savedId)
      const saved = editing()
      app.settingsMessage = { tone: 'ok', text: saved?.hasSecret ? 'Saved.' : 'Saved. Enter the token secret to connect.' }
      app.snap = null
      app.response = null
      if (app.config.connections.length && app.config.connections.every((c) => c.hasSecret)) {
        actions.setTab('hosts')
        await actions.refresh(true)
      }
    } else {
      const id = app.form.id && app.form.id !== 'new' ? app.form.id : undefined
      app.config = await orca.plugin.request('config.clear', id ? { id } : {})
      actions.discardRefresh()
      fillForm()
      app.snap = null
      app.response = null
      app.testResult = null
      app.settingsMessage = { tone: 'off', text: 'The connection and its token secret were removed.' }
      if (app.config.connections.length) await actions.refresh(true)
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

const HELP: Record<SourceKind, [string, string][]> = {
  pdm: [
    ['Create a token', 'In Proxmox Datacenter Manager: Configuration → Access Control → API Token. Add one for a user, e.g. monitor@pdm!orca, and copy the secret: PDM shows it once.'],
    ['Make it read-only', 'Under Permissions, add the Auditor role on /resource (or per remote, /resource/<remote>) for both the user and the token. It can then read but never change anything.'],
    ['Pin the certificate', 'Copy the SHA-256 fingerprint from Certificates and paste it below.']
  ],
  pve: [
    ['Create a token', 'In Proxmox VE: Datacenter → Permissions → API Tokens. Add one for a user, e.g. monitor@pve!orca, and copy the secret: PVE shows it once.'],
    ['Make it read-only', 'Under Permissions, add the PVEAuditor role on / for the user and, with privilege separation on, for the token too. On PVE 9 that role also lets the plugin ask VMs’ guest agents for their disk use (turn “Disk use inside VMs” off in Orca’s plugin settings, or use a role without VM.GuestAgent.Audit, to keep it out).'],
    ['One cluster per connection', 'A PVE shows its own cluster (or node) only: add each standalone host as its own connection.'],
    ['Pin the certificate', 'Copy the SHA-256 fingerprint of the node’s certificate (System → Certificates) and paste it below.']
  ],
  pbs: [
    ['Create a token', 'In Proxmox Backup Server: Configuration → Access Control → API Token. Add one, e.g. monitor@pbs!orca, and copy the secret.'],
    ['Make it read-only', 'Under Permissions, add the Audit role on / for the user and the token (or DatastoreAudit on /datastore for backups only).'],
    ['Pin the certificate', 'Copy the fingerprint from the Dashboard (Show Fingerprint) and paste it below.']
  ]
}

function connectionRow(c: ConnectionView): HTMLElement {
  const current = app.form.id === c.id
  let host = c.baseUrl
  try {
    host = new URL(c.baseUrl).host
  } catch {
    // shown as saved
  }
  return h(
    'li',
    { class: `conn-row${current ? ' current' : ''}` },
    h('span', { class: 'conn-kind' }, chip(KIND_SHORT[c.kind], c.kind === 'pdm' ? 'info' : 'plain')),
    h('span', { class: 'conn-name' }, h('strong', null, c.name || host), c.name ? h('span', { class: 'muted small' }, ` ${host}`) : null, h('div', { class: 'muted small' }, c.tokenId)),
    c.fingerprint ? chip('pinned', 'ok') : null,
    c.hasSecret ? null : chip('no secret', 'warn'),
    current ? chip('editing', 'plain') : button('Edit', () => (fillForm(c.id), actions.render()), { icon: 'settings', variant: 'ghost' })
  )
}

export function settingsView(): HTMLElement {
  const f = app.form
  const kind: SourceKind = f.kind ?? 'pdm'
  const cfg = app.config
  const list = connections()
  const current = editing()
  const isNew = !current
  const hasSecret = current?.hasSecret ?? false
  const test = app.testResult
  const busy = app.busy
  const ph = PLACEHOLDER[kind]
  const unit = test?.ok ? (test.unit === 'nodes' ? 'node' : test.unit === 'datastores' ? 'datastore' : 'remote') : 'remote'
  return h(
    'div',
    { class: 'view stack settings' },
    list.length
      ? h(
          'section',
          { class: 'connections' },
          h('h3', null, 'Connections'),
          h('ul', { class: 'conn-list' }, list.map(connectionRow)),
          isNew ? null : h('div', { class: 'toolbar' }, button('Add a connection', () => (fillForm('new', 'pve'), actions.render()), { icon: 'plug', variant: 'ghost' }))
        )
      : null,
    h('h3', null, isNew ? (list.length ? 'New connection' : 'Connect') : `Edit ${current?.name || KIND_SHORT[current!.kind]} connection`),
    isNew
      ? field(
          'set-kind',
          'Connect to',
          'PDM shows every remote it manages. Without PDM, add each Proxmox VE cluster or host and each Backup Server directly.',
          select(
            'set-kind',
            'Connect to',
            kind,
            (['pdm', 'pve', 'pbs'] as SourceKind[]).filter((k) => k !== 'pdm' || !list.some((c) => c.kind === 'pdm')).map((k) => ({ value: k, label: KIND_LABEL[k] })),
            (v) => edit({ kind: v as SourceKind, name: v === 'pdm' ? '' : f.name })
          )
        )
      : null,
    kind !== 'pdm'
      ? field('set-name', 'Name (optional)', `How this ${KIND_SHORT[kind]} appears in the estate; else the host name of its URL. Letters, digits, ".", "_" and "-".`, text('set-name', f.name ?? '', kind === 'pve' ? 'lab' : 'backup', (v) => edit({ name: v })))
      : null,
    field('set-url', 'Base URL', `${KIND_LABEL[kind]}, usually https://host:${ph.port}`, text('set-url', f.baseUrl, ph.url, (v) => edit({ baseUrl: v }))),
    field('set-token', 'API token ID', 'user@realm!tokenname', text('set-token', f.tokenId, ph.token, (v) => edit({ tokenId: v }))),
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
      current ? button('Remove', () => void run('clear'), { icon: 'trash', variant: 'danger', disabled: busy !== null }) : null,
      isNew && list.length ? button('Cancel', () => (fillForm(list[0].id), actions.render()), { variant: 'ghost', disabled: busy !== null }) : null
    ),
    app.settingsMessage ? h('div', { class: `${app.settingsMessage.tone}-text`, role: 'status' }, app.settingsMessage.text) : null,
    test?.ok
      ? callout(
          'ok',
          'Connected',
          `${KIND_LABEL[kind]} ${test.version}; the token sees ${test.remotes} ${unit}${test.remotes === 1 ? '' : 's'}.${test.remotes === 0 ? ` Give it the ${kind === 'pdm' ? 'Auditor role on /resource' : kind === 'pve' ? 'PVEAuditor role on /' : 'Audit role on /'} to see your estate.` : ''}`
        )
      : test
        ? errorCallout(test.error, { pin: pinFingerprint, openSettings: () => actions.setTab('settings') })
        : null,
    // The last import's outcome, for a day.
    cfg?.importStatus && Date.now() - cfg.importStatus.at < 86_400_000
      ? callout(cfg.importStatus.ok ? 'ok' : 'bad', cfg.importStatus.ok ? 'Imported from a file' : 'The import file was not imported', `${cfg.importStatus.message} (${new Date(cfg.importStatus.at).toLocaleString()})`, cfg.importStatus.file ? h('div', { class: 'small' }, cfg.importStatus.file) : null)
      : null,
    h(
      'details',
      { class: 'fold' },
      h('summary', null, icon('download', 14), ' Set up from a file (for agents and scripts)'),
      h(
        'p',
        { class: 'muted small' },
        'Write a connection as JSON (baseUrl, tokenId, fingerprint, secret, and kind "pve" or "pbs" for a direct one) to this file, readable by you only. Write it to a temporary name, then rename it into place. The plugin imports it when it starts, on the command “Proxmox: Import the connection file”, or here; a connection to the same URL is replaced, another one added, and nothing changes unless the imported one passes a connection test. Then the file is deleted. See docs/AGENT_SETUP.md.'
      ),
      h('code', { class: 'path small' }, cfg?.importPath ?? ''),
      h('div', { class: 'toolbar' }, button(busy === 'import' ? 'Importing…' : 'Import now', () => void run('import'), { icon: 'download', disabled: busy !== null }))
    ),
    h(
      'details',
      { class: 'fold', open: !list.length },
      h('summary', null, icon('settings', 14), ` How to create a read-only ${KIND_SHORT[kind]} token`),
      h('ol', { class: 'help' }, HELP[kind].map(([title, body]) => h('li', null, h('strong', null, title), ': ', body)))
    )
  )
}
