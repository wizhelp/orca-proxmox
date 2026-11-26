# Security

## Reporting

Please report a vulnerability privately through GitHub's security advisories for
`wizhelp/orca-proxmox` ("Report a vulnerability"), not in a public issue.

## What the plugin protects, and how

**Read-only towards Proxmox.** The worker only sends `GET` requests to PDM and to PVE and PBS
servers connected directly, over HTTPS, and follows no redirects. With a pinned SHA-256 fingerprint the certificate is compared after the TLS
handshake and before any HTTP is sent, so a server with another certificate never receives the
token. Without a pin, Node's certificate and hostname checks apply.

**The token secret.**

- It is stored in Orca's encrypted plugin secrets (`secrets:own`, backed by the OS keyring), and
  never in plugin storage or settings. If Orca cannot encrypt secrets on the machine, the plugin
  refuses to store it.
- It is stored **sealed** (AES-256-GCM) with a key the worker keeps in a file of its own:
  `%LOCALAPPDATA%\orca-proxmox-visualizer\worker.key` on Windows,
  `~/Library/Application Support/orca-proxmox-visualizer/worker.key` on macOS and
  `$XDG_CONFIG_HOME` (or `~/.config`)`/orca-proxmox-visualizer/worker.key` on Linux, created with
  owner-only permissions where the OS supports them. Orca hands `secrets:own` to a plugin's HTML
  panel as well as to its worker; the panel has no file access, so it can read the sealed value
  but not open it. Deleting the key file only means entering the secret again.
- The sealed secret is **bound to its endpoint**: the connection's id, revision, kind, canonical
  base URL (path included), token ID and pinned fingerprint are authenticated with it (AES-GCM
  associated data). The connection settings live in plugin storage, which the panel can write;
  if they are changed other than through the worker's save, the secret no longer opens and the
  worker asks for it again instead of sending it anywhere. A secret stored by a version before
  this binding is not migrated (its settings could have been changed meanwhile): it must be
  entered once more.
- **Several connections** (one PDM, PVE clusters and hosts, PBS servers) each have their own id,
  revision, sealed secret and keyring entry, bound as above to that connection's endpoint; each
  server is only ever sent its own token, in its own header form (`PDMAPIToken`, `PVEAPIToken`,
  `PBSAPIToken`). Removing one connection deletes only its secret. A base URL can belong to one
  connection only.
- Each saved configuration gets its own revision and its own keyring entry. A secret is carried
  over to a new configuration only for the very same base URL (path included), token ID and pin;
  any change to them needs the secret entered again. A refresh that read the old configuration
  can only use the old secret, so a replacement token is never sent to the previous server; the
  old entry is deleted once reads of it have finished.
- It is never returned to the panel and never logged.
- **The import file** (for agents and scripts, see [docs/AGENT_SETUP.md](docs/AGENT_SETUP.md))
  sits next to the worker's key file. The producer makes the folder private (on Windows: its
  access list replaced by exactly you and SYSTEM, nothing inherited, and checked, as is the new
  file's), writes the file to a new, unique name created exclusively in it (`mktemp`;
  `FileMode.CreateNew` on Windows) and then renames it into place, removing its own copy of the
  secret only once that worked. The worker claims it with an atomic rename to a unique name (so of several
  workers one gets it, and a file published later is not touched), opens it once without
  following links where the OS allows, and checks that handle: a regular file with a single
  link, within a size bound, and on Linux and macOS owned by the user, not readable by others,
  in a folder owned by the user that others cannot write to. A claimed file is **never put back**:
  it is read from that handle (when it can be trusted) and then removed in every case, wiped
  through the same handle first when it is a plain file of the user's, and unlinked only while the
  claimed name is still that file; any error after the claim goes through the same cleanup. The
  status says what became of the file in a part of its own, never shortened, built from the file's
  final state: "wiped" only when every byte was overwritten through the checked handle and synced
  (else "in part" or "not wiped"), and removed or still present, then always with its exact path:
  in that part and in the log only the secret itself is masked, so no folder name that merely
  looks like a credential is changed, and claimed files are named with a time and hex digits. The connection is validated field by
  field (messages never contain values) and **tested against PDM before it replaces the current
  one**; on failure the current connection stays. A save or removal in Settings at any time during
  an import, reading the file included, wins: the import then changes neither the connection nor
  the status beyond saying it was dropped. Nothing of the content is logged.
- **What the logs and the panel show**: each connection's URL, the token ID and the import file's path
  (which contains your account's folder name), as connection metadata. Never the secret.

**What leaves the worker.** HTTP errors are described by the plugin itself (path and status),
never with the server's response body, since a proxy can echo request headers in it. Everything
the panel receives, every log line and every notification is scrubbed first: known secrets and
anything shaped like a credential (`Authorization` headers, API tokens, cookies, UUIDs, URL
passwords) are replaced, and control characters removed, before any text is cut to length.
Notifications use the plugin's own wording, not a server's error text.

**Commands and links.** Node and guest addresses from PDM are used only when they are strictly an
IP address or a DNS name. The ssh commands built from them contain only letters, digits and
`_.:@-`, and the terminal fallback checks the exact form again before it is typed into a shell.
The `orca` CLI is run without a shell, every variable value is passed as `--flag=value`, and
paired servers by their id. Links use only credential-free `http(s)` URLs.

**Copy for AI.** The summary never includes server error text, and statuses and versions are
reduced to known words and version numbers in every mode. "Without addresses" is a **best-effort
filter**, not a guarantee: names and tags are first normalized (NFKC, so full-width digits become
plain ones; dash- and dot-like characters become `-` and `.`), then URLs, IPv4 addresses (any
separators, mixed too), IPv6 addresses and DNS names are taken out, and an absolute file path
(Unix, `~`, Windows drive, UNC) is cut from where it starts to the end of the name or tag, spaces
and all. Anything written in a form it does not recognize, and any other word, stays: a short
host name used as a guest name stays too. **For a sensitive estate use "Anonymized"**, which
replaces every name by a placeholder and leaves out tags, VMIDs and addresses. Names and
tags are escaped plain text, which keeps out markup and links, but their words still reach the
agent: a name or tag that reads like an instruction is pasted as such. The panel shows the exact
text before it is copied.

**The guest agent.** For VM disk use the worker asks PVE for the QEMU guest agent's `get-fsinfo`
(a `GET`), and keeps only used and total bytes. On PVE 9 this needs `VM.GuestAgent.Audit`, which
allows only the agent's informational calls and is **part of `PVEAuditor`**: a token with that
role can make the call. To keep the agent out of it, turn off *Disk use inside VMs* in Orca's
plugin settings (the worker then never asks) and, for the server to refuse it as well, use a copy
of `PVEAuditor` without that privilege (docs/AGENT_SETUP.md). On PVE 8 the only privilege for it,
`VM.Monitor`, also allows running commands in guests, so the documentation advises against
granting it; VM disk use then stays unknown. A VM the token may not ask is not asked again for 6
hours.

**SSH tunnels** (optional, per direct connection). The worker runs the system's OpenSSH client
by its absolute path, without a shell, as `ssh -F none -N -T -L 127.0.0.1:<port>:<target>` with
every option explicit: `BatchMode=yes` (no prompt can appear), `IdentitiesOnly=yes` with the
configured key as `-o IdentityFile` and `IdentityAgent=none` (no default or agent keys, also when
the file is missing; the worker checks it can read the file before ssh runs), password and
keyboard-interactive authentication off, `ExitOnForwardFailure=yes`,
and `StrictHostKeyChecking=yes` against a known_hosts file of its own (in the worker's folder,
owner-only) that holds only the pinned host key. The person's `~/.ssh/config` and known_hosts are
not read. A host key is learnt only by an explicit **Test** in Settings (`accept-new` into a fresh,
empty known_hosts file), shown as its SHA-256 fingerprint, and pinned only when the person confirms
it and saves; an import must bring the key already verified. Every tunnel field is validated
(host strictly a DNS name or IP, a plain user name, an absolute key path, `host:port` target) and
passed as separate arguments after `--` where it could be read as an option. The tunnel's fields
are part of what the sealed secret is bound to. Through the tunnel the HTTP client still checks the
PVE/PBS certificate pin (or CA and hostname) before sending the token. Tunnels stop when their
connection changes or is removed, and when Orca stops the worker; every ssh process (a test's
too) is tracked from the moment it is spawned, so none is left behind, and a failure to run ssh
is an error, not a crash; a stop while a tunnel is being set up is checked right before ssh is
spawned, so none starts after it. A tunnel counts as ready only when that ssh process itself
reports taking a connection on its forward (`-v`: "Connection to port N forwarding to …", after a
test connection the worker makes), never because something answers on the port; a port taken
before ssh bound it makes ssh exit (`ExitOnForwardFailure`) and another is tried. ssh's own output (which can
carry a server's login banner) never reaches a message: a failure is reported from a fixed list
of outcomes and its exit code, and a rejected setting is never repeated back. File names reach ssh as
one quoted, escaped value each (spaces, quotes, `%` tokens), as the real client's parser reads
them back.

**The documented server side** for a tunnel is a dedicated account (`orca-tunnel`, no shell, no
password) whose key carries `restrict,port-forwarding,permitopen="127.0.0.1:8006"`, and an sshd
`Match User orca-tunnel` block with `AllowTcpForwarding local`, `AllowStreamLocalForwarding no`,
`PermitListen none`, `PermitOpen 127.0.0.1:8006`, `PermitTTY no`, X11 and agent forwarding off
and `ForceCommand /bin/false`. The key options alone would leave reverse (`-R`) and Unix-socket
forwards possible; the `Match` block makes the account's effective policy local TCP forwarding to
the API only. docs/AGENT_SETUP.md checks the effective policy with `sshd -T -C user=orca-tunnel,…`
(and looks for earlier `Match` blocks, which would win) before reloading sshd and again after,
checks a fresh admin login (connection sharing off), installs the key only then (its way back
disables the key and ends the account's sessions before restoring a previous policy), and finally tries a shell, a command, `-R`, a socket forward
and another `-L` target with time limits, an isolated client configuration and the pinned host
key, which must all be refused. Every session that handles a secret creates its own private
temporary folder first.

**Enrich only** connections add data only to guests and nodes that PDM shows, matched one to one
within the one PDM cluster each belongs to (named by a `remote/node` mapping, or learnt while
every PDM cluster is visible and kept), so an outage never moves one to another cluster; a cluster
reached directly is never enriched, competing claims are left alone, and a VM's disk use is shown
only while the connection that measured it still answers for it.

### Connect via Orca

An optional one-click setup for a PVE or PBS host that Orca already reaches (an SSH target or a
paired server), in place of the manual steps. It is the only time the plugin changes anything,
and it does so only as a script on the host, never through the Proxmox API (towards the API the
plugin still only sends `GET`).

- **What runs.** The plugin generates each script from a fixed template in its own code (nothing
  is downloaded), filling in only values it validates strictly: the product, a random run id,
  the one-time public key (PEM), the plugin's tunnel public key (`ssh-ed25519 … orca-proxmox-tunnel`,
  nothing else), an IP address for `sshd -T -C`, and, for Undo, a backup path of one exact form.
  Anything else is refused before a script exists. The person sees the exact script and what it
  does; it runs only when they press **Run**, once, within 10 minutes, on the host it was made
  for. A read-only check (installed products, whether the shell is root or may use `sudo -n`,
  host name, `SSH_CONNECTION`) runs first, on its own click.
- **Where it runs.** In a terminal the plugin opens with the orca CLI in one of that host's Orca
  workspaces, so the shell runs on the host over Orca's own connection, as Orca's user there: the
  plugin never learns the host's address or credentials. The typed line carries the script
  compressed (base64), runs it with `sh` as root or through `sudo -n` (never a password prompt),
  and starts with a space to keep it out of most shells' history. The plugin reads the output with
  `orca terminal read` and closes the terminal's tab afterwards, also when reading fails. One
  script runs at a time.
- **No secret in the terminal.** An Orca terminal's output is kept like any other terminal's, so
  nothing secret may appear in it. The script holds only public values. The new token's secret is
  kept in a shell variable on the host, encrypted there with `openssl pkeyutl` (RSA-OAEP, SHA-256)
  to a one-time RSA-3072 key the worker made for this run, and only that ciphertext is printed;
  the private half exists only in the worker's memory and is wiped after one use, or when the plan
  expires. Decrypted, the secret is sealed like any other (it is also masked in every log and
  answer). The tunnel's key pair is made in the worker; only its public half goes to the host.
  Its private half is sealed in the plugin's secrets like a token secret (bound to its own
  reference), and written for `ssh` only into the worker's private folder (owner-only; on
  Windows the file's ACL is reduced to the user) when a tunnel starts, then removed as soon as
  that ssh says it has authenticated, or ends.
- **Answers.** The script answers in lines that carry the run's random id, so nothing else in the
  terminal (the typed line included) can pass for an answer; values are cleaned and capped, and
  each is used only in the strict form it must have (a SHA-256 fingerprint, one SSH public key, a
  node name, an IP address, a version string).
- **On the host.** The same rules as the guide: a user only for this (an existing one is reused
  only when its comment says it was made for Orca), its token with privilege separation, the
  read-only role on `/` for both; an existing token `orca` stops the script unless the person
  chose **Replace**. The tunnel account is refused if anything of it exists already; its rules
  are appended after a backup, checked with `sshd -t` and `sshd -T -C` for the account (exactly
  local forwarding to the API) and for root (unchanged), before and after the reload, and only
  then does the account get the key, in a file the run creates. The API certificate's
  fingerprint is read from what the API presents on the host, and the SSH host key from the
  host's own key file, so both pins come from the server itself; the connection is tested
  through them before it is saved.
- **Undo** works from what the host reported creating (kept in plugin storage, no secret), in the
  guide's order, each step checked and stopping at the first that fails: the key file only while
  it holds exactly the plugin's line, then that account's processes only, then the `Match` block
  only while `sshd_config` is exactly the backup plus that block (an admin's later change stops
  it), then the account, the token, and the user only when it has no other token left. What was
  reversed is remembered even when a later step stops.
- **PDM** is recognized but not set up: it has no root-only local command for tokens, and the
  plugin does not handle an admin password.

## Residual risks

- **Connect via Orca trusts Orca's connection to the host.** The script runs with root rights on
  the host, as whatever Orca's shell there is; whoever controls that Orca connection or the
  host already has those rights. The plugin's scripts print no secret, but the terminal shows
  what they do (user and account names, the backup path). The record Undo works from is in plugin
  storage, which the panel can rewrite; a rewritten record can only make Undo name the plugin's
  own user, token and account, and the person still sees the Undo script before it runs.
- **The tunnel key is a file for a moment.** `ssh` needs the private key as a file: it exists in
  the worker's private folder from just before ssh starts until ssh has authenticated (normally
  well under a second), readable by the user only.
- **The panel can still reach the sealed value.** Any code running in the plugin's panel can read
  (and overwrite or delete) the sealed secret through `secrets:own`; it cannot open it without the
  worker's key, nor redirect it by rewriting the connection settings (see above). It can make the
  plugin unusable until the secret is entered again. Orca offers no worker-only secret store or
  storage today.
- **A token for a direct PVE or PBS** reads that server with the role it was given; with
  `PVEAuditor` on `/` that includes every guest's configuration (cloud-init users, SSH keys),
  as through PDM. The worker keeps only names, addresses and notes from it.
- **Saving through the panel is trusted.** The worker accepts a new connection from the panel's
  Settings form (that is how you set it up); a new endpoint or pin always needs the secret entered
  with it.
- **The setup form** holds a freshly entered secret in the panel until it is sent to the worker.
- **The import file holds the secret in plain text** until the worker imports it (normally
  seconds). Overwriting before deleting does not guarantee that copy-on-write file systems or
  SSDs drop the old blocks; anyone running as your user can read the file while it exists. If the
  status says it could not be deleted (for example another program holds it open), delete it by
  hand.
- **On Windows the import file's permissions are not checked by the plugin**: it does not read
  ACLs; the documented producer step sets and verifies them (only you and SYSTEM), so a file
  written another way relies on the folder being private (do not redirect it to a shared place).
  Windows cannot open a file "without following links", so a link is detected by a check just
  before opening, which leaves a short race for a process already running as you.
- **Anyone running as your user account** can read the key file and, through Orca, the sealed
  value; the scheme separates the panel from the worker, not your account from itself.
- **Server text shown in the panel** (a remote's error, a task's status) is scrubbed, but its
  meaning is the server's: treat it as untrusted.
- **An SSH key without a passphrase** sits on Orca's machine for tunnels; anyone running as your
  user can use it, limited on the server to forwarding to the API (as documented). Use a dedicated
  key and account per purpose.
- **A tunnel's local end is a loopback port**: other programs running on this machine can connect
  to it while it is open (and reach the API's port through it, though not use the token). The
  certificate pin (or CA and hostname check) decides before the token is sent; pin the
  certificate of a tunnelled connection.
- **The `orca` CLI** used for Orca awareness, the status-bar command and terminals runs with your
  account's rights, like Orca itself.
