# Roadmap: next round

Approved features, in the order they are built: each step only needs the ones above it. The plugin
stays read-only towards Proxmox (GET only) and reuses what it already reads where it can.

## 1. More data from PDM (worker)

What several features need, read once and cached on the existing cadences:

- **Links**: each remote's `web-url` and node addresses (`/remotes/remote`, already read), and the
  PDM base URL. Needed by deep links (2) and ssh commands (1).
- **Storages**: the `pve-storage` entries of `/resources/list` (already read, so far ignored).
  Needed by disk warnings (8) and placement (12).
- **Notes**: the `description` of guest configs (already read for addresses) and node configs.
  Needed by tags and notes (6) and the AI summary (10).
- **Tasks**: `/remotes/tasks/list`, PDM's merged task list of every remote (one call, once a
  minute). Needed by the tasks feed (5) and backup-failure alerts (7).
- **Updates**: `/pve/remotes/{remote}/updates` per PVE remote, on the backup cadence. Needed by the
  updates badge (9).

## 2. Pure logic (shared, tested in Node)

- Deep links and ssh commands (1, 2).
- Disk warnings, "full in ~N days" from history, free capacity and placement ranking (8, 12).
- Version drift between hosts (9).
- The Markdown estate summary (10).
- Alert detection: what changed between two snapshots, debounced (7).

## 3. Panel

Quick wins first: copy buttons and links (1, 2), sparklines on guest rows (4), the tasks feed (5),
tags, notes and a tag filter (6). Then disk warnings (8), the updates badge (9), "copy estate for
AI" (10), "open Orca terminal here" (11) and the placement planner (12).

## 4. Worker in the background

A status-bar item (3) and alerts (7) must work with the panel closed, so the worker polls on its
own while the plugin is enabled. The status-bar item opens the panel when pressed. Alerts need the
`notifications:show` capability; each kind can be muted in Settings.

## 5. Docs

README sections and screenshots from the example estate.

## Status

| # | Feature | Status |
|---|---|---|
| 1 | Copy IP, VMID, ssh command | Done. Jumps through the node when the guest is on a private network. |
| 2 | Open in PDM / Proxmox | Done: PDM page, Proxmox web interface page, and a guest's console. |
| 3 | Status-bar item | Done: plugin API status-bar item. Opening the panel on press goes through the `orca` CLI (no plugin API call opens a panel). |
| 4 | Sparklines | Done: CPU and memory on host cards and guest rows. |
| 5 | Tasks feed | Done: PDM's merged task list, failures in red. |
| 6 | Tags and notes | Done, with a tag filter and notes in search. |
| 7 | Alerts | Done, through `notifications:show`, mutable per kind. |
| 8 | Disk-full warnings | Done for containers, datastores, storages and root disks, and for VMs whose QEMU guest agent reports their use (direct PVE connections; PDM 1.1 does not pass the agent call on). |
| 9 | Needs updates | Limited: the count shows where PDM has checked; a read-only token cannot ask for a check (403 on the summary and on `apt/update`). Version drift always works. |
| 10 | Copy estate for AI | Done, with or without addresses. |
| 11 | Open Orca terminal here | Done through the `orca` CLI (the plugin API's `terminal.create` needs a workspace id the API cannot map to a host). |
| 12 | Where should this go? | Done: free memory, disk and CPU per node, ranked. |
| 13 | Guest disk use (0.3.0) | Done: a sortable Disk column and a line in the details, used of size with a bar. Containers from Proxmox; VMs from the QEMU guest agent where it can be read (cached per guest, every 10 min, 24 per refresh, two at a time), else the allocated size with the reason use is unknown. |
| 14 | Direct PVE and PBS connections (0.3.0) | Done: PVE clusters or hosts and PBS servers without PDM, alone or beside a PDM, each with its own token, pin and sealed secret; merged into one estate. Pending updates on a direct PVE come from each node's `apt/update` list (`Sys.Audit`, in `PVEAuditor`). |
| 15 | SSH tunnel and enrich only (0.4.0) | Done: a direct PVE or PBS reached through `ssh -N -L` with a forward-only key and a pinned host key; as *enrich only*, a direct PVE adds VM disk use (guest agent), storage content types and pending updates to the guests and nodes PDM shows, matched by node name and VMID, without adding any. |
| 16 | Connect via Orca (0.5.0) | Done: the read-only token of a PVE or PBS that Orca already reaches, set up from Settings with the exact script shown first and run in a terminal of that host; the secret only as ciphertext in the terminal, the certificate and the token's rights checked from this machine, an API that is not reachable from here refused before anything runs; Undo per run of exactly what it made. PDM's token and the SSH tunnel stay guided steps. |
| 17 | Paired Orca servers without an SSH target (0.6.0) | Done: a paired server that Orca does not identify is matched by its endpoint's host when that is not loopback, else asked once per runtime (read-only, in a workspace it runs itself, terminal always closed) for its host names and addresses; claims are placement hints only (conflicts stay unplaced, never a root SSH destination). Every Orca host nothing places is listed under *Not placed yet* with a one-choice *Place on* selector. |
| 18 | Terminal offer (0.6.1) | Done: SSH targets named by a DNS name are placed by what it resolves to here (every matching answer must agree, more than 16 place nothing), as a hint kept by a paired server deployed over them; a card prefers a terminal in an Orca workspace of a host placed there; a local `ssh root@` only for a host placed by hand; without a route, a node shows the button disabled with the reason; a click sends the card, route, host, destination and estate revision, and nothing opens when the worker's offer for that card now differs (the view refreshes). |
