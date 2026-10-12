## Two halves: diagnose it, operate it

This guide has two parts because a Kubernetes interview has two moods. **Part 1 (diagnose it live)** is the symptom-first round: someone hands you a broken cluster and watches your loop. **Part 2 (operate it)** is the conversational round: "how do you upgrade a node", "what is a toleration", "how do you pin a workload to GPU nodes", with follow-ups until you reach your limits. Part 1 runs from the diagnostic funnel through Scenario 8. Part 2 starts after Scenario 8 and covers how a kubeadm cluster is assembled, upgraded, drained, scheduled onto, backed up, and secured.

If your hands-on experience is MicroK8s or a managed service, Part 2 is where the gap closes. Read the kubeadm mental model first, then upgrades, then scheduling. Facts tied to a version are marked "as of 1.37" (1.37.1 is the current stable release as of this writing).

---

## When you're in the seat, you get a symptom

The interview drops you into a running cluster and says: "Pods are not starting. Figure out what's wrong." Not "explain liveness probes." Not "describe the scheduler." A symptom. The win is a diagnostic loop you can narrate out loud as you work.

One loop covers almost every failure: `kubectl get` to see the state, `kubectl describe` (read Events first) to find the cause, `kubectl logs` to see what the app said, and then fix. Knowing that loop cold, and being able to say what each command reveals and why you ran it next, is the answer to most Kubernetes live-coding rounds.

---

## The diagnostic funnel

Every incident starts here. The four moves below cover 90% of the failures you will encounter.

```bash
# 1. See what state things are actually in
kubectl get pods -n <namespace> -o wide

# 2. Read Events: they almost always name the cause directly
kubectl describe pod <pod-name> -n <namespace>

# 3. See what the app said before it died
kubectl logs <pod-name> -n <namespace> --previous

# 4. Jump inside if the above is not enough
kubectl exec -it <pod-name> -n <namespace> -- sh
```

The catch: `describe` prints a lot. Skip straight to the `Events:` block at the bottom. That block is the error message. The top sections (`Status`, `Containers`) name what state you are in; Events name why you got there.

---

## Toolkit at a glance

| Command | What it answers |
|---|---|
| `kubectl get pods -o wide` | Pod phase, node placement, restart count |
| `kubectl describe pod` | Events, probe config, image, requested resources |
| `kubectl logs --previous` | Last container's stdout before it crashed |
| `kubectl get events --sort-by='.lastTimestamp' -n <ns>` | Cluster-wide timeline in order |
| `kubectl debug -it pod/<name> --image=busybox` | Shell in the cluster network, bypasses your app image |
| `kubectl port-forward pod/<name> 8080:8080` | Hit the pod directly, cuts out the Service |
| `kubectl get endpoints <svc-name>` | Instantly shows whether a Service has backing pods |

---

## Scenario 1: Pod stuck in Pending

The pod exists but has never run. Kubernetes accepted the object; the scheduler has not placed it on any node.

Causes, ranked by frequency:

1. Node resources exhausted: `requests.cpu` or `requests.memory` exceeds what any schedulable node can offer.
2. Taint/toleration mismatch: the node has a taint the pod does not tolerate.
3. Node selector or affinity rule not matched: a `nodeSelector` or `nodeAffinity` has no matching node.
4. PersistentVolumeClaim not bound: a `volumes` entry references a PVC that is still `Pending`.

```bash
# Events usually say it directly
kubectl describe pod <name> -n <ns>
# Events: 0/3 nodes are available: 3 Insufficient memory.
# or:     0/3 nodes available: 3 node(s) had untolerated taint {node-role.kubernetes.io/control-plane: }

# Confirm what each node actually has left
kubectl describe nodes | grep -A4 "Allocated resources"
```

Fix: reduce the request to what the app actually needs (or add nodes). The catch: CPU requests reserve capacity even when the app is idle. A `requests.cpu: 2000m` on a node with 2 cores leaves zero room and nothing will schedule there. `requests` express the guaranteed floor; set them from measured usage, not from limits.

For the full set of placement controls (taints, affinity, spread constraints, priority), see "Scheduling controls: putting pods on the right nodes" in Part 2.

---

## Scenario 2: ImagePullBackOff / ErrImagePull

The scheduler placed the pod but the kubelet cannot pull the image. The pod shows `ErrImagePull` on the first failure, then `ImagePullBackOff` as the kubelet retries with backoff.

Causes ranked:

1. Tag does not exist: a typo, a `:latest` override, or the image was never pushed with that tag.
2. Private registry with no pull secret, or the secret exists but is not referenced in the pod's `imagePullSecrets`.
3. Docker Hub rate limit: anonymous pulls are capped at roughly 100 per 6 hours per IP. On shared nodes this triggers unexpectedly.

```bash
kubectl describe pod <name>
# Events:
#   Failed to pull image "myrepo/app:v1.2": rpc error: ...
#   unauthorized: authentication required
#   or: manifest for myrepo/app:v1.2 not found

# Verify the pull secret exists and is the correct type
kubectl get secret my-registry-secret -o yaml
# type: kubernetes.io/dockerconfigjson   <- correct type
```

```yaml
spec:
  imagePullSecrets:
    - name: my-registry-secret
  containers:
    - name: app
      image: registry.example.com/myrepo/app:v1.2
```

The catch: the secret must live in the same namespace as the pod. A secret in `default` does not help a pod in `production`. In clusters using a service-account-bound pull secret, patch the service account rather than each Deployment individually.

---

## Scenario 3: CrashLoopBackOff

The container starts and exits. Kubernetes restarts it with exponential backoff: 10 s, 20 s, 40 s, up to 5 minutes. The symptom looks alarming; the root cause ranges from a one-line config fix to a fundamental app bug.

Causes ranked:

1. App crash on startup: missing env var, bad connection string, missing config file.
2. OOMKilled: exit code 137, kernel kills the process the moment it exceeds its memory limit.
3. Mis-tuned liveness probe killing a healthy-but-slow-starting app.
4. Wrong command or entrypoint in the image.

```bash
# Read the last crash's stdout
kubectl logs <pod> --previous

# Check exit code and restart count
kubectl describe pod <pod>
# Last State:  Terminated
#   Reason:    OOMKilled  Exit Code: 137
# or:
#   Reason:    Error      Exit Code: 1
```

The classic cascade that catches people off guard: a liveness probe with `initialDelaySeconds: 5` on an app that takes 30 seconds to load a model or build a cache will kill the container the moment the probe fails. Kubernetes restarts it; the probe fails again immediately; the pod enters CrashLoopBackOff with exit code 0 or 137 and no helpful app log. The fix is to set `initialDelaySeconds` long enough for the app to be genuinely healthy, and to use a separate readiness probe to gate traffic in the meantime.

```yaml
livenessProbe:
  httpGet:
    path: /healthz
    port: 8080
  initialDelaySeconds: 60    # longer than your worst-case cold-start
  periodSeconds: 10
  failureThreshold: 3
readinessProbe:
  httpGet:
    path: /ready
    port: 8080
  initialDelaySeconds: 10
  periodSeconds: 5
  failureThreshold: 3
```

Readiness controls traffic; liveness controls restarts. They are different knobs and should not be the same probe with the same thresholds.

---

## Scenario 4: Rollout stuck, Deployment never fully available

You apply a Deployment update. The rollout starts but never finishes. Old pods keep serving; new pods never become fully available.

```bash
kubectl rollout status deployment/<name>
# Waiting for deployment "<name>" rollout to finish:
#   1 out of 3 new replicas have been updated...

# See counts and strategy
kubectl describe deployment <name>
# Replicas: 3 desired | 1 updated | 3 total | 2 available | 1 unavailable
# StrategyType: RollingUpdate
# RollingUpdateStrategy: 25% max unavailable, 25% max surge
```

Causes:

1. New pods fail their readiness probe. They never enter `Running/Ready`, so the rollout controller refuses to proceed to the next batch.
2. `maxUnavailable: 0` with new pods also not ready means the controller cannot take any old pod down, and cannot bring any new pod up past 0 ready.
3. Not enough cluster capacity for the surge (loops back to Pending).

Diagnose the new pods directly. They will be in `Running` with `0/1` ready containers. Describe them and read Events and the probe section. The catch: a rollout is blocked in both directions by design. If you pushed a bad probe config, you need to push another update to fix it. The controller will not self-heal a deployment that is stuck due to its own spec.

---

## Scenario 5: I can't reach my Service

The pods are running but network calls to the Service fail. This is a layered problem: check selector, then Endpoints, then DNS, then NetworkPolicy.

```bash
# Step 1: does the Service have any endpoints at all?
kubectl get endpoints <svc-name> -n <ns>
# Endpoints: <none>   <- selector does not match any running pods

# Step 2: compare the Service selector with actual pod labels
kubectl get svc <svc-name> -o jsonpath='{.spec.selector}'
# {"app":"myapp"}
kubectl get pods -l app=myapp -n <ns> --show-labels
# No resources found  <- the label is different on the pods

# Step 3: test DNS from inside the cluster
kubectl run tmp --image=busybox --restart=Never -it --rm -- \
  nslookup myapp.production.svc.cluster.local

# Step 4: bypass the Service entirely to isolate networking vs routing
kubectl port-forward svc/<svc-name> 8080:80 -n <ns>
curl localhost:8080
```

A selector mismatch is the most common cause. The Service was written with `app: myapp` but the pod has `app.kubernetes.io/name: myapp`, or there is a namespace typo, or a deployment was renamed. If `kubectl get endpoints` returns `<none>`, the fix is the selector, not the network stack.

NetworkPolicy default-deny is the second most common: a `NetworkPolicy` with no ingress rules blocks all incoming traffic to pods in that namespace silently. Check with `kubectl get networkpolicy -n <ns>` and read the `Ingress` rules.

The catch: `targetPort` must match the port the container actually listens on, not the Service's own port. A Service with `port: 80, targetPort: 8080` works only if the container listens on 8080. Getting these reversed produces requests that arrive at the pod's IP but get refused at the socket layer, with no event and no clear error message.

---

## Scenario 6: OOMKilled vs CPU throttling

Two distinct resource failure modes, one loud and one silent.

**OOMKilled (memory limit exceeded):** the Linux kernel kills the process when it exceeds `limits.memory`. Exit code 137. Visible immediately in `kubectl describe pod` under `Last State: Terminated Reason: OOMKilled`. The pod restarts; if it OOMKills again quickly you get CrashLoopBackOff. Fix: raise the limit, or fix the memory leak. Check `kubectl top pod` to see live usage.

**CPU throttling (not a kill):** the container is not killed. It runs slowly. The Linux CFS scheduler caps CPU usage at the `limits.cpu` ceiling, measured in 100 ms windows. A container limited to `500m` that wants `2000m` CPU is throttled to 25% speed. There is no log entry, no event, no exit code. The only symptom is latency rising or throughput falling.

```bash
# Live usage
kubectl top pod <name> -n <ns>

# What is configured
kubectl describe pod <name> | grep -A6 Limits
```

The catch: setting no CPU limit avoids throttling but allows a runaway process to starve neighbours. The right approach is a limit, set from measured 99th-percentile usage, not a guess. `kubectl top` shows current; use your metrics store (Prometheus, Datadog) for the histogram. As a side note, the QoS class follows from how you set requests and limits: `Guaranteed` (requests equal limits on all containers) has the lowest eviction priority under memory pressure; `BestEffort` (no requests or limits) is evicted first.

Part 2 refines this: node-pressure eviction ranks by usage over requests and priority, not by QoS label alone. See "Requests, limits, and QoS" under Scheduling controls.

---

## Scenario 7: Node NotReady and evictions

Pods start disappearing from a node, or new pods will not schedule onto it.

```bash
kubectl get nodes
# NAME      STATUS     ROLES   AGE   VERSION
# node-3    NotReady   <none>  3d    v1.36.1

kubectl describe node node-3
# Conditions:
#   MemoryPressure  False
#   DiskPressure    True   <- kubelet is running out of disk
#   PIDPressure     False
#   Ready           False

# Is it just manually cordoned?
kubectl get node node-3 -o jsonpath='{.spec.unschedulable}'
# true  <- someone ran kubectl cordon
```

`DiskPressure` is the most common in production, especially on nodes running many short-lived jobs that fill `/var/log` or the container image overlay. When the kubelet detects pressure it automatically adds a `node.kubernetes.io/disk-pressure:NoSchedule` taint. Pods with no matching toleration are not scheduled there; existing pods without `NoExecute` tolerance are eventually evicted starting with `BestEffort` and `Burstable` QoS.

Free disk by pruning unused images (`crictl rmi --prune`), adjusting log rotation, or increasing volume size. The catch: once the taint goes on, the eviction sequence is determined by QoS class and pod priority, not by which pods are "least important" in your head. If you need a critical pod to survive node pressure, give it a `PriorityClass` with a high integer value and explicit tolerations for the pressure taints.

A node that is cordoned on purpose is a maintenance topic, not an incident: see "Node maintenance: cordon, drain, and PodDisruptionBudgets" and the taint and toleration material in Part 2.

---

## Scenario 8: Forbidden and won't-start-by-policy

Two causes that share a similar surface symptom but require different fixes.

**RBAC denial:** a service account or user is missing the right Role or ClusterRole binding. The response body and the audit log are explicit.

```bash
# Test whether a service account can do a specific thing
kubectl auth can-i get secrets -n production \
  --as=system:serviceaccount:production:my-sa
# no

# See what bindings the SA has
kubectl get rolebindings,clusterrolebindings -n production -o wide | grep my-sa
```

Fix: create a Role covering the exact verbs and resources needed, and bind it. The catch: granting `cluster-admin` "just to unblock" creates a blast radius where one compromised credential is full cluster write. Use audit logs to identify exactly which API calls the service makes, and grant only those.

**Pod Security Admission (PSA):** PodSecurityPolicy was removed in Kubernetes 1.25. The replacement is PSA, which enforces one of three built-in profiles at the namespace level via labels: `privileged`, `baseline`, or `restricted`. A pod running as root or requesting `hostNetwork: true` in a `restricted` namespace is rejected at admission time with a clear message.

```bash
# See which profile the namespace enforces
kubectl get ns production -o jsonpath='{.metadata.labels}'
# {"pod-security.kubernetes.io/enforce":"restricted"}

# The rejection you will see
# Error from server (Forbidden): pods "my-pod" is forbidden:
# violates PodSecurity "restricted:latest":
# allowPrivilegeEscalation != false, runAsNonRoot != true
```

Fix: either relax the namespace profile label (a business and security decision) or make the pod comply. The `warn` and `audit` modes let you detect violations without blocking, which is the right way to tighten an existing namespace without surprises.

```yaml
# Gradual tightening: warn and audit first, then switch enforce once clean
metadata:
  labels:
    pod-security.kubernetes.io/warn: restricted
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/enforce: baseline
```

How RBAC, OIDC login, PSA, and multi-tenant isolation fit together at cluster scale is covered in "Access, tenancy, and policy" in Part 2.

---

## Part 2: operating the cluster

Part 1 assumed the cluster exists and something in it is broken. Part 2 assumes you own the cluster: you built it, you upgrade it, you decide where pods land, and you are the one holding the etcd backup when it goes wrong. Questions in this half are conversational and escalate. Start with the plain answer, then be ready for "and what happens if...".

The sections marked ★ are the load-bearing ones. If time is short, read those and the question bank at the end.

---

## ★ How kubeadm assembles a cluster

**What it is.** kubeadm is a bootstrapper, not a lifecycle manager. It generates certificates and kubeconfigs, writes static pod manifests for the control plane, starts etcd, and hands you a join command. It does not install the kubelet, a container runtime, or a CNI plugin, and it does not manage anything after the cluster is up except by being run again for upgrades and cert renewal. Everything else is your job or your automation's job.

**Why it matters.** Once you know where kubeadm puts things, every control-plane question becomes a file-system question. You can debug a dead apiserver with `crictl` and `journalctl` even when `kubectl` does not work.

```text
/etc/kubernetes/manifests/     static pod manifests: kube-apiserver, kube-controller-manager,
                               kube-scheduler, etcd (the kubelet watches this directory)
/etc/kubernetes/pki/           CA and leaf certs; etcd/ subdirectory holds the etcd CA and certs
/etc/kubernetes/admin.conf     cluster-admin kubeconfig (a client cert for group system:masters)
/etc/kubernetes/kubelet.conf   the kubelet's credentials to the apiserver
/etc/kubernetes/controller-manager.conf, scheduler.conf    their client credentials
/var/lib/kubelet/config.yaml   kubelet configuration (cgroupDriver, rotateCertificates, ...)
/var/lib/etcd/                 etcd data directory (stacked topology)
kube-system/kubeadm-config     ConfigMap holding the ClusterConfiguration used for upgrades
```

The kubelet is a systemd service, and it is the only control-plane-adjacent process that is not a pod. It watches `/etc/kubernetes/manifests` and runs whatever it finds there as **static pods**: containers the kubelet owns directly, with a read-only "mirror pod" published to the API so you can see them. That is how the control plane boots without a control plane. Edit a manifest and the kubelet restarts that component within seconds.

The request path, end to end: `kubectl` talks to the kube-apiserver, which authenticates, authorizes, runs admission, and persists to etcd. The scheduler and the controllers hold watches on the apiserver and write back (a Pod gets its `nodeName`, a ReplicaSet creates Pods). The kubelet on each node watches for Pods bound to it and reconciles through the CRI to the container runtime. Only the apiserver talks to etcd. That one fact drives the failure table below.

| Component down | What stops | What keeps running |
|---|---|---|
| etcd (quorum lost) | All reads and writes through the API | Running pods and their traffic (kubelets keep what they have) |
| kube-apiserver | `kubectl`, all controllers, scheduling, kubelet status updates | Running pods; Services still route via existing kube-proxy rules |
| kube-scheduler | New pods stay `Pending` forever | Everything already scheduled |
| kube-controller-manager | No self-healing: dead pods are not replaced, Deployments do not roll, nodes are not marked NotReady-evicted | Existing pods |
| kubelet (one node) | That node goes `NotReady`; its pods are evicted after the toleration window | Containers on it keep running until evicted |
| CNI plugin | New pods stay `ContainerCreating`; pod networking breaks for new sandboxes | Existing pod networking (mostly) |
| CoreDNS | Service-name lookups fail | IP-to-IP traffic |

The catch: "apiserver is down" does not mean "the application is down". Running workloads survive a dead control plane. What you lose is the ability to change or heal anything. In an interview, say that out loud: it separates people who have run clusters from people who have read about them.

### MicroK8s vs kubeadm, mapped

You ran MicroK8s in production, so translate your experience precisely instead of claiming kubeadm fleet time you do not have.

| Concern | MicroK8s | kubeadm |
|---|---|---|
| Packaging | One snap bundling every binary | Distro packages (`kubeadm`, `kubelet`, `kubectl`) plus a runtime you install |
| Control plane | Daemons under snap-managed systemd units | Static pods from `/etc/kubernetes/manifests` |
| Datastore | dqlite (Raft on SQLite) by default in HA | etcd, stacked or external |
| Upgrade | `snap refresh --channel=1.N/stable` per node, snap handles the binaries | Explicit sequence: `kubeadm upgrade`, drain, kubelet, uncordon |
| Networking, DNS, storage | `microk8s enable dns`, Calico by default | You install CNI, CoreDNS is bundled, CSI is yours |
| Certs | Managed by the snap, refreshed on refresh | One-year leaf certs you must renew or upgrade through |
| Node identity | `microk8s add-node` token | `kubeadm join` with bootstrap token and CA hash |

The honest framing for the room: "MicroK8s hides the upgrade sequence inside the snap. I know what it is doing because the sequence is the same; kubeadm just makes me run each step." That is true and it lands well.

---

## Bootstrapping and joining (brief)

`kubeadm init --config kubeadm.yaml` is the repeatable form. The config file pins the Kubernetes version, the pod and service CIDRs, and, for HA, `controlPlaneEndpoint` pointing at a load balancer or VIP in front of all apiservers. Without `controlPlaneEndpoint` from day one you cannot add a second control-plane node cleanly, because every kubeconfig and certificate SAN bakes in the first node's address.

```yaml
apiVersion: kubeadm.k8s.io/v1beta4
kind: ClusterConfiguration
kubernetesVersion: v1.37.1
controlPlaneEndpoint: "k8s-api.example.org:6443"   # LB or VIP, decided before init
networking:
  podSubnet: 10.244.0.0/16        # must match what the CNI expects
  serviceSubnet: 10.96.0.0/12
```

Etcd topology is the other early choice. **Stacked** puts an etcd member on each control-plane node: fewer machines, but losing a node loses an apiserver and an etcd member together. **External** etcd runs on its own hosts: more machines and more certs to manage, but failure domains are separate. Most clusters run stacked with three control-plane nodes and good backups.

Joining uses a bootstrap token plus the CA public key hash. Tokens expire after 24 hours by default, so the usual surprise is a join command that worked yesterday and fails today. Generate a fresh one with `kubeadm token create --print-join-command`. Control-plane nodes also need `--control-plane` and a certificate key (`kubeadm init phase upload-certs --upload-certs`), which itself expires after two hours.

kubeadm does not install a CNI. Until you apply one, nodes sit `NotReady` and CoreDNS stays `Pending`. That is expected, not a failure.

Node prerequisites, one line each: swap off (the kubelet refuses to start by default), `br_netfilter` loaded and `net.bridge.bridge-nf-call-iptables=1`, `net.ipv4.ip_forward=1`, and the container runtime and kubelet agreeing on the **systemd** cgroup driver. A cgroup driver mismatch is the classic "kubelet starts then pods flap" cause.

The host-level view of these prerequisites (what each one looks like when it is wrong, and the commands to prove it) is in the companion guide [Linux Under the Pods](linux-sysadmin-prep.html).

---

## ★ Upgrading the cluster

**What it is.** A kubeadm upgrade moves the control plane one minor version, then the nodes, by running a fixed sequence on each machine. Nothing is automatic. You are the orchestrator.

**Why it matters.** "How do you upgrade a node" is the most likely first question in a kubeadm shop. The answer is a sequence with reasons, not a list of commands.

The procedure, in order:

1. **Prepare.** Read the release notes and the deprecation guide for the target minor. Scan manifests and Helm releases for removed APIs (tools such as `kubent` or `pluto` do this). Take an etcd snapshot. Confirm the add-ons (CNI, CSI, ingress) support the target version.
2. **One minor at a time.** Skipping minors is unsupported. 1.35 to 1.37 means 1.35 to 1.36 to 1.37, finishing each hop fully.
3. **First control-plane node.** Switch the package repository to the target minor (`pkgs.k8s.io` has one repo per minor), upgrade the `kubeadm` package, then plan and apply.
4. **Other control-plane nodes.** Same package step, then `kubeadm upgrade node` instead of `apply`.
5. **Per control-plane node:** drain, upgrade `kubelet` and `kubectl`, restart the kubelet, uncordon.
6. **Workers, one at a time or in batches:** drain, `kubeadm upgrade node`, upgrade the kubelet, restart, uncordon.
7. **Add-ons last,** each against its own compatibility matrix.

```bash
# On the first control-plane node (Debian/Ubuntu shown)
# 0. Point /etc/apt/sources.list.d/kubernetes.list at .../core:/stable:/v1.37/deb/
sudo apt-mark unhold kubeadm && sudo apt-get update \
  && sudo apt-get install -y kubeadm='1.37.1-*' && sudo apt-mark hold kubeadm

sudo kubeadm upgrade plan                # what is available, and what each component becomes
sudo kubeadm upgrade apply v1.37.1       # rewrites static pod manifests, renews certs

# Then the kubelet on that same node
kubectl drain cp-1 --ignore-daemonsets
sudo apt-mark unhold kubelet kubectl && sudo apt-get install -y \
  kubelet='1.37.1-*' kubectl='1.37.1-*' && sudo apt-mark hold kubelet kubectl
sudo systemctl daemon-reload && sudo systemctl restart kubelet
kubectl uncordon cp-1
```

Why each step exists. `kubeadm upgrade apply` does not touch the kubelet: it rewrites the static pod manifests (so the kubelet restarts the apiserver, controller-manager, scheduler, and possibly etcd at the new version), updates the `kubeadm-config` ConfigMap, applies CoreDNS and kube-proxy changes, and renews the control-plane certificates (opt out with `--certificate-renewal=false`). `kubeadm upgrade node` does the node-local half only. The drain before the kubelet upgrade is required because an in-place minor kubelet upgrade is not supported: the container spec hash changes, so containers restart regardless, and you want that to happen on an empty node.

After running the sequence, verify with `kubectl get nodes` (every node shows the new version and `Ready`) and `kubectl get pods -n kube-system`. The workers' kubelet version is what the VERSION column shows, so a node still on the old version means the kubelet step was skipped.

### Version skew: the rules that order the upgrade

As of 1.37, verified against the version skew policy:

| Component | Allowed relative to kube-apiserver |
|---|---|
| kube-apiserver (HA) | Newest and oldest instance within 1 minor |
| kubelet | Not newer; up to 3 minors older |
| kube-proxy | Not newer; up to 3 minors older |
| controller-manager, scheduler, cloud-controller-manager | Not newer; up to 1 minor older |
| kubectl | 1 minor older or newer |

This is why the control plane goes first: nodes may lag, never lead. It is also why the three-minor kubelet allowance matters in practice: you can upgrade the control plane through two minors in a window and roll the workers later, as long as no kubelet falls more than three behind. A kubelet persistently three minors behind must be upgraded before the control plane moves again.

### The catches

- **PDBs block drains.** A drain uses the Eviction API, which refuses to violate a PodDisruptionBudget. The drain does not fail; it retries and hangs. See the next section.
- **Unmanaged pods are deleted for good.** A bare pod (no ReplicaSet, StatefulSet, Job, DaemonSet) has nothing to recreate it. Drain refuses without `--force`, and with `--force` the pod is gone.
- **`emptyDir` data is lost.** Drain refuses without `--delete-emptydir-data`, because the volume lives and dies with the pod on that node.
- **DaemonSet pods are ignored.** The DaemonSet controller would recreate them immediately, so drain skips them with `--ignore-daemonsets`. They keep running on a cordoned node, which is usually what you want for node agents and not what you want for a GPU job.
- **Long-running batch and MPI jobs cannot be evicted mid-run.** Draining a node under a 40-hour simulation kills it, and the job restarts from zero unless it checkpoints. The operational answer is a drain window: cordon the node now, let running jobs finish, drain when it is empty. This is the same pattern as a Slurm maintenance reservation: stop new work landing, wait for the queue to drain, then do the work. For scientific workloads, say so, because it shows you have thought about the actual users.
- **Rollback is a restore, not a downgrade.** kubeadm does not support downgrading. Once `upgrade apply` has run, going back means restoring the etcd snapshot and the old manifests. That is why the snapshot comes first and why you upgrade a staging cluster before production.

### Rolling vs blue/green, and in-place vs replace

**Rolling** upgrades nodes in place in batches. It is cheap and it is the default. The risk is that a bad kubelet or runtime interaction hits the whole fleet one batch at a time, and you find out at batch one. **Blue/green node pools** bring up a new pool at the target version, cordon and drain the old pool, and delete it. It costs double capacity during the window, but you can stop at any point and the old pool is still there. For GPU nodes, double capacity is often not available, which is why rolling with a canary node is more common there.

**In-place** upgrade keeps the machine and mutates it. **Replace-the-node** (immutable nodes) builds a fresh machine from an image at the new version and joins it, which removes configuration drift but needs image tooling and automation. Control-plane nodes are often upgraded in place with kubeadm and workers replaced; both are defensible. Pick one and say why.

---

## ★ Node maintenance: cordon, drain, and PodDisruptionBudgets

**What it is.** `cordon` marks a node unschedulable (it adds the `node.kubernetes.io/unschedulable:NoSchedule` taint) and touches nothing already running. `drain` is cordon plus an eviction request for every evictable pod on the node. `uncordon` reverses the cordon.

**Why it matters.** Every upgrade, kernel patch, and hardware swap goes through this. The difference between a clean maintenance window and an outage is usually a PodDisruptionBudget.

Drain does not delete pods directly. It calls the **Eviction API**, which checks each pod against its PDB and either evicts it or returns 429 "cannot evict". The controller then recreates the pod on another node. That is the entire mechanism: cordon first so replacements do not land back on the same node, then evict.

```bash
kubectl drain node-7 --ignore-daemonsets --delete-emptydir-data --timeout=10m
```

The flags, as of 1.37:

| Flag | What it does | The catch |
|---|---|---|
| `--ignore-daemonsets` | Skip DaemonSet pods | Required in practice; without it drain refuses on any node with a CNI or log agent |
| `--delete-emptydir-data` | Allow evicting pods with `emptyDir` | Data is gone |
| `--force` | Also delete pods with no controller | Those pods never come back |
| `--grace-period` | Override each pod's termination grace | Cutting it short skips clean shutdown |
| `--timeout` | Give up after a duration (default 0, wait forever) | Without it, a blocked PDB hangs your pipeline silently |
| `--disable-eviction` | Use delete instead of eviction | **Bypasses PDBs.** Can take a quorum-based service below quorum |

A **PodDisruptionBudget** limits voluntary disruptions (drain, eviction), not involuntary ones (node crash). You set either `minAvailable` or `maxUnavailable`, never both. Use `maxUnavailable` for stateless Deployments since it scales with replica count, and `minAvailable` as an absolute floor for quorum systems.

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: api-pdb
spec:
  maxUnavailable: 1
  selector:
    matchLabels:
      app: api
```

The catch that bites: **a PDB with one replica and `minAvailable: 1` blocks every drain forever**, because evicting the only pod would violate the budget. The symptom is `kubectl drain` printing "Cannot evict pod ... would violate the pod's disruption budget" in a loop. The fix is at the owner: run two replicas, or loosen the budget, or accept downtime for that workload deliberately. Using `--disable-eviction` to push through is the wrong fix; it just moves the outage to production traffic.

Two more details. `terminationGracePeriodSeconds` (default 30) is how long the kubelet waits after SIGTERM before SIGKILL; a `preStop` hook runs first and counts against that budget, so a slow drain-then-exit needs both tuned. And when a node is being replaced rather than repaired, delete the Node object after the machine is gone (`kubectl delete node`); a stale Node object keeps its taints and confuses node-lifecycle controllers.

For fleet-wide kernel patching, **kured** (the Kubernetes reboot daemon) is the common pattern: a DaemonSet that watches for `/var/run/reboot-required`, takes a cluster-wide lock so only one node reboots at a time, and cordons and drains before the reboot. It inherits every drain catch above, so PDBs must be right first.

---

## ★ Scheduling controls: putting pods on the right nodes

This is the section the "basic questions" will hit. The scheduler runs two phases for every pending pod: **filter** (drop nodes that cannot run it: insufficient requests, untolerated taints, unmatched selectors) then **score** (rank the survivors and pick the best). Every mechanism below acts on one of those two phases. Hard rules filter; soft preferences score.

### nodeSelector

**What.** A map of labels the node must have. **Why.** The simplest, most readable way to say "this pod runs on nodes labelled X". **The catch.** It is a hard requirement with no expressiveness: no OR, no NOT, no preferences. A typo in the label leaves the pod `Pending` with "0/N nodes available: N node(s) didn't match Pod's node affinity/selector".

```yaml
spec:
  nodeSelector:
    disktype: nvme
```

### Node affinity

**What.** A richer node selector. `requiredDuringSchedulingIgnoredDuringExecution` is a hard filter; `preferredDuringSchedulingIgnoredDuringExecution` is a soft score with a `weight` from 1 to 100. Operators are `In`, `NotIn`, `Exists`, `DoesNotExist`, `Gt`, `Lt`. **Why.** Expresses "A100 or H100, prefer the one in rack 3". **The catch.** `IgnoredDuringExecution` means the rule is evaluated only at scheduling time. Relabel the node afterwards and running pods are not evicted. People assume affinity keeps pods in place; it does not.

```yaml
spec:
  affinity:
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
          - matchExpressions:
              - key: gpu.model
                operator: In
                values: ["a100", "h100"]
      preferredDuringSchedulingIgnoredDuringExecution:
        - weight: 50
          preference:
            matchExpressions:
              - key: rack
                operator: In
                values: ["r3"]
```

### Taints and tolerations

**What.** A taint on a node repels pods. A toleration on a pod permits it to land on a tainted node. **Why.** Dedicate nodes (GPU, control-plane, a team's pool) and keep everything else off them. **The catch, and the question they will ask:** a toleration permits, it does not attract. A pod with a toleration for the GPU taint can still be scheduled onto any untainted node. To dedicate nodes you need the pair: **taint to repel others, selector or affinity to attract yours**.

Taint effects:

| Effect | Behavior |
|---|---|
| `NoSchedule` | New pods without a toleration are not scheduled; existing pods stay |
| `PreferNoSchedule` | Soft version: the scheduler avoids it if it can |
| `NoExecute` | Also evicts running pods that do not tolerate it |

`tolerationSeconds` on a `NoExecute` toleration says how long the pod may stay after the taint appears, which is the lever for graceful drains.

```bash
kubectl taint nodes gpu-1 nvidia.com/gpu=present:NoSchedule
kubectl taint nodes gpu-1 nvidia.com/gpu=present:NoSchedule-   # trailing dash removes it
```

Built-in taints the control plane applies for you: `node.kubernetes.io/not-ready`, `unreachable`, `memory-pressure`, `disk-pressure`, `pid-pressure`, `network-unavailable`, and `unschedulable` (from cordon). Kubeadm also taints control-plane nodes with `node-role.kubernetes.io/control-plane:NoSchedule`, which is why ordinary pods do not land there. An admission controller adds default tolerations to every pod for `not-ready` and `unreachable` with `tolerationSeconds: 300`. That 300 seconds is the answer to "why did my pods wait five minutes before moving off the dead node?" A toleration with `operator: Exists` and an empty key tolerates everything, which is how DaemonSets and critical system pods survive any taint.

```yaml
spec:
  tolerations:
    - key: node.kubernetes.io/unreachable
      operator: Exists
      effect: NoExecute
      tolerationSeconds: 60      # fail over in 1 minute instead of 5
```

To run a pod on a control-plane node (say, a debugging pod), tolerate `node-role.kubernetes.io/control-plane` with effect `NoSchedule`. Whether you should is a different question.

### Pod affinity and anti-affinity

**What.** Rules relative to *other pods*: "co-locate with the cache" or "never share a node with another replica of me". `topologyKey` defines "together": `kubernetes.io/hostname` means same node, `topology.kubernetes.io/zone` means same zone. **The catch.** The scheduler must compare the pending pod against existing pods across the topology, which is expensive. At thousands of nodes, inter-pod affinity measurably slows scheduling, and the Kubernetes docs warn against it in large clusters. Required anti-affinity across hostnames also hard-limits replicas to the node count: 5 replicas on 4 nodes leaves one `Pending`.

### topologySpreadConstraints

**What.** Spread matching pods evenly across a topology, bounded by `maxSkew`, the maximum allowed difference in pod count between the fullest and emptiest domain. `whenUnsatisfiable: DoNotSchedule` is a hard rule; `ScheduleAnyway` is a preference. **Why it usually beats anti-affinity for spreading.** It expresses "even", not "never together", so 6 replicas across 3 zones works (2 each) where required anti-affinity on zone would leave 3 pending. **The catch.** Constraints are evaluated at scheduling time only. Scale-downs and evictions can skew the spread afterwards, and nothing rebalances it (the Descheduler project exists for that).

```yaml
spec:
  topologySpreadConstraints:
    - maxSkew: 1
      topologyKey: topology.kubernetes.io/zone
      whenUnsatisfiable: DoNotSchedule
      labelSelector:
        matchLabels:
          app: api
      matchLabelKeys: ["pod-template-hash"]   # as of 1.37: beta, on by default
```

`matchLabelKeys` makes a rolling update count only pods of the same revision, so old and new ReplicaSets do not distort the skew. It is beta (default on) for topology spread as of 1.37, while the pod-affinity variant is GA.

### PriorityClass and preemption

**What.** A cluster-scoped integer priority assigned to pods by `priorityClassName`. When a high-priority pod cannot be scheduled, the scheduler may **preempt**: evict lower-priority pods from a node to make room. **Why.** Protects platform pods (DNS, CNI, monitoring) and lets urgent work jump the queue. **The catch.** Preemption is a graceful deletion of someone else's pod, and a team whose jobs keep getting preempted will see it as a restart loop. Preemption tries to respect PDBs on a best-effort basis but may violate them. Too many high tiers makes the system meaningless; define three or four tiers and a policy for who may use them. Setting `preemptionPolicy: Never` gives a pod priority in the queue without letting it evict others, which is the right default for batch.

### Requests, limits, and QoS

**What.** The scheduler uses **requests only**: it sums requests per node and places a pod where they fit against `allocatable`. Limits are enforced later by the kubelet and kernel. QoS follows from the shape: **Guaranteed** (requests equal limits for CPU and memory in every container), **Burstable** (some requests), **BestEffort** (none). **The catch.** QoS is a summary, not the full eviction rule. Under node pressure the kubelet ranks pods by whether usage exceeds requests first, then by priority, then by how far over. A Burstable pod using less than its request can outlast a Guaranteed pod's neighbour; a BestEffort pod always exceeds its (zero) request, which is why it goes first. Set requests from measured usage: too high strands capacity, too low packs nodes until they thrash.

### ResourceQuota and LimitRange

**What.** A `ResourceQuota` caps the aggregate a namespace may request or create (CPU, memory, GPUs, object counts). A `LimitRange` sets per-pod and per-container defaults and bounds. **Why.** Quotas are how a shared cluster stays fair per team. **The catch.** Once a quota covers `requests.cpu`, every pod in that namespace must declare a request or it is rejected at admission. A LimitRange supplies defaults so users are not blocked by a missing field.

### nodeName and static pods

Setting `spec.nodeName` bypasses the scheduler entirely: no filter, no score, no resource check, and a pod pointed at a full or tainted node just fails. It is legitimate for static pods and rare debugging. For anything else prefer a selector or affinity, which keeps the scheduler's safety checks.

### A worked pattern: a dedicated GPU node pool

The goal: only GPU workloads run on GPU nodes, and GPU workloads only run there. That needs three pieces together.

```bash
# Node side: repel everyone, label for attraction
kubectl taint nodes gpu-1 nvidia.com/gpu=present:NoSchedule
kubectl label nodes gpu-1 accelerator=nvidia-a100
```

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: trainer
spec:
  tolerations:
    - key: nvidia.com/gpu
      operator: Equal
      value: present
      effect: NoSchedule            # permits landing on the tainted node
  affinity:
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
          - matchExpressions:
              - key: accelerator
                operator: In
                values: ["nvidia-a100"]   # attracts it to GPU nodes only
  containers:
    - name: trainer
      image: registry.example.org/ml/trainer:2.4
      resources:
        limits:
          nvidia.com/gpu: 1               # extended resource, integer, limits only
```

How it fits together. The `nvidia.com/gpu` resource does not exist by default. The NVIDIA device plugin (usually deployed by the GPU Operator) runs as a DaemonSet, registers with the kubelet over the device-plugin API, and the kubelet advertises `nvidia.com/gpu: N` in the node's `allocatable`. The scheduler then treats it like any countable resource. Extended resources are integers, cannot be overcommitted, and are specified in `limits` (a request, if given, must equal the limit). If the cluster enables the optional `ExtendedResourceToleration` admission plugin, pods requesting that resource get the matching toleration automatically; do not assume that it is on.

The catch is the pair. Taint without the toleration leaves the pod `Pending`. Toleration without the affinity lets a CPU-only pod that happens to carry it land on a GPU node, or your GPU pod land on a CPU node and fail at device allocation. Remove the taint and everyone floods in. All three, always.

DRA (Dynamic Resource Allocation) is the newer model: pods claim devices through `ResourceClaim` objects instead of counting integers, which supports sharing, partitioning (MIG), and device attributes. DRA is GA as of 1.34, with extended-resource support and device taints GA in 1.37, so it is real, but most clusters today still run the device plugin. Know both names.

### Where the default scheduler stops

The default scheduler places one pod at a time. A 64-rank MPI job needs all 64 pods or none, and partial placement deadlocks the cluster with half-started jobs holding GPUs. **Gang scheduling** and queueing solve that: **Kueue** (a job-queueing controller that admits whole jobs against quotas and cohorts) and **Volcano** (a batch scheduler with gang scheduling and queues) are the common choices. Native gang scheduling (the `GenericWorkload` gate) is beta in 1.37 but off by default. For SLAC-style batch and GPU workloads, naming Kueue and the gang problem is the right level of depth.

---

## ★ etcd backup, restore, and certificates

**What it is.** etcd holds all cluster state. Back it up and you can rebuild the control plane; lose it without a backup and the cluster is gone, even though the workloads may keep running on the nodes.

Snapshot from a live member, using the certs kubeadm placed on the node:

```bash
sudo ETCDCTL_API=3 etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  snapshot save /backup/etcd-$(date +%F).db

etcdutl --write-out=table snapshot status /backup/etcd-2026-10-12.db   # verify it
```

Restore uses `etcdutl`, not `etcdctl`. The `snapshot restore` and `snapshot status` subcommands on `etcdctl` were deprecated in etcd 3.5 and removed from etcdctl in 3.6. The restore procedure: stop the apiservers (move their manifests out of `/etc/kubernetes/manifests`), restore into a **new** data directory, point the etcd static pod's `etcd-data` hostPath at it, and let the kubelet restart etcd.

```bash
etcdutl --data-dir /var/lib/etcd-restored snapshot restore /backup/etcd-2026-10-12.db
# then edit /etc/kubernetes/manifests/etcd.yaml:
#   volumes: etcd-data hostPath.path -> /var/lib/etcd-restored
```

Catches: snapshots contain every Secret in the cluster unless you enable encryption at rest, so encrypt and restrict the backup. A snapshot is point-in-time: anything created after it is gone and workloads on nodes may disagree with the restored state. Test a restore somewhere; an untested backup is a hope.

**Quorum math.** etcd needs a majority: floor(n/2)+1. Three members tolerate one failure, five tolerate two (and five is the recommended production size). **Four is worse than three:** quorum is 3 either way, so you tolerate the same single failure but add write cost and another member that can fail. Symptoms of lost quorum: `kubectl` hangs or returns "etcdserver: request timed out", the apiserver logs "context deadline exceeded", and nothing can be created or changed while existing pods keep running.

### Certificates

kubeadm leaf certificates (apiserver, kubelet client for the apiserver, etcd, front-proxy, and the client certs inside `admin.conf`, `controller-manager.conf`, `scheduler.conf`) are valid for **one year** by default. The CAs are valid for ten. Both are configurable in `ClusterConfiguration` via `certificateValidityPeriod` and `caCertificateValidityPeriod` (as of kubeadm v1beta4).

```bash
sudo kubeadm certs check-expiration     # shows every cert and days left
sudo kubeadm certs renew all            # renews all leaf certs on this node
```

Renewal happens automatically on every `kubeadm upgrade apply` and `kubeadm upgrade node` (unless `--certificate-renewal=false`). The catch is the cluster that was never upgraded: it runs perfectly for a year and then every component's client certificate expires within the same minute, and `kubectl` answers "x509: certificate has expired". This is the most common avoidable kubeadm outage. After a manual `renew`, the running static pods do not reload the files, so restart them (move the manifests out and back, or restart containers with `crictl`), and copy the fresh `admin.conf` over `~/.kube/config`. In an HA cluster, renew on every control-plane node.

The kubelet is separate. Its **client** certificate (to the apiserver) rotates itself when `rotateCertificates: true`, which kubeadm sets. Its **serving** certificate is self-signed by default; for a CA-signed one set `serverTLSBootstrap: true` and approve the resulting CSRs, which is a manual step people forget and the reason `kubectl logs` can fail with certificate errors on some clusters.

---

## Access, tenancy, and policy (brief)

**RBAC** is four objects: `Role` and `ClusterRole` (what verbs on what resources) and `RoleBinding` and `ClusterRoleBinding` (who gets it). A ClusterRole bound by a RoleBinding is scoped to that namespace, which is the standard way to reuse a role across tenants. Test with `kubectl auth can-i create pods -n team-a --as=jane@example.org`. The catch is that RBAC is purely additive: you cannot write a deny, so the way to restrict is to grant less.

**OIDC login** points the apiserver at an identity provider. At SLAC that provider is Dex, federating to a SAML2 backend: users authenticate through the lab's SAML IdP, Dex mints OIDC tokens, and the apiserver validates them. The apiserver can be configured either with the legacy `--oidc-issuer-url`, `--oidc-client-id`, `--oidc-username-claim` and `--oidc-groups-claim` flags, or with a structured authentication configuration file (`--authentication-config`), which is GA since 1.34 and supports multiple issuers and claim validation rules. They are mutually exclusive: setting both makes the apiserver exit at startup. Groups from the token then match RBAC bindings.

**Multi-tenancy** is a spectrum of isolation versus cost.

| | Namespaces + quota + PSA + NetworkPolicy | vCluster |
|---|---|---|
| Isolation | Soft: shared control plane and kernel | Separate API server per tenant, still a shared node kernel |
| CRDs and cluster-scoped objects | Shared; tenants cannot install their own | Tenant installs its own CRDs and operators |
| Overhead | Near zero | A control plane (and its datastore) per tenant |
| Blast radius of a bad tenant | A noisy tenant affects the shared apiserver | Contained to the virtual cluster's API, though not the nodes |
| Best for | Trusted teams in one organisation | Teams needing admin-like freedom without separate clusters |

Neither isolates the node kernel; for hostile tenants you need sandboxed runtimes or separate clusters.

**Admission policy** engines enforce rules the API schema cannot: **Kyverno** (policies as YAML, can mutate and generate), **OPA Gatekeeper** (Rego), and the built-in **ValidatingAdmissionPolicy** (CEL expressions evaluated inside the apiserver, no webhook to run). The built-in option avoids the classic outage where a down policy webhook blocks every pod creation.

---

## CNI and CSI in one page

**CNI.** When the kubelet creates a pod sandbox it calls the CNI plugin, which creates the veth pair, assigns an IP from the node's pod CIDR, and wires routes. If the plugin is missing or broken, pods stay `ContainerCreating` with "network plugin not ready". `kube-proxy` is separate: it programs Service virtual IPs on each node. Its modes are `iptables` (the default as of 1.37), `nftables` (GA since 1.33, intended to become the default in a later release), and `ipvs` (deprecated as of 1.37). Set the mode explicitly in the kube-proxy config so an upgrade cannot change it for you.

**Calico vs Cilium** in three lines: Calico is routing-first (BGP or VXLAN) with iptables or eBPF dataplane and mature NetworkPolicy; Cilium is eBPF-native, can replace kube-proxy, and adds L7 policy and Hubble observability; both implement NetworkPolicy. The catch worth saying: **NetworkPolicy is enforced by the CNI, not by Kubernetes.** Apply a policy on a CNI that does not support it and the object is accepted and does nothing.

**CSI.** A `StorageClass` names a provisioner and parameters; a PVC against it triggers dynamic provisioning of a PV. Access modes: `ReadWriteOnce` (one node), `ReadOnlyMany`, `ReadWriteMany` (many nodes), `ReadWriteOncePod` (exactly one pod). `volumeBindingMode: WaitForFirstConsumer` delays provisioning until a pod is scheduled, so the volume lands in the same zone as the pod; with `Immediate`, a zonal volume can be created where the pod cannot run, leaving it `Pending` with a volume node-affinity conflict. `reclaimPolicy: Delete` removes the backing storage with the PVC; `Retain` keeps it for manual recovery. For shared scientific datasets you want RWX (CephFS, NFS) so many job pods read one dataset; RWO block (Ceph RBD) is faster per pod but cannot be shared across nodes.

---

## ★ Practice: operator drills

### Drill 1: Upgrade this cluster from 1.N to 1.N+1

Narrate the plan before touching anything. Steps: (1) read release notes and run `kubent` or `pluto` for removed APIs; (2) etcd snapshot, verified; (3) confirm CNI, CSI, ingress and device plugins support N+1; (4) staging first; (5) `kubeadm upgrade plan` then `apply` on the first control-plane node; `upgrade node` on the others; (6) per node drain, kubelet, restart, uncordon, checking `kubectl get nodes` between each; (7) workers in small batches, with a canary node first; (8) add-ons. State the abort point: after `apply` there is no downgrade, so the decision to go is made before that command, and rollback means etcd restore.

The catch to volunteer: the long-running jobs. Cordon the batch nodes early, let jobs drain, and schedule the drain window around the queue.

### Drill 2: Drain hangs forever

Symptom: `kubectl drain node-7` prints "evicting pod ..." repeatedly and never returns. Ranked causes: a PDB that cannot be satisfied (single replica, or `minAvailable` equal to replicas); a pod with no controller or with local storage (drain refuses outright, which shows as an error, not a hang); a pod whose finalizer or stuck termination never completes.

```bash
kubectl get pdb -A                                   # ALLOWED DISRUPTIONS column: 0 is the blocker
kubectl get pods -A -o wide --field-selector spec.nodeName=node-7
kubectl describe pdb api-pdb
```

Fix at the owner: add a replica, relax the budget, or schedule downtime for that service. The catch: `--disable-eviction` makes the drain finish and silently takes down a service you promised to protect.

### Drill 3: Pods will not schedule on the new GPU nodes

Two opposite failures. Pods `Pending` with "node(s) had untolerated taint {nvidia.com/gpu: present}": the nodes are tainted and the pod lacks the toleration. Pods `Running` but on the wrong nodes (or failing for lack of a device): the toleration is there but there is no affinity or selector, so the toleration permitted GPU nodes without attracting to them.

```bash
kubectl describe pod trainer | sed -n '/Events/,$p'
kubectl get nodes -L accelerator
kubectl describe node gpu-1 | grep -A3 -E "Taints|Allocatable"   # is nvidia.com/gpu advertised?
```

If `nvidia.com/gpu` is missing from Allocatable, the device plugin is not running on that node, and no scheduling rule will help. The catch: three things must agree, the taint, the label, and the device plugin.

### Drill 4: Every pod was evicted from a node at once

Two causes. Someone added a `NoExecute` taint (check `kubectl describe node` Taints), which evicts every pod without a matching toleration immediately. Or the node became unreachable and stayed so for more than 300 seconds, so the default `not-ready` and `unreachable` tolerations expired and the node controller evicted everything on it.

```bash
kubectl describe node node-3 | grep -A5 Taints
kubectl get events -A --field-selector reason=TaintManagerEviction
```

Fix: remove the errant taint, or repair the node's network or kubelet. The catch: lowering `tolerationSeconds` to fail over faster makes brief network blips evict healthy pods, so tune it per workload, not cluster-wide.

### Drill 5: `kubectl` returns x509 certificate has expired

Check from the control-plane node, where files work even if the API does not.

```bash
sudo kubeadm certs check-expiration
sudo kubeadm certs renew all
# restart the control-plane static pods so they reload certs
sudo mkdir -p /root/manifests-bak && sudo mv /etc/kubernetes/manifests/*.yaml /root/manifests-bak/
sleep 30
sudo mv /root/manifests-bak/*.yaml /etc/kubernetes/manifests/
sudo cp /etc/kubernetes/admin.conf ~/.kube/config
```

Repeat on every control-plane node. The catch: the old `admin.conf` in your home directory is a copy and is also expired, so a successful renew still shows the error until you copy the new one. And an HA cluster expires all nodes together, so doing one node and stopping leaves you half-fixed.

### Drill 6: A control-plane node is lost in a 3-node etcd cluster

What still works: quorum is 2 of 3, so etcd accepts writes, the other two apiservers serve through the load balancer, and scheduling and controllers run. You have lost your safety margin: one more failure loses quorum. Replace it promptly and in the right order.

```bash
kubectl delete node cp-3                              # drop the dead Node object
# on a healthy member: find and remove the dead etcd member FIRST
etcdctl --endpoints=... --cacert=... --cert=... --key=... member list
etcdctl ... member remove <dead-member-id>
# then join the replacement
kubeadm init phase upload-certs --upload-certs        # prints a certificate key
kubeadm token create --print-join-command             # append --control-plane --certificate-key <key>
```

The catch: remove the dead member before adding the new one. With a dead member still counted, adding a fourth raises quorum to 3 while only two are alive, and you can lock the cluster out of writes.

### Drill 7: A team's job gets preempted repeatedly

A high-priority tier is displacing their batch job, which restarts from zero each time. Check `kubectl get priorityclass` and the job's `priorityClassName`, and look for `Preempted` events. The design fix is on the owner side: give long batch work its own PriorityClass with `preemptionPolicy: Never` so it queues fairly but evicts nobody, protect the high tier by quota (only platform namespaces may use it via a ResourceQuota on `priorityclasses`), have the job checkpoint, and put a queueing system (Kueue) in front so jobs are admitted when capacity exists instead of competing in the scheduler. The catch: raising the batch job's priority just moves the preemption onto someone else.

---

## Question bank: cluster operations

| Question | What they are testing | Concise answer |
|---|---|---|
| How do you upgrade a worker node? | Whether you know the sequence and why | Drain, upgrade the `kubeadm` package, `kubeadm upgrade node`, upgrade `kubelet`, daemon-reload and restart, uncordon. Drain first because an in-place minor kubelet upgrade restarts every container. |
| How do you upgrade a cluster? | Ordering and risk | Snapshot etcd, one minor at a time, first control-plane node `upgrade apply`, others `upgrade node`, then workers, then add-ons. Control plane first because nodes may lag the apiserver, never lead it. |
| Can you skip a minor version? | Policy knowledge | No. One minor at a time, finishing each hop. |
| What is the version skew policy? | Precision | As of 1.37: kubelet and kube-proxy up to 3 minors older than the apiserver, never newer; controller-manager and scheduler up to 1 older; kubectl within 1 either way; HA apiservers within 1. |
| Difference between cordon and drain? | Basics | Cordon marks unschedulable and leaves running pods. Drain is cordon plus evicting pods through the Eviction API. |
| What does drain actually call? | Mechanism | The Eviction API, which respects PodDisruptionBudgets. `--disable-eviction` switches to plain delete and bypasses them. |
| Why does my drain hang? | Troubleshooting | Usually a PDB with zero allowed disruptions (single replica and `minAvailable: 1`). Check `kubectl get pdb -A`. |
| What is a PDB and when does it bite? | Disruption model | It limits voluntary disruptions (drain, eviction) to a floor or ceiling. It bites during upgrades when replicas equal the budget, and it does not cover node crashes. |
| What happens to pods without a controller on drain? | Failure modes | Drain refuses without `--force`; with it they are deleted and never recreated. |
| What happens to `emptyDir` data on drain? | Data safety | It is deleted with the pod. Drain requires `--delete-emptydir-data` to proceed. |
| What is a taint? A toleration? | Basics | A taint repels pods from a node; a toleration lets a pod tolerate a taint. |
| Why doesn't a toleration attract a pod? | The classic gotcha | Tolerations only remove a filter. Attraction needs a nodeSelector or node affinity. Dedicated nodes need taint plus toleration plus affinity. |
| What are the taint effects? | Depth | `NoSchedule` blocks new pods, `PreferNoSchedule` is soft, `NoExecute` also evicts running pods without a toleration. |
| Why did pods wait five minutes after a node died? | Defaults | Admission adds `not-ready` and `unreachable` NoExecute tolerations with `tolerationSeconds: 300` to every pod. |
| nodeSelector vs node affinity? | Basics | nodeSelector is an exact-match hard requirement. Affinity adds operators (`In`, `NotIn`, `Exists`, `Gt`) and soft preferences with weights. |
| What does `IgnoredDuringExecution` mean? | Subtlety | Rules are checked only when scheduling. Relabelling a node later does not evict running pods. |
| How do you dedicate nodes to a team? | Design | Taint the nodes, label them, and give that team's pods the toleration and a node affinity or selector for the label. Add a quota so the team cannot overrun the pool. |
| How would you add a GPU node pool? | End to end | Install the driver and runtime, join the nodes, taint and label them, deploy the device plugin so `nvidia.com/gpu` appears in allocatable, then use limits plus toleration plus affinity in pods. |
| How do you spread replicas across zones? | Scheduling | `topologySpreadConstraints` with `topologyKey: topology.kubernetes.io/zone` and `maxSkew: 1`. Preferred over anti-affinity because it expresses "even", not "never together". |
| DaemonSet vs Deployment with anti-affinity? | Judgement | A DaemonSet guarantees one per matching node and follows nodes as they join. Anti-affinity gives "at most one per node" for a fixed replica count and can leave pods Pending. |
| How does the scheduler pick a node? | Mechanism | Filter nodes that cannot run the pod (resources, taints, selectors, volumes), score the rest (spread, affinity preferences, resource balance), bind to the highest. |
| What are static pods? | kubeadm basics | Pods the kubelet runs directly from manifest files, with no API-server scheduling. kubeadm's control plane runs this way. |
| Where are control-plane manifests on a kubeadm node? | Layout | `/etc/kubernetes/manifests`, with certs in `/etc/kubernetes/pki`. |
| How do you run a pod on a control-plane node? | Taints | Tolerate `node-role.kubernetes.io/control-plane:NoSchedule`, optionally with a selector for that label. |
| How do you back up etcd? | Operations | `etcdctl snapshot save` with `--endpoints`, `--cacert`, `--cert`, `--key` from `/etc/kubernetes/pki/etcd`; verify with `etcdutl snapshot status`; encrypt it. |
| How do you restore etcd? | Operations | Stop apiservers, `etcdutl snapshot restore --data-dir <new>`, repoint the etcd static pod's hostPath, let the kubelet restart it. |
| Why 3 or 5 etcd members and not 4? | Quorum math | Quorum is floor(n/2)+1. Four needs 3, tolerating one failure like three, with more cost. Five tolerates two. |
| What happens when kubeadm certs expire? | The year-one outage | Components fail with x509 errors and `kubectl` stops. Fix with `kubeadm certs renew all`, restart static pods, refresh `admin.conf`. Upgrades renew them, so upgrade at least yearly. |
| What QoS class gets evicted first? | Pressure behaviour | BestEffort, then Burstable pods over their requests. Precisely, the kubelet ranks by usage over request, then priority. |
| What does the scheduler use, requests or limits? | Resources | Requests only. Limits are enforced by the kubelet and kernel at runtime. |
| What is PriorityClass and preemption? | Scheduling policy | An integer priority per pod; a pending high-priority pod can evict lower-priority pods to fit. Use `preemptionPolicy: Never` for batch that should queue, not evict. |
| How do you restrict what a namespace can consume? | Multi-tenancy | ResourceQuota for aggregate caps and LimitRange for defaults and per-pod bounds. |
| Namespaces vs vCluster? | Tenancy tradeoff | Namespaces share one control plane and no custom CRDs per tenant; vCluster gives each tenant its own API server and CRDs at the cost of overhead. Neither isolates the kernel. |
| How does OIDC login work with the apiserver? | Auth | The apiserver validates tokens from an issuer (Dex federating to SAML). Configure via `--authentication-config` (GA 1.34) or legacy `--oidc-*` flags, never both. |
| Who enforces NetworkPolicy? | CNI | The CNI plugin. Kubernetes stores the object; a CNI without support silently ignores it. |
| Why `WaitForFirstConsumer`? | Storage topology | It delays volume provisioning until the pod is scheduled, so the volume lands in a zone the pod can run in. |
| How is MicroK8s different from kubeadm? | Your experience | MicroK8s is a snap with dqlite and addons, upgraded by `snap refresh`. kubeadm uses packages, etcd and static pods, and you run each upgrade step and bring your own CNI and CSI. |
| What does kubeadm not do? | Scope | It does not install a kubelet, runtime or CNI, and it does not manage the lifecycle beyond init, join, upgrade and cert renewal. |

---

## How to narrate this in the interview

Interviewers running a live Kubernetes round are not testing whether you can recite YAML. They are watching how you reason under a symptom. Say the hypothesis before you run the command. "I expect the Events block to name why the scheduler rejected this pod, so I'll describe it first." Then read the output and update your hypothesis out loud. "Events say insufficient memory. My next step is to check node allocatable capacity against this pod's resource request."

That loop, stated clearly, is the answer. The interviewer can see you understand the mechanism, knew which command to run before you ran it, and move from symptom to root cause rather than from topic to topic. Speed matters less than the ability to demonstrate that each move follows logically from what the previous one showed.

Operational answers need a different shape: state the invariant, the order, the rollback, and the blast radius. For an upgrade plan: "The invariant is that no kubelet is ever newer than the apiserver and no node is drained below a PDB. Control plane first, one minor at a time, etcd snapshot before `upgrade apply` because that is the point of no return, workers in batches behind a canary node." For a scheduling design: "Taint to repel, label and affinity to attract, a quota so the team cannot overrun the pool, a PriorityClass tier that does not preempt batch work." Naming the failure you are guarding against in each step is what turns a command list into a plan.

Be straight about where your experience sits. "I ran MicroK8s in production for a 14.5M-user service, where the snap hid the upgrade sequence. I know the sequence and the reasons for it, and kubeadm makes me run each step myself" is a stronger answer than bluffing fleet experience, and the follow-ups will find the edge anyway.
