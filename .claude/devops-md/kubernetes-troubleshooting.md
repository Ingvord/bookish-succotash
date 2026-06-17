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

---

## How to narrate this in the interview

Interviewers running a live Kubernetes round are not testing whether you can recite YAML. They are watching how you reason under a symptom. Say the hypothesis before you run the command. "I expect the Events block to name why the scheduler rejected this pod, so I'll describe it first." Then read the output and update your hypothesis out loud. "Events say insufficient memory. My next step is to check node allocatable capacity against this pod's resource request."

That loop, stated clearly, is the answer. The interviewer can see you understand the mechanism, knew which command to run before you ran it, and move from symptom to root cause rather than from topic to topic. Speed matters less than the ability to demonstrate that each move follows logically from what the previous one showed.
