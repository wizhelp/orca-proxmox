// The server-side scripts of "Connect via Orca", generated from the fixed templates below: no
// remote fetch, nothing typed by anyone but the few validated values. Pure: the worker shows the
// exact text to the person and runs it only after they confirm (see service.ts).
//
// Every script speaks to the worker through lines `ORCA-SETUP-<run id> <key> <value>`; the run id
// is random per run, so nothing else in the terminal (the typed command included: it carries the
// script compressed) can pass for an answer. No script ever prints a secret: the new token's
// secret is encrypted on the server to the run's one-time public key (keys.ts) and only that
// ciphertext is printed.
//
// They follow the guide's rules (docs/AGENT_SETUP.md, T2): nothing that already exists is reused
// or changed without saying so; the tunnel's account gets its key only after its effective sshd
// policy is verified, before and after the reload; and Undo reverses only what that run created,
// each step checked, stopping at the first that fails.

import { safeIp } from '../features/targets'

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
  /** Also the restricted tunnel account, with the plugin's own key. */
  tunnel?: {
    /** `ssh-ed25519 AAAA… orca-proxmox-tunnel`, the plugin's public key. */
    keyLine: string
    /** The address Orca's machine connects from, as the server sees it (for `sshd -T -C`). */
    clientAddr: string
  }
}

/** What a run did, as the server reported it: kept by the plugin, and what Undo works from. */
export type SetupReceipt = {
  product: SetupProduct
  runId: string
  createdUser: boolean
  addedUserAcl: boolean
  createdToken: boolean
  replacedToken: boolean
  tunnel?: {
    keyLine: string
    createdAccount: boolean
    /** The backup of sshd_config made before the Match block was appended. */
    backup?: string
    addedPolicy: boolean
    createdKeyFile: boolean
  }
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
    userAdd: 'pveum user add "$U" --comment "$C"',
    userDel: 'pveum user delete "$U"',
    tokenList: 'pveum user token list "$U" --output-format json',
    tokenMatch: '"tokenid":"orca"',
    tokenAdd: 'pveum user token add "$U" "$T" --privsep 1 --comment "$C" --output-format json',
    tokenDel: 'pveum user token remove "$U" "$T"',
    aclList: 'pveum acl list --output-format json',
    userAcl: 'pveum acl modify / --users "$U" --roles PVEAuditor',
    userAclDel: 'pveum acl delete / --users "$U" --roles PVEAuditor',
    tokenAcl: 'pveum acl modify / --tokens "$U!$T" --roles PVEAuditor',
    tokenAclDel: 'pveum acl delete / --tokens "$U!$T" --roles PVEAuditor'
  },
  pbs: {
    label: 'Proxmox Backup Server',
    user: 'orca-monitor@pbs',
    role: 'Audit',
    port: 8007,
    tool: 'proxmox-backup-manager',
    userList: 'proxmox-backup-manager user list --output-format json',
    userAdd: 'proxmox-backup-manager user create "$U" --comment "$C"',
    userDel: 'proxmox-backup-manager user remove "$U"',
    tokenList: 'proxmox-backup-manager user list-tokens "$U" --output-format json',
    tokenMatch: '"tokenid":"orca-monitor@pbs!orca"',
    tokenAdd: 'proxmox-backup-manager user generate-token "$U" "$T" --output-format json',
    tokenDel: 'proxmox-backup-manager user delete-token "$U" "$T"',
    aclList: 'proxmox-backup-manager acl list --output-format json',
    userAcl: 'proxmox-backup-manager acl update / Audit --auth-id "$U"',
    userAclDel: 'proxmox-backup-manager acl update / Audit --auth-id "$U" --delete true',
    tokenAcl: 'proxmox-backup-manager acl update / Audit --auth-id "$U!$T"',
    tokenAclDel: 'proxmox-backup-manager acl update / Audit --auth-id "$U!$T" --delete true'
  }
} as const

export const TOKEN_NAME = 'orca'
export const TUNNEL_USER = 'orca-tunnel'
export const KEY_COMMENT = 'orca-proxmox-tunnel'
const COMMENT = 'Read-only, Orca plugin'

/** The token ID the plugin saves for `product`. */
export function tokenIdOf(product: SetupProduct): string {
  return `${PRODUCTS[product].user}!${TOKEN_NAME}`
}
export function apiPortOf(product: SetupProduct): number {
  return PRODUCTS[product].port
}
export function productLabel(product: SetupProduct): string {
  return PRODUCTS[product].label
}

const RUN_ID = /^[0-9a-f]{16}$/
const PEM = /^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]{200,1000}\n-----END PUBLIC KEY-----\n?$/
const KEY_LINE = new RegExp(`^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5[A-Za-z0-9+/]{43,}={0,2} ${KEY_COMMENT}$`)
const BACKUP = /^\/etc\/ssh\/sshd_config\.orca-backup\.\d{8}-\d{6}$/

/** Only an IP address goes into `sshd -T -C addr=`; anything else becomes a documentation address. */
export function clientAddress(raw: string | undefined): string {
  return safeIp(raw) ?? '192.0.2.10'
}

function check(request: SetupRequest): void {
  if (request.product !== 'pve' && request.product !== 'pbs') throw new ScriptError('Only a Proxmox VE or Backup Server host can be connected this way.')
  if (!RUN_ID.test(request.runId)) throw new ScriptError('The run id is not valid.')
  if (!PEM.test(request.resultKey)) throw new ScriptError('The one-time key is not a PEM public key.')
  if (request.tunnel) {
    if (!KEY_LINE.test(request.tunnel.keyLine)) throw new ScriptError('The tunnel key is not the plugin’s own Ed25519 public key.')
    if (clientAddress(request.tunnel.clientAddr) !== request.tunnel.clientAddr) throw new ScriptError('The client address is not an IP address.')
  }
}

/** Shell lines shared by every script: a fixed PATH, the answer and stop helpers. */
function prelude(runId: string, title: string): string {
  return `#!/bin/sh
# Proxmox for Orca: ${title}.
# Generated by the plugin from its reviewed template; it prints no secret.
set -u
umask 077
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
R=${runId}
say() { printf 'ORCA-SETUP-%s %s %s\\n' "$R" "$1" "$2"; }
stop() { say stop "$1"; say end stop; exit 1; }
`
}

/** The Match block for the tunnel account: local forwards to the API only. */
export function policyBlock(port: number): string {
  return `
# Orca plugin: an account that may only forward to the local Proxmox API.
Match User ${TUNNEL_USER}
    AllowTcpForwarding local
    AllowStreamLocalForwarding no
    PermitListen none
    PermitOpen 127.0.0.1:${port}
    PermitTTY no
    X11Forwarding no
    AllowAgentForwarding no
    ForceCommand /bin/false
`
}

/** The authorized_keys line: the key may only forward, and only to the API. */
export function authorizedLine(keyLine: string, port: number): string {
  return `restrict,port-forwarding,permitopen="127.0.0.1:${port}" ${keyLine}`
}

/** What sshd applies to the tunnel account coming from Orca's machine, compared exactly. */
function policyCheck(port: number, addr: string): string {
  return `policy_ok() {
  want=$(printf '%s\\n' 'allowagentforwarding no' 'allowstreamlocalforwarding no' 'allowtcpforwarding local' \\
    'forcecommand /bin/false' 'permitlisten none' 'permitopen 127.0.0.1:${port}' 'permittty no' 'x11forwarding no')
  got=$(sshd -T -C user=${TUNNEL_USER},host=orca-client,addr=${addr},laddr=192.0.2.20,lport=22 2>/dev/null |
    grep -Ei '^(allowtcpforwarding|allowstreamlocalforwarding|permitlisten|permitopen|permittty|x11forwarding|allowagentforwarding|forcecommand) ' | sort)
  [ "$got" = "$want" ]
}
root_policy() { sshd -T -C user=root,host=orca-client,addr=${addr},laddr=192.0.2.20,lport=22 2>/dev/null | sort; }
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
command -v sshd >/dev/null 2>&1 && say sshd yes
say hostname "$(hostname)"
say fqdn "$(hostname -f 2>/dev/null)"
say via "\${SSH_CONNECTION:-}"
say end ok
`
}

/** The setup script for `request`; throws ScriptError for anything not exactly as expected. */
export function setupScript(request: SetupRequest): string {
  check(request)
  const p = PRODUCTS[request.product]
  const t = request.tunnel
  const lines: string[] = [prelude(request.runId, `connect this ${p.label} to the plugin, read-only`)]
  lines.push(`# Root, the product's own tool and openssl are needed; nothing is changed before these checks.
[ "$(id -u)" = 0 ] || stop "not root"
command -v ${p.tool} >/dev/null 2>&1 || stop "${p.tool} not found: this is not a ${p.label} host"
command -v openssl >/dev/null 2>&1 || stop "openssl not found"
W=$(mktemp -d) || stop "no temporary folder"
trap 'rm -rf "$W"' EXIT
cat > "$W/orca.pub" <<'ORCA_KEY'
${request.resultKey.trim()}
ORCA_KEY
U='${p.user}'; T='${TOKEN_NAME}'; C='${COMMENT}'
`)
  if (t) {
    lines.push(`# The tunnel account: refused when anything of it exists already.
command -v sshd >/dev/null 2>&1 || stop "no sshd"
id ${TUNNEL_USER} >/dev/null 2>&1 && stop "the account ${TUNNEL_USER} exists already; nothing was changed"
grep -q '^Match User ${TUNNEL_USER}$' /etc/ssh/sshd_config && stop "sshd_config already has a Match User ${TUNNEL_USER} block; nothing was changed"
sshd -t || stop "sshd_config has an error already; nothing was changed"
${policyCheck(p.port, t.clientAddr)}BEFORE=$(root_policy)
[ -n "$BEFORE" ] || stop "sshd -T gave nothing; nothing was changed"
`)
  }
  lines.push(`# The read-only user: created, or reused only when it is the plugin's own.
if ${p.userList} | tr '{' '\\n' | grep -qF "\\"userid\\":\\"$U\\""; then
  ${p.userList} | tr '{' '\\n' | grep -F "\\"userid\\":\\"$U\\"" | grep -qF "\\"comment\\":\\"$C\\"" ||
    stop "the user $U exists and was not made for Orca; nothing was changed"
else
  ${p.userAdd} || stop "the user $U could not be created"
  say created_user 1
fi
# Its token: an earlier one is replaced only when asked to.
if ${p.tokenList} | tr '{' '\\n' | grep -qF '${p.tokenMatch}'; then
  ${request.replace ? `${p.tokenAclDel} || stop "the old token's permission could not be removed"
  ${p.tokenDel} || stop "the old token could not be removed"
  say replaced_token 1` : `stop "the token $U!$T exists already; choose Replace to make a new one (the old one then stops working)"`}
fi
# The secret is shown once: kept in a shell variable, encrypted to the plugin's one-time key.
OUT=$(${p.tokenAdd}) || stop "the token could not be created"
say created_token 1
S=$(printf '%s' "$OUT" | sed -n 's/.*"value" *: *"\\([0-9A-Za-z-]*\\)".*/\\1/p')
OUT=
[ -n "$S" ] || stop "no secret in the answer"
E=$(printf '%s' "$S" | openssl pkeyutl -encrypt -pubin -inkey "$W/orca.pub" -pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha256 -pkeyopt rsa_mgf1_md:sha256 | base64 | tr -d '\\n')
S=
[ -n "$E" ] || stop "the secret could not be encrypted"
# ${p.role} on / for both the user and the token: a token's rights are the intersection of both.
if ! ${p.aclList} | tr '{' '\\n' | grep -F "\\"ugid\\":\\"$U\\"" | grep -F '"roleid":"${p.role}"' | grep -qF '"path":"/"'; then
  ${p.userAcl} || stop "the user's permission could not be set"
  say added_user_acl 1
fi
${p.tokenAcl} || stop "the token's permission could not be set"
`)
  if (t) {
    lines.push(`# The tunnel account, with no password and no key yet.
B=/etc/ssh/sshd_config.orca-backup.$(date +%Y%m%d-%H%M%S)
cp -a /etc/ssh/sshd_config "$B" || stop "no backup of sshd_config could be made"
say backup "$B"
useradd --system --create-home --shell /usr/sbin/nologin ${TUNNEL_USER} || stop "the account could not be created"
say created_account 1
usermod -p '*' ${TUNNEL_USER} || stop "the account's password could not be locked"
install -d -m 700 -o ${TUNNEL_USER} -g ${TUNNEL_USER} /home/${TUNNEL_USER}/.ssh || stop "the account's .ssh could not be made"
# Its rules, appended; verified before the reload (on disk) and after it.
cat >> /etc/ssh/sshd_config <<'ORCA_POLICY' || stop "the rules could not be appended"
${policyBlock(p.port)}ORCA_POLICY
say added_policy 1
sshd -t || stop "sshd_config has an error now; use Undo"
policy_ok || stop "an earlier rule wins over the account's rules; use Undo"
[ "$(root_policy)" = "$BEFORE" ] || stop "root's effective sshd settings would change; use Undo"
{ systemctl reload ssh || systemctl reload sshd; } || stop "sshd could not be reloaded; use Undo"
policy_ok || stop "the rules differ after the reload; use Undo"
# Only now the key, into a file this run creates.
K=/home/${TUNNEL_USER}/.ssh/authorized_keys
[ -e "$K" ] && stop "$K exists already; use Undo"
install -m 600 -o ${TUNNEL_USER} -g ${TUNNEL_USER} /dev/null "$K" || stop "the key file could not be created"
say created_keyfile 1
printf '%s\\n' '${authorizedLine(t.keyLine, p.port)}' >> "$K" || stop "the key could not be written; use Undo"
for F in /etc/ssh/ssh_host_ed25519_key.pub /etc/ssh/ssh_host_ecdsa_key.pub; do
  [ -r "$F" ] && { say ssh_hostkey "$(cut -d' ' -f1,2 "$F")"; break; }
done
`)
  }
  lines.push(`# What the API presents, read here on the server: the plugin pins it.
FP=$(timeout 10 openssl s_client -connect 127.0.0.1:${p.port} </dev/null 2>/dev/null | openssl x509 -noout -fingerprint -sha256 2>/dev/null | sed 's/^.*=//')
say api_fp "$FP"
say hostname "$(hostname)"
printf '%s\\n' "$E" | fold -w 64 | while read -r L; do say secret "$L"; done
say end ok
`)
  return lines.join('\n')
}

/** The Undo script for a receipt: only what that run created, in the guide's order. */
export function undoScript(receipt: SetupReceipt, undoRunId: string): string {
  if (!RUN_ID.test(undoRunId)) throw new ScriptError('The run id is not valid.')
  if (receipt.product !== 'pve' && receipt.product !== 'pbs') throw new ScriptError('Unknown product.')
  const p = PRODUCTS[receipt.product]
  const t = receipt.tunnel
  if (t && !KEY_LINE.test(t.keyLine)) throw new ScriptError('The receipt’s tunnel key is not valid.')
  if (t?.addedPolicy && !(t.backup && BACKUP.test(t.backup))) throw new ScriptError('The receipt’s sshd_config backup is not valid.')
  const lines: string[] = [prelude(undoRunId, `undo what the setup run ${receipt.runId} created`)]
  lines.push(`[ "$(id -u)" = 0 ] || stop "not root"
U='${p.user}'; T='${TOKEN_NAME}'
`)
  if (t) {
    lines.push(`# 1. The key first: only the file this run created, and only while it holds exactly its line.
K=/home/${TUNNEL_USER}/.ssh/authorized_keys
${t.createdKeyFile ? `if [ -e "$K" ]; then
  [ "$(cat "$K")" = '${authorizedLine(t.keyLine, p.port)}' ] || stop "$K now holds more than this run's key; remove only that line by hand"
  rm -f "$K" || stop "the key file could not be removed"
fi
say removed_keyfile 1` : '# This run created no key file.'}
# 2. The tunnel account's processes only: never root's or anyone else's.
${t.createdAccount ? `if id -u ${TUNNEL_USER} >/dev/null 2>&1 && [ "$(id -u ${TUNNEL_USER})" != 0 ]; then
  pkill -u ${TUNNEL_USER}; sleep 1
  pgrep -u ${TUNNEL_USER} >/dev/null && stop "${TUNNEL_USER} processes are still running"
fi` : '# This run created no account.'}
# 3. The rules this run appended: restored only while sshd_config is exactly backup + those rules.
${t.addedPolicy ? `B='${t.backup}'
if [ -e "$B" ]; then
  { cat "$B"; cat <<'ORCA_POLICY'
${policyBlock(p.port)}ORCA_POLICY
  } | cmp -s - /etc/ssh/sshd_config || stop "sshd_config changed since the setup; remove the Orca Match block by hand"
  cp -a "$B" /etc/ssh/sshd_config && sshd -t || stop "sshd_config could not be restored from $B"
  { systemctl reload ssh || systemctl reload sshd; } || stop "sshd could not be reloaded"
  rm -f "$B"
else
  stop "the backup $B is gone; remove the Orca Match block by hand"
fi
say removed_policy 1` : '# This run appended no rules.'}
# 4. The account this run created.
${t.createdAccount ? `if id ${TUNNEL_USER} >/dev/null 2>&1; then
  userdel -r ${TUNNEL_USER} || stop "the account could not be removed"
fi
say removed_account 1` : ''}
`)
  }
  lines.push(`# 5. The token this run created (with its permission).
${receipt.createdToken ? `if ${p.tokenList} | tr '{' '\\n' | grep -qF '${p.tokenMatch}'; then
  ${p.tokenAclDel} || stop "the token's permission could not be removed"
  ${p.tokenDel} || stop "the token could not be removed"
fi
say removed_token 1` : '# This run created no token.'}
# 6. The user (or its permission) only when this run made it and it has no other token left.
LEFT=$(${p.tokenList} 2>/dev/null | tr '{' '\\n' | grep -c '"tokenid"')
${receipt.createdUser ? `if [ "$LEFT" = 0 ]; then
  ${p.userDel} || stop "the user could not be removed"
  say removed_user 1
else
  say kept_user "$LEFT other token(s)"
fi` : receipt.addedUserAcl ? `if [ "$LEFT" = 0 ]; then
  ${p.userAclDel} || stop "the user's permission could not be removed"
  say removed_user_acl 1
else
  say kept_user "$LEFT other token(s)"
fi` : '# This run created no user and no permission of it.'}
say end ok
`)
  return lines.join('\n')
}

export type ScriptAnswer = {
  /** Every `key value` the run said, in order. */
  pairs: [string, string][]
  /** `ok` or `stop`, once the run said `end`. */
  end?: 'ok' | 'stop'
  stop?: string
}

/** The run's answers in terminal output: only lines with its own run id, values cleaned and capped. */
export function parseAnswer(lines: readonly string[], runId: string): ScriptAnswer {
  const out: ScriptAnswer = { pairs: [] }
  const prefix = `ORCA-SETUP-${runId} `
  for (const raw of lines) {
    const at = raw.indexOf(prefix)
    if (at < 0) continue
    const rest = raw.slice(at + prefix.length).replace(/[\u0000-\u001f\u007f]/g, '').trimEnd()
    const space = rest.indexOf(' ')
    const key = space < 0 ? rest : rest.slice(0, space)
    if (!/^[a-z_]{2,20}$/.test(key)) continue
    const value = (space < 0 ? '' : rest.slice(space + 1)).trim().slice(0, 400)
    out.pairs.push([key, value])
    if (key === 'stop' && out.stop === undefined) out.stop = value
    if (key === 'end') {
      out.end = value === 'ok' && out.stop === undefined ? 'ok' : 'stop'
      break
    }
  }
  return out
}

export const valueOf = (answer: ScriptAnswer, key: string): string | undefined => answer.pairs.find(([k]) => k === key)?.[1]
export const said = (answer: ScriptAnswer, key: string): boolean => answer.pairs.some(([k, v]) => k === key && v === '1')

/** What the setup run reported it created: the receipt Undo works from (also after a stop). */
export function receiptOf(request: SetupRequest, answer: ScriptAnswer): SetupReceipt {
  const backup = valueOf(answer, 'backup')
  return {
    product: request.product,
    runId: request.runId,
    createdUser: said(answer, 'created_user'),
    addedUserAcl: said(answer, 'added_user_acl'),
    createdToken: said(answer, 'created_token'),
    replacedToken: said(answer, 'replaced_token'),
    ...(request.tunnel
      ? {
          tunnel: {
            keyLine: request.tunnel.keyLine,
            createdAccount: said(answer, 'created_account'),
            ...(backup && BACKUP.test(backup) ? { backup } : {}),
            addedPolicy: said(answer, 'added_policy'),
            createdKeyFile: said(answer, 'created_keyfile')
          }
        }
      : {})
  }
}

/** True when the receipt holds anything to undo. */
export function anythingToUndo(r: SetupReceipt): boolean {
  return r.createdUser || r.addedUserAcl || r.createdToken || !!(r.tunnel && (r.tunnel.createdAccount || r.tunnel.addedPolicy || r.tunnel.createdKeyFile))
}
