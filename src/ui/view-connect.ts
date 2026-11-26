// Settings → Connect via Orca: Orca's servers that run Proxmox, set up from here. A read-only Check
// finds out what a host runs; Connect shows the exact script first and runs it only on the
// person's click; Undo does the same for what a setup created. The worker does the work
// (setup/service.ts); the panel never sees a secret.
import type { SetupHost, SetupHostsAnswer, SetupPlan, SetupRecord, SetupRunAnswer } from '../protocol'
import { openLink } from './actions'
import { actions, failure } from './app'
import { h } from './dom'
import { icon } from './icons'
import { button, callout, chip } from './parts'

type Choice = { product: 'pve' | 'pbs'; replace: boolean; address: string; name: string }

const state = {
  loaded: false,
  loading: false,
  answer: null as SetupHostsAnswer | null,
  /** The host and step in progress. */
  busy: null as { hostKey: string; step: 'check' | 'plan' | 'run' } | null,
  /** The Connect form, per host. */
  choice: new Map<string, Choice>(),
  open: null as string | null,
  plan: null as SetupPlan | null,
  result: null as { hostKey: string; answer: SetupRunAnswer } | null,
  message: null as { hostKey?: string; text: string } | null
}

const RECORD_LABEL: Record<SetupRecord['status'], string> = { pending: 'outcome unknown (interrupted)', unknown: 'outcome unknown', stopped: 'stopped on the host', failed: 'not saved', saved: 'set up' }

const TUNNEL_GUIDE = 'https://github.com/wizhelp/orca-proxmox/blob/main/docs/AGENT_SETUP.md#through-an-ssh-tunnel-enrich-only'
const GUIDE = 'https://github.com/wizhelp/orca-proxmox/blob/main/docs/AGENT_SETUP.md#1-log-in-to-pdms-api'

async function load(): Promise<void> {
  state.loading = true
  actions.render()
  try {
    state.answer = await orca.plugin.request('setup.hosts', undefined, { timeoutMs: 60000 })
    state.message = null
  } catch (error) {
    state.message = { text: failure(error) }
  } finally {
    state.loading = false
    state.loaded = true
    actions.render()
  }
}

async function step<T>(hostKey: string, name: 'check' | 'plan' | 'run', work: () => Promise<T>): Promise<T | undefined> {
  state.busy = { hostKey, step: name }
  state.message = null
  actions.render()
  try {
    return await work()
  } catch (error) {
    state.message = { hostKey, text: failure(error) }
    return undefined
  } finally {
    state.busy = null
    actions.render()
  }
}

function defaults(host: SetupHost): Choice {
  const d = host.detection!
  return {
    product: d.products.pve ? 'pve' : 'pbs',
    replace: false,
    address: d.via?.server ?? d.fqdn ?? d.hostname,
    name: d.hostname.slice(0, 40)
  }
}

function check(host: SetupHost): void {
  void step(host.key, 'check', async () => {
    state.answer = await orca.plugin.request('setup.detect', { hostKey: host.key }, { timeoutMs: 90000 })
  })
}

function showPlan(host: SetupHost): void {
  const c = state.choice.get(host.key) ?? defaults(host)
  void step(host.key, 'plan', async () => {
    state.plan = await orca.plugin.request('setup.plan', { hostKey: host.key, ...c }, { timeoutMs: 60000 })
    state.result = null
  })
}

function showUndo(host: SetupHost, runId: string): void {
  void step(host.key, 'plan', async () => {
    state.plan = await orca.plugin.request('setup.undoPlan', { hostKey: host.key, runId }, { timeoutMs: 60000 })
    state.result = null
  })
}

function runPlan(plan: SetupPlan): void {
  void step(plan.hostKey, 'run', async () => {
    // Started in the background: its state is asked for until it ends (a run can take minutes).
    const { jobId } = await orca.plugin.request('setup.run', { planId: plan.planId, hostKey: plan.hostKey }, { timeoutMs: 30000 })
    state.plan = null
    state.open = null
    actions.render()
    let answer: SetupRunAnswer | undefined
    for (let misses = 0; !answer; ) {
      await new Promise((r) => setTimeout(r, 1500))
      try {
        const job = await orca.plugin.request('setup.job', { jobId }, { timeoutMs: 30000 })
        if (!job.running) answer = job.answer
        misses = 0
      } catch (error) {
        if ((misses += 1) >= 5) throw error
      }
    }
    state.result = { hostKey: plan.hostKey, answer }
    state.answer = await orca.plugin.request('setup.hosts', undefined, { timeoutMs: 60000 }).catch(() => state.answer)
    if (answer.ok) await actions.loadConfig()
  })
}

function input(id: string, value: string, onInput: (v: string) => void): HTMLInputElement {
  return h('input', { id, type: 'text', value, autocomplete: 'off', spellcheck: false, onInput: (e: Event) => onInput((e.target as HTMLInputElement).value) })
}

function toggle(id: string, label: string, checked: boolean, onChange: (on: boolean) => void): HTMLElement {
  return h('label', { class: 'check', for: id }, h('input', { id, type: 'checkbox', checked, onChange: (e: Event) => onChange((e.target as HTMLInputElement).checked) }), label)
}

/** What to set up on a checked host: product, address, name, replace. */
function connectForm(host: SetupHost): HTMLElement {
  const d = host.detection!
  const c = state.choice.get(host.key) ?? defaults(host)
  const set = (patch: Partial<Choice>) => {
    state.choice.set(host.key, { ...c, ...patch })
    state.plan = null
    actions.render()
  }
  const id = (s: string) => `cv-${s}-${host.key.replace(/[^A-Za-z0-9]/g, '')}`
  const busy = state.busy !== null
  return h(
    'div',
    { class: 'conn-extra stack-sm' },
    d.products.pve && d.products.pbs
      ? h('div', { class: 'toolbar' }, button('Proxmox VE', () => set({ product: 'pve' }), { variant: c.product === 'pve' ? 'primary' : 'ghost' }), button('Backup Server', () => set({ product: 'pbs' }), { variant: c.product === 'pbs' ? 'primary' : 'ghost' }))
      : null,
    h('div', { class: 'field' }, h('label', { for: id('addr') }, 'Address this machine reaches it at'), input(id('addr'), c.address, (v) => set({ address: v })), h('div', { class: 'muted small' }, 'Suggested from what the host reported (where its shell was reached); check it. The plugin connects to this address from here and requires the certificate the host reported.')),
    h('div', { class: 'field' }, h('label', { for: id('name') }, 'Name in the estate'), input(id('name'), c.name, (v) => set({ name: v }))),
    toggle(id('replace'), 'Replace an earlier Orca token on this host (the old one stops working)', c.replace, (on) => set({ replace: on })),
    h('div', { class: 'toolbar' }, button(state.busy?.step === 'plan' && state.busy.hostKey === host.key ? 'Preparing…' : 'Show the script', () => showPlan(host), { icon: 'note', variant: 'primary', disabled: busy }), button('Cancel', () => ((state.open = null), (state.plan = null), actions.render()), { variant: 'ghost', disabled: busy }))
  )
}

/** The exact script, what it does, and the one button that runs it. */
function planView(plan: SetupPlan): HTMLElement {
  const busy = state.busy !== null
  const undo = plan.action === 'undo'
  return h(
    'div',
    { class: 'confirm stack-sm', role: 'alertdialog', 'aria-label': undo ? 'Review the Undo script' : 'Review the setup script' },
    h('strong', null, undo ? `Undo on ${plan.hostName}` : `Set up ${plan.connection?.kind === 'pbs' ? 'Proxmox Backup Server' : 'Proxmox VE'} on ${plan.hostName}`),
    h('ul', { class: 'options small' }, plan.summary.map((s) => h('li', null, s))),
    plan.connection ? h('div', { class: 'small' }, 'Saves ', h('code', null, plan.connection.tokenId), ' at ', h('code', null, plan.connection.baseUrl), plan.connection.enrichOnly ? ' (enrich only)' : '') : null,
    h('details', { class: 'fold', open: true }, h('summary', null, `The script (${plan.script.split('\n').length} lines): exactly what runs`), h('pre', { class: 'script small' }, plan.script)),
    h('div', { class: 'muted small' }, `Valid until ${new Date(plan.expiresAt).toLocaleTimeString()}, once.`),
    h(
      'div',
      { class: 'toolbar' },
      button(state.busy?.step === 'run' ? 'Running…' : undo ? `Run Undo on ${plan.hostName}` : `Run on ${plan.hostName}`, () => runPlan(plan), { icon: undo ? 'undo' : 'terminal', variant: undo ? 'danger' : 'primary', disabled: busy }),
      button('Cancel', () => ((state.plan = null), actions.render()), { variant: 'ghost', disabled: busy })
    )
  )
}

/** An error, with the guide's link made clickable when it names it. */
function messageLine(text: string): HTMLElement {
  const at = text.indexOf(TUNNEL_GUIDE)
  if (at < 0) return h('div', { class: 'bad-text small', role: 'status' }, text)
  return h('div', { class: 'bad-text small', role: 'status' }, text.slice(0, at), h('a', { href: TUNNEL_GUIDE, onClick: (e: Event) => (e.preventDefault(), void openLink(TUNNEL_GUIDE)) }, 'the guide’s SSH tunnel section'), text.slice(at + TUNNEL_GUIDE.length))
}

function resultView(answer: SetupRunAnswer): HTMLElement {
  return callout(answer.ok ? 'ok' : 'bad', answer.ok ? (answer.stage === 'undone' ? 'Undone' : 'Connected') : 'Not done', h('div', null, answer.message), answer.steps.length ? h('div', { class: 'muted small' }, `Reported: ${answer.steps.join(', ').replace(/_/g, ' ')}`) : null)
}

function hostRow(host: SetupHost): HTMLElement {
  const d = host.detection
  const busy = state.busy !== null
  const here = state.busy?.hostKey === host.key
  const canSetUp = !!d && (!!d.products.pve || !!d.products.pbs) && d.root !== 'no'
  const open = state.open === host.key
  return h(
    'li',
    { class: 'conn-row setup-host' },
    h(
      'div',
      { class: 'setup-head' },
      h('span', { class: 'conn-kind' }, chip(host.kind === 'ssh' ? 'SSH' : 'server', 'plain')),
      h(
        'span',
        { class: 'conn-name' },
        h('strong', null, host.name),
        h('div', { class: 'muted small' }, host.unavailable ?? (d ? `Checked ${new Date(d.at).toLocaleString()}${d.root === 'no' ? '; not root, no sudo' : ''}` : 'Not checked yet'))
      ),
      d?.products.pve ? chip(`PVE ${d.products.pve}`, 'info') : null,
      d?.products.pbs ? chip(`PBS ${d.products.pbs}`, 'info') : null,
      d?.products.pdm ? chip(`PDM ${d.products.pdm}`, 'info') : null,
      d && !d.products.pve && !d.products.pbs && !d.products.pdm ? chip('no Proxmox', 'plain') : null,
      host.unavailable ? null : button(here && state.busy?.step === 'check' ? 'Checking…' : d ? 'Check again' : 'Check', () => check(host), { icon: 'search', variant: 'ghost', disabled: busy, title: 'Read-only: what it runs, and whether Orca’s shell there is root' }),
      canSetUp && !host.unavailable && !open ? button('Connect…', () => ((state.open = host.key), (state.plan = null), (state.result = null), actions.render()), { icon: 'plug', variant: 'primary', disabled: busy }) : null
    ),
    d?.products.pdm ? h('div', { class: 'muted small' }, 'PDM: its token is made with your PDM login, which the plugin never handles; follow ', h('a', { href: GUIDE, onClick: (e: Event) => (e.preventDefault(), void openLink(GUIDE)) }, 'the guide’s PDM token steps'), '.') : null,
    host.records.length
      ? h(
          'div',
          { class: 'toolbar small' },
          host.records.map((r) =>
            h(
              'span',
              { class: 'setup-record' },
              chip(`${r.product.toUpperCase()}: ${RECORD_LABEL[r.status]}`, r.status === 'saved' ? 'ok' : 'warn', undefined, `Run ${r.runId}, ${new Date(r.at).toLocaleString()}${r.message ? `: ${r.message}` : ''}`),
              host.unavailable ? null : button('Undo…', () => showUndo(host, r.runId), { icon: 'undo', variant: 'ghost', disabled: busy })
            )
          )
        )
      : null,
    open && d ? connectForm(host) : null,
    state.plan && state.plan.hostKey === host.key ? planView(state.plan) : null,
    state.result?.hostKey === host.key ? resultView(state.result.answer) : null,
    state.message?.hostKey === host.key ? messageLine(state.message.text) : null
  )
}

/** The section's body; with `autoload` (no connection yet) it reads Orca's hosts at once, else on a click. */
export function connectViaOrca(autoload: boolean): HTMLElement {
  if (autoload && !state.loaded && !state.loading) void load()
  const hosts = state.answer?.hosts ?? []
  return h(
    'div',
    { class: 'stack-sm' },
    h('p', { class: 'muted small' }, 'For Proxmox VE and Backup Servers Orca already connects to (SSH targets, paired servers). Check reads what a host runs and changes nothing. Connect shows the exact script first and runs it as root in a terminal of that host only when you click Run. It creates a read-only API token and keeps a record on the host; no secret is ever shown in the terminal. What the host reports is trusted only as far as the host: the plugin then checks from this machine that the address presents the reported certificate and that the token has read rights only, before it saves the connection. Undo reverses only what one run made.'),
    h('p', { class: 'muted small' }, 'Advanced: VM disk usage via SSH tunnel (the API stays closed to the network) is set up with the guided steps in ', h('a', { href: TUNNEL_GUIDE, onClick: (e: Event) => (e.preventDefault(), void openLink(TUNNEL_GUIDE)) }, 'the guide’s SSH tunnel section'), ', not from here.'),
    state.answer?.error ? callout('warn', 'Orca’s hosts could not be read', state.answer.error) : null,
    state.answer?.ignoredRecords ? callout('warn', 'Some setup records were ignored', `${state.answer.ignoredRecords} stored record(s) did not open with the plugin’s key or were altered; they cannot be undone from here (the guide’s way back lists what to check on the host).`) : null,
    state.loading && !state.answer ? h('div', { class: 'muted small' }, 'Reading Orca’s hosts…') : null,
    state.loaded && !hosts.length && !state.answer?.error ? h('div', { class: 'muted small' }, 'Orca has no SSH targets or paired servers yet.') : null,
    hosts.length ? h('ul', { class: 'conn-list' }, hosts.map(hostRow)) : null,
    state.message && !state.message.hostKey ? h('div', { class: 'bad-text small', role: 'status' }, state.message.text) : null,
    h('div', { class: 'toolbar' }, button(state.loading ? 'Reading…' : state.loaded ? 'Read Orca’s hosts again' : 'Find Orca’s hosts', () => void load(), { icon: 'refresh', variant: 'ghost', disabled: state.loading || state.busy !== null }))
  )
}

let shown: boolean | null = null

/** The section, folded: open while there is no connection yet, then as the person left it. */
export function connectSection(hasConnections: boolean): HTMLElement {
  const open = shown ?? !hasConnections
  return h(
    'details',
    {
      class: 'fold',
      open,
      onToggle: (e: Event) => {
        const now = (e.target as HTMLDetailsElement).open
        if (now === (shown ?? !hasConnections)) return
        shown = now
        if (now && !state.loaded && !state.loading) void load()
      }
    },
    h('summary', null, icon('plug', 14), ' Connect via Orca (easiest)'),
    connectViaOrca(open)
  )
}
