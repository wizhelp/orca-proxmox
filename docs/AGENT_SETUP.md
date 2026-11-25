# Setting up Proxmox for Orca: instructions for an agent

These steps are written for a coding agent (Claude Code, Codex, an Orca bot) that sets the plugin
up for a person. They are what a person would do by hand in PDM's web interface and the plugin's
Settings tab, done through PDM's API and a one-shot import file instead.

The plugin is read-only towards Proxmox. Everything below creates **one read-only API token**
in Proxmox Datacenter Manager (PDM) and hands it to the plugin.

## Rules for the agent

- **Establish trust in PDM's certificate before any credential is sent** (step 0). Never use
  `curl -k`/`--insecure`; every call that carries a password, cookie or token uses the verified
  certificate (`--cacert`) and its pinned public key (`--pinnedpubkey`).
- **Never ask the person to paste a password or token secret into the chat**, and never print
  one. Prompt for it in a terminal the person types into (`read -rs`). Secrets live only in files
  inside a private work folder (`umask 077`), are passed to `curl` as `@file` arguments or header
  files, never as command-line values (which other processes can see), and the folder is removed
  on exit, also when interrupted. Turn shell tracing off (`set +x`).
- **Check every answer**: an HTTP status other than 200, a missing session cookie or an empty
  token secret stops the procedure; do not continue on a guess.
- **Two-factor login**: if PDM asks for a second factor, stop and let the person create the token
  in PDM's web interface (step 2 by hand), then continue at step 3.
- Show the person each change before making it in PDM (a user, a token, two permissions).

## What to ask the person for

1. **The PDM URL as Orca's machine reaches it**, e.g. `https://pdm.example.com:8443`. This goes
   into the plugin (`PDM_URL`).
2. **How to make changes in PDM** (`ADMIN_URL`, where the admin calls go):
   - an **admin login** (for example `root@pam`) they type into a prompt you open on this
     machine; then `ADMIN_URL=$PDM_URL`; or
   - **SSH to the PDM host**: you open an SSH session in a terminal and run steps 0–2 there
     against `ADMIN_URL=https://127.0.0.1:8443`. A PDM login (typed into a prompt in that session)
     is still needed; SSH only keeps the admin traffic on the host. The token secret is then
     brought back to Orca's machine (step 4), and `PDM_URL` stays the address Orca uses.
3. **Which remotes** the plugin should see: all (Auditor on `/resource`) or only some (Auditor on
   `/resource/<remote>` for each).
4. Whether Orca is installed with this plugin (`orca plugin list` shows `…proxmox-visualizer`).
   If not: `orca plugin install wizhelp/orca-proxmox`, then the person approves it with the
   command Orca prints (an agent must not approve a plugin's access on the person's behalf).

No PDM yet? See [the appendix](#appendix-no-pdm-yet).

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
[ "$code" = 200 ] && python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["data"]), "remotes visible")' "$WORK/list.json"
rm -f "$WORK/list.json" "$WORK/jar" "$WORK/csrf.hdr"
```

`0 remotes visible` means either a missing permission (see above) or a PDM without remotes yet;
ask the person which.

## 3. The fingerprint for the plugin

The plugin pins the SHA-256 fingerprint confirmed in step 0 (`AB:CD:…`). With a certificate from
a trusted CA it can stay empty. When PDM's certificate is renewed, the pin changes and the plugin
asks for the new one.

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
ends). Bring the secret to Orca's machine without printing it, then remove it on the host, and use
`$LOCAL/secret` where the next step says `$WORK/secret`:

```sh
# On Orca's machine, in a private work folder of its own:
umask 077; LOCAL=$(mktemp -d)
ssh root@pdm-host "cat '$REMOTE_WORK/secret' && rm -f '$REMOTE_WORK/secret'" > "$LOCAL/secret"
```

Write the file **completely under a temporary name in the same folder, then rename it** to the
final name, so the plugin never sees a half-written file. Linux/macOS:

```sh
IMPORT="<path from the log>"; DIR=$(dirname "$IMPORT")
mkdir -p "$DIR" && chmod 700 "$DIR"
PDM_URL="$PDM_URL" FP="AB:CD:…" python3 - "$WORK/secret" "$IMPORT" <<'PY'
import json, os, sys
secret_file, target = sys.argv[1], sys.argv[2]
tmp = target + ".tmp"
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w", encoding="utf-8") as f:
    json.dump({"baseUrl": os.environ["PDM_URL"], "tokenId": "monitor@pdm!orca",
               "fingerprint": os.environ["FP"], "secret": open(secret_file).read().strip()}, f)
os.replace(tmp, target)
PY
rm -f "$WORK/secret"
```

Windows (Windows PowerShell 5.1 or PowerShell 7; UTF-8 without a byte-order mark, though the
plugin also accepts one):

```powershell
$import = '<path from the log>'; $dir = Split-Path $import
New-Item -ItemType Directory -Force $dir | Out-Null
$secret = (Get-Content -Raw $secretFile).Trim()
$json = @{ baseUrl = $PdmUrl; tokenId = 'monitor@pdm!orca'; fingerprint = $Fp; secret = $secret } | ConvertTo-Json -Compress
[IO.File]::WriteAllText("$import.tmp", $json, (New-Object Text.UTF8Encoding $false))
Move-Item -Force "$import.tmp" $import
Remove-Variable secret, json; Remove-Item $secretFile
```

On Windows the plugin does not inspect file permissions (ACLs): the folder under your profile is
private by default; do not use a shared or redirected folder others can read.

The file holds exactly `baseUrl`, `tokenId`, `secret` and optionally `fingerprint`, all strings.
The plugin refuses a file it cannot trust (a link, other hard links, another owner, readable by
others, a folder others can write to) and leaves it in place; it deletes any file it read.

Then make the plugin import it: when its worker starts, on the command *Proxmox: Import the
connection file*, or on *Import now* in Settings. From a terminal:

```sh
orca plugin restart "$KEY"                    # stop the worker…
orca plugin open "$KEY" --panel=proxmox       # …opening the panel starts it, and it imports
sleep 5; orca plugin logs "$KEY" | grep 'Import:' | tail -1
```

The plugin tests the connection **before** it replaces anything. The log line says either
`Import: Imported the connection to … Connection test: PDM x.y.z, N remotes visible. The file was
overwritten and deleted.` or why not, with the current connection kept. If it says the file could
**not** be deleted, delete it by hand: it holds the secret. The log (and the panel) show the PDM
URL, the token ID and the file's path, never the secret.

## 5. Check

Ask the person to look at the **Proxmox** panel: the header shows `N/N remotes up`, and the
Hosts tab their nodes. If it says the token sees no remotes, re-check the two ACL entries (step 2).

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
