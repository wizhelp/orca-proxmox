// The server-side scripts of "Connect via Orca", generated from the fixed templates below: no
// remote fetch, nothing typed by anyone but a few values validated here, each in one exact form.
// Pure: the worker shows the exact text to the person and runs it only after they confirm.
//
// Trust. A script runs as root on the host, and what it prints comes back through a terminal, so
// its answers are only as trustworthy as that host: they are framed strictly (run id, sequence
// number, a checksum over all of them in the last line) so that nothing else in the terminal, a
// partial read or a lost line can pass for a complete answer, and the plugin checks what it can
// on its own from this machine (the certificate by connecting, the token's rights through the API).
//
// Durable host-side state. Before each change the setup script records its intent, and after it
// the result, in /var/lib/orca-proxmox-setup/<run id> (root only), and what it creates is
// labelled with the run id (the user's and token's comments). Undo reads that file on the host
// and removes a resource only when this run recorded making it and its label is still this run's:
// never one an administrator made or remade since, never one that was there before, and never on
// the strength of what the terminal or the plugin's storage says alone.
//
// Only the read-only token is set up this way. An SSH tunnel account stays the guided manual path
// (docs/AGENT_SETUP.md, "Through an SSH tunnel").
//
// No script ever prints a secret: the new token's secret is encrypted on the host to the run's
// one-time public key (keys.ts) and only that ciphertext is printed.

export type SetupProduct = 'pve' | 'pbs'

/** What one setup run creates on a server. */
export type SetupRequest = {
  product: SetupProduct
  /** 16 hex digits, new per run. */
  runId: string
  /** The one-time RSA public key (PEM) the token secret is encrypted to. */
  resultKey: string
  /** Replace an earlier `orca` token of the plugin's user (the old one stops working). */
  replace: boolean
}

export class ScriptError extends Error {}

const PRODUCTS = {
  pve: {
    label: 'Proxmox VE',
    user: 'orca-monitor@pve',
    role: 'PVEAuditor',
    port: 8006,
    tool: 'pveum',
    userList: 'pveum user list --output-format json',
    userAdd: 'pveum user add "$U" --comment "$UC"',
    userDel: 'pveum user delete "$U"',
    tokenList: 'pveum user token list "$U" --output-format json',
    tokenMatch: '"tokenid":"orca"',
    tokenAdd: 'pveum user token add "$U" "$T" --privsep 1 --comment "$TC" --output-format json',
    tokenDel: 'pveum user token remove "$U" "$T"',
    aclList: 'pveum acl list --output-format json',
    userAcl: 'pveum acl modify / --users "$U" --roles PVEAuditor',
    userAclDel: 'pveum acl delete / --users "$U" --roles PVEAuditor',
    tokenAcl: 'pveum acl modify / --tokens "$U!$T" --roles PVEAuditor',
    tokenAclDel: 'pveum acl delete / --tokens "$U!$T" --roles PVEAuditor',
    preflight: '',
    // Deleting a PVE user also drops it from its groups: a membership added since keeps the user.
    groupCheck: `INGROUP=
GL=$(pveum group list --output-format json) || stop "the groups could not be read"
printf '%s\\n' "$GL" | tr '{' '\\n' | sed -n 's/.*"users":"\\([^"]*\\)".*/\\1/p' | tr ',' '\\n' | grep -qxF "$U" && INGROUP=1
`
  },
  pbs: {
    label: 'Proxmox Backup Server',
    user: 'orca-monitor@pbs',
    role: 'Audit',
    port: 8007,
    tool: 'proxmox-backup-manager',
    userList: 'proxmox-backup-manager user list --output-format json',
    userAdd: 'proxmox-backup-manager user create "$U" --comment "$UC"',
    userDel: 'proxmox-backup-manager user remove "$U"',
    tokenList: 'proxmox-backup-manager user list-tokens "$U" --output-format json',
    tokenMatch: '"tokenid":"orca-monitor@pbs!orca"',
    // No --output-format here: generate-token is the API method itself; it prints its result
    // (tokenid and value) as JSON, which is read as such.
    tokenAdd: 'proxmox-backup-manager user generate-token "$U" "$T" --comment "$TC"',
    tokenDel: 'proxmox-backup-manager user delete-token "$U" "$T"',
    aclList: 'proxmox-backup-manager acl list --output-format json',
    userAcl: 'proxmox-backup-manager acl update / Audit --auth-id "$U"',
    userAclDel: 'proxmox-backup-manager acl update / Audit --auth-id "$U" --delete true',
    tokenAcl: 'proxmox-backup-manager acl update / Audit --auth-id "$U!$T"',
    tokenAclDel: 'proxmox-backup-manager acl update / Audit --auth-id "$U!$T" --delete true',
    // Every subcommand and option this script uses, as the installed version documents them;
    // missing ones stop it before anything is changed.
    // PBS has no groups.
    groupCheck: 'INGROUP=\n',
    preflight: `for C in 'user list:--output-format' 'user list-tokens:--output-format' 'user generate-token:--comment' 'user create:--comment' 'acl list:--output-format' 'acl update:--delete' 'acl update:--auth-id' 'user delete-token:delete-token' 'user remove:remove'; do
  H=$(proxmox-backup-manager help \${C%%:*} --verbose 2>&1 || proxmox-backup-manager help \${C%%:*} --verbose true 2>&1) || stop "this proxmox-backup-manager has no '\${C%%:*}'; nothing was changed"
  printf '%s' "$H" | grep -q -- "\${C#*:}" || stop "this proxmox-backup-manager's '\${C%%:*}' has no \${C#*:}; nothing was changed"
done
`
  }
} as const

export const TOKEN_NAME = 'orca'
const USER_COMMENT = 'Read-only, Orca plugin'
const STATE_DIR = '/var/lib/orca-proxmox-setup'

/**
 * The state folder, checked (a real folder of root's, not a link), and one lock on it for every
 * script that changes or undoes anything: held until the script ends, so setup, finalize and
 * Undo never run at once on a host, whatever the plugin remembers after a restart.
 */
const LOCK = `command -v flock >/dev/null 2>&1 || stop "flock not found; nothing was changed"
D=${STATE_DIR}
[ -d "$D" ] && [ ! -L "$D" ] && [ "$(stat -c %u "$D")" = 0 ] || stop "${STATE_DIR} is not root's own folder; nothing was changed"
exec 9>>"$D/.lock" || stop "no lock file"
flock -n 9 || stop "another Orca setup step is running on this host; try again when it has ended"
`

export function tokenIdOf(product: SetupProduct): string {
  return `${PRODUCTS[product].user}!${TOKEN_NAME}`
}
export function apiPortOf(product: SetupProduct): number {
  return PRODUCTS[product].port
}
export function productLabel(product: SetupProduct): string {
  return PRODUCTS[product].label
}

export const RUN_ID = /^[0-9a-f]{16}$/
const PEM = /^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]{200,1000}\n-----END PUBLIC KEY-----\n?$/
function check(request: SetupRequest): void {
  if (request.product !== 'pve' && request.product !== 'pbs') throw new ScriptError('Only a Proxmox VE or Backup Server host can be connected this way.')
  if (!RUN_ID.test(request.runId)) throw new ScriptError('The run id is not valid.')
  if (!PEM.test(request.resultKey)) throw new ScriptError('The one-time key is not a PEM public key.')
  if (typeof request.replace !== 'boolean') throw new ScriptError('Replace must be yes or no.')
}

/**
 * Shell lines shared by every script: a fixed PATH, and the answer helpers. Each answer is
 * `ORCA-SETUP-<run id> <n> <key> <value>`, numbered from 1; the last is `end ok|stop <sha256>`
 * over every earlier `key value` line, so the plugin can tell a complete answer from a partial one.
 */
function prelude(runId: string, title: string): string {
  return `#!/bin/sh
# Proxmox for Orca: ${title}.
# Generated by the plugin from its reviewed template; it prints no secret.
set -u
umask 077
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
R=${runId}
N=0
ALL=
say() {
  V=$(printf '%s' "$2" | tr -d '\\r\\n')
  N=$((N + 1))
  ALL="$ALL$1 $V
"
  printf 'ORCA-SETUP-%s %s %s %s\\n' "$R" "$N" "$1" "$V"
}
finish() {
  N=$((N + 1))
  printf 'ORCA-SETUP-%s %s end %s %s\\n\\n' "$R" "$N" "$1" "$(printf '%s' "$ALL" | sha256sum | cut -c1-64)"
}
stop() { say stop "$1"; finish stop; exit 1; }
`
}

/** Read-only: what this host runs, who the shell is, and where it was reached. */
export function detectScript(runId: string): string {
  if (!RUN_ID.test(runId)) throw new ScriptError('The run id is not valid.')
  return `${prelude(runId, 'detect what this host runs (read-only, changes nothing)')}
if [ "$(id -u)" = 0 ]; then say root yes
elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then say root sudo
else say root no
fi
v() { dpkg-query -W -f='\${Version}' "$1" 2>/dev/null; }
command -v pveum >/dev/null 2>&1 && say pve "$(v pve-manager)"
command -v proxmox-backup-manager >/dev/null 2>&1 && say pbs "$(v proxmox-backup-server)"
command -v proxmox-datacenter-manager-admin >/dev/null 2>&1 && say pdm "$(v proxmox-datacenter-manager)"
say hostname "$(hostname)"
say fqdn "$(hostname -f 2>/dev/null)"
say via "\${SSH_CONNECTION:-}"
finish ok
`
}

/** Shell helpers to read the product's JSON lists: an object holding every given string. */
const JSON_HELPERS = `has() { h_l=$1; shift; printf '%s\n' "$h_l" | tr '{' '\\n' | { while IFS= read -r h_o; do h_m=1; for h_s in "$@"; do case "$h_o" in *"$h_s"*) ;; *) h_m=0 ;; esac; done; [ $h_m = 1 ] && exit 0; done; exit 1; }; }
`

/** The setup script for `request`; throws ScriptError for anything not exactly as expected. */
export function setupScript(request: SetupRequest): string {
  check(request)
  const p = PRODUCTS[request.product]
  const lines: string[] = [prelude(request.runId, `connect this ${p.label} to the plugin, read-only`)]
  lines.push(`# Root, the product's own tool and openssl are needed; nothing is changed before these checks.
[ "$(id -u)" = 0 ] || stop "not root"
command -v ${p.tool} >/dev/null 2>&1 || stop "${p.tool} not found: this is not a ${p.label} host"
command -v openssl >/dev/null 2>&1 || stop "openssl not found"
${p.preflight}W=$(mktemp -d) || stop "no temporary folder"
trap 'rm -rf "$W"' EXIT
cat > "$W/orca.pub" <<'ORCA_KEY'
${request.resultKey.trim()}
ORCA_KEY
U='${p.user}'; T='${TOKEN_NAME}'; UC="${USER_COMMENT} $R"; TC="Orca plugin $R"
${JSON_HELPERS}# This run's record on the host: intent before each change, done after it (Undo reads it).
install -d -m 700 ${STATE_DIR} || stop "no state folder"
${LOCK}STATE=${STATE_DIR}/$R
( set -C; : > "$STATE" ) 2>/dev/null || stop "this run was started before; nothing was changed"
mark() { printf '%s\\n' "$*" >> "$STATE" || stop "the state file could not be written"; }
`)
  lines.push(`# The read-only user: created, or reused only when it is the plugin's own.
UL=$(${p.userList}) || stop "the user list could not be read"
if has "$UL" "\\"userid\\":\\"$U\\""; then
  has "$UL" "\\"userid\\":\\"$U\\"" "\\"comment\\":\\"${USER_COMMENT}" || stop "the user $U exists and was not made for Orca; nothing was changed"
  mark existing user
  say reused_user 1
else
  mark intent user
  ${p.userAdd} || stop "the user $U could not be created"
  mark done user
  say created_user 1
fi
# Its token: an earlier one is replaced only when asked to.
TL=$(${p.tokenList}) || stop "the user's tokens could not be read"
if has "$TL" '${p.tokenMatch}'; then
  ${request.replace ? `mark intent replace
  ${p.tokenAclDel} || stop "the old token's permission could not be removed"
  ${p.tokenDel} || stop "the old token could not be removed"
  mark done replace
  say replaced_token 1` : `stop "the token $U!$T exists already; choose Replace to make a new one (the old one then stops working)"`}
fi
# The secret is shown once: kept in a shell variable, encrypted to the plugin's one-time key.
mark intent token
OUT=$(${p.tokenAdd}) || stop "the token could not be created"
mark done token
say created_token 1
S=$(printf '%s' "$OUT" | tr ',{}' '\\n\\n\\n' | sed -n 's/^[[:space:]]*"value"[[:space:]]*:[[:space:]]*"\\([0-9A-Za-z-]*\\)"[[:space:]]*$/\\1/p' | head -n 1)
OUT=
[ -n "$S" ] || stop "no secret in the answer"
E=$(printf '%s' "$S" | openssl pkeyutl -encrypt -pubin -inkey "$W/orca.pub" -pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha256 -pkeyopt rsa_mgf1_md:sha256 | base64 | tr -d '\\n')
S=
[ -n "$E" ] || stop "the secret could not be encrypted"
# ${p.role} on / for both the user and the token: a token's rights are the intersection of both.
AL=$(${p.aclList}) || stop "the permissions could not be read"
if ! has "$AL" "\\"ugid\\":\\"$U\\"" '"roleid":"${p.role}"' '"path":"/"'; then
  mark intent user_acl
  ${p.userAcl} || stop "the user's permission could not be set"
  mark done user_acl
  say added_user_acl 1
  # The grant exactly as it now stands (path, role, propagate, user): Undo removes it only while
  # it is still this very entry.
  AL=$(${p.aclList}) || stop "the permissions could not be read"
  A=$(printf '%s\\n' "$AL" | tr '{' '\\n' | grep -F "\\"ugid\\":\\"$U\\"" | grep -F '"roleid":"${p.role}"' | grep -F '"path":"/"' | sed 's/[]},[:space:]]*$//')
  [ -n "$A" ] && [ "$(printf '%s\\n' "$A" | wc -l)" = 1 ] || stop "the user's new permission could not be read back"
  mark acl "$A"
else
  mark existing user_acl
fi
mark intent token_acl
${p.tokenAcl} || stop "the token's permission could not be set"
mark done token_acl
`)
  lines.push(`# What the API presents, read here on the host: the plugin then requires the same from its side.
FP=$(timeout 10 openssl s_client -connect 127.0.0.1:${p.port} </dev/null 2>/dev/null | openssl x509 -noout -fingerprint -sha256 2>/dev/null | sed 's/^.*=//')
say api_fp "$FP"
say hostname "$(hostname)"
I=0
for L in $(printf '%s\\n' "$E" | fold -w 64); do I=$((I + 1)); say secret "$I $L"; done
mark complete
finish ok
`)
  return lines.join('\n')
}

/**
 * The Undo script for a setup run: what the host recorded for that run, in the guide's order,
 * each resource removed only while it still carries this run's label, every list read checked.
 */
export function undoScript(product: SetupProduct, setupRunId: string, runId: string): string {
  if (product !== 'pve' && product !== 'pbs') throw new ScriptError('Unknown product.')
  if (!RUN_ID.test(setupRunId) || !RUN_ID.test(runId)) throw new ScriptError('The run id is not valid.')
  const p = PRODUCTS[product]
  const lines: string[] = [prelude(runId, `undo what the setup run ${setupRunId} created`)]
  lines.push(`[ "$(id -u)" = 0 ] || stop "not root"
S=${setupRunId}
[ -e ${STATE_DIR} ] || { say nothing 1; finish ok; exit 0; }
${LOCK}STATE=${STATE_DIR}/$S
[ -f "$STATE" ] && [ ! -L "$STATE" ] || { say nothing 1; finish ok; exit 0; }
did() { grep -q "^intent $1\\( \\|$\\)" "$STATE"; }
# Ownership of the user, its permission and the token: only what this run recorded as done;
# never what it found there (existing), never what it only meant to do (intent).
made() { grep -q "^done $1\\( \\|$\\)" "$STATE" && ! grep -qx "existing $1" "$STATE"; }
UNSURE=
for I in user user_acl token; do did "$I" && ! made "$I" && UNSURE="$UNSURE $I"; done
undone() { grep -qx "undone $1" "$STATE"; }
mark() { printf '%s\\n' "$*" >> "$STATE" || stop "the state file could not be written"; }
U='${p.user}'; T='${TOKEN_NAME}'
${JSON_HELPERS}`)
  lines.push(`# 1. The token this run created, only while its comment is still this run's.
UL=$(${p.userList}) || stop "the user list could not be read"
UEX=
has "$UL" "\\"userid\\":\\"$U\\"" && UEX=1
TL='[]'
if [ -n "$UEX" ]; then TL=$(${p.tokenList}) || stop "the user's tokens could not be read"; fi
if made token && ! undone token; then
  if has "$TL" '${p.tokenMatch}' "\\"comment\\":\\"Orca plugin $S\\""; then
    ${p.tokenAclDel} || stop "the token's permission could not be removed"
    ${p.tokenDel} || stop "the token could not be removed"
    TL=$(${p.tokenList}) || stop "the user's tokens could not be read"
    say removed_token 1
  elif has "$TL" '${p.tokenMatch}'; then
    say kept_token "a token of that name was made again since"
  fi
  mark undone token
fi
# 2. The user (or its permission) only when this run made it and it has no token left at all.
LEFT=$(printf '%s' "$TL" | tr '{' '\\n' | grep -c '"tokenid"')
# The user's own permission entries now, and the one this run made as it recorded it then.
UG="\\"ugid\\":\\"$U\\""
AL=$(${p.aclList}) || stop "the permissions could not be read"
ALLU=$(printf '%s\\n' "$AL" | tr '{' '\\n' | grep -F "$UG" | sed 's/[]},[:space:]]*$//')
MINE=$(printf '%s\\n' "$ALLU" | grep -F '"roleid":"${p.role}"' | grep -F '"path":"/"')
REC=$(sed -n 's/^acl //p' "$STATE" | head -n 1)
CHANGED=
ACL=
if made user_acl && ! undone user_acl; then
  if [ -z "$MINE" ]; then
    say kept_user "its permission was already removed"
    mark undone user_acl
  elif [ -n "$REC" ] && [ "$MINE" = "$REC" ]; then
    ACL=1
  else
    # Changed since the run (propagation, role or more): an administrator's now; left as it is.
    CHANGED="$CHANGED user_acl"
  fi
fi
${p.groupCheck}if [ -n "$UEX" ] && made user && ! undone user; then
  if ! has "$UL" "\\"userid\\":\\"$U\\"" "\\"comment\\":\\"Read-only, Orca plugin $S\\""; then
    say kept_user "it is not this run's any more"
    mark undone user
  elif [ "$LEFT" != 0 ]; then
    say kept_user "$LEFT other token(s)"
    mark undone user
  elif [ -n "$CHANGED" ]; then
    say kept_user "its permission was changed since the run"
  elif [ -n "$ALLU" ] && [ "$ALLU" != "$REC" ]; then
    CHANGED="$CHANGED user"
    say kept_user "it has permissions this run did not make"
  elif [ -n "$INGROUP" ]; then
    CHANGED="$CHANGED user"
    say kept_user "it was added to a group since the run"
  else
    # Its permission first (PBS keeps a removed user's permissions), then the user; then
    # nothing may be left for it or its token.
    if [ -n "$ACL" ]; then
      ${p.userAclDel} || stop "the user's permission could not be removed"
      mark undone user_acl
      say removed_user_acl 1
    fi
    ${p.userDel} || stop "the user could not be removed"
    mark undone user
    say removed_user 1
    AL=$(${p.aclList}) || stop "the permissions could not be read after removing the user"
    printf '%s\\n' "$AL" | tr '{' '\\n' | grep -qF -e "$UG" -e "\\"ugid\\":\\"$U!" && stop "permissions for $U are still there after removing it; remove them by hand"
  fi
elif [ -n "$ACL" ]; then
  if [ "$LEFT" = 0 ]; then
    ${p.userAclDel} || stop "the user's permission could not be removed"
    say removed_user_acl 1
  else
    say kept_user "$LEFT other token(s)"
  fi
  mark undone user_acl
fi
if [ -n "$UNSURE" ] || [ -n "$CHANGED" ]; then
  # Started but not recorded as done, or changed since: never removed from here; the journal stays.
  [ -n "$UNSURE" ] && say unconfirmed "$UNSURE"
  [ -n "$CHANGED" ] && say changed "$CHANGED"
else
  rm -f "$STATE"
fi
finish ok
`)
  return lines.join('\n')
}

/** What a script may answer, and which keys may come more than once. */
const KEYS = new Set([
  'root', 'pve', 'pbs', 'pdm', 'hostname', 'fqdn', 'via',
  'reused_user', 'created_user', 'replaced_token', 'created_token', 'added_user_acl', 'api_fp', 'secret',
  'nothing', 'unconfirmed', 'changed', 'removed_token', 'kept_token', 'removed_user', 'removed_user_acl', 'kept_user', 'stop'
])
const REPEATED = new Set(['secret'])

export type ScriptAnswer = {
  /** Every `key value`, in order, from 1 without a gap (only what was seen in full). */
  pairs: [string, string][]
  /** Set once the run's last line came, complete and matching its checksum. */
  end?: 'ok' | 'stop'
  stop?: string
  /** Something in the terminal claimed to be an answer of this run but did not fit. */
  invalid?: string
}

/**
 * Collects a run's answers from terminal reads, keeping what was seen in full across reads (a
 * later, shorter tail loses nothing), and accepts the end only when every line before it is
 * there and matches its checksum.
 */
export class AnswerReader {
  private frames = new Map<number, [string, string]>()
  private endLine: { n: number; status: string; sum: string } | undefined
  private bad: string | undefined
  private readonly runId: string
  constructor(runId: string) {
    this.runId = runId
  }

  /** One read's lines: the last may still be being written, so only an end line is taken from it. */
  add(lines: readonly string[]): void {
    const re = new RegExp(`^ORCA-SETUP-${this.runId} ([1-9][0-9]{0,3}) ([a-z_]{2,20})(?: (.*))?$`)
    lines.forEach((raw, i) => {
      const line = raw.replace(/\s+$/, '')
      if (!line.includes(`ORCA-SETUP-${this.runId} `)) return
      const m = re.exec(line)
      if (!m) {
        if (i < lines.length - 1) this.bad ??= 'a line of this run is malformed'
        return
      }
      const n = Number(m[1])
      const key = m[2]
      const value = (m[3] ?? '').slice(0, 600)
      if (key === 'end') {
        const e = /^(ok|stop) ([0-9a-f]{64})$/.exec(value)
        if (!e) return
        if (this.endLine && (this.endLine.n !== n || this.endLine.sum !== e[2])) this.bad ??= 'two different ends'
        this.endLine = { n, status: e[1], sum: e[2] }
        return
      }
      if (i === lines.length - 1) return
      if (!KEYS.has(key)) {
        this.bad ??= `an unknown answer ${key}`
        return
      }
      const seen = this.frames.get(n)
      if (seen && (seen[0] !== key || seen[1] !== value)) this.bad ??= `answer ${n} changed between reads`
      else this.frames.set(n, [key, value])
    })
  }

  /** The answer so far; `end` only when it is complete and checks out. */
  answer(sha256: (text: string) => string): ScriptAnswer {
    const pairs: [string, string][] = []
    for (let n = 1; this.frames.has(n); n += 1) pairs.push(this.frames.get(n)!)
    const out: ScriptAnswer = { pairs }
    const stop = pairs.find(([k]) => k === 'stop')
    if (stop) out.stop = stop[1]
    if (this.bad) out.invalid = this.bad
    const e = this.endLine
    if (!e || this.bad) return out
    if (pairs.length !== e.n - 1 || this.frames.size !== pairs.length) {
      if (pairs.length >= e.n - 1) out.invalid = 'answers beyond the end'
      return out
    }
    if (sha256(pairs.map(([k, v]) => `${k} ${v}\n`).join('')) !== e.sum) {
      out.invalid = 'the answers do not match their checksum'
      return out
    }
    const once = new Set<string>()
    for (const [k] of pairs) {
      if (REPEATED.has(k)) continue
      if (once.has(k)) {
        out.invalid = `answer ${k} came twice`
        return out
      }
      once.add(k)
    }
    out.end = e.status === 'ok' && !stop ? 'ok' : 'stop'
    return out
  }
}

export const valueOf = (answer: ScriptAnswer, key: string): string | undefined => answer.pairs.find(([k]) => k === key)?.[1]
export const said = (answer: ScriptAnswer, key: string): boolean => answer.pairs.some(([k, v]) => k === key && v === '1')

/** The secret's ciphertext, from its numbered chunks (1, 2, … in order), or null. */
export function cipherOf(answer: ScriptAnswer): string | null {
  const chunks = answer.pairs.filter(([k]) => k === 'secret').map(([, v]) => /^(\d{1,2}) ([A-Za-z0-9+/=]{1,64})$/.exec(v))
  if (!chunks.length || chunks.some((c, i) => !c || Number(c[1]) !== i + 1)) return null
  return chunks.map((c) => c![2]).join('')
}
