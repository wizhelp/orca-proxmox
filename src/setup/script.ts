// The server-side scripts of "Connect via Orca", generated from the fixed templates below: no
// remote fetch, nothing typed by anyone but a few values validated here, each in one exact form.
// Pure: the worker shows the exact text to the person and runs it only after they confirm.
//
// Trust. A script runs as root on the host, and what it prints comes back through a terminal, so
// its answers are only as trustworthy as that host: they are framed strictly (run id, sequence
// number, a checksum over all of them in the last line) so that nothing else in the terminal, a
// partial read or a lost line can pass for a complete answer, and the plugin checks what it can
// on its own from this machine (the certificate and SSH host key by connecting, the token's
// rights through the API, the tunnel account's limits with live ssh attempts).
//
// Durable host-side state. Before each change the setup script records its intent, and after it
// the result, in /var/lib/orca-proxmox-setup/<run id> (root only), and everything it creates is
// labelled with the run id (user and token comments, the account's GECOS field, the exact key
// line). Undo reads that file on the host and removes a resource only when its label is still
// this run's: never one an administrator made or remade since, and never on the strength of what
// the terminal or the plugin's storage says alone.
//
// No script ever prints a secret: the new token's secret is encrypted on the host to the run's
// one-time public key (keys.ts) and only that ciphertext is printed.

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
  tunnel?: TunnelRequest
}

/** The tunnel account, and the SSH connection the tunnel will use, as the host must see it. */
export type TunnelRequest = {
  /** `ssh-ed25519 AAAA… orca-proxmox-tunnel`, the plugin's public key. */
  keyLine: string
  /** This machine's address as the host sees it (its SSH_CONNECTION). */
  client: string
  /** The host's address and SSH port the tunnel connects to. */
  laddr: string
  lport: number
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
    preflight: ''
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
    preflight: `for C in 'user list:--output-format' 'user list-tokens:--output-format' 'user generate-token:--comment' 'user create:--comment' 'acl list:--output-format' 'acl update:--delete'; do
  H=$(proxmox-backup-manager help \${C%%:*} --verbose 2>&1 || proxmox-backup-manager help \${C%%:*} --verbose true 2>&1) || stop "this proxmox-backup-manager has no '\${C%%:*}'; nothing was changed"
  printf '%s' "$H" | grep -q -- "\${C#*:}" || stop "this proxmox-backup-manager's '\${C%%:*}' has no \${C#*:}; nothing was changed"
done
`
  }
} as const

export const TOKEN_NAME = 'orca'
export const TUNNEL_USER = 'orca-tunnel'
export const KEY_COMMENT = 'orca-proxmox-tunnel'
const USER_COMMENT = 'Read-only, Orca plugin'
const STATE_DIR = '/var/lib/orca-proxmox-setup'

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
export const KEY_LINE = new RegExp(`^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5[A-Za-z0-9+/]{43,}={0,2} ${KEY_COMMENT}$`)
/** OpenSSH's `expiry-time`, as the setup script writes it (UTC). */
export const EXPIRY = /^\d{12}Z$/

function check(request: SetupRequest): void {
  if (request.product !== 'pve' && request.product !== 'pbs') throw new ScriptError('Only a Proxmox VE or Backup Server host can be connected this way.')
  if (!RUN_ID.test(request.runId)) throw new ScriptError('The run id is not valid.')
  if (!PEM.test(request.resultKey)) throw new ScriptError('The one-time key is not a PEM public key.')
  if (typeof request.replace !== 'boolean') throw new ScriptError('Replace must be yes or no.')
  if (request.tunnel) checkTunnel(request.tunnel)
}

function checkTunnel(t: TunnelRequest): void {
  if (!KEY_LINE.test(t.keyLine)) throw new ScriptError('The tunnel key is not the plugin’s own Ed25519 public key.')
  if (safeIp(t.client) !== t.client || safeIp(t.laddr) !== t.laddr) throw new ScriptError('The connection context must be IP addresses.')
  if (!Number.isInteger(t.lport) || t.lport < 1 || t.lport > 65535) throw new ScriptError('The SSH port is not valid.')
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

/** The final authorized_keys line: the key may only forward, and only to the API. */
export function authorizedLine(keyLine: string, port: number): string {
  return `restrict,port-forwarding,permitopen="127.0.0.1:${port}" ${keyLine}`
}

/** The line installed first: the same, from this machine only, and expiring by itself. */
export function probeLine(keyLine: string, port: number, client: string, expiry: string): string {
  return `restrict,port-forwarding,permitopen="127.0.0.1:${port}",from="${client}",expiry-time="${expiry}" ${keyLine}`
}

/**
 * The connection context sshd -T -C is asked about: exactly the connection the tunnel will use,
 * which must be the one this shell came in on (its SSH_CONNECTION); anything else stops.
 */
function contextCheck(t: TunnelRequest, port: number): string {
  return `# The connection the tunnel will use must be the one this shell came in on.
set -- \${SSH_CONNECTION:-}
[ "$#" = 4 ] || stop "this shell did not come in over SSH, so the tunnel's connection cannot be checked; nothing was changed"
[ "$1" = '${t.client}' ] && [ "$3" = '${t.laddr}' ] && [ "$4" = '${t.lport}' ] || stop "this shell came in from $1 to $3 port $4, not as the tunnel will (${t.client} to ${t.laddr} port ${t.lport}); nothing was changed"
CH='${t.client}'
if sshd -T 2>/dev/null | grep -qi '^usedns yes'; then
  CH=$(getent hosts '${t.client}' | awk '{ print $2; exit }')
  [ -n "$CH" ] || CH='${t.client}'
fi
CTX="host=$CH,addr=${t.client},laddr=${t.laddr},lport=${t.lport}"
policy_ok() {
  want=$(printf '%s\\n' 'allowagentforwarding no' 'allowstreamlocalforwarding no' 'allowtcpforwarding local' \\
    'forcecommand /bin/false' 'permitlisten none' 'permitopen 127.0.0.1:${port}' 'permittty no' 'x11forwarding no')
  got=$(sshd -T -C "user=${TUNNEL_USER},$CTX" 2>/dev/null |
    grep -Ei '^(allowtcpforwarding|allowstreamlocalforwarding|permitlisten|permitopen|permittty|x11forwarding|allowagentforwarding|forcecommand) ' | sort)
  [ "$got" = "$want" ]
}
root_policy() { sshd -T -C "user=root,$CTX" 2>/dev/null | sort; }
# What sshd -T reads from disk must be what the running daemon applies: no change since it last
# (re)loaded, unless sshd is socket-activated (each connection then reads the files anew).
if ! systemctl is-active --quiet ssh.socket 2>/dev/null; then
  SU=ssh.service
  systemctl is-active --quiet "$SU" || SU=sshd.service
  systemctl is-active --quiet "$SU" || stop "sshd's service is not active; nothing was changed"
  SINCE=$(date -d "$(systemctl show -p StateChangeTimestamp --value "$SU")" +%s 2>/dev/null) || stop "when sshd last loaded its settings is unknown; nothing was changed"
  [ -z "$(find /etc/ssh/sshd_config /etc/ssh/sshd_config.d -newermt "@$SINCE" 2>/dev/null | head -n 1)" ] ||
    stop "sshd's settings changed on disk since sshd last loaded them; reload sshd yourself first, then run this again; nothing was changed"
fi
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
  const t = request.tunnel
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
STATE=${STATE_DIR}/$R
[ -e "$STATE" ] && stop "this run was started before; nothing was changed"
: > "$STATE" || stop "no state file"
mark() { printf '%s\\n' "$*" >> "$STATE" || stop "the state file could not be written"; }
`)
  if (t) {
    lines.push(`# The tunnel account: refused when anything of it exists already.
command -v sshd >/dev/null 2>&1 || stop "no sshd"
id ${TUNNEL_USER} >/dev/null 2>&1 && stop "the account ${TUNNEL_USER} exists already; nothing was changed"
grep -q '^Match User ${TUNNEL_USER}$' /etc/ssh/sshd_config && stop "sshd_config already has a Match User ${TUNNEL_USER} block; nothing was changed"
sshd -t || stop "sshd_config has an error already; nothing was changed"
${contextCheck(t, p.port)}BEFORE=$(root_policy)
[ -n "$BEFORE" ] || stop "sshd -T gave nothing; nothing was changed"
`)
  }
  lines.push(`# The read-only user: created, or reused only when it is the plugin's own.
UL=$(${p.userList}) || stop "the user list could not be read"
if has "$UL" "\\"userid\\":\\"$U\\""; then
  has "$UL" "\\"userid\\":\\"$U\\"" "\\"comment\\":\\"${USER_COMMENT}" || stop "the user $U exists and was not made for Orca; nothing was changed"
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
fi
${p.tokenAcl} || stop "the token's permission could not be set"
`)
  if (t) {
    lines.push(`# The tunnel account, with no password and no key yet.
B=/etc/ssh/sshd_config.orca-backup.$R
cp -a /etc/ssh/sshd_config "$B" || stop "no backup of sshd_config could be made"
mark intent account
useradd --system --create-home --shell /usr/sbin/nologin --comment "Orca plugin $R" ${TUNNEL_USER} || stop "the account could not be created"
mark done account
say created_account 1
usermod -p '*' ${TUNNEL_USER} || stop "the account's password could not be locked"
install -d -m 700 -o ${TUNNEL_USER} -g ${TUNNEL_USER} /home/${TUNNEL_USER}/.ssh || stop "the account's .ssh could not be made"
# Its rules, appended; verified for the tunnel's own connection before the reload and after it.
mark intent policy
cat >> /etc/ssh/sshd_config <<'ORCA_POLICY' || stop "the rules could not be appended"
${policyBlock(p.port)}ORCA_POLICY
mark done policy
say added_policy 1
sshd -t || stop "sshd_config has an error now; use Undo"
policy_ok || stop "an earlier rule wins over the account's rules for this connection; use Undo"
[ "$(root_policy)" = "$BEFORE" ] || stop "root's effective sshd settings would change; use Undo"
{ systemctl reload ssh || systemctl reload sshd; } || stop "sshd could not be reloaded; use Undo"
sleep 1
policy_ok || stop "the rules differ after the reload; use Undo"
[ "$(root_policy)" = "$BEFORE" ] || stop "root's effective sshd settings changed with the reload; use Undo"
[ "$(timeout 5 bash -c 'exec 3<>/dev/tcp/${t.laddr}/${t.lport} && head -c 4 <&3' 2>/dev/null)" = SSH- ] ||
  stop "sshd does not answer new connections on ${t.laddr} port ${t.lport} after the reload; use Undo now, from this session"
# Only now a key: for this machine only, expiring by itself in 15 minutes unless the plugin's
# checks from this machine pass and it is made permanent.
K=/home/${TUNNEL_USER}/.ssh/authorized_keys
[ -e "$K" ] && stop "$K exists already; use Undo"
X=$(date -u -d '+15 min' +%Y%m%d%H%MZ) || stop "no expiry time"
mark intent keyfile $X ${t.client}
install -m 600 -o ${TUNNEL_USER} -g ${TUNNEL_USER} /dev/null "$K" || stop "the key file could not be created"
printf '%s\\n' 'restrict,port-forwarding,permitopen="127.0.0.1:${p.port}",from="${t.client}",expiry-time="'"$X"'" ${t.keyLine}' >> "$K" || stop "the key could not be written; use Undo"
mark done keyfile $X ${t.client}
say created_keyfile 1
say key_expiry "$X"
for F in /etc/ssh/ssh_host_ed25519_key.pub /etc/ssh/ssh_host_ecdsa_key.pub; do
  [ -r "$F" ] && { say ssh_hostkey "$(cut -d' ' -f1,2 "$F")"; break; }
done
`)
  }
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
 * After the plugin's own checks from this machine passed: the key that expires is made the
 * permanent one, only while the file holds exactly the key this run installed.
 */
export function finalizeScript(product: SetupProduct, setupRunId: string, runId: string, t: TunnelRequest, expiry: string): string {
  if (product !== 'pve' && product !== 'pbs') throw new ScriptError('Unknown product.')
  if (!RUN_ID.test(setupRunId) || !RUN_ID.test(runId)) throw new ScriptError('The run id is not valid.')
  checkTunnel(t)
  if (!EXPIRY.test(expiry)) throw new ScriptError('The key’s expiry is not valid.')
  const port = PRODUCTS[product].port
  return `${prelude(runId, `make the tunnel key of setup run ${setupRunId} permanent`)}
[ "$(id -u)" = 0 ] || stop "not root"
STATE=${STATE_DIR}/${setupRunId}
K=/home/${TUNNEL_USER}/.ssh/authorized_keys
grep -qx 'done keyfile ${expiry} ${t.client}' "$STATE" 2>/dev/null || stop "the host has no record of that key"
[ "$(cat "$K" 2>/dev/null)" = '${probeLine(t.keyLine, port, t.client, expiry)}' ] || stop "$K does not hold exactly the key that run installed; nothing was changed"
printf '%s\\n' "intent final" >> "$STATE" || stop "the state file could not be written"
install -m 600 -o ${TUNNEL_USER} -g ${TUNNEL_USER} /dev/null "$K.orca-new" || stop "the new key file could not be created"
printf '%s\\n' '${authorizedLine(t.keyLine, port)}' >> "$K.orca-new" || { rm -f "$K.orca-new"; stop "the key could not be written"; }
mv -f "$K.orca-new" "$K" || { rm -f "$K.orca-new"; stop "the key file could not be replaced"; }
printf '%s\\n' "done final" >> "$STATE" || stop "the state file could not be written"
say finalized_key 1
finish ok
`
}

/**
 * The Undo script for a setup run: what the host recorded for that run, in the guide's order,
 * each resource removed only while it still carries this run's label, every list read checked.
 */
export function undoScript(product: SetupProduct, setupRunId: string, runId: string, keyLine?: string): string {
  if (product !== 'pve' && product !== 'pbs') throw new ScriptError('Unknown product.')
  if (!RUN_ID.test(setupRunId) || !RUN_ID.test(runId)) throw new ScriptError('The run id is not valid.')
  if (keyLine !== undefined && !KEY_LINE.test(keyLine)) throw new ScriptError('The tunnel key is not the plugin’s own Ed25519 public key.')
  const p = PRODUCTS[product]
  const lines: string[] = [prelude(runId, `undo what the setup run ${setupRunId} created`)]
  lines.push(`[ "$(id -u)" = 0 ] || stop "not root"
S=${setupRunId}
STATE=${STATE_DIR}/$S
[ -f "$STATE" ] || { say nothing 1; finish ok; exit 0; }
did() { grep -q "^intent $1\\( \\|$\\)" "$STATE"; }
undone() { grep -qx "undone $1" "$STATE"; }
mark() { printf '%s\\n' "$*" >> "$STATE" || stop "the state file could not be written"; }
U='${p.user}'; T='${TOKEN_NAME}'
${JSON_HELPERS}`)
  if (!keyLine) {
    lines.push(`grep -qE '^intent (keyfile|policy|account)( |$)' "$STATE" && stop "the host recorded a tunnel account for this run, which this Undo does not know; nothing was changed"
`)
  } else {
    lines.push(`# 1. The key first: only while the file holds exactly a key this run installed.
K=/home/${TUNNEL_USER}/.ssh/authorized_keys
if did keyfile && ! undone keyfile; then
  X=$(sed -n 's/^intent keyfile \\([0-9]\\{12\\}Z\\) [0-9A-Fa-f:.]*$/\\1/p' "$STATE" | head -n 1)
  F=$(sed -n 's/^intent keyfile [0-9]\\{12\\}Z \\([0-9A-Fa-f:.]*\\)$/\\1/p' "$STATE" | head -n 1)
  if [ -e "$K" ]; then
    C=$(cat "$K")
    OK=
    [ "$C" = '${authorizedLine(keyLine, p.port)}' ] && OK=1
    [ -n "$X" ] && [ -n "$F" ] && [ "$C" = 'restrict,port-forwarding,permitopen="127.0.0.1:${p.port}",from="'"$F"'",expiry-time="'"$X"'" ${keyLine}' ] && OK=1
    [ -n "$OK" ] || stop "$K holds more than, or other than, this run's key; remove only that line by hand"
    rm -f "$K" || stop "the key file could not be removed"
  fi
  rm -f "$K.orca-new"
  mark undone keyfile
  say removed_keyfile 1
fi
# 2. The tunnel account's processes, only while the account is this run's: never anyone else's.
OURS=
[ "$(getent passwd ${TUNNEL_USER} | cut -d: -f5)" = "Orca plugin $S" ] && OURS=1
if did account && ! undone account && [ -n "$OURS" ] && [ "$(id -u ${TUNNEL_USER})" != 0 ]; then
  pkill -u ${TUNNEL_USER}; sleep 1
  pgrep -u ${TUNNEL_USER} >/dev/null && stop "${TUNNEL_USER} processes are still running"
fi
# 3. The rules this run appended: only while sshd_config is exactly the backup plus those rules
#    (or already the backup again, when a reload failed last time).
B=/etc/ssh/sshd_config.orca-backup.$S
if did policy && ! undone policy; then
  [ -e "$B" ] || stop "the backup $B is gone; remove the Orca Match block by hand"
  if { cat "$B"; cat <<'ORCA_POLICY'
${policyBlock(p.port)}ORCA_POLICY
  } | cmp -s - /etc/ssh/sshd_config; then
    cp -a "$B" /etc/ssh/sshd_config || stop "sshd_config could not be restored from $B"
  elif ! cmp -s "$B" /etc/ssh/sshd_config; then
    stop "sshd_config changed since the setup; remove the Orca Match block by hand"
  fi
  sshd -t || stop "the restored sshd_config has an error"
  { systemctl reload ssh || systemctl reload sshd; } || stop "sshd could not be reloaded; run Undo again"
  mark undone policy
  rm -f "$B"
  say removed_policy 1
fi
# 4. The account this run created, only while it is still labelled as this run's.
if did account && ! undone account; then
  if id ${TUNNEL_USER} >/dev/null 2>&1; then
    [ -n "$OURS" ] || stop "the account ${TUNNEL_USER} is not this run's any more; it was kept"
    userdel -r ${TUNNEL_USER} || stop "the account could not be removed"
  fi
  mark undone account
  say removed_account 1
fi
`)
  }
  lines.push(`# 5. The token this run created, only while its comment is still this run's.
UL=$(${p.userList}) || stop "the user list could not be read"
UEX=
has "$UL" "\\"userid\\":\\"$U\\"" && UEX=1
TL='[]'
if [ -n "$UEX" ]; then TL=$(${p.tokenList}) || stop "the user's tokens could not be read"; fi
if did token && ! undone token; then
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
# 6. The user (or its permission) only when this run made it and it has no token left at all.
LEFT=$(printf '%s' "$TL" | tr '{' '\\n' | grep -c '"tokenid"')
if [ -n "$UEX" ] && did user && ! undone user; then
  if ! has "$UL" "\\"userid\\":\\"$U\\"" "\\"comment\\":\\"Read-only, Orca plugin $S\\""; then
    say kept_user "it is not this run's any more"
  elif [ "$LEFT" = 0 ]; then
    ${p.userDel} || stop "the user could not be removed"
    say removed_user 1
  else
    say kept_user "$LEFT other token(s)"
  fi
  mark undone user
elif [ -n "$UEX" ] && did user_acl && ! undone user_acl; then
  if [ "$LEFT" = 0 ]; then
    ${p.userAclDel} || stop "the user's permission could not be removed"
    say removed_user_acl 1
  else
    say kept_user "$LEFT other token(s)"
  fi
  mark undone user_acl
fi
rm -f "$STATE"
finish ok
`)
  return lines.join('\n')
}

/** What a script may answer, and which keys may come more than once. */
const KEYS = new Set([
  'root', 'pve', 'pbs', 'pdm', 'sshd', 'hostname', 'fqdn', 'via',
  'reused_user', 'created_user', 'replaced_token', 'created_token', 'added_user_acl', 'created_account', 'added_policy', 'created_keyfile', 'key_expiry', 'ssh_hostkey', 'api_fp', 'secret',
  'finalized_key', 'nothing', 'removed_keyfile', 'removed_policy', 'removed_account', 'removed_token', 'kept_token', 'removed_user', 'removed_user_acl', 'kept_user', 'stop'
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
