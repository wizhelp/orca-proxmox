// Answers of the `orca` CLI commands the plugin reads (`host list`, `environment list`,
// `bot list`, `worktree ps [--environment]`), recorded from a real Orca 1.4.273 setup
// and reduced to the fields the plugin reads: no paths, prompts or private repository
// names; host, server and bot names are examples, every id is a fresh random one (SSH target ids
// are plain `ssh-example-…` labels), and activity times are moved by the same offset as the PDM
// recordings. Four SSH
// targets are the Proxmox nodes, renamed after pairing; each paired server's orcad was deployed
// through one of them.
export const recordedOrcaCli = {
  "host list": {
    "ok": true,
    "result": {
      "hosts": [
        {
          "kind": "local",
          "name": "this machine",
          "id": "local",
          "machineName": "DESKTOP-EXAMPLE",
          "platform": "win32"
        },
        {
          "kind": "ssh",
          "name": "pve-backups",
          "id": "ssh-example-a01",
          "connected": true,
          "connectionStatus": "connected"
        },
        {
          "kind": "ssh",
          "name": "pve-a",
          "id": "ssh-example-b72",
          "connected": true,
          "connectionStatus": "connected"
        },
        {
          "kind": "ssh",
          "name": "pve-lab",
          "id": "ssh-example-ce3",
          "connected": true,
          "connectionStatus": "connected"
        },
        {
          "kind": "ssh",
          "name": "pve-b",
          "id": "ssh-example-d54",
          "connected": true,
          "connectionStatus": "connected"
        },
        {
          "kind": "environment",
          "name": "203.0.113.3",
          "id": "c9a3be10-310f-4497-89a2-2ca29828a0b7"
        },
        {
          "kind": "environment",
          "name": "server-b",
          "id": "3a713d00-a608-489a-8b3f-1bfd2e06f0d0"
        },
        {
          "kind": "environment",
          "name": "server-lab",
          "id": "f5613273-66af-43ff-8449-d496f19ff80e"
        },
        {
          "kind": "environment",
          "name": "server-a",
          "id": "b4fa9e5c-40bf-470f-89a9-d49922fb998b"
        }
      ]
    }
  },
  "environment list": {
    "ok": true,
    "result": {
      "environments": [
        {
          "id": "c9a3be10-310f-4497-89a2-2ca29828a0b7",
          "name": "203.0.113.3",
          "orcadDeployment": {
            "sshTargetId": "ssh-example-a01"
          }
        },
        {
          "id": "3a713d00-a608-489a-8b3f-1bfd2e06f0d0",
          "name": "server-b",
          "orcadDeployment": {
            "sshTargetId": "ssh-example-d54"
          }
        },
        {
          "id": "f5613273-66af-43ff-8449-d496f19ff80e",
          "name": "server-lab",
          "orcadDeployment": {
            "sshTargetId": "ssh-example-ce3"
          }
        },
        {
          "id": "b4fa9e5c-40bf-470f-89a9-d49922fb998b",
          "name": "server-a",
          "orcadDeployment": {
            "sshTargetId": "ssh-example-b72"
          }
        }
      ]
    }
  },
  "bot list": {
    "ok": true,
    "result": {
      "bots": [
        {
          "id": "a80aaa23-d9cc-4258-858e-040437004dcd",
          "name": "Ops",
          "agent": "claude",
          "paused": false
        },
        {
          "id": "c48e9e25-2d39-4189-8a45-b74a75df6203",
          "name": "Builder",
          "agent": "claude",
          "paused": false
        },
        {
          "id": "0a343563-9b23-4270-a1d5-6e210210a822",
          "name": "Runner",
          "agent": "claude",
          "paused": false,
          "server": {
            "name": "server-a",
            "on": "server-a"
          }
        }
      ],
      "unreachable": []
    }
  },
  "worktree ps": {
    "local": {
      "ok": true,
      "result": {
        "worktrees": [
          {
            "worktreeId": "05cced8b-4ee5-4933-8f98-826391844745::project-1-main",
            "workspaceKind": "git",
            "hostId": "local",
            "isArchived": false,
            "status": "inactive",
            "sidebarStatus": "inactive",
            "workspaceStatus": "in-progress",
            "lastActivityAt": 1792045605851,
            "liveTerminalCount": 0,
            "repo": "project-1",
            "displayName": "main",
            "environment": {
              "name": "local"
            },
            "agents": []
          },
          {
            "worktreeId": "055ddd34-58dc-4a80-bba9-e5d87fe5aa79::orca-proxmox-main",
            "workspaceKind": "git",
            "hostId": "local",
            "isArchived": false,
            "status": "inactive",
            "sidebarStatus": "inactive",
            "workspaceStatus": "in-progress",
            "lastActivityAt": 1792057290841,
            "liveTerminalCount": 0,
            "repo": "orca-proxmox",
            "displayName": "main",
            "environment": {
              "name": "local"
            },
            "agents": []
          },
          {
            "worktreeId": "aaba9db0-1895-433c-ac6a-9d94e11e183f::project-2-main",
            "workspaceKind": "git",
            "hostId": "local",
            "isArchived": false,
            "status": "inactive",
            "sidebarStatus": "inactive",
            "workspaceStatus": "in-progress",
            "lastActivityAt": 1790354225466,
            "liveTerminalCount": 0,
            "repo": "project-2",
            "displayName": "main",
            "environment": {
              "name": "local"
            },
            "agents": []
          },
          {
            "worktreeId": "05cced8b-4ee5-4933-8f98-826391844745::project-1-wt",
            "workspaceKind": "git",
            "hostId": "local",
            "isArchived": false,
            "bot": "Builder",
            "status": "inactive",
            "sidebarStatus": "inactive",
            "workspaceStatus": "in-progress",
            "lastActivityAt": 1792046258293,
            "liveTerminalCount": 0,
            "repo": "project-1",
            "displayName": "feature-branch",
            "environment": {
              "name": "local"
            },
            "agents": []
          },
          {
            "worktreeId": "055ddd34-58dc-4a80-bba9-e5d87fe5aa79::orca-proxmox-wt",
            "workspaceKind": "git",
            "hostId": "local",
            "isArchived": false,
            "bot": "Ops",
            "status": "working",
            "sidebarStatus": "working",
            "workspaceStatus": "in-progress",
            "lastActivityAt": 1792057316838,
            "liveTerminalCount": 0,
            "repo": "orca-proxmox",
            "displayName": "feature-branch",
            "environment": {
              "name": "local"
            },
            "agents": [
              {
                "agentType": "codex",
                "state": "done",
                "stateStartedAt": 1792061086634
              },
              {
                "agentType": "claude",
                "state": "working",
                "stateStartedAt": 1792062682326
              }
            ]
          },
          {
            "worktreeId": "9a2a4538-88d5-446d-aa2e-dabc9e7684ac::project-3-main",
            "workspaceKind": "git",
            "hostId": "local",
            "isArchived": false,
            "status": "inactive",
            "sidebarStatus": "inactive",
            "workspaceStatus": "in-progress",
            "lastActivityAt": 1790353862622,
            "liveTerminalCount": 0,
            "repo": "project-3",
            "displayName": "main",
            "environment": {
              "name": "local"
            },
            "agents": []
          },
          {
            "worktreeId": "folder:f723be46-1c15-458a-9923-3d00993de0b1",
            "workspaceKind": "folder-workspace",
            "hostId": "local",
            "isArchived": false,
            "bot": "Builder",
            "botHome": true,
            "status": "inactive",
            "sidebarStatus": "inactive",
            "workspaceStatus": "in-progress",
            "lastActivityAt": 1792047436146,
            "liveTerminalCount": 0,
            "repo": "Bots",
            "displayName": "Builder",
            "environment": {
              "name": "local"
            },
            "agents": [
              {
                "agentType": "claude",
                "state": "done",
                "stateStartedAt": 1792047436121
              }
            ]
          },
          {
            "worktreeId": "folder:14afb103-f8e0-4c03-a1ed-e56cae43766d",
            "workspaceKind": "folder-workspace",
            "hostId": "local",
            "isArchived": false,
            "bot": "Ops",
            "botHome": true,
            "status": "inactive",
            "sidebarStatus": "done",
            "workspaceStatus": "in-progress",
            "lastActivityAt": 1792062698295,
            "liveTerminalCount": 0,
            "repo": "Bots",
            "displayName": "Ops",
            "environment": {
              "name": "local"
            },
            "agents": [
              {
                "agentType": "claude",
                "state": "done",
                "stateStartedAt": 1792062698270
              }
            ]
          }
        ]
      }
    },
    "203.0.113.3": {
      "ok": true,
      "result": {
        "worktrees": [
          {
            "worktreeId": "7056dfd2-acfe-43c5-8b5f-15dbd83a6a9c::root-main",
            "workspaceKind": "git",
            "hostId": "local",
            "isArchived": false,
            "status": "inactive",
            "sidebarStatus": "inactive",
            "workspaceStatus": "in-progress",
            "lastActivityAt": 1791992452480,
            "liveTerminalCount": 0,
            "repo": "root",
            "displayName": "root",
            "environment": {
              "name": "203.0.113.3"
            },
            "agents": []
          }
        ]
      }
    },
    "server-b": {
      "ok": true,
      "result": {
        "worktrees": [
          {
            "worktreeId": "c96fc3a2-1377-4125-b8c3-e83b4c7b8dd5::root-main",
            "workspaceKind": "git",
            "hostId": "local",
            "isArchived": false,
            "status": "inactive",
            "sidebarStatus": "inactive",
            "workspaceStatus": "in-progress",
            "lastActivityAt": 1790433884754,
            "liveTerminalCount": 0,
            "repo": "root",
            "displayName": "root",
            "environment": {
              "name": "server-b"
            },
            "agents": []
          }
        ]
      }
    },
    "server-lab": {
      "ok": true,
      "result": {
        "worktrees": [
          {
            "worktreeId": "8d7a1112-0d31-46c7-88d1-572d747c90fd::root-main",
            "workspaceKind": "git",
            "hostId": "local",
            "isArchived": false,
            "status": "inactive",
            "sidebarStatus": "inactive",
            "workspaceStatus": "in-progress",
            "lastActivityAt": 1792058415190,
            "liveTerminalCount": 0,
            "repo": "root",
            "displayName": "root",
            "environment": {
              "name": "server-lab"
            },
            "agents": []
          }
        ]
      }
    },
    "server-a": {
      "ok": true,
      "result": {
        "worktrees": [
          {
            "worktreeId": "folder:17826723-58d0-48c3-b0ac-8a7b351245ee",
            "workspaceKind": "folder-workspace",
            "hostId": "local",
            "isArchived": false,
            "bot": "Runner",
            "botHome": true,
            "status": "inactive",
            "sidebarStatus": "inactive",
            "workspaceStatus": "in-progress",
            "lastActivityAt": 1792055010654,
            "liveTerminalCount": 0,
            "repo": "Bots",
            "displayName": "Runner",
            "environment": {
              "name": "server-a"
            },
            "agents": [
              {
                "agentType": "claude",
                "state": "done",
                "stateStartedAt": 1792056551714
              }
            ]
          },
          {
            "worktreeId": "d9f0158e-f924-4cd4-a1e9-f219ac5f1511::root-main",
            "workspaceKind": "git",
            "hostId": "local",
            "isArchived": false,
            "status": "inactive",
            "sidebarStatus": "inactive",
            "workspaceStatus": "in-progress",
            "lastActivityAt": 1792056523999,
            "liveTerminalCount": 0,
            "repo": "root",
            "displayName": "root",
            "environment": {
              "name": "server-a"
            },
            "agents": []
          }
        ]
      }
    }
  }
} as const
