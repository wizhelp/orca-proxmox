# Setting up Proxmox for Orca: instructions for an agent

These steps are written for a coding agent (Claude Code, Codex, an Orca bot) that sets the plugin
up for a person. They are what a person would do by hand in PDM's web interface and the plugin's
Settings tab, done through PDM's API and a one-shot import file instead.

The plugin is read-only towards Proxmox. Everything below creates **one read-only API token**
in Proxmox Datacenter Manager (PDM) and hands it to the plugin.

## Rules for the agent

- **Never ask the person to paste a password or token secret into the chat**, and never print
  one. Prompt for it in a terminal the person types into (`read -rs`), or have them run the one
  command that needs it. Keep secrets in shell variables, out of command lines that land in shell
  history or process lists (pass them on stdin or in files with user-only permissions), and
  `unset` them when done.
- Do not disable TLS checks to "make it work": get the certificate fingerprint and pin it (step 3).
- Show the person each change before making it in PDM (a user, a token, two permissions).

## What to ask the person for

1. The PDM URL, e.g. `https://pdm.example.com:8443` (PDM listens on 8443).
2. One way to make changes in PDM, either:
   - an **admin login** to PDM (for example `root@pam`) that they type into a prompt you open, or
   - **SSH to the PDM host**, where you run the same API calls against `https://127.0.0.1:8443`.
3. Whether Orca is installed with this plugin (`orca plugin list` shows `…proxmox-visualizer`).
   If not: `orca plugin install wizhelp/orca-proxmox`, then the person approves it with the
   command Orca prints (an agent must not approve a plugin's access on the person's behalf).

No PDM yet? See [the appendix](#appendix-no-pdm-yet).

## 1. Log in to PDM's API

PDM answers a login with a ticket, set as a **cookie**; requests that change something also need
the `CSRFPreventionToken` it returns, as a header. With `curl` and a cookie jar:

```sh
PDM=https://pdm.example.com:8443
umask 077; JAR=$(mktemp)
read -rp "PDM admin user (e.g. root@pam): " PDM_USER
read -rsp "Password for $PDM_USER: " PDM_PASS; echo
# The password goes on stdin, not on the command line.
CSRF=$(printf 'username=%s&password=%s' "$PDM_USER" "$PDM_PASS" |
  curl -s -k -c "$JAR" -X POST --data @- "$PDM/api2/json/access/ticket" |
  python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["CSRFPreventionToken"])')
unset PDM_PASS
api() { curl -s -k -b "$JAR" -H "CSRFPreventionToken: $CSRF" "$@"; }
```

`-k` is used only for this one-off admin session before the fingerprint is pinned; check the
fingerprint from step 3 against what the person sees in PDM (*Certificates*) before trusting it.
Prefer running these calls on the PDM host itself over SSH (`$PDM=https://127.0.0.1:8443`).

## 2. Create a read-only user and token

```sh
# A user only for this; PDM's roles are Administrator and Auditor, Auditor reads everything.
api -X POST --data-urlencode 'userid=monitor@pdm' --data-urlencode 'comment=Read-only, Orca plugin' \
  "$PDM/api2/json/access/users"
# The token. Its secret ("value") is shown ONCE: keep it in a variable, never print it.
TOKEN_SECRET=$(api -X POST "$PDM/api2/json/access/users/monitor@pdm/token/orca" |
  python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["value"])')
# Auditor on /resource for BOTH the user and the token: a token's rights are the
# intersection of its own and its user's, so either one missing means it sees nothing.
for who in 'monitor@pdm' 'monitor@pdm!orca'; do
  api -X PUT --data-urlencode 'path=/resource' --data-urlencode 'role=Auditor' \
    --data-urlencode "auth-id=$who" --data-urlencode 'propagate=1' "$PDM/api2/json/access/acl"
done
```

Gotchas:

- **Deleting and re-creating a token drops its permissions.** Re-run the `acl` call for the token
  after re-creating it (and you get a new secret).
- If PDM refuses to create a `@pdm` user without a password, set one the person chooses (typed
  into a prompt) or use their existing realm; the token never needs the user's password.
- Without Auditor on `/resource` the token still logs in, and every list comes back empty.

Verify with the token itself (the secret goes in a header file, not on the command line):

```sh
HDR=$(mktemp); printf 'Authorization: PDMAPIToken=monitor@pdm!orca:%s\n' "$TOKEN_SECRET" > "$HDR"
curl -s -k -H @"$HDR" "$PDM/api2/json/resources/list" |
  python3 -c 'import json,sys; d=json.load(sys.stdin)["data"]; print(len(d), "remotes:", [r["remote"] for r in d])'
rm -f "$HDR"
```

It should list every remote. An empty list means a missing ACL (see above). Then end the admin
session: `rm -f "$JAR"; unset CSRF`.

## 3. Get the certificate fingerprint

PDM uses a self-signed certificate by default. The plugin pins its SHA-256 fingerprint: the TLS
handshake is checked against it before any request is sent, so the token never reaches a server
that is not this PDM.

```sh
openssl s_client -connect pdm.example.com:8443 -servername pdm.example.com </dev/null 2>/dev/null |
  openssl x509 -noout -fingerprint -sha256
# sha256 Fingerprint=AB:CD:…  → the part after "=" is the pin
```

Ask the person to compare it with the one PDM shows under *Certificates*. A certificate from a
trusted CA needs no pin (leave it empty). When PDM's certificate is renewed, the pin changes and
the plugin asks for the new one.

## 4. Hand the connection to the plugin

Orca's CLI cannot call an installed plugin or write its secrets, so the plugin imports a
**one-shot file** instead. Write it with user-only permissions at this fixed path:

| OS | Import file |
|---|---|
| Linux | `~/.config/orca-proxmox-visualizer/connection-import.json` (`$XDG_CONFIG_HOME/…` when Orca runs with it set) |
| macOS | `~/Library/Application Support/orca-proxmox-visualizer/connection-import.json` |
| Windows | `%LOCALAPPDATA%\orca-proxmox-visualizer\connection-import.json` |

The exact path is in the plugin log (`Connection import file: …`) and in the panel under
Settings → *Set up from a file*.

```sh
DIR="${XDG_CONFIG_HOME:-$HOME/.config}/orca-proxmox-visualizer"   # macOS: see the table
mkdir -p "$DIR" && chmod 700 "$DIR"
( umask 077
  PDM_URL="$PDM" FP="AB:CD:…" TOKEN_SECRET="$TOKEN_SECRET" python3 - "$DIR/connection-import.json" <<'PY'
import json, os, sys
json.dump({"baseUrl": os.environ["PDM_URL"], "tokenId": "monitor@pdm!orca",
           "fingerprint": os.environ["FP"], "secret": os.environ["TOKEN_SECRET"]}, open(sys.argv[1], "w"))
PY
)
unset TOKEN_SECRET
```

On Windows (PowerShell), the folder under `%LOCALAPPDATA%` is private to the user:

```powershell
$dir = Join-Path $env:LOCALAPPDATA 'orca-proxmox-visualizer'; New-Item -ItemType Directory -Force $dir | Out-Null
@{ baseUrl = $Pdm; tokenId = 'monitor@pdm!orca'; fingerprint = $Fp; secret = $TokenSecret } |
  ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $dir 'connection-import.json')
Remove-Variable TokenSecret
```

The file holds exactly `baseUrl`, `tokenId`, `secret` and optionally `fingerprint`, all strings.
The plugin refuses (and leaves in place) a file that group or others can read on Linux/macOS, a
link, or anything that is not a regular file; it refuses and deletes one with bad JSON or other
fields.

Then make the plugin import it. It does so when its worker starts, on the command
*Proxmox: Import the connection file*, and on *Import now* in Settings. From a terminal:

```sh
KEY=$(orca plugin list --json | python3 -c 'import json,sys; print(next(p["pluginKey"] for p in json.load(sys.stdin)["result"]["plugins"] if p["pluginKey"].endswith(".proxmox-visualizer")))')
orca plugin restart "$KEY"                    # stop the worker…
orca plugin open "$KEY" --panel=proxmox       # …opening the panel starts it, and it imports
sleep 5; orca plugin logs "$KEY" | grep -E 'Import:|Connection import file'
```

The log says `Import: Imported the connection to … Connection test: PDM x.y.z, N remotes
visible.` on success, or why it was refused. The import file is gone afterwards (overwritten,
then deleted). The secret is now stored sealed in Orca's encrypted secrets, bound to that URL,
token and pin.

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

Then continue with step 1 above.
