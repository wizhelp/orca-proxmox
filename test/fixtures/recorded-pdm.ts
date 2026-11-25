// Recorded from a real Proxmox Datacenter Manager 1.1.10 (4 PVE 9.x remotes, 1 PBS 4.2) through
// the plugin's own worker, then scrubbed: IP addresses (also where a name encodes one), certificate
// fingerprints, guest names and backup comments are replaced, and remote, node, namespace and
// PBS user names are example names (alpha, beta, gamma, delta). VMIDs and backup ids are mapped
// to other numbers (the same everywhere, so VMIDs shared by two remotes still collide, and in the
// same order), and every time is moved by one offset, so intervals are kept but no real date.
// Answers are the `data` of each GET, keyed by path and query after /api2/json.

/** A moment just after the newest snapshot in this recording; tests use it as "now". */
export const RECORDED_AT = 1792060343000

export const recordedRoutes: Record<string, unknown> = {
  "/version": {
    "release": "10",
    "repoid": "0000000000000000000000000000000000000000",
    "version": "1.1"
  },
  "/remotes/remote": [
    {
      "authid": "pdm@pve!pdm",
      "id": "alpha",
      "nodes": [
        "192.0.2.1:8006,fingerprint=00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:01"
      ],
      "token": "",
      "type": "pve"
    },
    {
      "authid": "pdm@pve!pdm",
      "id": "beta",
      "nodes": [
        "192.0.2.1:8006,fingerprint=00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:02"
      ],
      "token": "",
      "type": "pve"
    },
    {
      "authid": "pdm@pve!pdm",
      "id": "gamma",
      "nodes": [
        "192.0.2.1:8006,fingerprint=00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:03"
      ],
      "token": "",
      "type": "pve"
    },
    {
      "authid": "pdm@pbs!pdm",
      "id": "gamma-pbs",
      "nodes": [
        "192.0.2.1:8007,fingerprint=00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:04"
      ],
      "token": "",
      "type": "pbs"
    },
    {
      "authid": "pdm@pve!pdm",
      "id": "delta",
      "nodes": [
        "192.0.2.1:8006,fingerprint=00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:05"
      ],
      "token": "",
      "type": "pve"
    }
  ],
  "/resources/list?max-age=30": [
    {
      "remote": "alpha",
      "resources": [
        {
          "cpu": 0.015657344546984,
          "disk": 0,
          "id": "remote/alpha/guest/310",
          "maxcpu": 4,
          "maxdisk": 128849018880,
          "maxmem": 8589934592,
          "mem": 3586113536,
          "name": "vm-alpha-310",
          "node": "pve",
          "pool": "",
          "status": "running",
          "template": false,
          "type": "pve-qemu",
          "uptime": 62643,
          "vmid": 310
        },
        {
          "cpu": 0.000582808253585652,
          "disk": 5253824512,
          "id": "remote/alpha/guest/311",
          "maxcpu": 2,
          "maxdisk": 33501757440,
          "maxmem": 2147483648,
          "mem": 483594240,
          "name": "ct-alpha-311",
          "node": "pve",
          "pool": "",
          "status": "running",
          "template": false,
          "type": "pve-lxc",
          "uptime": 62639,
          "vmid": 311
        },
        {
          "cpu": 0.00265378721135323,
          "disk": 0,
          "id": "remote/alpha/guest/312",
          "maxcpu": 2,
          "maxdisk": 53687091200,
          "maxmem": 4294967296,
          "mem": 2287603712,
          "name": "vm-alpha-312",
          "node": "pve",
          "pool": "",
          "status": "running",
          "template": false,
          "type": "pve-qemu",
          "uptime": 62640,
          "vmid": 312
        },
        {
          "cpu": 0.0043180793333846,
          "disk": 34408841216,
          "id": "remote/alpha/guest/313",
          "maxcpu": 4,
          "maxdisk": 52655996928,
          "maxmem": 8589934592,
          "mem": 1287000064,
          "name": "ct-alpha-313",
          "node": "pve",
          "pool": "",
          "status": "running",
          "template": false,
          "type": "pve-lxc",
          "uptime": 62636,
          "vmid": 313
        },
        {
          "cpu": 0.00286105869942047,
          "disk": 3461722112,
          "id": "remote/alpha/guest/314",
          "maxcpu": 2,
          "maxdisk": 8350298112,
          "maxmem": 2147483648,
          "mem": 144097280,
          "name": "ct-alpha-314",
          "node": "pve",
          "pool": "",
          "status": "running",
          "template": false,
          "type": "pve-lxc",
          "uptime": 62636,
          "vmid": 314
        },
        {
          "cpu": 0.00212302976908258,
          "disk": 0,
          "id": "remote/alpha/guest/316",
          "maxcpu": 4,
          "maxdisk": 32212254720,
          "maxmem": 8589934592,
          "mem": 1350725632,
          "name": "vm-alpha-316",
          "node": "pve",
          "pool": "",
          "status": "running",
          "template": false,
          "type": "pve-qemu",
          "uptime": 62637,
          "vmid": 316
        },
        {
          "cpu": 0.000211930274031146,
          "disk": 2343661568,
          "id": "remote/alpha/guest/317",
          "maxcpu": 1,
          "maxdisk": 8350298112,
          "maxmem": 4294967296,
          "mem": 174936064,
          "name": "ct-alpha-317",
          "node": "pve",
          "pool": "",
          "status": "running",
          "template": false,
          "type": "pve-lxc",
          "uptime": 62633,
          "vmid": 317
        },
        {
          "cpu": 0.00318454465362387,
          "disk": 0,
          "id": "remote/alpha/guest/318",
          "maxcpu": 1,
          "maxdisk": 21474836480,
          "maxmem": 2147483648,
          "mem": 815833088,
          "name": "vm-alpha-318",
          "node": "pve",
          "pool": "",
          "status": "running",
          "template": false,
          "type": "pve-qemu",
          "uptime": 62647,
          "vmid": 318
        },
        {
          "cpu": 0.0737752844756197,
          "disk": 0,
          "id": "remote/alpha/guest/332",
          "maxcpu": 2,
          "maxdisk": 42949672960,
          "maxmem": 4294967296,
          "mem": 3382063104,
          "name": "vm-alpha-332",
          "node": "pve",
          "pool": "",
          "status": "running",
          "template": false,
          "type": "pve-qemu",
          "uptime": 62634,
          "vmid": 332
        },
        {
          "cpu": 0.00212302976908258,
          "disk": 0,
          "id": "remote/alpha/guest/350",
          "maxcpu": 1,
          "maxdisk": 12884901888,
          "maxmem": 1073741824,
          "mem": 747089920,
          "name": "vm-alpha-350",
          "node": "pve",
          "pool": "",
          "status": "running",
          "tags": [
            "tag"
          ],
          "template": false,
          "type": "pve-qemu",
          "uptime": 62495,
          "vmid": 350
        },
        {
          "cpu": 0.00318454465362387,
          "disk": 0,
          "id": "remote/alpha/guest/351",
          "maxcpu": 1,
          "maxdisk": 21474836480,
          "maxmem": 2147483648,
          "mem": 1271390208,
          "name": "vm-alpha-351",
          "node": "pve",
          "pool": "",
          "status": "running",
          "tags": [
            "tag"
          ],
          "template": false,
          "type": "pve-qemu",
          "uptime": 62471,
          "vmid": 351
        },
        {
          "cgroup-mode": 2,
          "cpu": 0.022715173025732,
          "id": "remote/alpha/node/pve",
          "level": "",
          "maxcpu": 12,
          "maxmem": 67341910016,
          "mem": 24795070464,
          "node": "pve",
          "status": "online",
          "type": "pve-node",
          "uptime": 62659
        },
        {
          "disk": 170742059008,
          "id": "remote/alpha/storage/pve/pbs-gamma",
          "maxdisk": 467909804032,
          "node": "pve",
          "shared": true,
          "status": "available",
          "storage": "pbs-gamma",
          "type": "pve-storage"
        },
        {
          "disk": 285689733120,
          "id": "remote/alpha/storage/pve/local",
          "maxdisk": 467909804032,
          "node": "pve",
          "shared": false,
          "status": "available",
          "storage": "local",
          "type": "pve-storage"
        },
        {
          "id": "remote/alpha/network/pve/zone/localnetwork",
          "legacy": false,
          "network": "localnetwork",
          "network_type": "zone",
          "node": "pve",
          "status": "available",
          "type": "pve-network",
          "zone-type": ""
        }
      ]
    },
    {
      "remote": "beta",
      "resources": [
        {
          "cpu": 0.00519727576136395,
          "disk": 0,
          "id": "remote/beta/guest/310",
          "maxcpu": 4,
          "maxdisk": 64424509440,
          "maxmem": 8589934592,
          "mem": 3145375744,
          "name": "vm-beta-310",
          "node": "pve01",
          "pool": "",
          "status": "running",
          "template": false,
          "type": "pve-qemu",
          "uptime": 78758,
          "vmid": 310
        },
        {
          "cpu": 0.00272238254166683,
          "disk": 0,
          "id": "remote/beta/guest/314",
          "maxcpu": 4,
          "maxdisk": 107374182400,
          "maxmem": 17179869184,
          "mem": 1044975616,
          "name": "vm-beta-314",
          "node": "pve01",
          "pool": "",
          "status": "running",
          "template": false,
          "type": "pve-qemu",
          "uptime": 78755,
          "vmid": 314
        },
        {
          "cpu": 0.00445480779545481,
          "disk": 0,
          "id": "remote/beta/guest/320",
          "maxcpu": 2,
          "maxdisk": 34359738368,
          "maxmem": 4294967296,
          "mem": 3494866944,
          "name": "vm-beta-320",
          "node": "pve01",
          "pool": "",
          "status": "running",
          "template": false,
          "type": "pve-qemu",
          "uptime": 10930,
          "vmid": 320
        },
        {
          "cpu": 0,
          "disk": 2964447232,
          "id": "remote/beta/guest/430",
          "maxcpu": 2,
          "maxdisk": 16729894912,
          "maxmem": 2147483648,
          "mem": 473034752,
          "name": "ct-beta-430",
          "node": "pve01",
          "pool": "pool1",
          "status": "running",
          "template": false,
          "type": "pve-lxc",
          "uptime": 78752,
          "vmid": 430
        },
        {
          "cpu": 0.000593993074973256,
          "disk": 32892108800,
          "id": "remote/beta/guest/431",
          "maxcpu": 4,
          "maxdisk": 83955703808,
          "maxmem": 8589934592,
          "mem": 226521088,
          "name": "ct-beta-431",
          "node": "pve01",
          "pool": "pool1",
          "status": "running",
          "template": false,
          "type": "pve-lxc",
          "uptime": 78752,
          "vmid": 431
        },
        {
          "cgroup-mode": 2,
          "cpu": 0.00203373015873016,
          "id": "remote/beta/node/pve01",
          "level": "",
          "maxcpu": 20,
          "maxmem": 67192713216,
          "mem": 13191860224,
          "node": "pve01",
          "status": "online",
          "type": "pve-node",
          "uptime": 78767
        },
        {
          "disk": 125489082368,
          "id": "remote/beta/storage/pve01/local",
          "maxdisk": 467645579264,
          "node": "pve01",
          "shared": false,
          "status": "available",
          "storage": "local",
          "type": "pve-storage"
        },
        {
          "disk": 170742059008,
          "id": "remote/beta/storage/pve01/pbs-gamma",
          "maxdisk": 467909804032,
          "node": "pve01",
          "shared": true,
          "status": "available",
          "storage": "pbs-gamma",
          "type": "pve-storage"
        },
        {
          "id": "remote/beta/network/pve01/zone/localnetwork",
          "legacy": false,
          "network": "localnetwork",
          "network_type": "zone",
          "node": "pve01",
          "status": "available",
          "type": "pve-network",
          "zone-type": ""
        }
      ]
    },
    {
      "remote": "gamma",
      "resources": [
        {
          "cpu": 0,
          "disk": 0,
          "id": "remote/gamma/guest/9100",
          "maxcpu": 1,
          "maxdisk": 3221225472,
          "maxmem": 1073741824,
          "mem": 0,
          "name": "vm-gamma-9100",
          "node": "pve-gamma",
          "pool": "",
          "status": "stopped",
          "template": true,
          "type": "pve-qemu",
          "uptime": 0,
          "vmid": 9100
        },
        {
          "cgroup-mode": 2,
          "cpu": 0.00237055520898316,
          "id": "remote/gamma/node/pve-gamma",
          "level": "",
          "maxcpu": 8,
          "maxmem": 67198681088,
          "mem": 3061780480,
          "node": "pve-gamma",
          "status": "online",
          "type": "pve-node",
          "uptime": 65068
        },
        {
          "disk": 170742059008,
          "id": "remote/gamma/storage/pve-gamma/backup-offsite",
          "maxdisk": 467909804032,
          "node": "pve-gamma",
          "shared": false,
          "status": "available",
          "storage": "backup-offsite",
          "type": "pve-storage"
        },
        {
          "disk": 170742059008,
          "id": "remote/gamma/storage/pve-gamma/local",
          "maxdisk": 467909804032,
          "node": "pve-gamma",
          "shared": false,
          "status": "available",
          "storage": "local",
          "type": "pve-storage"
        },
        {
          "id": "remote/gamma/network/pve-gamma/zone/localnetwork",
          "legacy": false,
          "network": "localnetwork",
          "network_type": "zone",
          "node": "pve-gamma",
          "status": "available",
          "type": "pve-network",
          "zone-type": ""
        }
      ]
    },
    {
      "remote": "gamma-pbs",
      "resources": [
        {
          "cpu": 0.002955082742316817,
          "id": "remote/gamma-pbs/node/localhost",
          "maxcpu": 8,
          "maxmem": 67198681088,
          "mem": 3063250944,
          "name": "localhost",
          "type": "pbs-node",
          "uptime": 65076
        },
        {
          "disk": 170742059008,
          "id": "remote/gamma-pbs/datastore/main",
          "maxdisk": 467909804032,
          "name": "main",
          "type": "pbs-datastore",
          "usage": 0.36490378602181006
        }
      ]
    },
    {
      "remote": "delta",
      "resources": [
        {
          "cpu": 0.0357652181314218,
          "disk": 0,
          "id": "remote/delta/guest/410",
          "maxcpu": 6,
          "maxdisk": 161061273600,
          "maxmem": 25769803776,
          "mem": 3868913664,
          "name": "vm-delta-410",
          "node": "pve-delta",
          "pool": "",
          "status": "running",
          "template": false,
          "type": "pve-qemu",
          "uptime": 956,
          "vmid": 410
        },
        {
          "cpu": 0.00935398012667954,
          "disk": 0,
          "id": "remote/delta/guest/411",
          "maxcpu": 4,
          "maxdisk": 64424509440,
          "maxmem": 6442450944,
          "mem": 1032044544,
          "name": "vm-delta-411",
          "node": "pve-delta",
          "pool": "",
          "status": "running",
          "template": false,
          "type": "pve-qemu",
          "uptime": 953,
          "vmid": 411
        },
        {
          "cgroup-mode": 2,
          "cpu": 0.0273193731798641,
          "id": "remote/delta/node/pve-delta",
          "level": "",
          "maxcpu": 8,
          "maxmem": 67198423040,
          "mem": 8563953664,
          "node": "pve-delta",
          "status": "online",
          "type": "pve-node",
          "uptime": 966
        },
        {
          "disk": 170742059008,
          "id": "remote/delta/storage/pve-delta/pbs-gamma",
          "maxdisk": 467909804032,
          "node": "pve-delta",
          "shared": true,
          "status": "available",
          "storage": "pbs-gamma",
          "type": "pve-storage"
        },
        {
          "disk": 80095887360,
          "id": "remote/delta/storage/pve-delta/local",
          "maxdisk": 467909804032,
          "node": "pve-delta",
          "shared": false,
          "status": "available",
          "storage": "local",
          "type": "pve-storage"
        },
        {
          "id": "remote/delta/network/pve-delta/zone/localnetwork",
          "legacy": false,
          "network": "localnetwork",
          "network_type": "zone",
          "node": "pve-delta",
          "status": "available",
          "type": "pve-network",
          "zone-type": ""
        }
      ]
    }
  ],
  "/pve/remotes/alpha/nodes/pve/status": {
    "boot-info": {
      "mode": "legacy-bios"
    },
    "cpu": 0.0293915088842034,
    "cpuinfo": {
      "cores": 6,
      "cpus": 12,
      "model": "AMD Ryzen 5 3600 6-Core Processor",
      "sockets": 1
    },
    "current-kernel": {
      "machine": "x86_64",
      "release": "7.0.14-30-pve",
      "sysname": "Linux",
      "version": "#1 SMP PREEMPT_DYNAMIC PMX 7.0.14-30 (2026-11-16T21:55Z)"
    },
    "idle": 725352,
    "ksm": {
      "shared": 0
    },
    "kversion": "Linux 7.0.14-30-pve #1 SMP PREEMPT_DYNAMIC PMX 7.0.14-30 (2026-11-16T21:55Z)",
    "loadavg": [
      "0.68",
      "1.03",
      "1.22"
    ],
    "memory": {
      "available": 42552205312,
      "free": 30039482368,
      "total": 67341910016,
      "used": 24789704704
    },
    "pveversion": "pve-manager/9.2.32/60a22e26e411402f",
    "rootfs": {
      "avail": 158376316928,
      "free": 182220058624,
      "total": 467909804032,
      "used": 285689745408
    },
    "swap": {
      "free": 34325131264,
      "total": 34325131264,
      "used": 0
    },
    "uptime": 62694,
    "wait": 0.00225681016306248
  },
  "/pve/remotes/beta/nodes/pve01/status": {
    "boot-info": {
      "mode": "efi",
      "secureboot": false
    },
    "cpu": 0.00319168195423385,
    "cpuinfo": {
      "cores": 14,
      "cpus": 20,
      "model": "13th Gen Intel(R) Core(TM) i5-13500",
      "sockets": 1
    },
    "current-kernel": {
      "machine": "x86_64",
      "release": "7.0.14-30-pve",
      "sysname": "Linux",
      "version": "#1 SMP PREEMPT_DYNAMIC PMX 7.0.14-30 (2026-11-16T21:55Z)"
    },
    "idle": 1568408,
    "ksm": {
      "shared": 0
    },
    "kversion": "Linux 7.0.14-30-pve #1 SMP PREEMPT_DYNAMIC PMX 7.0.14-30 (2026-11-16T21:55Z)",
    "loadavg": [
      "0.05",
      "0.13",
      "0.10"
    ],
    "memory": {
      "available": 54014078976,
      "free": 20895240192,
      "total": 67192713216,
      "used": 13178634240
    },
    "pveversion": "pve-manager/9.2.32/60a22e26e411402f",
    "rootfs": {
      "avail": 318326034432,
      "free": 342156353536,
      "total": 467645579264,
      "used": 125489225728
    },
    "swap": {
      "free": 34325114880,
      "total": 34325131264,
      "used": 16384
    },
    "uptime": 78817,
    "wait": 0.000680095587525345
  },
  "/pve/remotes/gamma/nodes/pve-gamma/status": {
    "boot-info": {
      "mode": "legacy-bios"
    },
    "cpu": 0.00253455542129616,
    "cpuinfo": {
      "cores": 4,
      "cpus": 8,
      "model": "Intel(R) Core(TM) i7-7700 CPU @ 3.60GHz",
      "sockets": 1
    },
    "current-kernel": {
      "machine": "x86_64",
      "release": "7.0.14-30-pve",
      "sysname": "Linux",
      "version": "#1 SMP PREEMPT_DYNAMIC PMX 7.0.14-30 (2026-11-16T21:55Z)"
    },
    "idle": 517082,
    "ksm": {
      "shared": 0
    },
    "kversion": "Linux 7.0.14-30-pve #1 SMP PREEMPT_DYNAMIC PMX 7.0.14-30 (2026-11-16T21:55Z)",
    "loadavg": [
      "0.09",
      "0.29",
      "0.27"
    ],
    "memory": {
      "available": 64117059584,
      "free": 786419712,
      "total": 67198681088,
      "used": 3081621504
    },
    "pveversion": "pve-manager/9.2.32/60a22e26e411402f",
    "rootfs": {
      "avail": 273323991040,
      "free": 297167732736,
      "total": 467909804032,
      "used": 170742071296
    },
    "swap": {
      "free": 34325110784,
      "total": 34325131264,
      "used": 20480
    },
    "uptime": 65117,
    "wait": 0.00010315051133182
  },
  "/pve/remotes/delta/nodes/pve-delta/status": {
    "boot-info": {
      "mode": "legacy-bios"
    },
    "cpu": 0.0377179681576952,
    "cpuinfo": {
      "cores": 4,
      "cpus": 8,
      "model": "Intel(R) Core(TM) i7-7700 CPU @ 3.60GHz",
      "sockets": 1
    },
    "current-kernel": {
      "machine": "x86_64",
      "release": "7.0.14-30-pve",
      "sysname": "Linux",
      "version": "#1 SMP PREEMPT_DYNAMIC PMX 7.0.14-30 (2026-11-16T21:55Z)"
    },
    "idle": 7120,
    "ksm": {
      "shared": 0
    },
    "kversion": "Linux 7.0.14-30-pve #1 SMP PREEMPT_DYNAMIC PMX 7.0.14-30 (2026-11-16T21:55Z)",
    "loadavg": [
      "0.43",
      "1.09",
      "1.03"
    ],
    "memory": {
      "available": 58632638464,
      "free": 58633613312,
      "total": 67198423040,
      "used": 8565784576
    },
    "pveversion": "pve-manager/9.3.1/4cbab754a7da645d",
    "rootfs": {
      "avail": 363970084864,
      "free": 387813826560,
      "total": 467909804032,
      "used": 80095977472
    },
    "swap": {
      "free": 34325131264,
      "total": 34325131264,
      "used": 0
    },
    "uptime": 1011,
    "wait": 0.000852918877937832
  },
  "/pbs/remotes/gamma-pbs/status": {
    "boot-info": {
      "mode": "legacy-bios",
      "secureboot": false
    },
    "cpu": 0.002364532019704435,
    "cpuinfo": {
      "cpus": 8,
      "model": "Intel(R) Core(TM) i7-7700 CPU @ 3.60GHz",
      "sockets": 1
    },
    "current-kernel": {
      "machine": "x86_64",
      "release": "7.0.14-30-pve",
      "sysname": "Linux",
      "version": "#1 SMP PREEMPT_DYNAMIC PMX 7.0.14-30 (2026-11-16T21:55Z)"
    },
    "info": {
      "fingerprint": "00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:06"
    },
    "kversion": "Linux 7.0.14-30-pve #1 SMP PREEMPT_DYNAMIC PMX 7.0.14-30 (2026-11-16T21:55Z)",
    "loadavg": [
      0.08,
      0.29,
      0.27
    ],
    "memory": {
      "free": 790630400,
      "total": 67198681088,
      "used": 3077410816
    },
    "root": {
      "avail": 273323991040,
      "total": 467909804032,
      "used": 170742071296
    },
    "swap": {
      "free": 34325110784,
      "total": 34325131264,
      "used": 20480
    },
    "uptime": 65118,
    "wait": 0.00020833333333333335
  },
  "/remotes/remote/gamma-pbs/version": {
    "release": "14",
    "repoid": "0000000000000000000000000000000000000000",
    "version": "4.2"
  },
  "/pbs/remotes/gamma-pbs/datastore/main/namespaces": [
    {
      "ns": ""
    },
    {
      "ns": "beta"
    },
    {
      "ns": "alpha"
    },
    {
      "ns": "delta"
    }
  ],
  "/pbs/remotes/gamma-pbs/datastore/main/snapshots": [
    {
      "backup-id": "431",
      "backup-time": 1792045387,
      "backup-type": "ct",
      "comment": "ct-beta-431 first PBS backup",
      "files": [
        {
          "crypt-mode": "none",
          "filename": "pct.conf.blob",
          "size": 259
        },
        {
          "crypt-mode": "none",
          "filename": "root.pxar.didx",
          "size": 30630231040
        },
        {
          "crypt-mode": "none",
          "filename": "catalog.pcat1.didx",
          "size": 19603852
        },
        {
          "crypt-mode": "none",
          "filename": "index.json.blob",
          "size": 476
        },
        {
          "filename": "client.log.blob"
        }
      ],
      "owner": "beta@pbs!pve",
      "protected": false,
      "size": 30649835627
    },
    {
      "backup-id": "430",
      "backup-time": 1792045373,
      "backup-type": "ct",
      "comment": "ct-beta-430 first PBS backup",
      "files": [
        {
          "crypt-mode": "none",
          "filename": "pct.conf.blob",
          "size": 258
        },
        {
          "crypt-mode": "none",
          "filename": "root.pxar.didx",
          "size": 3105503456
        },
        {
          "crypt-mode": "none",
          "filename": "catalog.pcat1.didx",
          "size": 1276821
        },
        {
          "crypt-mode": "none",
          "filename": "index.json.blob",
          "size": 478
        },
        {
          "filename": "client.log.blob"
        }
      ],
      "owner": "beta@pbs!pve",
      "protected": false,
      "size": 3106781013
    },
    {
      "backup-id": "313",
      "backup-time": 1791994921,
      "backup-type": "ct",
      "comment": "ct-alpha-313 pre-upgrade 2026-11-24",
      "files": [
        {
          "crypt-mode": "none",
          "filename": "pct.conf.blob",
          "size": 258
        },
        {
          "crypt-mode": "none",
          "filename": "root.pxar.didx",
          "size": 32637673873
        },
        {
          "crypt-mode": "none",
          "filename": "catalog.pcat1.didx",
          "size": 18104229
        },
        {
          "crypt-mode": "none",
          "filename": "index.json.blob",
          "size": 475
        },
        {
          "filename": "client.log.blob"
        }
      ],
      "owner": "alpha@pbs!pve",
      "protected": false,
      "size": 32655778835
    },
    {
      "backup-id": "314",
      "backup-time": 1791995344,
      "backup-type": "ct",
      "comment": "ct-alpha-314 pre-upgrade 2026-11-24",
      "files": [
        {
          "crypt-mode": "none",
          "filename": "pct.conf.blob",
          "size": 303
        },
        {
          "crypt-mode": "none",
          "filename": "root.pxar.didx",
          "size": 3327961796
        },
        {
          "crypt-mode": "none",
          "filename": "catalog.pcat1.didx",
          "size": 1207218
        },
        {
          "crypt-mode": "none",
          "filename": "index.json.blob",
          "size": 473
        },
        {
          "filename": "client.log.blob"
        }
      ],
      "owner": "alpha@pbs!pve",
      "protected": false,
      "size": 3329169790
    },
    {
      "backup-id": "311",
      "backup-time": 1791994700,
      "backup-type": "ct",
      "comment": "ct-alpha-311 pre-upgrade 2026-11-24",
      "files": [
        {
          "crypt-mode": "none",
          "filename": "pct.conf.blob",
          "size": 263
        },
        {
          "crypt-mode": "none",
          "filename": "root.pxar.didx",
          "size": 4205846689
        },
        {
          "crypt-mode": "none",
          "filename": "catalog.pcat1.didx",
          "size": 9121393
        },
        {
          "crypt-mode": "none",
          "filename": "index.json.blob",
          "size": 465
        },
        {
          "filename": "client.log.blob"
        }
      ],
      "owner": "alpha@pbs!pve",
      "protected": false,
      "size": 4214968810
    },
    {
      "backup-id": "317",
      "backup-time": 1791995444,
      "backup-type": "ct",
      "comment": "ct-alpha-317 pre-upgrade 2026-11-24",
      "files": [
        {
          "crypt-mode": "none",
          "filename": "pct.conf.blob",
          "size": 224
        },
        {
          "crypt-mode": "none",
          "filename": "root.pxar.didx",
          "size": 2156940639
        },
        {
          "crypt-mode": "none",
          "filename": "catalog.pcat1.didx",
          "size": 1639371
        },
        {
          "crypt-mode": "none",
          "filename": "index.json.blob",
          "size": 468
        },
        {
          "filename": "client.log.blob"
        }
      ],
      "owner": "alpha@pbs!pve",
      "protected": false,
      "size": 2158580702
    },
    {
      "backup-id": "318",
      "backup-time": 1791995475,
      "backup-type": "vm",
      "comment": "vm-alpha-318 pre-upgrade 2026-11-24",
      "files": [
        {
          "crypt-mode": "none",
          "filename": "qemu-server.conf.blob",
          "size": 567
        },
        {
          "crypt-mode": "none",
          "filename": "drive-scsi0.img.fidx",
          "size": 21474836480
        },
        {
          "crypt-mode": "none",
          "filename": "index.json.blob",
          "size": 434
        },
        {
          "filename": "client.log.blob"
        }
      ],
      "owner": "alpha@pbs!pve",
      "protected": false,
      "size": 21474837481
    },
    {
      "backup-id": "351",
      "backup-time": 1791995651,
      "backup-type": "vm",
      "comment": "vm-alpha-351 pre-upgrade 2026-11-24",
      "files": [
        {
          "crypt-mode": "none",
          "filename": "qemu-server.conf.blob",
          "size": 657
        },
        {
          "crypt-mode": "none",
          "filename": "drive-scsi0.img.fidx",
          "size": 21474836480
        },
        {
          "crypt-mode": "none",
          "filename": "index.json.blob",
          "size": 424
        },
        {
          "filename": "client.log.blob"
        }
      ],
      "owner": "alpha@pbs!pve",
      "protected": false,
      "size": 21474837561
    },
    {
      "backup-id": "316",
      "backup-time": 1791995387,
      "backup-type": "vm",
      "comment": "vm-alpha-316 pre-upgrade 2026-11-24",
      "files": [
        {
          "crypt-mode": "none",
          "filename": "qemu-server.conf.blob",
          "size": 583
        },
        {
          "crypt-mode": "none",
          "filename": "drive-scsi0.img.fidx",
          "size": 32212254720
        },
        {
          "crypt-mode": "none",
          "filename": "index.json.blob",
          "size": 432
        },
        {
          "filename": "client.log.blob"
        }
      ],
      "owner": "alpha@pbs!pve",
      "protected": false,
      "size": 32212255735
    },
    {
      "backup-id": "312",
      "backup-time": 1791994815,
      "backup-type": "vm",
      "comment": "vm-alpha-312 pre-upgrade 2026-11-24",
      "files": [
        {
          "crypt-mode": "none",
          "filename": "qemu-server.conf.blob",
          "size": 392
        },
        {
          "crypt-mode": "none",
          "filename": "drive-scsi0.img.fidx",
          "size": 53687091200
        },
        {
          "crypt-mode": "none",
          "filename": "index.json.blob",
          "size": 425
        },
        {
          "filename": "client.log.blob"
        }
      ],
      "owner": "alpha@pbs!pve",
      "protected": false,
      "size": 53687092017
    },
    {
      "backup-id": "314",
      "backup-time": 1792045331,
      "backup-type": "vm",
      "comment": "vm-beta-314 first PBS backup",
      "files": [
        {
          "crypt-mode": "none",
          "filename": "qemu-server.conf.blob",
          "size": 597
        },
        {
          "crypt-mode": "none",
          "filename": "drive-scsi0.img.fidx",
          "size": 107374182400
        },
        {
          "crypt-mode": "none",
          "filename": "index.json.blob",
          "size": 423
        },
        {
          "filename": "client.log.blob"
        }
      ],
      "owner": "beta@pbs!pve",
      "protected": false,
      "size": 107374183420
    },
    {
      "backup-id": "332",
      "backup-time": 1791995509,
      "backup-type": "vm",
      "comment": "vm-alpha-332 pre-upgrade 2026-11-24",
      "files": [
        {
          "crypt-mode": "none",
          "filename": "qemu-server.conf.blob",
          "size": 516
        },
        {
          "crypt-mode": "none",
          "filename": "drive-scsi0.img.fidx",
          "size": 42949672960
        },
        {
          "crypt-mode": "none",
          "filename": "index.json.blob",
          "size": 428
        },
        {
          "filename": "client.log.blob"
        }
      ],
      "owner": "alpha@pbs!pve",
      "protected": false,
      "size": 42949673904
    },
    {
      "backup-id": "350",
      "backup-time": 1791995621,
      "backup-type": "vm",
      "comment": "vm-alpha-350 pre-upgrade 2026-11-24",
      "files": [
        {
          "crypt-mode": "none",
          "filename": "qemu-server.conf.blob",
          "size": 688
        },
        {
          "crypt-mode": "none",
          "filename": "drive-scsi0.img.fidx",
          "size": 12884901888
        },
        {
          "crypt-mode": "none",
          "filename": "index.json.blob",
          "size": 427
        },
        {
          "filename": "client.log.blob"
        }
      ],
      "owner": "alpha@pbs!pve",
      "protected": false,
      "size": 12884903003
    },
    {
      "backup-id": "310",
      "backup-time": 1791993898,
      "backup-type": "vm",
      "comment": "vm-alpha-310 pre-upgrade 2026-11-24",
      "files": [
        {
          "crypt-mode": "none",
          "filename": "qemu-server.conf.blob",
          "size": 512
        },
        {
          "crypt-mode": "none",
          "filename": "drive-tpmstate0-backup.img.fidx",
          "size": 16896
        },
        {
          "crypt-mode": "none",
          "filename": "drive-scsi0.img.fidx",
          "size": 128849018880
        },
        {
          "crypt-mode": "none",
          "filename": "drive-efidisk0.img.fidx",
          "size": 540672
        },
        {
          "crypt-mode": "none",
          "filename": "index.json.blob",
          "size": 544
        },
        {
          "filename": "client.log.blob"
        }
      ],
      "owner": "alpha@pbs!pve",
      "protected": false,
      "size": 128849577504
    }
  ],
  "/pbs/remotes/gamma-pbs/datastore/main/snapshots?ns=alpha": [],
  "/pbs/remotes/gamma-pbs/datastore/main/snapshots?ns=beta": [
    {
      "backup-id": "431",
      "backup-time": 1792045750,
      "backup-type": "ct",
      "comment": "ct-beta-431 first PBS backup",
      "files": [
        {
          "crypt-mode": "none",
          "filename": "pct.conf.blob",
          "size": 259
        },
        {
          "crypt-mode": "none",
          "filename": "root.pxar.didx",
          "size": 30630252040
        },
        {
          "crypt-mode": "none",
          "filename": "catalog.pcat1.didx",
          "size": 19603852
        },
        {
          "crypt-mode": "none",
          "filename": "index.json.blob",
          "size": 477
        },
        {
          "filename": "client.log.blob"
        }
      ],
      "owner": "beta@pbs!pve",
      "protected": false,
      "size": 30649856628
    },
    {
      "backup-id": "430",
      "backup-time": 1792045737,
      "backup-type": "ct",
      "comment": "ct-beta-430 first PBS backup",
      "files": [
        {
          "crypt-mode": "none",
          "filename": "pct.conf.blob",
          "size": 258
        },
        {
          "crypt-mode": "none",
          "filename": "root.pxar.didx",
          "size": 3105503894
        },
        {
          "crypt-mode": "none",
          "filename": "catalog.pcat1.didx",
          "size": 1276821
        },
        {
          "crypt-mode": "none",
          "filename": "index.json.blob",
          "size": 479
        },
        {
          "filename": "client.log.blob"
        }
      ],
      "owner": "beta@pbs!pve",
      "protected": false,
      "size": 3106781452
    },
    {
      "backup-id": "312",
      "backup-time": 1792045656,
      "backup-type": "vm",
      "comment": "removed-guest first PBS backup",
      "files": [
        {
          "crypt-mode": "none",
          "filename": "qemu-server.conf.blob",
          "size": 571
        },
        {
          "crypt-mode": "none",
          "filename": "drive-scsi0.img.fidx",
          "size": 85899345920
        },
        {
          "crypt-mode": "none",
          "filename": "index.json.blob",
          "size": 431
        },
        {
          "filename": "client.log.blob"
        }
      ],
      "owner": "beta@pbs!pve",
      "protected": false,
      "size": 85899346922
    },
    {
      "backup-id": "314",
      "backup-time": 1792045695,
      "backup-type": "vm",
      "comment": "vm-beta-314 first PBS backup",
      "files": [
        {
          "crypt-mode": "none",
          "filename": "qemu-server.conf.blob",
          "size": 597
        },
        {
          "crypt-mode": "none",
          "filename": "drive-scsi0.img.fidx",
          "size": 107374182400
        },
        {
          "crypt-mode": "none",
          "filename": "index.json.blob",
          "size": 425
        },
        {
          "filename": "client.log.blob"
        }
      ],
      "owner": "beta@pbs!pve",
      "protected": false,
      "size": 107374183422
    },
    {
      "backup-id": "310",
      "backup-time": 1792045593,
      "backup-type": "vm",
      "comment": "vm-beta-310 first PBS backup",
      "files": [
        {
          "crypt-mode": "none",
          "filename": "qemu-server.conf.blob",
          "size": 571
        },
        {
          "crypt-mode": "none",
          "filename": "drive-scsi0.img.fidx",
          "size": 64424509440
        },
        {
          "crypt-mode": "none",
          "filename": "index.json.blob",
          "size": 424
        },
        {
          "filename": "client.log.blob"
        }
      ],
      "owner": "beta@pbs!pve",
      "protected": false,
      "size": 64424510435
    }
  ],
  "/pbs/remotes/gamma-pbs/datastore/main/snapshots?ns=delta": [
    {
      "backup-id": "411",
      "backup-time": 1792058543,
      "backup-type": "vm",
      "comment": "vm-delta-411 first PBS backup",
      "files": [
        {
          "crypt-mode": "none",
          "filename": "qemu-server.conf.blob",
          "size": 541
        },
        {
          "crypt-mode": "none",
          "filename": "drive-scsi0.img.fidx",
          "size": 64424509440
        },
        {
          "crypt-mode": "none",
          "filename": "index.json.blob",
          "size": 427
        },
        {
          "filename": "client.log.blob"
        }
      ],
      "owner": "delta@pbs!pve",
      "protected": false,
      "size": 64424510408
    },
    {
      "backup-id": "410",
      "backup-time": 1792058201,
      "backup-type": "vm",
      "comment": "vm-delta-410 first PBS backup",
      "files": [
        {
          "crypt-mode": "none",
          "filename": "qemu-server.conf.blob",
          "size": 544
        },
        {
          "crypt-mode": "none",
          "filename": "drive-scsi0.img.fidx",
          "size": 161061273600
        },
        {
          "crypt-mode": "none",
          "filename": "index.json.blob",
          "size": 428
        },
        {
          "filename": "client.log.blob"
        }
      ],
      "owner": "delta@pbs!pve",
      "protected": false,
      "size": 161061274572
    }
  ]
}
