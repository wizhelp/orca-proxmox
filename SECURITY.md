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
allows only the agent's informational calls; the documented setup grants it only if the person
agrees. On PVE 8 the only privilege for it, `VM.Monitor`, also allows running commands in guests,
so the documentation advises against granting it; VM disk use then stays unknown. A remote that
refuses the call is not asked again for 6 hours.

## Residual risks

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
- **The `orca` CLI** used for Orca awareness, the status-bar command and terminals runs with your
  account's rights, like Orca itself.
