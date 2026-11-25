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

## Guest actions

Start, shutdown and reboot a guest from its details card, behind an explicit confirmation that
names the guest and node. Uses a separate token with `VM.PowerMgmt` on the guests it may act on;
the read-only token stays as it is. Shows the PVE task and its result.

## Direct PVE and PBS hosts

Connect to a single PVE host or PBS server without PDM, with the same connection model (base URL,
token ID, secret in Orca's secrets, pinned fingerprint). The auth header schemes for `pve` and
`pbs` exist in `src/proxmox/client.ts`; this needs an `EstateSource` for each (PVE's
`/cluster/resources`, `/nodes/{node}/status`; PBS's `/status`, `/admin/datastore`), and more than
one connection in the settings.

## Orca plugin API

Switch Orca awareness from the `orca` CLI to the plugin API once it offers:

- `hosts.list`: Orca's hosts (local, SSH targets, paired servers) with name, address, connection
  state, and for a paired server the SSH target it was deployed through;
- `bots.list`: bots with their agent, state and the host they live on;
- `workspace.list` fields for the bot that owns a workspace and its agents' states.

## Smaller ideas

- Show PBS verification state and pruning/garbage collection jobs per datastore.
