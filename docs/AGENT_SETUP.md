# Setting up Proxmox for Orca: instructions for an agent

These steps are written for a coding agent (Claude Code, Codex, an Orca bot) that sets the plugin
up for a person. They are what a person would do by hand in PDM's web interface and the plugin's
Settings tab, done through PDM's API and a one-shot import file instead.

The plugin is read-only towards Proxmox. Everything below creates **one read-only API token**
in Proxmox Datacenter Manager (PDM) and hands it to the plugin. Without PDM, the same is done once
per PVE cluster (or standalone host) and per PBS: see
[Without PDM: PVE and PBS directly](#without-pdm-pve-and-pbs-directly). Start with
[Choose the setup with the person](#choose-the-setup-with-the-person).

## Rules for the agent

- **Establish trust in PDM's certificate before any credential is sent** (step 0). Never use
  `curl -k`/`--insecure`; every call that carries a password, cookie or token uses the verified
  certificate (`--cacert`) and its pinned public key (`--pinnedpubkey`).
- **Never ask the person to paste a password or token secret into the chat**, and never print
  one. Prompt for it in a terminal the person types into (`read -rs`). Secrets live only in files
  inside a private work folder (`umask 077`), are passed to `curl` as `@file` arguments or header
  files, never as command-line values (which other processes can see), and the folder is removed
  on exit, also when interrupted. Turn shell tracing off (`set +x`).
- **Every session that handles a secret, on Orca's machine or on a host, creates its own private
  folder first** (`umask 077; WORK=$(mktemp -d)`, removed on exit) and stops if it cannot; a
  secret is never written to a path whose folder was not created that way in the same session.
- **Check every answer**: an HTTP status other than 200, a missing session cookie or an empty
  token secret stops the procedure; do not continue on a guess.
- **Two-factor login**: if PDM asks for a second factor, stop and let the person create the token
  in PDM's web interface (step 2 by hand), then continue at step 3.
- Show the person each change before making it in PDM (a user, a token, two permissions).

## Choose the setup with the person

Before anything else, explain the setups and ask which the person wants. Each adds to the one
before, and all of them are read-only towards Proxmox:

| Setup | Needs | Adds | Sections |
| --- | --- | --- | --- |
| **A. PDM** | A read-only PDM token, HTTPS to PDM | Every remote's hosts, guests, containers' disk use, PBS backups, tasks, alerts, planner, Copy for AI | [0–5](#0-trust-pdms-certificate-first) |
| **B. PVE and PBS directly** (instead of A, or beside it) | A read-only token per server, HTTPS to each | The same per connection | [Without PDM](#without-pdm-pve-and-pbs-directly) |
| **C. + SSH tunnel, enrich only** | Per PVE node: SSH, a forward-only key, a read-only token; nothing else opened | VM disk use from the guest agent, storage types and updates, added to PDM's guests | [Through an SSH tunnel](#through-an-ssh-tunnel-enrich-only) |
| **D. + hosts connected to Orca** | The Proxmox nodes (or the guests running Orca) added to Orca as SSH targets or paired servers | Where Orca runs on the map, *Open Orca terminal here*, the base for per-worktree VMs | [Connect the hosts to Orca](#connect-the-hosts-to-orca) |

**Recommend A + D, and C if they want VM disk use.** Then follow the matching sections in order;
each one ends by handing a connection to the plugin through the import file
([step 4](#4-hand-the-connection-to-the-plugin)), except D, which is done in Orca itself.

## What to ask the person for

1. **The PDM URL as Orca's machine reaches it**, e.g. `https://pdm.example.com:8443`. This goes
   into the plugin (`PDM_URL`).
2. **How to make changes in PDM** (`ADMIN_URL`, where the admin calls go):
   - an **admin login** (for example `root@pam`) they type into a prompt you open on this
     machine; then `ADMIN_URL=$PDM_URL`; or
   - **SSH to the PDM host**: you open an SSH session in a terminal and run steps 0–2 there
     against `ADMIN_URL=https://127.0.0.1:8443`. Only over a host key that is already trusted
     (in `known_hosts`), or that the person confirms first: compare `ssh-keyscan pdm-host |
     ssh-keygen -lf -` with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` read on the
     host's console; then use `ssh -o StrictHostKeyChecking=yes`. A PDM login (typed into a prompt
     in that session) is still needed; SSH only keeps the admin traffic on the host. The token
     secret is then brought back to Orca's machine (step 4), and `PDM_URL` stays the address Orca
     uses: its certificate is verified separately (step 3).
3. **Which remotes** the plugin should see: all (Auditor on `/resource`) or only some (Auditor on
   `/resource/<remote>` for each).
4. Whether Orca is installed with this plugin (`orca plugin list` shows `…proxmox-visualizer`).
   If not: `orca plugin install wizhelp/orca-proxmox`, then the person approves it with the
   command Orca prints (an agent must not approve a plugin's access on the person's behalf).

No PDM? Connect the PVE hosts and PBS servers directly
([below](#without-pdm-pve-and-pbs-directly)), or set up a PDM ([the appendix](#appendix-no-pdm-yet)).

## 0. Trust PDM's certificate first

```sh
set +x; umask 077
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT INT TERM HUP
PDM_URL=https://pdm.example.com:8443
ADMIN_URL=$PDM_URL                      # or https://127.0.0.1:8443 in an SSH session on the host
HOSTPORT=${ADMIN_URL#https://}; HOSTPORT=${HOSTPORT%%/*}; HOST=${HOSTPORT%:*}
openssl s_client -connect "$HOSTPORT" -servername "$HOST" </dev/null 2>/dev/null |
  openssl x509 > "$WORK/pdm.pem"
openssl x509 -in "$WORK/pdm.pem" -noout -fingerprint -sha256
```

**Confirm that fingerprint independently before going on**, one of:

- the person compares it with what PDM's web interface shows under *Certificates* (on a screen
  they already trust), or
- you read it on the PDM host over SSH, which authenticates the host:
  `ssh root@pdm-host "openssl s_client -connect 127.0.0.1:8443 </dev/null 2>/dev/null | openssl x509 -noout -fingerprint -sha256"`.

If they differ, **stop**: something else answers at that address. If they match, pin the
certificate's public key for every call, in a private curl config file:

```sh
SPKI=$(openssl x509 -in "$WORK/pdm.pem" -pubkey -noout | openssl pkey -pubin -outform der |
  openssl dgst -sha256 -binary | openssl base64)
cat > "$WORK/curl.cfg" <<EOF
cacert = "$WORK/pdm.pem"
pinnedpubkey = "sha256//$SPKI"
silent
show-error
EOF
```

`--cacert` makes curl verify the certificate and the host name against exactly this certificate;
`--pinnedpubkey` makes it abort before sending anything if the server's key is a different one.
If curl reports that the certificate does not match the host name (you reach PDM by an address
the certificate does not list), add `connect-to = "<name in the certificate>:8443:<address>:8443"`
to the config and use that name in `ADMIN_URL` (`openssl x509 -in "$WORK/pdm.pem" -noout -ext
subjectAltName` lists the names). With a certificate from a public CA the normal checks apply and
the pin is still a good extra.

Keep the fingerprint (`AB:CD:…`, the part after `=`): it goes into the plugin in step 4. The
plugin then checks it on every connection before any request is sent.

## 1. Log in to PDM's API

PDM answers a login with a ticket set as an HTTP-only **cookie**, and returns a
`CSRFPreventionToken` that requests which change something must send as a header.

```sh
read -rp "PDM admin user (e.g. root@pam): " PDM_USER
read -rsp "Password for $PDM_USER: " PDM_PASS; echo
printf '%s' "$PDM_PASS" > "$WORK/password"; unset PDM_PASS       # printf is a shell builtin
code=$(curl -K "$WORK/curl.cfg" -c "$WORK/jar" -o "$WORK/login.json" -w '%{http_code}' \
  --data-urlencode "username=$PDM_USER" --data-urlencode "password@$WORK/password" \
  "$ADMIN_URL/api2/json/access/ticket")
rm -f "$WORK/password"
[ "$code" = 200 ] || { echo "Login failed (HTTP $code)"; exit 1; }
python3 - "$WORK" <<'PY' || exit 1
import json, os, sys
work = sys.argv[1]
data = json.load(open(os.path.join(work, "login.json"))).get("data") or {}
if data.get("NeedTFA") or "!tfa!" in str(data.get("ticket", "")):
    sys.exit("This login needs a second factor: create the token in PDM's web interface instead.")
csrf = data.get("CSRFPreventionToken")
if not csrf:
    sys.exit("No CSRFPreventionToken in the answer: the login did not complete.")
jar = open(os.path.join(work, "jar")).read()
if "AuthCookie" not in jar:
    sys.exit("No session cookie was set: the login did not complete.")
with open(os.path.join(work, "csrf.hdr"), "w") as f:
    f.write("CSRFPreventionToken: " + csrf + "\n")
os.remove(os.path.join(work, "login.json"))
PY
api() {  # api METHOD PATH [curl args…]: an authenticated call; fails unless HTTP 200
  local m=$1 p=$2; shift 2
  local c; c=$(curl -K "$WORK/curl.cfg" -b "$WORK/jar" -H @"$WORK/csrf.hdr" -X "$m" \
    -o "$WORK/answer.json" -w '%{http_code}' "$@" "$ADMIN_URL/api2/json$p")
  [ "$c" = 200 ] || { echo "$m $p failed (HTTP $c)"; return 1; }
}
```

## 2. Create a read-only user and token

```sh
# A user only for this; PDM's roles are Administrator and Auditor, Auditor reads everything.
api POST /access/users --data-urlencode 'userid=monitor@pdm' \
  --data-urlencode 'comment=Read-only, Orca plugin' || exit 1
# The token. Its secret ("value") is shown ONCE: straight into a private file, never printed.
api POST '/access/users/monitor@pdm/token/orca' || exit 1
python3 - "$WORK" <<'PY' || exit 1
import json, os, sys
work = sys.argv[1]
value = (json.load(open(os.path.join(work, "answer.json"))).get("data") or {}).get("value", "")
os.remove(os.path.join(work, "answer.json"))
if not value.strip():
    sys.exit("The token was created but no secret came back: delete it in PDM and create it again.")
open(os.path.join(work, "secret"), "w").write(value.strip())
PY
# Auditor for BOTH the user and the token: a token's rights are the intersection of its own and
# its user's. All remotes: /resource; only some: /resource/<remote>, once per remote.
for path in /resource; do
  for who in 'monitor@pdm' 'monitor@pdm!orca'; do
    api PUT /access/acl --data-urlencode "path=$path" --data-urlencode 'role=Auditor' \
      --data-urlencode "auth-id=$who" --data-urlencode 'propagate=1' || exit 1
  done
done
```

Gotchas:

- **Deleting and re-creating a token drops its permissions.** Re-run the `acl` calls for the
  token after re-creating it (and you get a new secret).
- If PDM refuses to create a `@pdm` user without a password, set one the person chooses (typed
  into a prompt and passed as `--data-urlencode password@file`); the token never needs it.
- Without Auditor the token still logs in, and every list comes back empty.

Verify with the token itself; print only a count (remote names are the person's data):

```sh
python3 - "$WORK" <<'PY'
import os, sys
work = sys.argv[1]
secret = open(os.path.join(work, "secret")).read().strip()
open(os.path.join(work, "auth.hdr"), "w").write("Authorization: PDMAPIToken=monitor@pdm!orca:" + secret + "\n")
PY
code=$(curl -K "$WORK/curl.cfg" -H @"$WORK/auth.hdr" -o "$WORK/list.json" -w '%{http_code}' \
  "$ADMIN_URL/api2/json/resources/list")
rm -f "$WORK/auth.hdr"
[ "$code" = 200 ] || { echo "The token cannot read the resources (HTTP $code): stop and check step 2."; exit 1; }
python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["data"]), "remotes visible")' "$WORK/list.json" ||
  { echo "Unexpected answer from PDM: stop."; exit 1; }
rm -f "$WORK/list.json" "$WORK/jar" "$WORK/csrf.hdr"
```

`0 remotes visible` means either a missing permission (see above) or a PDM without remotes yet;
ask the person which.

## 3. The fingerprint for the plugin

The plugin pins a SHA-256 fingerprint (`AB:CD:…`) for `PDM_URL`, the address **Orca** uses.

- If `PDM_URL` is the address you used in step 0 (`ADMIN_URL=$PDM_URL`), use the fingerprint
  confirmed there.
- If it differs (you worked over SSH on the host, or Orca reaches PDM through a different name, a
  proxy or a TLS-terminating front end), **verify the certificate `PDM_URL` presents separately**,
  from Orca's machine: run step 0's `openssl s_client` against `PDM_URL` and have the person
  confirm that fingerprint (with the front end's operator, or on that host) before using it. The
  plugin pins exactly what Orca's machine sees; a fingerprint from another endpoint fails closed.

With a certificate from a trusted CA it can stay empty. When the certificate is renewed, the pin
changes and the plugin asks for the new one.

## 4. Hand the connection to the plugin

Orca's CLI cannot call an installed plugin or write its secrets, so the plugin imports a
**one-shot file** on Orca's machine. Its exact path is in the plugin log; the worker writes it
when it starts (open the panel once if the log has no such line yet):

```sh
KEY=$(orca plugin list --json | python3 -c 'import json,sys; print(next(p["pluginKey"] for p in json.load(sys.stdin)["result"]["plugins"] if p["pluginKey"].endswith(".proxmox-visualizer")))')
orca plugin logs "$KEY" | sed -n 's/.*Connection import file: //p' | tail -1
```

Usually: Linux `~/.config/orca-proxmox-visualizer/connection-import.json` (or under
`$XDG_CONFIG_HOME`), macOS `~/Library/Application Support/orca-proxmox-visualizer/…`, Windows
`<your profile>\AppData\Local\orca-proxmox-visualizer\…`. Use the path from the log: a
redirected profile can differ from `%LOCALAPPDATA%`.

**If you ran steps 0–2 over SSH on the PDM host**, the secret is in that session's `$WORK`
(`echo $WORK` there gives `REMOTE_WORK`; keep that session open, its folder is removed when it
ends). Bring the secret to Orca's machine without printing it, into a private folder that is
removed on exit too, then remove it on the host; use `$LOCAL/secret` where the next step says
`$WORK/secret`:

```sh
# On Orca's machine:
set +x; umask 077; LOCAL=$(mktemp -d); trap 'rm -rf "$LOCAL"' EXIT INT TERM HUP
ssh -o StrictHostKeyChecking=yes root@pdm-host "cat '$REMOTE_WORK/secret' && rm -f '$REMOTE_WORK/secret'" > "$LOCAL/secret"
[ -s "$LOCAL/secret" ] || { echo "No secret came back: stop."; exit 1; }
```

Publish the file safely: write it **to a new, unique file created exclusively in the same folder**
(never an existing or predictable name), completely, then **rename it** to the final name, so the
plugin never sees a half-written or foreign file. If a file is still waiting under the final name,
let the plugin import it first. Linux/macOS:

```sh
IMPORT="<path from the log>"; DIR=$(dirname "$IMPORT")
mkdir -p "$DIR" && chmod 700 "$DIR"
[ -e "$IMPORT" ] && { echo "An earlier import file is still waiting: import it first."; exit 1; }
TMP=$(mktemp "$DIR/.connection-import.XXXXXXXX")        # new, unique, 0600, created exclusively
trap 'rm -rf "$WORK" "$LOCAL"; rm -f "$TMP"' EXIT INT TERM HUP
PDM_URL="$PDM_URL" FP="AB:CD:…" python3 - "$WORK/secret" "$TMP" "$IMPORT" <<'PY' || { echo "Publishing failed: the secret is kept in $WORK/secret, nothing was removed."; exit 1; }
import json, os, sys
secret_file, tmp, target = sys.argv[1], sys.argv[2], sys.argv[3]
with open(tmp, "w", encoding="utf-8") as f:   # the file mktemp just created, private to you
    json.dump({"baseUrl": os.environ["PDM_URL"], "tokenId": "monitor@pdm!orca",
               "fingerprint": os.environ["FP"], "secret": open(secret_file).read().strip()}, f)
    f.flush(); os.fsync(f.fileno())
os.rename(tmp, target)
PY
rm -f "$WORK/secret"
```

Windows (Windows PowerShell 5.1 or PowerShell 7). First the folder's access list is **replaced**
by exactly two entries, you and SYSTEM (nothing inherited, no other explicit entry kept), and
checked; then the file is created exclusively under a new unique name, its own access list checked
the same way, written as UTF-8 without a byte-order mark (the plugin also accepts one), and only
then renamed, without replacing anything. The secret file is removed only once the rename worked:

```powershell
$ErrorActionPreference = 'Stop'
$import = '<path from the log>'; $dir = Split-Path $import
New-Item -ItemType Directory -Force $dir | Out-Null
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$allowed = @($me, 'S-1-5-18')   # you and SYSTEM
# Replace the folder's access list: protected (nothing inherited), every existing entry removed,
# then full control for exactly the allowed accounts, inherited by what is created inside.
$acl = Get-Acl -LiteralPath $dir
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))) { $acl.PurgeAccessRules($rule.IdentityReference) }
foreach ($sid in $allowed) {
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule (
    (New-Object Security.Principal.SecurityIdentifier $sid), 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')))
}
Set-Acl -LiteralPath $dir -AclObject $acl
function Assert-Private($path) {   # protected, and no entry for anyone else
  $check = Get-Acl -LiteralPath $path
  $rules = $check.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
  $others = @($rules | Where-Object { $allowed -notcontains $_.IdentityReference.Value })
  if (-not $check.AreAccessRulesProtected -and $path -eq $dir) { throw "$path still inherits access: stop." }
  if ($others.Count -gt 0) { throw "$path is not private (others have access): stop." }
}
Assert-Private $dir
if (Test-Path -LiteralPath $import) { throw 'An earlier import file is still waiting: import it first.' }
$tmp = Join-Path $dir ('.connection-import.' + [guid]::NewGuid().ToString('N') + '.tmp')
$stream = [IO.File]::Open($tmp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try {
  $stream.Dispose(); Assert-Private $tmp   # checked before any secret goes in
  $stream = [IO.File]::Open($tmp, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::None)
  $secret = (Get-Content -Raw $secretFile).Trim()
  $json = @{ baseUrl = $PdmUrl; tokenId = 'monitor@pdm!orca'; fingerprint = $Fp; secret = $secret } | ConvertTo-Json -Compress
  $bytes = (New-Object Text.UTF8Encoding $false).GetBytes($json)
  $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true); $stream.Dispose()
  Move-Item -LiteralPath $tmp -Destination $import
} catch { $stream.Dispose(); Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue; throw }
Remove-Variable secret, json, bytes; Remove-Item -LiteralPath $secretFile
```

On Windows the plugin itself does not inspect file permissions (ACLs): the step above is what
makes and checks the folder and the file private, and it stops if either has an entry for anyone
but you and SYSTEM. Do not use a shared or redirected folder.

The file holds exactly `baseUrl`, `tokenId`, `secret` and optionally `fingerprint`, `kind`
(`pdm`, the default, `pve` or `pbs`) and, for `pve` and `pbs`, `name` (how the connection is
shown in the panel), all strings; for a direct connection also `tunnel` (an object: `host`,
`port`, `user`, `identityFile`, `target`, `hostKey`; see
[Through an SSH tunnel](#through-an-ssh-tunnel-enrich-only)), `enrichOnly` (true or false, PVE
only) and `nodeMap` (node names to PDM's). A file for a URL the plugin already has replaces that
connection; any other is added beside the existing ones.
The plugin refuses a file in a folder it cannot trust (a link, another owner, others can write
to it) and leaves it as it is. A file it has taken is never put back: one it cannot trust (a link,
other hard links, another owner, readable by others) or cannot use is removed, wiped first when it
is a plain file of yours; the status says exactly what became of it, with its path if it could
not be removed.

Then make the plugin import it: when its worker starts, on the command *Proxmox: Import the
connection file*, or on *Import now* in Settings. From a terminal:

```sh
orca plugin restart "$KEY"                    # stop the worker…
orca plugin open "$KEY" --panel=proxmox       # …opening the panel starts it, and it imports
sleep 5; orca plugin logs "$KEY" | grep -E 'Import( file)?:' | tail -2
```

The plugin tests the connection **before** it replaces anything. Two log lines tell the outcome:
`Import: …` says either `Imported the PDM connection to … Connection test: PDM x.y.z, N remotes
visible.` (for PVE: `N nodes visible`, for PBS: `N datastores visible`) or why not, with the
current connections kept; `Import file: …` says what became of the file. Read both. If the file
could **not** be deleted, delete it by hand: it holds the secret. The log (and the panel) show the PDM
URL, the token ID and the file's path, never the secret.

## 5. Check

Ask the person to look at the **Proxmox** panel: the header shows `N/N remotes up`, and the
Hosts tab their nodes. If it says the token sees no remotes, re-check the two ACL entries (step 2).

## Without PDM: PVE and PBS directly

Each **PVE cluster** is one connection: any one of its nodes shows the whole cluster. A
**standalone PVE host** cannot see other hosts' guests, so each standalone host is its own
connection. Each **PBS** is its own connection. Do the steps below once per server, with the same
rules as above (trust the certificate first, secrets only in files, show each change first).

**Ask the person for** each server's URL as Orca's machine reaches it (`https://pve.example.com:8006`,
`https://pbs.example.com:8007`), how you may make changes there (an admin login such as `root@pam`
typed into a prompt, or SSH to the host and `pveum`/`proxmox-backup-manager` there), an optional
short name for each connection (letters, digits, `.`, `_`, `-`; without one, the panel names it
after the URL's host), and, for PVE 9, whether the plugin may ask VMs' guest agents for their disk
use (below: the read-only role allows it unless you leave that privilege out).

### Certificate

Step 0 as written, with the server's port (8006 for PVE, 8007 for PBS). Confirm the fingerprint
independently: the person compares it with the node's **System → Certificates** (PVE) or the
dashboard's **Show Fingerprint** (PBS), or you read it on the host over SSH
(`openssl x509 -noout -fingerprint -sha256 -in /etc/pve/local/pve-ssl.pem` on PVE, or the
`pveproxy-ssl.pem` next to it when a custom certificate is installed;
`/etc/proxmox-backup/proxy.pem` on PBS).

### PVE: a read-only user and token

Over SSH on a PVE node (one node per cluster is enough, the access control is cluster-wide), in a
session that first creates a private folder for the secret (removed when it ends):

```sh
set +x; umask 077
WORK=$(mktemp -d) || { echo "no private temporary folder: stop"; exit 1; }
trap 'rm -rf "$WORK"' EXIT INT TERM HUP
[ -d "$WORK" ] && [ -O "$WORK" ] || { echo "temporary folder not private: stop"; exit 1; }
pveum user add monitor@pve --comment 'Read-only, Orca plugin'
# The token, with privilege separation: it gets only what is granted to it, capped by its user.
pveum user token add monitor@pve orca --privsep 1 --output-format json > "$WORK/token.json"
python3 - "$WORK" <<'PY' || exit 1
import json, os, sys
work = sys.argv[1]
value = json.load(open(os.path.join(work, "token.json"))).get("value", "")
os.remove(os.path.join(work, "token.json"))
if not value.strip():
    sys.exit("No secret came back: delete the token and create it again.")
open(os.path.join(work, "secret"), "w").write(value.strip())
PY
# PVEAuditor on / for BOTH the user and the token.
pveum acl modify / --users monitor@pve --roles PVEAuditor
pveum acl modify / --tokens 'monitor@pve!orca' --roles PVEAuditor
```

Through the API with an admin login instead, step 1's login works against PVE's
`/api2/json/access/ticket` (the cookie is `PVEAuthCookie`), then `POST /access/users` with
`userid=monitor@pve`, `POST /access/users/monitor@pve/token/orca` with `privsep=1` (the secret is
in `data.value`), and `PUT /access/acl` with `path=/`, `roles=PVEAuditor` and `users=monitor@pve`,
then again with `tokens=monitor@pve!orca` (for the role without guest-agent access below: first
`POST /access/roles` with `roleid=OrcaAuditor` and `privs=…`, then `roles=OrcaAuditor`).

**VM disk use through the guest agent.** The plugin reads a running VM's filesystem use from its
QEMU guest agent (`GET …/qemu/{vmid}/agent/get-fsinfo`; it keeps only used and total bytes).
What the token may do there depends on the PVE version:

- **PVE 9**: `PVEAuditor` **includes** `VM.GuestAgent.Audit`, which allows the agent's
  informational calls only (file systems, network interfaces, OS info, users and the like;
  running commands or reading files needs other privileges). So the role above already lets the
  plugin read VM disk use. **Ask the person before you hand the connection over**: if they do not
  want the guest agent asked, use a role without that privilege instead of `PVEAuditor`, so the
  server itself refuses it, and tell them to turn off **Disk use inside VMs** in Orca
  **Settings → Plugins → Proxmox** (then the plugin never asks):

  ```sh
  # PVEAuditor's privileges without VM.GuestAgent.Audit.
  pveum role add OrcaAuditor --privs 'VM.Audit,Sys.Audit,Datastore.Audit,SDN.Audit,Pool.Audit,Mapping.Audit'
  pveum acl modify / --users monitor@pve --roles OrcaAuditor
  pveum acl modify / --tokens 'monitor@pve!orca' --roles OrcaAuditor
  pveum acl delete / --users monitor@pve --roles PVEAuditor
  pveum acl delete / --tokens 'monitor@pve!orca' --roles PVEAuditor
  ```

- **PVE 8**: `PVEAuditor` has no guest-agent privilege; the only one for `get-fsinfo` is
  `VM.Monitor`, which also lets the token run commands inside guests through the agent. Do not
  grant it for this plugin: VM disk use then shows as unknown, with the allocated size.

For a VM's use to be readable, the person also has to **enable the guest agent** in the VM's
**Options → QEMU Guest Agent** (it takes effect after the VM is shut down and started again) and
**install and run** `qemu-guest-agent` inside the guest (on Windows, from the VirtIO drivers ISO).
Otherwise the panel says "unknown (no guest agent)".

Verify with the token itself from Orca's machine, with `PVE_URL` the address Orca uses and
`curl.cfg` pinned to that server's certificate as in step 0 (the PVE header has `=` between
token ID and secret); print only a count:

```sh
python3 - "$WORK" <<'PY'
import os, sys
work = sys.argv[1]
secret = open(os.path.join(work, "secret")).read().strip()
open(os.path.join(work, "auth.hdr"), "w").write("Authorization: PVEAPIToken=monitor@pve!orca=" + secret + "\n")
PY
code=$(curl -K "$WORK/curl.cfg" -H @"$WORK/auth.hdr" -o "$WORK/list.json" -w '%{http_code}' \
  "$PVE_URL/api2/json/cluster/resources?type=node")
rm -f "$WORK/auth.hdr"
[ "$code" = 200 ] || { echo "The token cannot read the cluster (HTTP $code): stop."; exit 1; }
python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["data"]), "nodes visible")' "$WORK/list.json" ||
  { echo "Unexpected answer from PVE: stop."; exit 1; }
rm -f "$WORK/list.json"
```

`0 nodes visible` means the ACL is missing on the user or the token.

### PBS: a read-only user and token

Over SSH on the PBS host, in a session that first creates a private folder for the secret
(removed when it ends):

```sh
set +x; umask 077
WORK=$(mktemp -d) || { echo "no private temporary folder: stop"; exit 1; }
trap 'rm -rf "$WORK"' EXIT INT TERM HUP
[ -d "$WORK" ] && [ -O "$WORK" ] || { echo "temporary folder not private: stop"; exit 1; }
proxmox-backup-manager user create monitor@pbs --comment 'Read-only, Orca plugin'
proxmox-backup-manager user generate-token monitor@pbs orca --output-format json > "$WORK/token.json"
python3 - "$WORK" <<'PY' || exit 1
import json, os, sys
work = sys.argv[1]
answer = json.load(open(os.path.join(work, "token.json")))
os.remove(os.path.join(work, "token.json"))
value = (answer.get("data") or answer).get("value", "")
if not value.strip():
    sys.exit("No secret came back: delete the token and create it again.")
open(os.path.join(work, "secret"), "w").write(value.strip())
PY
proxmox-backup-manager acl update / Audit --auth-id monitor@pbs
proxmox-backup-manager acl update / Audit --auth-id 'monitor@pbs!orca'
```

`Audit` on `/` reads the server's status, datastores, snapshots and tasks and changes nothing.
`DatastoreAudit` on `/datastore` is enough for datastores and backups only. Through the API:
`POST /access/users`, `POST /access/users/monitor@pbs/token/orca` and `PUT /access/acl` with
`path=/`, `role=Audit` and `auth-id`, once for the user and once for the token.

Verify from Orca's machine the same way as for PVE, with `PBS_URL` the address Orca uses,
`curl.cfg` pinned to the PBS certificate (step 0 against port 8007) and the PBS header (`:`
between token ID and secret):

```sh
python3 - "$WORK" <<'PY'
import os, sys
work = sys.argv[1]
secret = open(os.path.join(work, "secret")).read().strip()
open(os.path.join(work, "auth.hdr"), "w").write("Authorization: PBSAPIToken=monitor@pbs!orca:" + secret + "\n")
PY
code=$(curl -K "$WORK/curl.cfg" -H @"$WORK/auth.hdr" -o "$WORK/list.json" -w '%{http_code}' \
  "$PBS_URL/api2/json/admin/datastore")
rm -f "$WORK/auth.hdr"
[ "$code" = 200 ] || { echo "The token cannot read the datastores (HTTP $code): stop."; exit 1; }
python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["data"]), "datastores visible")' "$WORK/list.json" ||
  { echo "Unexpected answer from PBS: stop."; exit 1; }
rm -f "$WORK/list.json"
```

### Hand each connection to the plugin

Step 4, once per server, with `kind` and optionally `name` in the file; wait for each import's log
line before writing the next file:

```json
{ "kind": "pve", "name": "lab", "baseUrl": "https://pve.example.com:8006", "tokenId": "monitor@pve!orca", "fingerprint": "AB:CD:…", "secret": "…" }
```

In the Python of step 4, add `"kind": "pve"` (or `"pbs"`) and `"name"` to the dumped object and use
the server's URL and token ID; in the PowerShell, add `kind = 'pve'; name = 'lab'` to the hashtable.
The plugin tests each one before saving it; a PDM connection, if there is one, is kept. In the
panel, **Settings** lists every connection; the header counts the remotes of all of them.

## Through an SSH tunnel (enrich only)

For each PVE node (or PBS) whose API is not reachable from Orca's machine but SSH is. Usually
beside PDM, as **enrich only**: the connection adds VM disk use (guest agent), storage content
types and pending updates to the guests and nodes PDM already shows, and nothing else.

Same rules as above, and for every change on a host: **show the person the exact commands first
and wait for their approval**. Keep the current root session open from start to end, and open a
second one only to check that admin logins still work: if anything goes wrong, the open session
restores the backup. Examples use `pve-a.example.com` (SSH and API host, `192.0.2.20`) and
`192.0.2.10` (Orca's machine as the host sees it).

**Ask the person for**, per host: the SSH host and port as Orca's machine reaches them; how you
may make changes there (an SSH login as root over a host key that is already trusted, or that they
confirm on the console); the node's name in PDM, and its PDM cluster (remote) if more than one
PDM cluster could have a node of that name; and whether the plugin may read VMs' guest agents (on
PVE 9 the read-only role allows it).

### T1. On Orca's machine: a key only for the tunnel

One key for the plugin's tunnels and nothing else, without a passphrase (the plugin runs ssh
without prompts), readable by the person only:

```sh
ssh-keygen -t ed25519 -N '' -C orca-proxmox-tunnel -f ~/.ssh/orca-proxmox-tunnel
chmod 600 ~/.ssh/orca-proxmox-tunnel
```

On Windows PowerShell: `ssh-keygen -t ed25519 -N '""' -C orca-proxmox-tunnel -f
$HOME\.ssh\orca-proxmox-tunnel`, then `icacls $HOME\.ssh\orca-proxmox-tunnel /inheritance:r
/grant:r "$($env:USERNAME):F"` (OpenSSH refuses a key others can read). The public half
(`.pub`) goes to the hosts in T2f. On the hosts this key can only open the one forward set up
below; it opens no shell and runs no command, and the API behind the forward still needs its own
token.

### T2. On each host: the tunnel account, verified before it can be used

Everything in T2 runs in the open root session, one block at a time, each after the person's
approval. **Nothing here ends that session**: no block uses `exit`; a problem prints a line starting
with `STOP`, and then no further block is run until the person decides (the way back at the end
undoes exactly what this run did). The key is installed last (T2f), only once the account's
effective policy is verified. The blocks record what they changed in shell variables
(`ORCA_*`), which the way back uses, so keep to this one session.

**T2a. Backup and account** (no key yet, so nobody can log in as it):

```sh
umask 077
ORCA_BACKUP=/etc/ssh/sshd_config.orca-backup.$(date +%Y%m%d-%H%M%S)
if ! cp -a /etc/ssh/sshd_config "$ORCA_BACKUP"; then
  echo "STOP: no backup could be made"
elif id orca-tunnel >/dev/null 2>&1; then
  echo "STOP: orca-tunnel already exists; show the person 'id orca-tunnel' and its ~/.ssh first"
elif useradd --system --create-home --shell /usr/sbin/nologin orca-tunnel && usermod -p '*' orca-tunnel &&
     install -d -m 700 -o orca-tunnel -g orca-tunnel /home/orca-tunnel/.ssh; then
  ORCA_CREATED_ACCOUNT=1; echo "backup: $ORCA_BACKUP; account created (no password, no key)"
else
  echo "STOP: the account could not be set up"
fi
```

**T2b. Earlier Match blocks.** sshd uses the **first** value it finds for each keyword, so a
`Match` block that comes earlier and also matches this account (by `Group`, `Address`, `Host`,
`LocalAddress`, `LocalPort` or `All`), in `sshd_config` or in a file it includes before the end,
can override the rules below. List them and show them to the person:

```sh
grep -nE '^[[:space:]]*(Match|Include)[[:space:]]' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf 2>/dev/null
```

If one could match this account (for example `Match Group users` or `Match Address 192.0.2.0/24`),
stop and agree with the person how to change it; T2d shows the outcome either way.

**T2c. The account's rules**, appended at the end of `sshd_config` (once):

```sh
if grep -q '^Match User orca-tunnel$' /etc/ssh/sshd_config; then
  echo "STOP: a Match User orca-tunnel block is already there; review it with the person"
else
  cat >> /etc/ssh/sshd_config <<'EOF' && ORCA_ADDED_POLICY=1 && echo "policy appended"

# Orca plugin: an account that may only forward to the local Proxmox API.
Match User orca-tunnel
    AllowTcpForwarding local
    AllowStreamLocalForwarding no
    PermitListen none
    PermitOpen 127.0.0.1:8006
    PermitTTY no
    X11Forwarding no
    AllowAgentForwarding no
    ForceCommand /bin/false
EOF
fi
```

For PBS use `127.0.0.1:8007` (a host running both: `PermitOpen 127.0.0.1:8006 127.0.0.1:8007`, and
the same in `orca_policy_ok` below).

**T2d. Verify the effective policy before reloading.** `sshd -T` reads the configuration on disk,
not the running daemon, so this checks exactly what a reload would apply, for a connection from
Orca's machine to this host:

```sh
orca_policy_ok() {  # what sshd applies to orca-tunnel coming from Orca's machine, exactly
  local want got
  want=$(printf '%s\n' 'allowagentforwarding no' 'allowstreamlocalforwarding no' 'allowtcpforwarding local' \
    'forcecommand /bin/false' 'permitlisten none' 'permitopen 127.0.0.1:8006' 'permittty no' 'x11forwarding no')
  got=$(sshd -T -C user=orca-tunnel,host=orca-client,addr=192.0.2.10,laddr=192.0.2.20,lport=22 2>/dev/null |
    grep -Ei '^(allowtcpforwarding|allowstreamlocalforwarding|permitlisten|permitopen|permittty|x11forwarding|allowagentforwarding|forcecommand) ' | sort)
  [ "$got" = "$want" ] && return 0
  printf 'effective policy:\n%s\n' "$got"; return 1
}
if ! sshd -t; then
  echo "STOP: sshd_config has an error; restore it with the way back"
elif orca_policy_ok; then
  echo "policy OK (not reloaded yet)"
else
  echo "STOP: an earlier rule wins (T2b); use the way back"
fi
```

**T2e. Reload, verify again, then check a fresh admin login** (in the same session):

```sh
if ! { systemctl reload ssh || systemctl reload sshd; }; then
  echo "STOP: the reload failed; use the way back"
elif orca_policy_ok; then
  echo "reloaded, policy OK"
else
  echo "STOP: the policy differs after the reload; use the way back"
fi
```

Then, from Orca's machine in a **new** terminal, open a **new** authenticated admin connection,
with connection sharing off, so an existing (multiplexed) connection can neither stand in for it
nor be touched by it; do not close or `ssh -O exit` any existing master connection:

```sh
ssh -o ControlMaster=no -o ControlPath=none root@pve-a.example.com true && echo "fresh admin login works"
```

If it fails, use the way back from the open session.

**T2f. Only now, the key.** Only into a file this run creates; an existing `authorized_keys` is
never touched:

```sh
ORCA_KEYFILE=/home/orca-tunnel/.ssh/authorized_keys
ORCA_KEYLINE='restrict,port-forwarding,permitopen="127.0.0.1:8006" <contents of orca-proxmox-tunnel.pub>'
if [ -e "$ORCA_KEYFILE" ]; then
  echo "STOP: $ORCA_KEYFILE already exists; show it to the person, nothing was changed"
elif install -m 600 -o orca-tunnel -g orca-tunnel /dev/null "$ORCA_KEYFILE" && ORCA_CREATED_KEYFILE=1 &&
     printf '%s\n' "$ORCA_KEYLINE" >> "$ORCA_KEYFILE"; then
  echo "key installed"
else
  echo "STOP: the key could not be installed; use the way back"
fi
```

`restrict` turns off every forwarding, PTY and agent feature for the key, `port-forwarding` allows
forwards again and `permitopen` limits local forwards to the API; the `Match` block makes the
account's effective policy local TCP forwarding to the API only, whatever key is used.

**The way back**, at any point, in the same session. It undoes only what this run did, in an
order that never leaves the key enabled under a weaker policy: first the key (only the file this
run created, and only while it holds exactly this run's key line), then the `orca-tunnel` sessions
(that account's only: never root's or anyone else's, so this session and any admin connection
stay open), then the policy this run appended, then the reload, then the account this run
created. It stops at the first step that fails, without closing the session:

```sh
orca_way_back() {
  if [ "${ORCA_CREATED_KEYFILE:-}" = 1 ]; then
    if [ "$(cat "$ORCA_KEYFILE")" = "$ORCA_KEYLINE" ]; then
      rm -f "$ORCA_KEYFILE" || { echo "STOP: could not remove the key file"; return 1; }
    else
      echo "STOP: $ORCA_KEYFILE now holds more than this run's key; remove only that line by hand"; return 1
    fi
  fi
  # Only when this run made the account or its key: an account that was there before is left alone.
  if { [ "${ORCA_CREATED_ACCOUNT:-}" = 1 ] || [ "${ORCA_CREATED_KEYFILE:-}" = 1 ]; } && [ "$(id -u orca-tunnel 2>/dev/null)" != 0 ]; then
    pkill -u orca-tunnel; sleep 1
    pgrep -u orca-tunnel >/dev/null && { echo "STOP: orca-tunnel processes still running"; return 1; }
  fi
  if [ "${ORCA_ADDED_POLICY:-}" = 1 ]; then
    cp -a "$ORCA_BACKUP" /etc/ssh/sshd_config && sshd -t || { echo "STOP: could not restore $ORCA_BACKUP"; return 1; }
    { systemctl reload ssh || systemctl reload sshd; } || { echo "STOP: the reload failed"; return 1; }
  fi
  if [ "${ORCA_CREATED_ACCOUNT:-}" = 1 ]; then
    userdel -r orca-tunnel || { echo "STOP: could not remove the account"; return 1; }
  fi
  echo "undone"
}
orca_way_back
```

### T3. Pin both keys

Read both on the host (in the open root session, or on its console), not over the network:

```sh
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub                             # show the person
cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub                            # the tunnel's hostKey
openssl x509 -in /etc/pve/local/pve-ssl.pem -noout -fingerprint -sha256      # the API's pin
```

(`pveproxy-ssl.pem` next to `pve-ssl.pem` when a custom certificate is installed; PBS:
`/etc/proxmox-backup/proxy.pem`.) The person confirms the SSH host key fingerprint against what
`ssh-keyscan -t ed25519 -p 22 pve-a.example.com | ssh-keygen -lf -` shows from Orca's machine.

### T4. Verify the scope before using it (from Orca's machine)

Every check uses only the tunnel key, no SSH config, no agent, and the host key from T3 pinned in
a private file, with a time limit, so that a key or host-key problem can never pass for a refused
forward, and nothing allowed by mistake keeps running. The first check must succeed (it proves the
key and the host key work); every other must be refused with its own message:

```sh
set -u; umask 077
CHK=$(mktemp -d) || exit 1; trap 'rm -rf "$CHK"' EXIT INT TERM HUP
H=pve-a.example.com; K=$HOME/.ssh/orca-proxmox-tunnel
printf '%s %s\n' "$H" 'ssh-ed25519 AAAA…' > "$CHK/known_hosts"           # the hostKey from T3
S() { timeout 20 ssh -F none -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityAgent=none \
  -o "IdentityFile=$K" -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$CHK/known_hosts" \
  -o GlobalKnownHostsFile=none -o ConnectTimeout=10 -o ExitOnForwardFailure=yes "$@" "orca-tunnel@$H"; }
refused() {  # refused <expected message or ''> <ssh options…>: the attempt must fail, with that message
  local want=$1; shift
  S "$@" </dev/null >"$CHK/out" 2>&1; local code=$?
  if grep -qiE 'permission denied|host key verification failed' "$CHK/out"; then echo "KEY OR HOST KEY PROBLEM, not a policy answer: stop"; return 1; fi
  if [ "$code" = 124 ]; then echo "ALLOWED (ran until the time limit): stop and use the way back"; return 1; fi
  if [ "$code" = 0 ]; then echo "ALLOWED (exit 0): stop and use the way back"; return 1; fi
  if [ -n "$want" ] && ! grep -qi "$want" "$CHK/out"; then echo "UNEXPECTED: $(tail -2 "$CHK/out")"; return 1; fi
  echo "refused as expected (exit $code)"
}

# 1. The forward works: the API's certificate comes back through it (compare with T3's pin).
S -N -L 127.0.0.1:18006:127.0.0.1:8006 & T=$!; sleep 4
openssl s_client -connect 127.0.0.1:18006 </dev/null 2>/dev/null | openssl x509 -noout -fingerprint -sha256
kill $T; wait $T 2>/dev/null

refused ''                                         # 2. no shell: exits at once (status 1)
refused '' id                                      # 3. no command: no output (status 1)
grep -q 'uid=' "$CHK/out" && echo "A COMMAND RAN: stop and use the way back"
refused 'remote port forwarding failed' -N -R 127.0.0.1:18080:127.0.0.1:22        # 4. no reverse forward
refused 'remote port forwarding failed' -N -R /tmp/orca-test.sock:127.0.0.1:22    # 5. no socket forward

# 6. No other destination: the forward starts, but opening it is refused.
S -N -L 127.0.0.1:18022:127.0.0.1:22 >"$CHK/out" 2>&1 & T=$!; sleep 4
(exec 3<>/dev/tcp/127.0.0.1/18022) 2>/dev/null; sleep 2; kill $T; wait $T 2>/dev/null
grep -q 'administratively prohibited' "$CHK/out" && echo "refused as expected" || echo "UNEXPECTED: stop"
```

If check 1 fails, or any of 2–6 is not refused as expected, stop and use the way back (T2).
`timeout` is GNU coreutils (on macOS: `brew install coreutils` and `gtimeout`); without it, run
each check in the background and `kill` it after 20 s.

### T5. On each host: a read-only API token

In a root session on the host that starts by creating a private folder for the secret, removed
when the session ends; stop if it cannot be created:

```sh
set +x; umask 077
WORK=$(mktemp -d) || { echo "no private temporary folder: stop"; exit 1; }
trap 'rm -rf "$WORK"' EXIT INT TERM HUP
[ -d "$WORK" ] && [ -O "$WORK" ] || { echo "temporary folder not private: stop"; exit 1; }
pveum user add orca-monitor@pve --comment 'Read-only, Orca plugin'
pveum user token add orca-monitor@pve orca --privsep 1 --output-format json > "$WORK/token.json"
# Read the secret into "$WORK/secret" without printing it, as in "PVE: a read-only user and token".
pveum acl modify / --users orca-monitor@pve --roles PVEAuditor
pveum acl modify / --tokens 'orca-monitor@pve!orca' --roles PVEAuditor
pveum role list --output-format json | python3 -c 'import json,sys; r=[x for x in json.load(sys.stdin) if x["roleid"]=="PVEAuditor"][0]; print("VM.GuestAgent.Audit" in r["privs"])'
```

The token has **privilege separation**, and `PVEAuditor` on `/` (or narrower paths such as `/vms`,
`/nodes`, `/storage`) goes to **both** the user and the token. Never `Administrator` or any role
that can change something. The last line prints `True` on PVE 9: the role allows the guest
agent's informational calls, which is what VM disk use needs. `False` (PVE 8): VM disk use stays
unknown, and the plugin must not be given `VM.Monitor` instead (it allows running commands in
guests). If the person does not want the agent read, use the `OrcaAuditor` role from the PVE
section and turn off *Disk use inside VMs*. On a cluster the user, token and ACL exist once for
all nodes. Bring the secret to Orca's machine as in [step 4](#4-hand-the-connection-to-the-plugin)
(over SSH, into a private folder there, removed from the host). PBS: `orca-monitor@pbs`, `Audit`
on `/` (or `DatastoreAudit` on `/datastore`), for the user and the token, as in
[PBS: a read-only user and token](#pbs-a-read-only-user-and-token), in the same kind of session.

### T6. Hand each host to the plugin

Step 4's import file, once per host, waiting for each import's log lines before the next:

```json
{
  "kind": "pve",
  "name": "pve-a-agent",
  "baseUrl": "https://pve-a.example.com:8006",
  "tokenId": "orca-monitor@pve!orca",
  "fingerprint": "AB:CD:…",
  "secret": "…",
  "enrichOnly": true,
  "nodeMap": { "pve-a": "cluster-a/pve-a" },
  "tunnel": {
    "host": "pve-a.example.com",
    "port": 22,
    "user": "orca-tunnel",
    "identityFile": "/home/you/.ssh/orca-proxmox-tunnel",
    "target": "127.0.0.1:8006",
    "hostKey": "ssh-ed25519 AAAA…"
  }
}
```

`identityFile` is the absolute path on Orca's machine; on Windows `"C:\\Users\\you\\.ssh\\orca-proxmox-tunnel"`
(backslashes escaped, as JSON requires) or `"C:/Users/you/.ssh/orca-proxmox-tunnel"`. Write the
file from PowerShell (`ConvertTo-Json`) or Python there: a POSIX shell heredoc in Git Bash can drop
the backslashes, and the plugin then reports the path as it received it. `nodeMap` names the node in PDM as
`remote/node`: the plugin then knows which PDM cluster this server belongs to. Without it, the
plugin learns the cluster only while every PDM cluster is visible and exactly one has these node
names; otherwise it waits and says so. An import without `hostKey` is refused (it cannot show
anyone a new key). Then restart the plugin and read both log lines, as in step 4:

```sh
orca plugin restart "$KEY"; orca plugin open "$KEY" --panel=proxmox
sleep 10; orca plugin logs "$KEY" | grep -E 'Import( file)?:' | tail -2
# Import: Imported the PVE connection to https://pve-a.example.com:8006 as orca-monitor@pve!orca, pinned (start). Connection test: PVE 9.x, 1 nodes visible.
```

A failure names the cause: the key refused or unreadable (T1/T2f), the SSH host key not matching
(T3), the forward not allowed (T2), or the API's certificate (T3). Finally ask the person to open
the **Guests** tab: within a few minutes, running VMs whose guest agent runs show their disk use as
a percentage instead of the allocated size with `?`; the panel's warnings name an enrich-only
connection that matched no guest or whose cluster is not known yet (fix with `nodeMap`).

Alternatively the person adds the connection in **Settings** with *Reach via SSH tunnel* and
*Enrich only*, presses **Test**, compares the SSH host key shown and pins it.

## Scoped access principles

Each level gets the least it needs, and each credential can be withdrawn on its own:

| Credential | Where | Can | Cannot | Revoke |
| --- | --- | --- | --- | --- |
| PDM token (`Auditor`) | PDM | Read every remote PDM manages | Change anything; open consoles; read backup contents | Delete the token in PDM (Configuration → Access Control → API Token) |
| PVE token (`PVEAuditor`, privilege separation) | Each PVE cluster | Read nodes, guests, configs, storages, tasks; on PVE 9 the guest agent's informational calls | Change anything; consoles; run commands or read files in guests | `pveum user token remove orca-monitor@pve orca` (or `pveum user delete orca-monitor@pve`) |
| PBS token (`Audit` or `DatastoreAudit`) | Each PBS | List datastores, snapshots, tasks | Read or restore backup contents; change anything | `proxmox-backup-manager user delete-token orca-monitor@pbs orca` |
| Tunnel key and `orca-tunnel` account | Orca's machine and each host | Open a TCP forward to the local API port | Shell, commands, PTY, reverse or Unix-socket forwards, other destinations | Remove its line from `/home/orca-tunnel/.ssh/authorized_keys` (no new logins), end running ones with `pkill -u orca-tunnel`; or remove the account (`userdel -r orca-tunnel`) and the `Match User orca-tunnel` block, then `sshd -t && systemctl reload ssh` |
| Orca's own SSH targets | Orca | What that SSH login may do (Orca's feature, not the plugin's) | — | Remove the target in Orca (`orca host rm ssh:<id>`) |

The plugin itself only sends `GET` requests and keeps every token sealed (see
[SECURITY.md](../SECURITY.md)); the limits above hold even if the machine running Orca is not
trusted with more.

## Connect the hosts to Orca

This is done in Orca, not in the plugin: add each machine where Orca should run or open terminals
(the Proxmox nodes, and guests that run Orca) as an **SSH target**, or pair a remote Orca server,
following Orca's documentation ([github.com/stablyai/orca](https://github.com/stablyai/orca)).
From the command line, `orca host list` shows what Orca can reach and how each is named, and a
remote Orca server is paired with `orca environment add --name <name> --pairing-code <code>`; there is
no CLI command to add an SSH target, so ask the person to add it in Orca's interface. The plugin
then places each Orca host on its node or guest (by address or name; by hand under the Orca tab's
*Placement* if neither matches) and turns on *Open Orca terminal here*.

## Appendix: No PDM yet?

PDM aggregates PVE clusters and PBS servers behind one API. A pattern that works well for a
small estate:

- **A small VM for PDM** on one PVE host: Debian 13 from a cloud image, 2 vCPU, 2 GiB RAM, 16 GiB
  disk, set up with cloud-init. Two cloud-init gotchas: `runcmd` items are YAML lists
  (`- [apt-get, install, -y, foo]`), and with a custom user-data file (`--cicustom user=…`) the
  `--sshkeys` option is ignored, so put the keys in that file.
- **Install PDM** from its repository: add the Proxmox release key and the PDM repository for
  Debian 13 as the documentation shows, then `apt install proxmox-datacenter-manager
  proxmox-datacenter-manager-ui`. See the [PDM documentation](https://pdm.proxmox.com/docs/).
- **Add the PVE remotes** with a dedicated token per cluster, e.g. user `pdm@pve` with a token
  without privilege separation (`privsep 0`, so it has the user's rights) and the rights PDM's
  documentation lists; **add PBS** with its own token on the PBS side. Pin each remote's
  fingerprint when adding it.
- **Prefer a private network** between the PDM VM and the hosts (a bridge or VLAN), and let PDM
  reach the hosts' API ports only there.
- **Renaming a PVE node changes its certificate**: re-pin that remote in PDM afterwards.

Then continue with step 0 above.
