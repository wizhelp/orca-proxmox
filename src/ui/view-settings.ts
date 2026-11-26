// Settings: the connections. PDM, or Proxmox VE and Backup Servers reached directly, each with its
// own URL, token and pin. A secret goes straight to the worker, which keeps it in Orca's encrypted
// secrets; the panel never gets it back. The list is compact; a connection's form opens on Edit
// (or Add) and closes on Save or Cancel; the rest (import file, help, options) unfolds on click.
import type { ConnectionView, SourceKind } from '../model'
import type { ConnectionInput } from '../protocol'
import { actions, app, failure } from './app'
import { h } from './dom'
import { icon } from './icons'
import { ask, CONFIRM_MS, connectionTarget, mayAct, pending } from './confirm'
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
/** SSH host keys -> their fingerprints, as the worker showed them (a test, a saved connection). */
const sshFingerprints = new Map<string, string>()
const DEFAULT_TARGET: Record<SourceKind, string> = { pdm: '', pve: '127.0.0.1:8006', pbs: '127.0.0.1:8007' }
const editing = (): ConnectionView | undefined => connections().find((c) => c.id === app.form.id)

/** Fills the form with a connection (by id), the first one, or a new one of `kind`. */
export function fillForm(id?: string, kind: SourceKind = 'pdm'): void {
  const list = connections()
  const c = id === 'new' ? undefined : (list.find((x) => x.id === (id ?? app.form.id)) ?? (id ? undefined : list[0]))
  app.form = c
    ? {
        id: c.id,
        kind: c.kind,
        name: c.name ?? '',
        baseUrl: c.baseUrl,
        tokenId: c.tokenId,
        fingerprint: c.fingerprint,
        secret: '',
        ...(c.tunnel ? { tunnel: { ...c.tunnel } } : {}),
        ...(c.enrichOnly ? { enrichOnly: true } : {}),
        ...(c.nodeMap ? { nodeMap: { ...c.nodeMap } } : {})
      }
    : { id: 'new', kind, name: '', baseUrl: '', tokenId: '', fingerprint: '', secret: '' }
  if (c?.tunnel?.hostKey && c.sshFingerprint) sshFingerprints.set(c.tunnel.hostKey, c.sshFingerprint)
  app.formDirty = false
  app.testResult = null
}

/** Opens the form on a connection (by id) or on a new one. */
function openForm(id: string, kind?: SourceKind): void {
  app.confirm = null
  fillForm(id, kind)
  app.formOpen = true
  app.settingsMessage = null
  actions.render()
}

function closeForm(): void {
  app.confirm = null
  fillForm()
  app.formOpen = false
  actions.render()
}

/** `target`: for 'clear', the connection (id and revision) the removal was confirmed for. */
async function run(kind: 'test' | 'save' | 'clear' | 'import' | 'dismiss', target?: { id: string; revision?: string }): Promise<void> {
  app.busy = kind
  app.confirm = null
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
    } else if (kind === 'dismiss') {
      app.config = await orca.plugin.request('config.dismissImport')
    } else if (kind === 'test') {
      app.testResult = await orca.plugin.request('connection.test', app.form, { timeoutMs: 60000 })
    } else if (kind === 'save') {
      const wasNew = app.form.id === 'new'
      const before = new Set(connections().map((c) => c.id))
      app.config = await orca.plugin.request('config.save', app.form)
      const savedId = wasNew ? app.config.connections.find((c) => !before.has(c.id))?.id : app.form.id
      fillForm(savedId)
      const saved = editing()
      // Saved: the form closes, unless the connection still needs its secret.
      app.formOpen = !saved?.hasSecret
      app.settingsMessage = { tone: 'ok', text: saved?.hasSecret ? `Saved ${saved.name || KIND_SHORT[saved.kind]} connection.` : 'Saved. Enter the token secret to connect.' }
      app.snap = null
      app.response = null
      if (app.config.connections.length && app.config.connections.every((c) => c.hasSecret)) {
        actions.setTab('hosts')
        await actions.refresh(true)
      }
    } else {
      // Exactly the confirmed connection, never whatever the form shows now.
      if (!target) throw new Error('No connection was confirmed for removal; nothing was removed.')
      app.config = await orca.plugin.request('config.clear', target.revision ? { id: target.id, revision: target.revision } : { id: target.id })
      actions.discardRefresh()
      fillForm()
      app.formOpen = false
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
  app.formOpen = true
  edit({ fingerprint })
  actions.setTab('settings')
}

function field(id: string, label: string, help: string, input: HTMLElement): HTMLElement {
  return h('div', { class: 'field' }, h('label', { for: id }, label), input, help ? h('div', { class: 'muted small' }, help) : null)
}

function text(id: string, value: string, placeholder: string, onInput: (v: string) => void, type = 'text'): HTMLInputElement {
  return h('input', { id, type, value, placeholder, autocomplete: 'off', spellcheck: false, onInput: (e: Event) => onInput((e.target as HTMLInputElement).value) })
}

const HELP: Record<SourceKind, [string, string][]> = {
  pdm: [
    ['Create a token', 'Configuration → Access Control → API Token: add one for a user, e.g. monitor@pdm!orca, and copy the secret (shown once).'],
    ['Make it read-only', 'Permissions: the Auditor role on /resource (or /resource/<remote>), for the user and for the token.'],
    ['Pin the certificate', 'Copy the SHA-256 fingerprint from Certificates.']
  ],
  pve: [
    ['Create a token', 'Datacenter → Permissions → API Tokens: add one for a user, e.g. monitor@pve!orca, and copy the secret (shown once).'],
    ['Make it read-only', 'Permissions: the PVEAuditor role on /, for the user and for the token.'],
    ['Guest agent', 'On PVE 9 that role also lets the plugin read disk use inside VMs from their guest agent. To keep it out, turn off “Disk use inside VMs” in Orca’s plugin settings, or use a role without VM.GuestAgent.Audit.'],
    ['One cluster per connection', 'Any node shows its whole cluster; add each standalone host on its own.'],
    ['Pin the certificate', 'The node’s System → Certificates shows the fingerprint.']
  ],
  pbs: [
    ['Create a token', 'Configuration → Access Control → API Token: add one, e.g. monitor@pbs!orca, and copy the secret.'],
    ['Make it read-only', 'Permissions: the Audit role on / for the user and the token (DatastoreAudit on /datastore is enough for backups).'],
    ['Pin the certificate', 'Dashboard → Show Fingerprint.']
  ]
}

function hostOf(c: ConnectionView): string {
  try {
    return new URL(c.baseUrl).host
  } catch {
    return c.baseUrl
  }
}

function connectionRow(c: ConnectionView, open: boolean): HTMLElement {
  return h(
    'li',
    { class: `conn-row${open ? ' editing' : ''}` },
    h('span', { class: 'conn-kind' }, chip(KIND_SHORT[c.kind], c.kind === 'pdm' ? 'info' : 'plain')),
    h('span', { class: 'conn-name' }, h('strong', null, c.name || hostOf(c)), c.name ? h('span', { class: 'muted small' }, ` ${hostOf(c)}`) : null, h('div', { class: 'muted small' }, c.tokenId)),
    c.fingerprint ? chip('pinned', 'ok') : null,
    c.tunnel ? chip('via SSH', 'plain', 'link', `Through SSH to ${c.tunnel.user}@${c.tunnel.host}:${c.tunnel.port}${c.sshFingerprint ? `, host key ${c.sshFingerprint}` : ''}`) : null,
    c.enrichOnly ? chip('enrich only', 'plain', undefined, 'Adds VM disk use and more to the guests PDM shows; adds no hosts or guests of its own') : null,
    c.hasSecret ? null : chip('no secret', 'warn'),
    open ? null : button('Edit', () => openForm(c.id), { icon: 'settings', variant: 'ghost', disabled: app.busy !== null })
  )
}

function isRemoveAsked(c: ConnectionView): boolean {
  const live = pending(app.confirm, Date.now())
  return live?.action === 'remove' && live.target === connectionTarget(c)
}

function askRemove(c: ConnectionView): void {
  app.confirm = ask('remove', connectionTarget(c), Date.now())
  // Gone when it expires, even if nothing else re-renders.
  setTimeout(() => actions.render(), CONFIRM_MS + 50)
  actions.render()
}

/**
 * The confirm button's action, bound now to this confirmation and this connection revision:
 * later, repeated or replayed, or after the connection changed, it removes nothing.
 */
function confirmRemove(c: ConnectionView): () => void {
  const nonce = app.confirm?.nonce ?? -1
  const target = connectionTarget(c)
  const revision = c.revision
  return () => {
    const now = connections().find((x) => x.id === c.id)
    const ok = app.busy === null && mayAct(app.confirm, nonce, 'remove', target, now && connectionTarget(now), Date.now())
    app.confirm = null
    if (!ok) {
      app.settingsMessage = { tone: 'off', text: 'That confirmation no longer applies; nothing was removed.' }
      actions.render()
      return
    }
    void run('clear', revision ? { id: c.id, revision } : { id: c.id })
  }
}

function check(id: string, label: string, checked: boolean, onChange: (on: boolean) => void): HTMLElement {
  return h('label', { class: 'check', for: id }, h('input', { id, type: 'checkbox', checked, onChange: (e: Event) => onChange((e.target as HTMLInputElement).checked) }), label)
}

/** "Reach via SSH tunnel": the SSH server, user, key and where the API is, and the pinned host key. */
function tunnelFields(kind: SourceKind): HTMLElement {
  const t = app.form.tunnel
  const set = (patch: Partial<NonNullable<typeof t>>) => edit({ tunnel: { ...t!, ...patch } })
  return h(
    'div',
    { class: 'conn-extra stack-sm' },
    check('set-tunnel', 'Reach via SSH tunnel', !!t, (on) =>
      edit({ tunnel: on ? { host: '', port: 22, user: '', identityFile: '', target: DEFAULT_TARGET[kind], hostKey: '' } : undefined })
    ),
    t
      ? h(
          'div',
          { class: 'stack-sm' },
          h('div', { class: 'muted small' }, 'For an API that only the server itself reaches (only SSH open): the plugin runs ssh -N -L with this key and talks to the API through it, still checking the certificate above.'),
          field('set-ssh-host', 'SSH host', 'DNS name or IP address of the server.', text('set-ssh-host', t.host, 'pve.example.com', (v) => set({ host: v }))),
          field('set-ssh-port', 'SSH port', '', text('set-ssh-port', String(t.port), '22', (v) => set({ port: Number(v) || 22 }))),
          field('set-ssh-user', 'SSH user', 'A user whose key may only forward to the API (see the README).', text('set-ssh-user', t.user, 'orca-tunnel', (v) => set({ user: v }))),
          field('set-ssh-key', 'Identity file', 'The private key on this machine, without a passphrase, readable by you only.', text('set-ssh-key', t.identityFile, '/home/you/.ssh/orca-proxmox', (v) => set({ identityFile: v }))),
          field('set-ssh-target', 'API as the server reaches it', `Usually ${DEFAULT_TARGET[kind]}.`, text('set-ssh-target', t.target, DEFAULT_TARGET[kind], (v) => set({ target: v }))),
          h(
            'div',
            { class: 'small' },
            t.hostKey
              ? [h('span', null, 'SSH host key pinned: '), h('code', null, sshFingerprints.get(t.hostKey) ?? t.hostKey.split(' ')[0]), ' ', button('Forget', () => set({ hostKey: '' }), { variant: 'ghost', title: 'Learn the key again with the next test' })]
              : h('span', { class: 'warn-text' }, 'No SSH host key pinned yet: Test shows the server’s key to compare and pin.')
          )
        )
      : null
  )
}

/** "Enrich only", and node names that differ between this server and PDM. */
function enrichFields(): HTMLElement {
  const f = app.form
  const lines = Object.entries(f.nodeMap ?? {}).map(([a, b]) => `${a}=${b}`).join('\n')
  return h(
    'div',
    { class: 'conn-extra stack-sm' },
    check('set-enrich', 'Enrich only: add to the guests PDM shows', !!f.enrichOnly, (on) => edit({ enrichOnly: on || undefined, ...(on ? {} : { nodeMap: undefined }) })),
    f.enrichOnly
      ? field(
          'set-nodemap',
          'Node names, where they differ',
          'One per line: this server’s node=the node in PDM (or remote/node). VM disk use, storage types and updates go to the guest with the same node and VMID; nothing is added.',
          h('textarea', {
            id: 'set-nodemap',
            rows: 2,
            spellcheck: false,
            placeholder: 'pve-x1=pve-a',
            value: lines,
            onChange: (e: Event) => {
              const map: Record<string, string> = {}
              for (const line of (e.target as HTMLTextAreaElement).value.split(/\r?\n/)) {
                const [a, b] = line.split('=').map((x) => x.trim())
                if (a && b) map[a] = b
              }
              edit({ nodeMap: Object.keys(map).length ? map : undefined })
            }
          })
        )
      : null
  )
}

/** A host key the test saw (a first contact): shown to compare; pinned only on the person's click. */
function hostKeyCallout(key: { key: string; fingerprint: string }): HTMLElement {
  sshFingerprints.set(key.key, key.fingerprint)
  const pinned = app.form.tunnel?.hostKey === key.key
  return callout(
    pinned ? 'ok' : 'warn',
    pinned ? 'SSH host key ready to pin' : 'Compare the SSH host key',
    h('div', null, 'The SSH server presented ', h('code', null, key.fingerprint), '. Compare it with ', h('code', null, 'ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub'), ' run on the server (or its console) before you pin it.'),
    pinned
      ? h('div', { class: 'small' }, 'Save to pin it: from then on any other key is refused.')
      : h('div', { class: 'toolbar' }, button('It matches: pin this key', () => {
          const t = app.form.tunnel
          if (!t) return
          app.form = { ...app.form, tunnel: { ...t, hostKey: key.key } }
          app.formDirty = true
          actions.render()
        }, { icon: 'check', variant: 'primary' }))
  )
}

/** The form for the connection in `app.form`: a saved one, or a new one. */
function connectionForm(list: ConnectionView[]): HTMLElement {
  const f = app.form
  const kind: SourceKind = f.kind ?? 'pdm'
  const current = editing()
  const isNew = !current
  const hasSecret = current?.hasSecret ?? false
  const test = app.testResult
  const busy = app.busy
  const ph = PLACEHOLDER[kind]
  const unit = test?.ok ? (test.unit === 'nodes' ? 'node' : test.unit === 'datastores' ? 'datastore' : 'remote') : 'remote'
  return h(
    'div',
    { class: 'conn-form stack' },
    h('h4', null, isNew ? (list.length ? 'New connection' : 'Connect') : `Edit ${current.name || KIND_SHORT[current.kind]}`),
    isNew
      ? field(
          'set-kind',
          'Connect to',
          list.length ? '' : 'PDM covers all its remotes; without it, add each PVE and PBS.',
          select(
            'set-kind',
            'Connect to',
            kind,
            (['pdm', 'pve', 'pbs'] as SourceKind[]).filter((k) => k !== 'pdm' || !list.some((c) => c.kind === 'pdm')).map((k) => ({ value: k, label: KIND_LABEL[k] })),
            (v) => edit({ kind: v as SourceKind, name: v === 'pdm' ? '' : f.name })
          )
        )
      : null,
    kind !== 'pdm' ? field('set-name', 'Name (optional)', 'Else the URL’s host.', text('set-name', f.name ?? '', kind === 'pve' ? 'lab' : 'backup', (v) => edit({ name: v }))) : null,
    field('set-url', 'Base URL', `Usually https://host:${ph.port}`, text('set-url', f.baseUrl, ph.url, (v) => edit({ baseUrl: v }))),
    field('set-token', 'API token ID', 'user@realm!tokenname', text('set-token', f.tokenId, ph.token, (v) => edit({ tokenId: v }))),
    field(
      'set-secret',
      'API token secret',
      hasSecret ? 'Stored. Leave empty to keep it.' : 'Kept in Orca’s encrypted secrets only.',
      text('set-secret', f.secret ?? '', hasSecret ? '•••••••• (stored)' : 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx', (v) => edit({ secret: v }), 'password')
    ),
    field('set-fp', 'Certificate fingerprint (SHA-256)', 'Optional: for a self-signed certificate.', text('set-fp', f.fingerprint, 'AA:BB:CC:…', (v) => edit({ fingerprint: v }))),
    kind !== 'pdm' ? tunnelFields(kind) : null,
    kind === 'pve' ? enrichFields() : null,
    app.config?.secretsProtection === 'unavailable'
      ? callout('bad', 'Orca cannot encrypt secrets on this machine', 'There is no OS keyring, so the token secret cannot be saved. This plugin will not store it in plain text.')
      : null,
    current && isRemoveAsked(current)
      ? h(
          'div',
          { class: 'confirm', role: 'alertdialog', 'aria-label': 'Confirm removal' },
          h('div', null, h('strong', null, `Remove ${KIND_SHORT[current.kind]} ${current.name || hostOf(current)}?`), ` This deletes its stored token secret; the panel stops showing its remotes.${list.length > 1 ? ' The other connections stay.' : ''}`),
          h(
            'div',
            { class: 'toolbar' },
            button(busy === 'clear' ? 'Removing…' : 'Remove', confirmRemove(current), { icon: 'trash', variant: 'danger', disabled: busy !== null, id: 'confirm-remove' }),
            button('Keep it', () => ((app.confirm = null), actions.render()), { variant: 'ghost', disabled: busy !== null })
          )
        )
      : h(
          'div',
          { class: 'toolbar' },
          button(busy === 'save' ? 'Saving…' : 'Save', () => void run('save'), { icon: 'check', variant: 'primary', disabled: busy !== null }),
          button(busy === 'test' ? 'Testing…' : 'Test', () => void run('test'), { icon: 'plug', disabled: busy !== null }),
          list.length ? button('Cancel', closeForm, { variant: 'ghost', disabled: busy !== null }) : null,
          current ? button('Remove…', () => askRemove(current), { icon: 'trash', variant: 'danger', disabled: busy !== null }) : null
        ),
    test?.sshHostKey ? hostKeyCallout(test.sshHostKey) : null,
    test?.ok
      ? callout(
          'ok',
          'Connected',
          `${KIND_LABEL[kind]} ${test.version}; the token sees ${test.remotes} ${unit}${test.remotes === 1 ? '' : 's'}.${test.remotes === 0 ? ` Give it the ${kind === 'pdm' ? 'Auditor role on /resource' : kind === 'pve' ? 'PVEAuditor role on /' : 'Audit role on /'} to see your estate.` : ''}`
        )
      : test
        ? errorCallout(test.error, { pin: pinFingerprint, openSettings: () => actions.setTab('settings') })
        : null
  )
}

/** The last import's outcome as one line, details on click, and a dismiss button; for a day. */
function importLine(): HTMLElement | null {
  const status = app.config?.importStatus
  if (!status || Date.now() - status.at > 86_400_000) return null
  return h(
    'div',
    { class: `import-line ${status.ok ? 'ok' : 'bad'}`, role: 'status' },
    h(
      'details',
      null,
      h('summary', null, chip(status.ok ? 'imported' : 'import failed', status.ok ? 'ok' : 'bad', status.ok ? 'check' : 'alert'), ` ${new Date(status.at).toLocaleString()}`),
      h('div', { class: 'small' }, status.message),
      status.file ? h('div', { class: 'muted small' }, status.file) : null
    ),
    button('Dismiss', () => void run('dismiss'), { icon: 'x', variant: 'ghost', iconOnly: true, title: 'Dismiss', disabled: app.busy !== null })
  )
}

function fold(title: string, iconName: Parameters<typeof icon>[0], body: (HTMLElement | null)[], open = false): HTMLElement {
  return h('details', { class: 'fold', open }, h('summary', null, icon(iconName, 14), ` ${title}`), body)
}

const onOff = (on: boolean) => (on ? 'on' : 'off')

export function settingsView(): HTMLElement {
  const cfg = app.config
  const list = connections()
  const formOpen = app.formOpen || list.length === 0
  const current = formOpen ? editing() : undefined
  const busy = app.busy
  const s = cfg?.settings
  const kind: SourceKind = app.form.kind ?? 'pdm'
  return h(
    'div',
    { class: 'view stack settings' },
    h(
      'section',
      { class: 'connections stack' },
      h('h3', null, 'Connections'),
      list.length
        ? h(
            'ul',
            { class: 'conn-list' },
            list.flatMap((c) => {
              const open = current?.id === c.id
              return open ? [connectionRow(c, true), h('li', { class: 'conn-edit' }, connectionForm(list))] : [connectionRow(c, false)]
            })
          )
        : h('p', { class: 'muted small' }, 'Connect to a Proxmox Datacenter Manager, or to Proxmox VE and Backup Servers directly, with a read-only API token.'),
      formOpen && !current ? connectionForm(list) : null,
      !formOpen ? h('div', { class: 'toolbar' }, button('Add a connection', () => openForm('new', 'pve'), { icon: 'plug', variant: 'ghost', disabled: busy !== null })) : null,
      app.settingsMessage ? h('div', { class: `${app.settingsMessage.tone}-text small`, role: 'status' }, app.settingsMessage.text) : null
    ),
    importLine(),
    fold('Import from a file', 'download', [
      h('p', { class: 'muted small' }, 'For agents and scripts: a connection as JSON (baseUrl, tokenId, fingerprint, secret; kind "pve" or "pbs" and a name for a direct one) in this file, readable by you only. It is imported only if its connection test passes, then deleted. See docs/AGENT_SETUP.md.'),
      h('code', { class: 'path small' }, cfg?.importPath ?? ''),
      h('div', { class: 'toolbar' }, button(busy === 'import' ? 'Importing…' : 'Import now', () => void run('import'), { icon: 'download', disabled: busy !== null }))
    ]),
    fold(
      'Help: a read-only token',
      'settings',
      (['pdm', 'pve', 'pbs'] as SourceKind[]).map((k) =>
        h('details', { class: 'help-kind', open: formOpen && k === kind }, h('summary', null, KIND_LABEL[k]), h('ol', { class: 'help' }, HELP[k].map(([title, body]) => h('li', null, h('strong', null, title), ': ', body))))
      ),
      !list.length
    ),
    fold('Plugin options', 'grid', [
      h('p', { class: 'muted small' }, 'Changed in Orca: Settings → Plugins → Proxmox.'),
      s
        ? h(
            'ul',
            { class: 'options small' },
            h('li', null, `Refresh every ${s.refreshSeconds} s; snapshot lists every ${s.backupRefreshMinutes} min`),
            h('li', null, `Backups older than ${s.backupStaleHours} h are flagged`),
            h('li', null, `Disk use inside VMs (guest agent): ${onOff(s.guestAgentDisk)}`),
            h('li', null, `Show where Orca runs: ${onOff(s.orcaAwareness)}; status bar: ${onOff(s.statusBar)}`),
            h('li', null, `Alerts: offline ${onOff(s.alertRemoteOffline)}, stopped ${onOff(s.alertGuestStopped)}, failed backup ${onOff(s.alertBackupFailed)}, stale backup ${onOff(s.alertBackupStale)}`)
          )
        : null
    ])
  )
}
