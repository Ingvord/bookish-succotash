## When the abstraction leaks

The interviewer is a seasoned lab sysadmin, and he has said the conversation will be "mostly Kubernetes and system administration". That second half is not trivia. He wants to know whether you can go below `kubectl`: when a pod is slow, a node is NotReady, or a volume hangs, can you reason at the kernel and host level instead of re-running `kubectl describe` and hoping.

The skill is the same narrated loop as the [Kubernetes troubleshooting guide](kubernetes-troubleshooting.html), applied one layer down. State a hypothesis ("load is high but CPU is idle, so I suspect processes stuck in uninterruptible I/O"), run the command that tests it, read the output, update out loud. The commands in this guide are the vocabulary; the loop is the answer.

Facts tied to a Kubernetes version are marked "as of 1.37". Where I could not verify a claim against current documentation, the text says so.

---

## ★ A container is a process with three wrappers

**What it is.** There is no "container" object in the Linux kernel. A container is an ordinary process (or a tree of them) started with three wrappers: **namespaces** limit what it can see (its own PID tree, network stack, mounts, hostname, users), **cgroups** limit what it can use (CPU time, memory, PIDs, I/O), and a **root filesystem plus capabilities and seccomp** limit what it can touch (an image's layers, a reduced set of root powers, a filter on system calls).

**Why it matters.** Every Kubernetes concept maps onto one of those primitives, and once you see the mapping, a "Kubernetes problem" becomes a kernel question you already know how to ask.

| Kubernetes concept | Kernel primitive |
|---|---|
| Pod (shared network and IPC) | Containers joined to one network and IPC namespace, held open by the `pause` container |
| `resources.requests.cpu` | cgroup `cpu.weight` (relative share under contention) |
| `resources.limits.cpu` | cgroup `cpu.max` (CFS quota per period) |
| `resources.limits.memory` | cgroup `memory.max` (hard ceiling) |
| OOMKilled, exit code 137 | Kernel OOM killer firing inside that cgroup, SIGKILL |
| `securityContext` | Linux capabilities, seccomp profile, user and group IDs |
| `emptyDir` | A directory on the node's disk (or tmpfs), deleted with the pod |
| `hostPath` | A bind mount of a node directory into the container's mount namespace |
| Liveness restart | The kubelet killing and recreating the container process via the runtime |

The pod is the interesting one. Containers in a pod share a network namespace because the `pause` container creates it and the others join it. That is why two containers in a pod talk over `localhost` and why they cannot bind the same port.

To get from a pod name to the kernel objects, start on the node with the runtime's own tool, since `kubectl` may not even be reachable:

```bash
# Find the container, then its host PID
crictl ps --name myapp
# CONTAINER      IMAGE          CREATED        STATE    NAME    POD ID
# 3f9a1c2d7e10   reg/app:1.4    2 hours ago    Running  myapp   8b21aa04c9f3

crictl inspect 3f9a1c2d7e10 | grep -m1 '"pid"'
#     "pid": 48213,

# Which cgroup is it in, and which namespaces does it have?
cat /proc/48213/cgroup
# 0::/kubepods.slice/kubepods-burstable.slice/kubepods-burstable-pod5c2.slice/cri-containerd-3f9a1c2d7e10.scope
ls -l /proc/48213/ns/

# Run a host tool inside the container's network namespace
nsenter -t 48213 -n ss -tulpn
```

Read the cgroup path from the right. It names the container's scope, inside its pod's slice, inside the QoS slice (`burstable` here), inside `kubepods`. The QoS class is literally a directory in the cgroup tree, which is how the kernel and kubelet can rank pods under pressure.

The catch: `nsenter -n` enters only the network namespace, so `ps` and the filesystem you see are still the host's. That is exactly what you want to debug a container that has no shell, but it also means a command you run is not constrained by the container's limits. As of 1.37, cgroup v1 is deprecated and the kubelet does not start on a v1 node unless `failCgroupV1: false` is set. Check which you have with `stat -fc %T /sys/fs/cgroup`, which prints `cgroup2fs` on v2. The paths in this guide are v2.

---

## ★ CPU and load

**What it is.** Load average is the number of tasks that are runnable or in uninterruptible sleep, averaged over 1, 5 and 15 minutes. On Linux that includes tasks in **D state** (blocked in the kernel, usually waiting on I/O), not just tasks wanting CPU.

**Why it matters.** A load of 200 does not mean the CPUs are busy. A hung NFS mount parks hundreds of processes in D state, load climbs, and every CPU is idle. Reading load as "CPU saturation" sends you to the wrong layer.

```bash
top -bn1 | head -5
# %Cpu(s):  1.2 us,  0.8 sy,  0.0 ni, 21.0 id, 76.5 wa,  0.0 hi,  0.2 si,  0.3 st
# load average: 187.42, 160.10, 95.33

vmstat 1 5          # r = runnable, b = blocked (D state), wa = iowait, si/so = swap
mpstat -P ALL 1 3   # one line per core: is one core pegged while the rest are idle?
pidstat -u -p ALL 1 3
```

The `top` fields to read aloud: `us` user code, `sy` kernel (system calls, networking), `wa` waiting on I/O, `st` stolen by the hypervisor (a noisy neighbour on a VM), `si` soft interrupts (often network packet processing). High `wa` plus high load plus low `us` says "storage or network filesystem". High `st` says the problem is outside your VM entirely.

### CFS throttling: the silent latency source

`limits.cpu` becomes `cpu.max`, a quota of CPU time per 100 ms period. A container limited to 500m gets 50 ms of CPU per period; once it spends that, every thread is **throttled** until the next period, even if the node is idle. A multi-threaded service can burn its quota in the first few milliseconds of a period and then sit frozen for 80 ms.

```bash
cat /sys/fs/cgroup/kubepods.slice/.../cri-containerd-<id>.scope/cpu.stat
# usage_usec 91823345
# nr_periods 120344
# nr_throttled 38812       <- throttled in 32% of periods
# throttled_usec 4412009123
```

The symptom is p99 latency spikes with CPU usage that looks low on a dashboard, because average usage is under the limit. The catch is why many platforms run with requests but no CPU limits: requests give fair share under contention via `cpu.weight`, and without a limit nothing throttles. The tradeoff is a runaway pod can use idle capacity freely, so it needs a good request and monitoring, and it is a policy choice rather than a universal rule.

### NUMA and CPU pinning

On multi-socket HPC and GPU nodes, memory is closer to some cores than others. A process migrating between sockets pays remote-memory latency. The kubelet's **CPU manager** with `policy: static` gives Guaranteed pods with integer CPU requests exclusive cores, which removes migration and noisy neighbours for latency-sensitive jobs. The catch: exclusive cores are removed from the shared pool, so pinning too many Guaranteed pods starves everything else on the node. The policy options (`CPUManagerPolicyOptions`) are GA as of 1.33.

---

## ★ Memory

**What it is.** Memory on Linux has more kinds than "used" and "free". **Anonymous** memory is heap and stack, with no file behind it. **Page cache** is file data the kernel keeps in RAM to speed up reads, and it is reclaimable. **RSS** is what a process has resident, including shared pages.

**Why it matters.** The kernel uses all spare RAM for cache by design, so "free" looks tiny on a healthy node, and panicking about it wastes the interview.

```bash
free -m
#                total   used   free   shared  buff/cache   available
# Mem:           128000  41200   1900     210       84900      85600
```

Read `available`, not `free`. It estimates how much a new workload could use without swapping, counting reclaimable cache. Here `free` is 1.9 GB and the node is fine.

### Who kills what

Three different mechanisms get conflated, and the interviewer will test whether you separate them.

| Mechanism | Trigger | Who acts | What you see |
|---|---|---|---|
| Container OOM | Process exceeds its cgroup `memory.max` | Kernel OOM killer, scoped to that cgroup | Pod `OOMKilled`, exit 137, a line in `journalctl -k` |
| Node OOM | Whole machine out of reclaimable memory | Kernel OOM killer, host-wide, ranked by `oom_score` | Random processes die, possibly the kubelet or runtime |
| Kubelet eviction | `memory.available` falls below a threshold | Kubelet, gracefully evicts pods | Pods `Evicted`, node condition `MemoryPressure` |

Kubelet eviction is meant to act before the kernel does. The kubelet also biases the kernel OOM killer through `oom_score_adj`: Guaranteed pods get a strongly negative value (about -997, "almost never kill"), BestEffort get 1000 ("kill first"), and Burstable fall in between scaled by their request. These values are as the kubelet implements them historically; verify on a live node with `cat /proc/<pid>/oom_score_adj`.

```bash
journalctl -k | grep -i -E "out of memory|oom-kill|killed process"
# Memory cgroup out of memory: Killed process 48213 (java) total-vm:9201344kB,
#   anon-rss:2095612kB, file-rss:1204kB ... oom_memcg=/kubepods.slice/...
```

The `oom_memcg=` field tells you which cgroup hit its ceiling. If it names a pod's scope, it was a container OOM; if the message has no memcg, the whole node ran out.

### The page cache catch

Page cache is charged to the cgroup that read the file. A pod that streams a 200 GB dataset fills cache inside its own `memory.max`. Clean cache is reclaimable, so usually the kernel evicts it instead of OOM-killing, but it matters in three ways: dirty pages waiting for writeback cannot be dropped instantly, a write-heavy data mover can fill the cgroup with dirty cache faster than storage drains it, and kubelet's eviction signal (the **working set**, usage minus inactive file cache) still counts the active file cache. The symptom, familiar in data-heavy science workloads, is "my pod only has a small heap but gets OOMKilled or evicted". Check `memory.stat`:

```bash
grep -E "^(anon|file|active_file|inactive_file|shmem) " memory.stat
# anon 812000000
# file 6900000000        <- 6.9 GB of page cache charged to this pod
# active_file 5100000000
```

Fix by sizing `memory` for working set plus cache, using `O_DIRECT` or `fadvise(DONTNEED)` in the data mover, or limiting dirty ratios. Off-heap memory (JVM metaspace and direct buffers, memory-mapped files, native libraries) is counted the same way, which is why heap size alone never tells you the container size.

### Swap and PSI

Swap on nodes was off by default for years. As of 1.37, NodeSwap is GA (since 1.34): `memorySwap.swapBehavior` is `NoSwap` by default and `LimitedSwap` lets pods use swap, and the kubelet still refuses to start on a node with swap enabled unless `failSwapOn: false`. I could not verify from the pages I read exactly which QoS classes `LimitedSwap` covers, so check the swap behaviour reference before claiming it. MemoryQoS, which sets `memory.high` to throttle before the hard limit, is beta and on by default as of 1.37.

**PSI** (pressure stall information) is the modern signal: `/proc/pressure/{cpu,memory,io}` reports the share of time tasks were stalled waiting for a resource.

```bash
cat /proc/pressure/memory
# some avg10=4.20 avg60=2.10 avg300=0.80 total=84021334
# full avg10=1.10 avg60=0.40 avg300=0.10 total=21003492
```

`some` means at least one task stalled; `full` means all non-idle tasks stalled, which is real thrash. PSI beats utilisation graphs because it measures harm, not use. The kubelet exposes PSI metrics (KubeletPSI is GA as of 1.36). The catch is that PSI needs kernel 4.20+ built with `CONFIG_PSI`, and some distro kernels ship it disabled by default and need `psi=1` on the boot line. I did not verify the default for RHEL 9, so check `/proc/pressure` exists on your nodes.

---

## ★ Storage and filesystems

**What it is.** A disk can be "full" in three different ways: out of blocks, out of inodes, or full of files you deleted but a process still holds open.

**Why it matters.** Scientific data produces all three: huge files, millions of small files, and long-running writers with big log files.

```bash
df -h /var            # blocks
df -i /var            # inodes
# Filesystem      Inodes   IUsed   IFree IUse% Mounted on
# /dev/sda3     19660800 19660800       0  100% /var
```

`df -h` shows free space while `df -i` shows 100%, and writes fail with "No space left on device" anyway. The catch: you cannot grow inodes on ext4 after creation, and XFS allocates them dynamically, which is one reason XFS is common for data volumes.

When `df` says full but `du` cannot find the space, a process has a deleted file open:

```bash
du -sh /var/* | sort -h | tail -3     # accounts for 12G of a 100G volume
lsof +L1 | grep deleted
# fluentd  2210  root  7w  REG  8,3  86000000000  0  412 /var/log/app/big.log (deleted)
```

The file is unlinked (link count 0) but the process keeps the inode alive, so blocks stay allocated until it closes the file. Restart the process, or truncate through `/proc/2210/fd/7` (`: > /proc/2210/fd/7`). Deleting a huge log with `rm` while the writer runs never frees the space.

### Reading iostat

```bash
iostat -x 1 3
# Device   r/s    w/s   rkB/s   wkB/s  await  aqu-sz  %util
# nvme0n1  8200  3100   410000  190000   0.9    8.1    100.0
```

`await` is average time per request including queue, in ms: a few ms is healthy on SSD, hundreds means trouble. The catch is `%util`: it is the share of time at least one request was in flight, so a device that handles many requests in parallel (SSD, NVMe) shows 100% while having plenty of headroom. Judge by `await` and queue depth (`aqu-sz`), not `%util`.

### Mounts, NFS, and parallel filesystems

`findmnt` shows what is mounted where and with which options, `/etc/fstab` makes it persistent. For network filesystems the option that matters is **hard vs soft**. A `hard` mount retries forever when the server is unreachable, so any process touching it blocks in D state, cannot be killed, and survives even `kill -9`. A `soft` mount returns an I/O error after retries, which can silently corrupt a writer that does not check errors. Scientific data mounts are usually hard on purpose, which is why a stuck storage server produces a high-load node with idle CPUs and pods that will not terminate.

```bash
nfsstat -c            # retransmissions climbing = server or network trouble
findmnt -t nfs4
mount | grep -E "hard|soft"
```

### What the kubelet and runtime store

`/var/lib/kubelet` holds pod volumes, `emptyDir` data and logs; `/var/lib/containerd` holds image layers and writable container layers. When disk usage on either crosses the kubelet's thresholds (by default `nodefs.available<10%` and `imagefs.available<15%`, which are the long-standing defaults), the kubelet sets `DiskPressure`, garbage collects unused images, and then evicts pods. That chain is the link from a full `/var` to the scheduling taints you met in the troubleshooting section.

### LVM and XFS in brief

To grow a filesystem online: `lvextend -r -L +50G /dev/vg0/var` extends the logical volume and resizes the filesystem in one step, or `lvextend` then `xfs_growfs /var` for XFS (`resize2fs` for ext4). XFS can grow but never shrink, which is the catch to remember before provisioning.

---

## ★ Networking on the host

**What it is.** Below the CNI, a node's networking is ordinary Linux: interfaces, routes, a neighbour table, netfilter rules, and the connection-tracking table.

```bash
ip addr; ip route; ip neigh        # addresses, routes, ARP table
ss -tulpn                          # listening sockets with owning process
ss -s                              # socket summary: established, timewait counts
```

### Conntrack: the classic node-level failure

Netfilter tracks every connection in a fixed-size table so NAT and Service translation work. When it fills, new connections are dropped, and the kernel says so:

```bash
dmesg | grep conntrack
# nf_conntrack: table full, dropping packet
conntrack -S | head -2             # look for rising insert_failed and drop
sysctl net.netfilter.nf_conntrack_count net.netfilter.nf_conntrack_max
```

The symptom is intermittent connection timeouts at high fan-out, while most requests succeed and nothing is wrong with the apps. Cause: the node proxies many short-lived connections (a service calling thousands of backends, DNS over UDP, a load test). Fix by raising `nf_conntrack_max` (it costs kernel memory), shortening timeouts, or reducing connection churn with keep-alives. kube-proxy relies on conntrack for Service NAT, so this hits Kubernetes nodes disproportionately.

### kube-proxy and the rule layer

kube-proxy programs Service virtual IPs as netfilter rules. As of 1.37 its default mode is `iptables`, `nftables` is GA since 1.33 and slated to become the default in a later release, and `ipvs` is deprecated. The tradeoff for scale: iptables rules are evaluated linearly, so thousands of Services slow rule updates and lookups; nftables and ipvs scale better. Set the mode explicitly so an upgrade cannot change it for you. Cilium can replace kube-proxy entirely with eBPF. For CNI internals see the [Kubernetes guide](kubernetes-troubleshooting.html).

### Capturing traffic

A pod's traffic crosses a veth pair into the host. Find the host side and capture there:

```bash
nsenter -t 48213 -n ip link show eth0
# 7: eth0@if29: ...                    <- peer interface index is 29
ip -o link | awk -F': ' '$1==29{print $2}'     # host-side veth name
tcpdump -ni veth3a1c9f -c 50 port 5432
```

### DNS and `ndots`

Pods get a `resolv.conf` with `search` domains and `options ndots:5`. A name with fewer than five dots is tried against each search domain first, so one lookup of `api.example.org` (two dots) becomes up to four queries (`api.example.org.<ns>.svc.cluster.local`, `...svc.cluster.local`, `...cluster.local`, then the bare name), each also asked as A and AAAA. At high request rates this multiplies load on CoreDNS and is a common cause of latency and `conntrack` pressure. Fixes: use fully qualified names with a trailing dot, set `ndots:2` per pod, or run node-local DNS cache.

### MTU mismatch

Overlay networks (VXLAN, Geneve, WireGuard) add a header, so the overlay interface MTU must be smaller than the underlay's. If it is not, small requests work (health checks, SYNs) and large ones hang, because full-size packets are silently dropped or need fragmentation that is blocked. The tell is "TCP connects, TLS or large responses stall". Test with `ping -M do -s 1400 <peer>` and walk the size up.

---

## systemd, journald, and the node services

systemd supervises everything. The commands to have ready: `systemctl status kubelet`, `systemctl restart kubelet`, `systemctl enable --now containerd`, and `systemctl edit kubelet` for a drop-in override that survives package upgrades (never edit the packaged unit directly).

```bash
journalctl -u kubelet -f                      # follow
journalctl -u kubelet --since "15 min ago" -p err
journalctl -k -b                              # kernel messages this boot
```

The node service stack is a chain, and what you see depends on where it breaks:

| Down | Effect |
|---|---|
| systemd or kernel | Node gone: reboot, hardware, or hypervisor |
| containerd | Kubelet cannot create or inspect containers: pods stuck `ContainerCreating`, the node goes NotReady |
| kubelet | Node goes NotReady after a grace period; containers already running keep running |
| Static pods (control plane) | The API server, scheduler or etcd on that node is missing |

`crictl` is the "kubectl on the node": `crictl ps`, `crictl logs <id>`, `crictl pods`, `crictl images` talk to containerd directly, so they work when the API server is unreachable, which is exactly when you need them.

---

## Processes and tracing

Process states tell you where to look: **R** running or runnable, **S** sleeping (interruptible, the normal idle), **D** uninterruptible sleep (blocked in the kernel, cannot be signalled, the load-average inflator), **Z** zombie (exited, parent has not reaped). A few zombies are harmless; thousands are a PID leak.

**PID 1 in a container.** The first process in a PID namespace is expected to reap orphaned children and forward signals. Most app binaries do neither, so orphans become zombies and `SIGTERM` is ignored, which makes pods take the full `terminationGracePeriodSeconds` to die. `tini` (or `--init`) exists to be a correct PID 1. `shareProcessNamespace: true` puts all containers of a pod in one PID namespace so a debugging sidecar can see them.

**Signals and termination.** On pod deletion the kubelet sends SIGTERM, waits `terminationGracePeriodSeconds` (default 30), then SIGKILL, which cannot be caught. An app that ignores SIGTERM always costs the full grace period.

```bash
strace -f -p 48213 -e trace=network,file -tt     # what syscalls, with timestamps
lsof -p 48213 | head                             # open files and sockets
cat /proc/48213/status | grep -E "State|VmRSS|Threads"
cat /proc/48213/limits | grep -i "open files"
ls /proc/48213/fd | wc -l
```

`strace` slows the target substantially, so use it briefly on production processes; `perf top` is the lower-overhead sampler for "where is the CPU going". Limits: `ulimit -n` (open files) too low produces "too many open files" under load, and containers inherit the runtime's limit, so check the containerd unit. **PID exhaustion**: `kernel.pid_max` is node-wide, and the kubelet's `podPidsLimit` caps each pod, because one fork-bombing pod can otherwise take the node (`PIDPressure`, "fork: retry: Resource temporarily unavailable").

---

## Kernel tuning and node prep (brief)

`sysctl` settings are either **namespaced** (can differ per pod, such as `net.ipv4.ip_local_port_range`) or **node-level** (shared by everyone, such as `vm.max_map_count`). Kubernetes lets pods set only a safe namespaced subset by default, and unsafe sysctls need the kubelet's `allowedUnsafeSysctls`, because a node-level setting from one pod affects every tenant.

The kubeadm node prerequisites, with the symptom when missing:

| Setting | Why | Symptom if wrong |
|---|---|---|
| `br_netfilter` loaded, `net.bridge.bridge-nf-call-iptables=1` | Bridged traffic must hit iptables for Services | Service traffic between pods on one node fails |
| `net.ipv4.ip_forward=1` | Node must route between pod and external networks | Pods cannot reach outside the node |
| Swap off (or `failSwapOn: false`) | Kubelet refuses to start otherwise | Kubelet exits at start with a swap error |
| cgroup driver `systemd` on **both** kubelet and containerd | One cgroup manager must own the tree | Pods flap or fail to start after a containerd upgrade; two managers fight |

Hugepages (`vm.nr_hugepages`) reserve large pages that cannot be swapped or used as normal memory. They help HPC and some GPU or database workloads by cutting TLB misses, and the catch is that reserved hugepages shrink what normal pods can use, so they show up as missing memory in `free`.

---

## Security basics a sysadmin is asked about (brief)

**SSH:** key-only (`PasswordAuthentication no`), no root login, restrict users and use a bastion. **sudo:** least privilege in `/etc/sudoers.d`, edited with `visudo`.

**SELinux and AppArmor** confine processes beyond file permissions. SELinux modes are `enforcing`, `permissive` (logs only) and `disabled`. The symptom of a policy block is an access failure with correct permissions, and the proof is in the audit log: `ausearch -m avc -ts recent` or `grep "avc:  denied" /var/log/audit/audit.log`. The sysadmin mistake to avoid is turning SELinux off instead of fixing the label (`restorecon`, `semanage fcontext`).

**Permissions:** the setuid bit (`chmod u+s`) makes a binary run as its owner, which is how `sudo` works and why a world-writable setuid root file is a privilege escalation. **User namespaces** map a container's root to an unprivileged host UID, so root in the container is nobody outside; Kubernetes support (`hostUsers: false`) is GA as of 1.36.

**Patching:** kernel live-patching (kpatch, Livepatch) fixes some CVEs without a reboot, but not all, and it is not a replacement for periodic reboots. The fleet pattern is drain, patch, reboot, uncordon, one node or batch at a time, with a tool such as kured automating the lock and drain. See the node maintenance section of the [Kubernetes guide](kubernetes-troubleshooting.html).

---

## ★ Practice: "the node is unhealthy" scenarios

### Scenario 1: Load average 150, CPU idle

Symptom: monitoring pages for load, but `top` shows 80% idle and the app on the node is slow. Causes, ranked: processes stuck in D state on a hung NFS or parallel-filesystem mount; a failing disk or controller; heavy swap (rare with swap off).

```bash
ps -eo state,pid,wchan:30,cmd | awk '$1=="D"' | head
# D  2201  nfs_wait_bit_killable   python /opt/ingest.py
# D  2207  nfs_wait_bit_killable   rsync -a /scratch/...
findmnt -t nfs4,nfs
timeout 5 ls /mnt/scratch || echo "mount is hung"
```

Fix: repair the storage server or network path, not the node. The catch: `kill -9` does nothing to D-state tasks, and hard mounts retry forever, so pods using the volume sit `Terminating`. A lazy unmount (`umount -l`) detaches the mount point but does not free blocked tasks. Until the server returns, draining the node cannot finish, and rebooting is often the only way out.

### Scenario 2: Node NotReady, kubelet will not stay up

```bash
systemctl status kubelet
journalctl -u kubelet --since "10 min ago" | tail -30
# failed to run Kubelet: misconfiguration: kubelet cgroup driver: "systemd"
#   is different from container runtime cgroup driver: "cgroupfs"
```

Causes, ranked: a cgroup driver mismatch, often right after a containerd upgrade reset `SystemdCgroup`; an expired kubelet client certificate (`x509: certificate has expired` in the log, check `openssl x509 -noout -dates -in /var/lib/kubelet/pki/kubelet-client-current.pem`); swap turned on after a reboot; the runtime socket down. Fix the cause, then `systemctl restart kubelet`. The catch: a mismatch can leave pods half-created, so after fixing check for orphaned sandboxes with `crictl pods`.

### Scenario 3: Disk full, but `du` finds nothing

```bash
df -h /var && du -xsh /var       # df says 98G used, du says 14G
lsof +L1 | grep deleted          # the deleted-but-open file
df -i /var                       # the inode variant: blocks free, inodes 100%
```

A rotated or deleted log file still held open by a writer explains the gap. The inode variant shows plenty of free GB with `IUse% 100%`, caused by millions of small files such as per-frame detector outputs or cache shards. Fix: restart or truncate the holder, or remove the small-file tree and change the data layout (pack into archives, HDF5). The catch: growing the volume does not add inodes on ext4.

### Scenario 4: Pod OOMKilled while the heap looks small

```bash
kubectl describe pod <pod> | grep -A3 "Last State"
# Reason: OOMKilled  Exit Code: 137
cat <cgroup>/memory.stat | grep -E "^(anon|file|shmem) "
cat <cgroup>/memory.peak
```

The app reports a 2 GB heap, yet `memory.max` is 4 GB. `memory.stat` shows `file` at 3 GB: page cache from reading input data, plus off-heap buffers, thread stacks and `/dev/shm` counted in the same cgroup. Fix: size the limit for working set, not heap, reduce cache pressure in the data mover, and cap off-heap. The catch is that the total looks reasonable on any single metric; only the cgroup's own accounting adds them up.

### Scenario 5: Intermittent timeouts at high fan-out

```bash
dmesg | grep -i conntrack         # table full, dropping packet
conntrack -S | grep -E "insert_failed|drop"
kubectl exec <pod> -- cat /etc/resolv.conf     # ndots:5
```

Ranked causes: conntrack table full on the node; a DNS storm from `ndots:5` amplification overloading CoreDNS (look for CoreDNS CPU and timeouts); ephemeral port exhaustion from many outbound connections to one destination. Fix the layer you found: raise `nf_conntrack_max`, use FQDNs or node-local DNS cache, reuse connections. The catch: failures are partial, so the service looks healthy in a quick check.

### Scenario 6: Latency spikes with low CPU usage

```bash
cat <cgroup>/cpu.stat            # nr_throttled / nr_periods
cat <cgroup>/cpu.max             # e.g. 50000 100000  (500m)
```

A high ratio of `nr_throttled` to `nr_periods` confirms CFS throttling. Fix: raise or remove the CPU limit, reduce thread count to match the quota, or move the workload to the static CPU manager. The catch: lowering CPU usage in the app does not help if the quota is exhausted by burst, so measure throttled time and not average CPU.

### Scenario 7: A process you cannot kill (D state), and the drain

```bash
ps -o pid,state,wchan:32,cmd -p 2201
#  2201 D nfs_wait_bit_killable  python /opt/ingest.py
kubectl drain node-9 --ignore-daemonsets --timeout=5m    # times out: pod Terminating
```

A D-state process is waiting for the kernel; signals are queued until the call returns. Drain evicts the pod, the kubelet sends SIGTERM then SIGKILL, and the container cannot exit, so the pod stays `Terminating` and drain blocks. What it means for the node: do not wait forever. Fix the storage path, or accept that the node needs a reboot, and for a Slurm-style hard mount that is the honest answer. The catch: force-deleting the pod object (`--force --grace-period=0`) removes it from the API but the process is still there holding the volume, so a new pod on another node can write the same data. For a ReadWriteOnce volume, confirm the old process is gone before force-deleting.

---

## Question bank: host-level Linux

| Question | What they are testing | Concise answer |
|---|---|---|
| What is a container? | Core model | A process (tree) isolated by namespaces, limited by cgroups, and confined by a root filesystem, capabilities and seccomp. No kernel "container" object. |
| What is a cgroup? | Resource control | A kernel hierarchy that groups processes and enforces limits and accounting for CPU, memory, I/O and PIDs. v2 is a single unified tree. |
| What is a namespace? | Isolation | A kernel view partition: PID, network, mount, UTS, IPC, user, cgroup. A process sees only its namespace's instance. |
| What does load average measure? | Subtlety | Runnable plus uninterruptible (D state) tasks averaged over 1, 5 and 15 minutes. Not CPU utilisation. |
| Load is 200 and CPU is idle. Why? | Diagnosis | Many tasks in D state, usually blocked on a hung network filesystem or failing disk. Find them with `ps` state D and `wchan`. |
| What does `free -m` "available" mean? | Memory reading | Estimate of memory usable without swapping, counting reclaimable cache. The number that matters, not `free`. |
| What is the page cache? | Memory model | File data cached in RAM, reclaimable, and charged to the cgroup that read it. |
| What does OOMKilled mean? | K8s and kernel | The kernel OOM killer SIGKILLed the process because its cgroup exceeded `memory.max`. Exit 137. |
| Container OOM vs kubelet eviction? | Mechanism | OOM is the kernel killing inside a cgroup at its limit. Eviction is the kubelet gracefully removing pods when node `memory.available` falls below a threshold. |
| What is `oom_score_adj`? | OOM ranking | A per-process bias to the OOM killer. The kubelet sets it by QoS: very negative for Guaranteed, 1000 for BestEffort. |
| What is CPU throttling? | Hidden latency | CFS quota: once a cgroup uses `cpu.max` in a period, its threads stop until the next. Check `nr_throttled` in `cpu.stat`. |
| Requests vs limits in kernel terms? | Mapping | Request becomes `cpu.weight` (share under contention) and scheduling accounting; limit becomes `cpu.max` or `memory.max` (hard ceiling). |
| Hard link vs symbolic link? | Fundamentals | A hard link is another directory entry for the same inode (same filesystem, survives deleting the original name). A symlink is a file holding a path, can cross filesystems and dangle. |
| What is an inode? | Filesystems | A record holding a file's metadata and block pointers; the directory entry maps a name to it. Running out of inodes fails writes with free blocks. |
| `df` says full, `du` disagrees. Why? | Diagnosis | A deleted file still open by a process keeps its blocks. Find it with `lsof +L1`. |
| What does `%util` in iostat mean on NVMe? | Tool literacy | Time with at least one request in flight. It saturates at 100% with parallel devices, so use `await` and queue depth. |
| Hard vs soft NFS mount? | Failure behaviour | Hard retries forever (processes block in D state); soft errors after retries (risks silent corruption). |
| What happens when you type `ls` and press Enter? | Fundamentals | The shell parses, resolves `ls` via `PATH`, `fork`s, the child `execve`s the binary, the loader maps libraries, it calls `getdents`, writes to stdout, exits, and the parent `wait`s. |
| What are process states? | Basics | R running, S sleeping, D uninterruptible, Z zombie, T stopped. |
| What is a zombie and why does PID 1 matter? | Containers | An exited process whose parent has not reaped it. PID 1 must reap orphans and forward signals, which is why `tini` exists. |
| How does DNS resolve inside a pod? | K8s networking | `resolv.conf` points at CoreDNS; `search` domains and `ndots:5` expand short names into several queries before the bare name. |
| What is conntrack and when does it fail? | Netfilter | A kernel table tracking connections for NAT. When full, new connections drop with "table full". |
| How does kube-proxy implement a Service? | K8s plumbing | It programs netfilter rules (iptables by default as of 1.37, or nftables or ipvs) that DNAT the Service IP to a backend pod IP. |
| Why do large requests hang while small ones work? | Networking | MTU mismatch on an overlay: full-size packets are dropped. Test with `ping -M do -s`. |
| What is the cgroup driver and why must it match? | Node prep | The cgroup manager (systemd or cgroupfs). Kubelet and runtime must use the same one or two managers fight over the tree. |
| What is PSI? | Modern signals | `/proc/pressure/*`: the fraction of time tasks stalled on CPU, memory or I/O. Measures harm, not utilisation. |
| How do you find what is filling `/var`? | Operations | `df -h` and `df -i`, then `du -xsh /var/*` sorted by size, then `lsof +L1` for deleted-open files; on a node also check `/var/lib/containerd` and `/var/log`. |
| How do you patch 200 nodes without downtime? | Operations | Canary first, then batches: cordon, drain (respecting PDBs), patch, reboot, uncordon, verify, with kured or similar to serialise. Live-patch only for kernel CVEs it covers. |
| A pod is stuck Terminating. What now? | Diagnosis | Find the process on the node. If it is in D state on a hung mount, fix the storage path; force-deleting the object leaves the process running. |
| Where do you look when the API server is down? | Node-level | `journalctl -u kubelet`, `crictl ps` and `crictl logs` for the static pods under `/etc/kubernetes/manifests`. |

---

## How to say it in the room

Narrate the loop out loud: the symptom, the hypothesis, the command that tests it, the reading, the next move. "Load is high but CPU is idle, so I want to know what is in D state" says more than any recited command list, and it lets the interviewer steer you toward the edge of what you know, which is where he is going anyway.

When a question goes past your production experience, say so plainly and then reason. "I have not tuned NUMA topology for a GPU node in production. I would start from `numactl --hardware` to see the layout, check whether the device and the job's CPUs sit on the same node, and use the static CPU manager for exclusive cores." That is a stronger answer than bluffing, because the follow-up always finds the edge.

Three bridges from your own experience to personalise, not recite:

- **MicroK8s at RCSB.** You ran nodes where a snap managed the binaries and dqlite held the state. That is a real answer to "what does a node consist of": the same kubelet, runtime and CNI, packaged differently. Bridge it to what you would look at on a kubeadm node (the systemd units and static pods).
- **Data acquisition hosts at Hereon.** Hosts held to 99.9% uptime make a credible case for how you think about maintenance windows, hardware failure, and not rebooting a machine mid-measurement. That is the cordon-and-wait mindset for long batch jobs.
- **DESY scientific infrastructure.** Large parallel filesystems, big files and high I/O are the same patterns as the storage section: hard mounts, D-state hangs, inode pressure from small files. Use a real incident if you have one.

Be straight about where the host-level work was done by tooling rather than by you, and say what you know about how the tool did it. The interview is a conversation, and a calibrated answer reads as seniority.
