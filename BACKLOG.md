# Backlog

Planned work, not built yet. Everything here changes state on a Proxmox server, so each needs a
token with more than the read-only Auditor role (kept separate from the monitoring token) and an
explicit confirmation in the panel before it acts.

## A guest per Orca worktree

Launch a container or micro VM for an Orca worktree from the plugin, so the worktree can be built
and tested on its own guest.

1. **Check the requirements** before offering it:
   - a template to clone: an LXC template or a cloud-init VM template (for example the existing
     `debian-12-cloudinit-template`), chosen per target;
   - resources on the chosen node: free CPU, RAM and storage for the requested size, shown next to
     the node's current use;
   - network: a bridge, and either DHCP or a free static address in the node's guest subnet, and
     a way for Orca to reach it (the node as SSH jump host, or a routed/VPN address);
   - the token's rights: `VM.Allocate`, `VM.Clone`, `Datastore.AllocateSpace`, `SDN.Use` (or
     `Sys.Modify` on the bridge) on the target only.
2. **Create the guest** on a chosen node: clone the template (linked clone when the storage allows
   it), set CPU, memory, disk, network and cloud-init (user, SSH key from Orca, hostname derived
   from the worktree), tag it `orca` and `orca-worktree-<id>`, start it.
3. **Prepare it for the worktree**: wait for the guest agent or SSH, install the toolchain the
   project needs (a recipe per project, or the project's own setup script), check out the
   worktree's branch.
4. **Register it with Orca** as an SSH target (or deploy an Orca runtime there and pair it), so the
   worktree can run its terminals and agents on it. The plugin API cannot add hosts today; this
   needs a host API such as `hosts.add` (or the `orca` CLI, as the Orca view uses now).
5. **Clean up**: list guests tagged for worktrees whose worktree is gone, and offer to stop and
   destroy them (with the confirmation and a final backup option).

Open questions: who owns the guest's lifetime (the worktree, or the person), and whether to use
Orca's per-workspace environment recipes (`orca vm recipe`) as the provisioning step.

**Callable by Orca's bots and agents?** Not with today's plugin API (checked against host API 1
and Orca 1.4's CLI, 2026-11): a plugin's worker can register commands, but they are palette
commands run by the person (or a status-bar item); `orca plugin dev request` calls a worker
handler only for a development plugin (installed plugins are refused); and MCP servers, skills
and tools are reserved contributions, not buildable yet. So a bot cannot ask the plugin for a
sandbox. If Orca adds a way, the sandbox harness lives in the plugin: a separate token scoped to
one pool (clone, allocate and power its guests only, never the monitoring token), quotas (guests
per worktree and in total, CPU, memory, disk), a TTL per guest with cleanup of expired ones, and
every create shown in the panel's log. What Orca would need to add:

- an agent-callable plugin surface, for example `contributes.tools` (or an MCP server
  contribution) with a JSON schema per tool, or `orca plugin run <plugin> <command> --data` for
  installed plugins, limited to commands the manifest marks as callable by agents;
- the caller's identity in the handler (bot, agent session, workspace), so quotas, TTLs and the
  log are per caller;
- the person's approval per plugin tool and bot (as for capabilities), and Orca's own audit of
  each call;
- `hosts.add` (above), so the new guest becomes the worktree's host.

## The SSH tunnel in Connect via Orca

Connect via Orca sets up the read-only token only; the SSH tunnel account for VM disk use stays
the guided manual path (docs/AGENT_SETUP.md, T1–T6). Bringing it into the one-click setup later
needs, before it is offered:

- a live check of the account's limits that only counts an explicit refusal of each attempt (a
  remote forward refused, a forward to another target refused, a command refused), never an
  inconclusive disconnect;
- sshd's effective settings as the running daemon applies them (its own files and options), for
  the tunnel's real connection, and a fresh admin login checked before the key is enabled;
- a key that stays limited to what was verified (source address included), with its promotion
  journaled and reconciled on the host, and a failed or unconfirmed promotion rolled back or left
  expiring, never reported as expiring once it is permanent;
- the local connection's revision recorded durably with the host state, so a save or record
  update that fails cannot strand a key or a connection outside Undo.

## Guest actions

Start, shutdown and reboot a guest from its details card, behind an explicit confirmation that
names the guest and node. Uses a separate token with `VM.PowerMgmt` on the guests it may act on;
the read-only token stays as it is. Shows the PVE task and its result.

## VM disk use through PDM

PDM 1.1 answers the guest agent's `get-fsinfo` with 404, so through PDM a VM shows only its
allocated size. When PDM passes the call on, the plugin reads it as it does for a direct PVE (the
code already asks, and stops for 6 hours on a refusal).

## Orca plugin API

Switch Orca awareness from the `orca` CLI to the plugin API once it offers:

- `hosts.list`: Orca's hosts (local, SSH targets, paired servers) with name, address, connection
  state, and for a paired server the SSH target it was deployed through;
- **Feature request for Orca:** a paired server's `machineName` and addresses (as `orca host list`
  gives `machineName` for this machine), in the plugin API and in `orca environment list` /
  `orca host list`. Today they expose only the label, runtime ids and the endpoint, which is a
  loopback tunnel for a server reached over SSH; so for a paired server without an SSH target the
  plugin has to ask the server itself, in a terminal (README, "Paired servers Orca does not
  identify"). With those fields it would not need to;
- `bots.list`: bots with their agent, state and the host they live on;
- `workspace.list` fields for the bot that owns a workspace and its agents' states.

## Smaller ideas

- Show PBS verification state and pruning/garbage collection jobs per datastore.
