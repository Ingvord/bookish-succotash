## When the curl fails and the clock is running

The interviewer hands you a terminal and says: "curl to this service does not work. Find out why." The platform is one shared kubeadm cluster, each tenant project gets a **vCluster**, services are exposed through the **Gateway API**, and **Kyverno** enforces admission policy. You have never run two of those four in production, and that is fine. The test is not whether you have memorised vCluster's Helm values. It is whether you can walk the request path layer by layer, out loud, and say which layer each symptom points at.

The shape of the answer is a funnel: gateway, route, service, endpoints, pod, volume. At every step you read one status object, name what it told you, and move one layer inward. This guide builds that funnel for a multi-tenant cluster, fills in the two technologies that are new to you, and ends with the exact drill you are likely to get. Facts tied to a version are marked as of the versions current at writing: vCluster 0.37, Gateway API 1.6, Kyverno 1.19.

This guide leans on two others. For the get/describe/logs loop, taint effects, and the "a toleration permits, it does not attract" catch, see the Kubernetes guide ("Scenario 1", "Scenario 5", "Taints and tolerations"). For DNS `ndots` and conntrack, see the Linux guide. They are not repeated here.

---

## Read the symptom, pick the layer

Before touching kubectl, the `curl -v` output already narrows the search. Run it with `-v` and read the first thing that goes wrong.

```bash
curl -v https://app.team-a.example.org/healthz
```

| What curl shows | Layer it points at | First command |
|---|---|---|
| `Could not resolve host` | DNS record missing or wrong | `dig app.team-a.example.org` |
| `Connection refused` | Nothing listening on the address and port: Gateway not Programmed, wrong port, LB not exposed | `kubectl get gateway -A` |
| `Connection timed out` | Address unreachable: no LB address, firewall, NetworkPolicy, wrong IP | `kubectl get gateway -A -o wide`, then the data-plane Service |
| TLS handshake error, `unknown ca`, wrong cert | Listener certificate, SNI versus hostname | `kubectl describe gateway` (listener `ResolvedRefs`) |
| `404 Not Found` from the gateway (often an Envoy or NGINX default body) | Gateway is alive but no route matched: not attached, hostname or path mismatch | `kubectl get httproute -o yaml` (parent conditions) |
| `503` or `no healthy upstream` | Route matched but the backend has nothing: unresolved ref, zero endpoints, pods not Ready | `kubectl get endpointslices` |
| `200` but wrong content | Weights, path rewrite, or the wrong backend | route `backendRefs` |

The catch: a 404 and a 503 look similar to a stressed reader and mean opposite things. **404 means the gateway does not know this request belongs to anyone.** The fault is at or before the route. **503 means the gateway knows exactly who should answer and nobody is home.** The fault is at or after the Service. Saying that sentence out loud early in the drill is worth more than any command.

---

## ★ The request path in a multi-tenant cluster

One diagram carries the whole guide. Read it top to bottom, and notice the boundary on the left: the tenant sees only part of the path.

```text
client
  |  DNS: app.team-a.example.org -> Gateway address
  v
+-------------------------- HOST CLUSTER ------------------------------+
|  GatewayClass          (infra provider; host only)                   |
|  Gateway               (platform team; host namespace)               |
|    listener: port 443, protocol HTTPS, hostname *.team-a.example.org |
|              tls.certificateRefs -> Secret                           |
|              allowedRoutes: namespaces.from Selector / Same / All    |
|        ^                                                             |
|        | parentRefs (attach)                                         |
|  +----------------- vCluster "team-a" (host namespace vc-team-a) --+ |
|  | TENANT VIEW (virtual API server)                               | |
|  |   HTTPRoute  hostnames, matches, backendRefs  --synced-->  copy | |
|  |   Service                                    --synced-->  copy | |
|  |   EndpointSlices                             --synced-->  copy | |
|  |   Pod  (what the tenant sees)                --synced-->  pod-x-ns-x-team-a
|  |   PVC                                        --synced-->  copy | |
|  |   (tenant CRDs, RBAC, Namespaces: virtual only)                | |
|  +----------------------------------------------------------------+ |
|  PV, StorageClass, Node, taints, ResourceQuota (host only unless     |
|  sync is enabled)                                                    |
|        Service -> EndpointSlices -> Pod (Ready?) -> PVC -> PV -> node
+----------------------------------------------------------------------+
```

Three categories of object matter, and every debugging move is "which category is this in":

- **Tenant-only.** Namespaces, RBAC, CRDs and custom resources created inside the virtual cluster. The host has no idea they exist.
- **Synced.** Pods, Services, Endpoints, PVCs, ConfigMaps and Secrets by default; Gateway API objects and a few others only when enabled. The syncer copies them to the host and rewrites names, so they are real host objects the host scheduler and host controllers act on.
- **Host-only.** GatewayClass, the Gateway and its data plane, Nodes and their taints, PVs, StorageClasses, ResourceQuota, the node kernel. The tenant cannot see most of these by default, but every one of them can fail the request.

The catch is the one the interview exposed: **the tenant sees "Pending" or "404" and the cause lives in a host-only object they cannot read.** When a ticket comes in from a tenant, your first question is always which side of the boundary the failing object is on.

---

## ★ vCluster in depth

### What it is and why a platform ships it

**What.** A vCluster is a Kubernetes control plane (API server, controller manager, a datastore, and a component called the syncer) that runs as a pod, or a StatefulSet, inside a namespace of a host cluster. The tenant gets a kubeconfig for that virtual API server and behaves as if they have a whole cluster. Pods they create are copied by the syncer into the host namespace, where the host's scheduler and kubelets actually run them.

**Why.** Tenants get cluster-admin-like freedom, can install their own CRDs and operators, can create their own namespaces and RBAC, and do not need their own nodes. The platform gets one fleet of nodes to patch and bill.

**The catch.** It is a control-plane boundary, not a kernel boundary. All tenants' pods share the host kernel and, unless you segregate it, the same nodes. For hostile tenants you still need sandboxed runtimes or separate clusters.

| | Namespaces + RBAC + quota + PSA | vCluster | Dedicated cluster |
|---|---|---|---|
| Isolation | Soft: shared API server and kernel | Own API server, shared nodes and kernel | Hard: own everything |
| CRD and cluster-scoped freedom | None; tenants cannot install CRDs | Full inside the virtual cluster | Full |
| Blast radius of a bad tenant | Shared API server, shared etcd | Contained to the virtual API; nodes still shared | Contained |
| Cost | Near zero | One control plane and datastore per tenant (small, but 100 tenants is 100 control planes) | Full cluster per tenant: nodes, control plane, ops |
| Ops overhead | Lowest | Medium: upgrade vClusters and host separately, version skew | Highest: N clusters to patch |
| Best for | Trusted teams, uniform needs | Teams that need admin freedom without a cluster | Compliance boundaries, hostile tenants |

Pair this table with the shorter namespaces-versus-vCluster comparison in the Kubernetes guide's "Access, tenancy, and policy". The line to say in the room: vCluster buys control-plane isolation and CRD freedom at the price of another thing to upgrade, and it does not buy kernel isolation.

### The syncer and what it copies

The syncer watches the virtual cluster and the host namespace and reconciles in both directions.

- **toHost** (tenant to host). Enabled by default: pods, services, endpoints, secrets, configMaps, PersistentVolumeClaims. Disabled by default: ingresses, Gateway API objects, networkPolicies, persistentVolumes, storageClasses, serviceAccounts, PodDisruptionBudgets, priorityClasses, namespaces, customResources, volume snapshots.
- **fromHost** (host to tenant). Enabled by default: events. Disabled by default: nodes, ingressClasses, gatewayClasses, gateways, storageClasses, CSI objects, host configMaps and secrets, customResources.

The config lives in `vcluster.yaml`. Everything is under `sync.toHost` and `sync.fromHost`, each resource with an `enabled` flag.

```yaml
sync:
  toHost:
    ingresses:
      enabled: false        # default
    persistentVolumeClaims:
      enabled: true         # default
    gatewayApi:
      httpRoutes:
        enabled: true       # opt in: routes created in the vCluster reach the host
      referenceGrants:
        enabled: auto
  fromHost:
    nodes:
      enabled: true         # opt in: tenant can see (read-only) host nodes
    storageClasses:
      enabled: auto
```

This block says: sync HTTPRoutes to the host, let the syncer decide about ReferenceGrants, show host nodes and StorageClasses inside the virtual cluster. Each line you leave out keeps the default above. The catch to say aloud: **if a resource is not in the toHost list, the host controller never sees it.** A tenant who creates an Ingress on a vCluster with `ingresses.enabled: false` gets an object that exists and does nothing, with no error. That silent no-op is the most common first ticket.

### How names are rewritten

A pod called `nginx-6d6565-abcde` in tenant namespace `demo` in vCluster `team-a` appears on the host as `nginx-6d6565-abcde-x-demo-x-team-a`, inside the host namespace that holds the vCluster (for example `vc-team-a`). The pattern is `NAME-x-NAMESPACE-x-VCLUSTER_NAME`. Names longer than the Kubernetes limit are truncated and hashed, so do not parse them with a regex; look them up by the labels the syncer adds (`vcluster.loft.sh/...`) or by grepping.

The reason is collision avoidance: many virtual namespaces map into one host namespace, and `demo/nginx` in two vClusters must not clash. The catch: when a tenant pastes a pod name and says "it is stuck", the name on the host is different, and you need to translate it before you can run anything host-side.

### Scheduling: who places the pod

The **host scheduler** places synced pods, on **host nodes**, by default. That means host taints, host node labels, host ResourceQuota and host LimitRange all apply to tenant pods, even when the tenant cannot see the nodes. A tenant who tolerates nothing and lands on a tainted pool is Pending for a reason that exists only on the host.

There is an optional virtual scheduler (`controlPlane.distro.k8s.scheduler.enabled: true`, which requires `sync.fromHost.nodes.enabled: true`). With it, the tenant schedules against its own view of nodes and can label and taint them without touching the host, and the syncer only syncs pods that already have a node. The catch is that the host kubelet and admission still enforce host-level constraints, so a virtual scheduler does not exempt the pod from host quota or from taints that gate the node.

For the taint mechanics themselves (effects, `tolerationSeconds`, the pair "taint to repel, selector to attract") see the Kubernetes guide's "Taints and tolerations".

### Storage and networking in one pass

**Storage.** PVCs sync to the host, so the host's StorageClass provisions the volume. StorageClasses and PVs are not shown to the tenant by default, so `kubectl get sc` inside the vCluster may be empty while PVCs bind happily from the host default class. Enable `fromHost.storageClasses` to let tenants see and select. The catch: a PVC that stays Pending inside the vCluster usually has its explanation in an event on the **host** PVC, which names the host StorageClass and node constraints.

**Networking.** Services and Endpoints sync, so a Service is a real host Service with a real ClusterIP-based path. Each vCluster runs its own CoreDNS, which resolves tenant names and forwards the rest. A tenant pod that is Running but cannot resolve a name is usually a DNS problem inside the virtual cluster (CoreDNS pod, or the rewritten Service cannot be found), not the host's DNS.

### Debugging from both sides

```bash
# Which vClusters exist, and what state are they in
vcluster list

# Point kubectl at the tenant's virtual API server
vcluster connect team-a --namespace vc-team-a

# Inside: what the tenant sees
kubectl get pods -A
kubectl describe pod nginx-6d6565-abcde -n demo

# Host side: the same pod under its rewritten name
kubectl -n vc-team-a get pods | grep nginx
kubectl -n vc-team-a describe pod nginx-6d6565-abcde-x-demo-x-team-a

# Syncer logs when something is not appearing on the host
kubectl -n vc-team-a logs team-a-0 -c syncer --tail=100
```

`vcluster connect` switches your kube context to the virtual cluster (it writes or updates a kubeconfig and, by default, may start a background proxy that needs Docker; run `vcluster connect --help` on your binary to confirm the flags in your version). The host-side `describe` is where the answer usually is, because the Events there come from the real scheduler and kubelet. The syncer logs show why an object was skipped: validation failure, missing dependency, or unsupported kind.

The catches, collected:

- **Tenant sees Pending, cause is a host taint or quota.** The tenant cannot inspect it. You can, on the host.
- **Default sync is narrow.** Ingress, Gateway API, PVs and StorageClasses all need enabling.
- **Version skew.** The virtual API server version and the host version are independent. A vCluster running a newer API than the host can accept manifests the host side of the syncer cannot translate; upgrade host first, then vClusters, and test the sync after each.

---

## ★ Gateway API in depth

### The role split and the Ingress mapping

Gateway API splits what Ingress crammed into one object, and the split matches who owns what.

| Role | Owns | Ingress equivalent |
|---|---|---|
| Infrastructure provider | `GatewayClass` (which controller implements it) | `IngressClass` |
| Cluster operator / platform team | `Gateway` (addresses, listeners, TLS, which namespaces may attach) | The Ingress controller's Service plus global config |
| Application team | `HTTPRoute` (hostnames, paths, backends) | The `Ingress` object |

| Ingress concept | Gateway API equivalent |
|---|---|
| `ingressClassName` | `Gateway.spec.gatewayClassName` |
| `spec.rules[].host` | `HTTPRoute.spec.hostnames` plus listener `hostname` |
| `spec.rules[].http.paths` | `HTTPRoute.spec.rules[].matches` |
| `spec.tls[].secretName` | `listeners[].tls.certificateRefs` (on the Gateway, not the route) |
| Annotations (rewrite, redirect, timeouts) | `filters` and policy attachments, now typed |
| Canary annotation | `backendRefs[].weight` |
| (nothing) | `allowedRoutes`, `ReferenceGrant`: explicit cross-team permission |

If you come from a single shared Ingress on MicroK8s, the translation is: the Ingress controller's config becomes a Gateway you do not own, and your Ingress becomes an HTTPRoute that has to be **allowed** to attach. That word "allowed" is the whole new idea.

### Listeners and allowedRoutes

A Gateway has listeners. Each has a port, protocol, optional hostname, optional TLS config, and an `allowedRoutes` block that says who may attach.

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: public-web
  namespace: platform-gateways
spec:
  gatewayClassName: envoy
  listeners:
    - name: https
      port: 443
      protocol: HTTPS
      hostname: "*.team-a.example.org"
      tls:
        mode: Terminate
        certificateRefs:
          - kind: Secret
            name: team-a-wildcard
      allowedRoutes:
        namespaces:
          from: Selector
          selector:
            matchLabels:
              gateway-access: public-web
        kinds:
          - kind: HTTPRoute
```

This listener terminates TLS for any host under `team-a.example.org` and accepts HTTPRoutes only from namespaces labelled `gateway-access=public-web`. Two things bite. First, `allowedRoutes.namespaces.from` **defaults to `Same`**, meaning only routes in the Gateway's own namespace attach, so a Gateway someone wrote without that block silently refuses every tenant route. Second, the `hostname` on the listener and the `hostnames` on the route must intersect; if they do not, the route is accepted by nobody and the fault is a hostname mismatch rather than a permission.

### HTTPRoute

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: app
  namespace: team-a-app
spec:
  parentRefs:
    - name: public-web
      namespace: platform-gateways
      sectionName: https
  hostnames:
    - app.team-a.example.org
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /
      backendRefs:
        - name: app-v1
          port: 80
          weight: 90
        - name: app-v2
          port: 80
          weight: 10
```

`parentRefs` is the attachment request: which Gateway, in which namespace, optionally which listener via `sectionName`. `backendRefs` are Services in the route's namespace (a cross-namespace backend needs a grant, below). Weights are relative, not percentages, so 90 and 10 gives a 90/10 split and 1 and 0 sends everything to the first backend. The catch: a `backendRef.port` must be the **Service** port, not the container port; the wrong port gives a `BackendNotFound` or a 503 that looks like an empty backend.

### ReferenceGrant: the target namespace owns the permission

A route may reference a Service in another namespace, and a Gateway may reference a Secret in another namespace, only if the **target** namespace has granted it. The grant is a `ReferenceGrant` created **in the namespace that owns the target object**.

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: ReferenceGrant
metadata:
  name: allow-routes-from-team-a-app
  namespace: shared-services          # lives where the Service is
spec:
  from:
    - group: gateway.networking.k8s.io
      kind: HTTPRoute
      namespace: team-a-app           # who is allowed to reference
  to:
    - group: ""
      kind: Service                   # what they may reference
```

Read it as the owner of `shared-services` saying "HTTPRoutes from `team-a-app` may point at Services here". The reason it lives in the target namespace is simple: the owner of the thing being referenced must consent, otherwise any team could point at anyone's Secret or Service. A second grant is needed for a Gateway pointing at a TLS Secret in another namespace, with `from.kind: Gateway` and `to.kind: Secret`. As of Gateway API 1.5, ReferenceGrant is in the standard channel as v1. The catch: the grant has **no status**. You confirm it worked only by watching the route reach `ResolvedRefs=True`.

### Status is the debugger

Everything the controller decided is written back to status. Read the route's parents and the Gateway's listeners and you have the diagnosis.

```bash
kubectl get httproute app -n team-a-app -o yaml
```

Look at `status.parents[].conditions`. A healthy route has `Accepted=True` and `ResolvedRefs=True`. A Gateway's `status.listeners[]` carries per-listener `Accepted`, `ResolvedRefs`, `Programmed`, and `attachedRoutes`.

| Object | Condition | Reason | What it means | Fix |
|---|---|---|---|---|
| Route parent | `Accepted=False` | `NotAllowedByListeners` | No listener's `allowedRoutes` permits this route's namespace or kind | Label the namespace, widen `allowedRoutes`, or move the route |
| Route parent | `Accepted=False` | `NoMatchingListenerHostname` | Listener and route hostnames do not intersect | Fix `hostnames` on route or `hostname` on listener |
| Route parent | `Accepted=False` | `NoMatchingParent` | `sectionName` or `port` matches no listener | Correct `parentRefs` |
| Route parent | `Accepted=False` | `UnsupportedValue` / `IncompatibleFilters` | A field or filter combination the controller rejects | Read the message; remove the offending filter |
| Route parent | `Accepted=False` | `Pending` | Controller has not reconciled yet | Is the controller running? |
| Route parent | `ResolvedRefs=False` | `RefNotPermitted` | Cross-namespace backend without a ReferenceGrant | Add grant in the backend's namespace |
| Route parent | `ResolvedRefs=False` | `BackendNotFound` | Service does not exist, or wrong name or port | Fix name, namespace, or port |
| Route parent | `ResolvedRefs=False` | `InvalidKind` | `backendRef` kind or group unsupported | Use Service, or a kind the implementation supports |
| Gateway | `Programmed=False` | `AddressNotAssigned` / `Pending` / `Invalid` | No LB address yet, controller not reconciling, or config invalid | Check LB provisioner and GatewayClass controller |
| Gateway | `Accepted=False` | `ListenersNotValid`, `InvalidParameters` | One or more listeners or the `parametersRef` are bad | Read listener status |
| Listener | `ResolvedRefs=False` | `InvalidCertificateRef` | TLS Secret missing or malformed | Fix the Secret |
| Listener | `ResolvedRefs=False` | `RefNotPermitted` | TLS Secret in another namespace without a grant | Add grant `from: Gateway` in the Secret's namespace |
| Listener | `Conflicted=True` | `HostnameConflict`, `ProtocolConflict` | Two listeners clash on port, hostname, or protocol | De-duplicate |

Two different kinds of "not allowed" show up, and telling them apart is a mark of fluency. `NotAllowedByListeners` is **the Gateway owner** saying no (the listener's `allowedRoutes`). `RefNotPermitted` is **the backend or Secret owner** saying no (a missing ReferenceGrant). The fix lives in a different namespace and with a different team in each case.

### The catch list

- **Accepted but 503.** `Accepted=True` and `ResolvedRefs=False`: the route attached, the backend did not resolve, the data plane returns 503.
- **Hostname mismatch is silent.** Listener says `*.team-a.example.org`, route says `app.example.org`; nothing errors in apply, the route simply never attaches.
- **`allowedRoutes: Same` with a route in another namespace.** The default. Everything looks right and nothing attaches.
- **Cross-namespace backend without a grant.** Route accepted, backend refused.
- **Gateway not Programmed.** No address, so curl times out or refuses; check the GatewayClass controller and the address provisioner before anything else.
- **Listener `attachedRoutes: 0`.** Useful single number: if it is zero, no route is attached to that listener, whatever the route's own YAML claims.

Common implementations you may be asked about: Envoy Gateway, Cilium, Istio, NGINX Gateway Fabric, Traefik, kgateway. All are listed as conformant for the 1.6 release; the status condition shapes above are the same across them, though message text differs.

As of 1.5, `ListenerSet` is in the standard channel, which lets an application team contribute listeners to a Gateway without editing it; whether your platform exposes that is a policy question for the Gateway owner.

### How Gateway API behaves inside a vCluster

By default Gateway API objects do not sync. To let tenants publish routes, the platform enables `sync.toHost.gatewayApi.httpRoutes` (and `tlsRoutes`, `referenceGrants` as needed) and imports the host Gateway into the virtual cluster with `sync.fromHost.gateways` (plus `gatewayClasses`), with `mappings.byName` translating the host's `namespace/name` to the name the tenant will use in `parentRefs`. GRPCRoute, TCPRoute and UDPRoute have no native sync keys; those need the generic `customResources` path.

```yaml
sync:
  toHost:
    gatewayApi:
      httpRoutes:
        enabled: true
      referenceGrants:
        enabled: auto
  fromHost:
    gatewayClasses:
      enabled: true
    gateways:
      enabled: true
      mappings:
        byName:
          "platform-gateways/public-web": "shared-gateways/shared-web"
```

This says: HTTPRoutes created in the vCluster are copied to the host, and the host Gateway `platform-gateways/public-web` shows up inside the tenant as `shared-gateways/shared-web`. The tenant's route names `shared-web` in `parentRefs`; the syncer translates. The catch is a second debugging surface: **in the default single-namespace mode the syncer itself validates `allowedRoutes` and ReferenceGrants against the tenant's objects, and if the check fails it does not sync the route at all.** It records a Warning event such as `RefNotPermitted` on the tenant's route and the route has no `Accepted` parent. So "no status on the route" in a vCluster means look at `kubectl get events` first, and Gateway status second. This is also why tenants raise tickets for new routes: the host Gateway's listeners, hostnames and namespace labels are platform-owned, and a route outside them never reaches the data plane.

---

## ★ Kyverno: the policy layer for routes and tenants

### Three rule types

**What.** Kyverno is an admission controller whose policies are Kubernetes YAML. A policy has rules of three main kinds.

- **Validate.** Allow or deny a request that matches (for example, deny an HTTPRoute with a hostname outside the tenant's domains).
- **Mutate.** Change the request on the way in (add a label, add a default toleration, inject a securityContext).
- **Generate.** Create other resources in response to an event (when a Namespace is created, generate a NetworkPolicy and a ReferenceGrant).

A cluster-scoped `ClusterPolicy` applies everywhere; a namespaced `Policy` applies in its namespace only. `validationFailureAction: Enforce` blocks a violating request at apply time; `Audit` lets it through and records the violation in a **PolicyReport**.

**Why.** Gateway API tells you what is *allowed to route*; Kyverno tells you what is *allowed to exist*. Letting tenants self-serve routes safely is mostly a Kyverno job.

**The catch.** Kyverno's newer policy types (`ValidatingPolicy`, `MutatingPolicy`, `GeneratingPolicy`, under `policies.kyverno.io/v1`) became stable in 1.17, and `ClusterPolicy` and `Policy` are deprecated, with removal planned in a later release (check the release notes for your version; planned for 1.20 at the time of writing). A cluster that still runs `ClusterPolicy` is normal today, but a platform engineer should know the new types exist and that a policy using `validationActions: [Deny]` replaces `validationFailureAction: Enforce`.

### Which layer rejected my route?

Two different systems can say no, and they speak in different places.

| Evidence | Who said no | Where you see it |
|---|---|---|
| `kubectl apply` fails with `admission webhook "validate.kyverno.svc-fail" denied the request: ...` | Kyverno (Enforce) | Immediately, at apply time, as an error |
| Apply succeeds, `PolicyReport` shows `fail` for the resource | Kyverno (Audit) | `kubectl get policyreport -n <ns>` or `kubectl get polr` |
| Apply succeeds, route `status.parents[].conditions` has `Accepted=False` | Gateway controller | Route status |
| Apply succeeds, tenant route has no status and a Warning event `RefNotPermitted` | vCluster syncer | `kubectl get events` in the vCluster |

The rule of thumb: **an apply-time error is admission (Kyverno); a post-apply condition is the Gateway controller.** If the object exists and has status, Kyverno has already let it through.

### Worked example: restrict route hostnames to a tenant's domains

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: restrict-httproute-hostnames
spec:
  validationFailureAction: Enforce
  background: false
  rules:
    - name: hostnames-must-be-in-tenant-domain
      match:
        any:
          - resources:
              kinds:
                - HTTPRoute
      validate:
        message: "HTTPRoute hostnames must end with .{{request.namespace}}.example.org"
        foreach:
          - list: "request.object.spec.hostnames"
            deny:
              conditions:
                all:
                  - key: "{{ element }}"
                    operator: NotEquals
                    value: "*.{{request.namespace}}.example.org"
```

This rule runs on every HTTPRoute and denies it when a hostname does not fit the namespace's domain. Two catches. The wildcard comparison above is illustrative: production rules use `wildcard` matching functions or a lookup against a tenant-to-domain ConfigMap rather than string equality, so test it with `kyverno test` before enforcing. And `background: false` is needed here because `request.namespace` is not available in background scans.

The same intent in the newer CEL-based type reads as a single expression.

```yaml
apiVersion: policies.kyverno.io/v1
kind: ValidatingPolicy
metadata:
  name: restrict-httproute-hostnames
spec:
  validationActions:
    - Deny
  matchConstraints:
    resourceRules:
      - apiGroups: ["gateway.networking.k8s.io"]
        apiVersions: ["v1"]
        operations: ["CREATE", "UPDATE"]
        resources: ["httproutes"]
  validations:
    - expression: >-
        object.spec.hostnames.all(h, h.endsWith("." + object.metadata.namespace + ".example.org"))
      message: "HTTPRoute hostnames must be under <namespace>.example.org"
```

`validationActions` takes `Deny` and `Audit` (the docs examples use these; whether `Warn` is accepted should be checked against your Kyverno version). The CEL form is evaluated in-process with no per-rule JMESPath, which is why it is the direction of travel.

### Worked example: generate a ReferenceGrant at tenant onboarding

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: onboard-tenant-namespace
spec:
  rules:
    - name: label-and-grant
      match:
        any:
          - resources:
              kinds:
                - Namespace
              selector:
                matchLabels:
                  tenant: "true"
      generate:
        apiVersion: gateway.networking.k8s.io/v1
        kind: ReferenceGrant
        name: allow-gateway-to-cert
        namespace: "{{request.object.metadata.name}}"
        synchronize: true
        data:
          spec:
            from:
              - group: gateway.networking.k8s.io
                kind: Gateway
                namespace: platform-gateways
            to:
              - group: ""
                kind: Secret
```

When a Namespace labelled `tenant=true` is created, Kyverno creates a ReferenceGrant in it that lets the platform Gateway reference Secrets there (the wildcard cert flow). `synchronize: true` means that if someone deletes the grant, Kyverno puts it back. The catch: Kyverno needs RBAC to create ReferenceGrants, and generate rules fail quietly when its service account lacks it, so read the policy's events and the `kyverno-admission-controller` logs when a generated object does not appear.

### Worked example: require tolerations or nodeSelectors

A validate rule can demand that workloads in a namespace declare a `nodeSelector` pointing at the tenant's pool, so tenants cannot land on shared system nodes. The reverse, a **mutate** rule that injects a toleration for a dedicated pool, is convenient and dangerous.

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: add-pool-toleration
spec:
  rules:
    - name: add-toleration
      match:
        any:
          - resources:
              kinds:
                - Pod
              namespaceSelector:
                matchLabels:
                  pool: dedicated
      mutate:
        patchesJson6902: |-
          - op: add
            path: "/spec/tolerations/-"
            value:
              key: "dedicated"
              operator: "Equal"
              value: "tenant"
              effect: "NoSchedule"
```

This appends a toleration to every Pod in namespaces labelled `pool=dedicated`. The catch, and the reason it is in this guide: **a policy that silently mutates tolerations (or strips them, or a mutate rule that fails open) is a legitimate cause of the exact scheduling failure you are debugging.** The pod YAML the tenant wrote has no toleration, the pod on the host has one, or the reverse. When a tolerations story does not add up, `kubectl get pod -o yaml` on the **host** copy is the source of truth, and `kubectl get cpol` plus the pod's annotations (`policies.kyverno.io/last-applied-patches`) tells you what Kyverno changed.

### Rolling out a policy and where Kyverno runs with vCluster

Roll out in stages: ship as `Audit`, read PolicyReports for violations for a week, fix or exempt the legitimate offenders (a `PolicyException`, or `exclude` blocks), then flip to `Enforce`. The catch is that flipping to Enforce with the webhook set to `failurePolicy: Fail` means an unhealthy Kyverno blocks every matching create; keep the webhook scoped, and give it replicas. The built-in ValidatingAdmissionPolicy avoids that class of outage for simple rules (see the Kubernetes guide).

With vCluster there are two models. **Kyverno inside each vCluster** gives tenants their own policy plane and their own PolicyReports, at the cost of N Kyvernos. **One Kyverno on the host**, with vCluster's external admission enforcement, lets the host's webhook configuration cover virtual API servers too; the host Kyverno also sees the synced, renamed pods in the host namespace, so a host-side `Enforce` rule can reject a pod the tenant thought was created successfully (it was admitted by the virtual API server, then refused when the syncer tried to create it on the host). That last case shows up as a syncer error and a Warning event rather than an apply-time error to the tenant.

---

## ★ Storage and scheduling: the taint that blocks a PVC

### WaitForFirstConsumer couples volume to pod

A StorageClass with `volumeBindingMode: WaitForFirstConsumer` does not bind or provision the PV when the PVC is created. It waits until a pod that uses the PVC is scheduled, then binds on that pod's node (or zone). That is deliberate: a local or zonal volume must be created where the pod will run, not where the PVC was created.

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: local-nvme
provisioner: kubernetes.io/no-provisioner
volumeBindingMode: WaitForFirstConsumer
```

```yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: nvme-node-7
spec:
  capacity:
    storage: 200Gi
  accessModes: ["ReadWriteOnce"]
  storageClassName: local-nvme
  local:
    path: /mnt/nvme0
  nodeAffinity:
    required:
      nodeSelectorTerms:
        - matchExpressions:
            - key: kubernetes.io/hostname
              operator: In
              values: ["node-7"]
```

The class says "bind late". The PV says "I exist only on node-7". Together they mean: the PVC cannot bind until a pod is scheduled, and the pod can only be scheduled to a node that satisfies the PV's `nodeAffinity`. If node-7 carries a taint the pod does not tolerate, **both** stay Pending: the pod because no node is eligible, the PVC because there is no consumer scheduled yet. This is not a deadlock in the strict sense, it is a missing toleration, but it presents as two Pending objects that each point at the other.

### How to read it

```bash
kubectl describe pod web-0 -n demo
# Events:
#   Warning  FailedScheduling  0/6 nodes are available: 1 node(s) had untolerated taint
#   {dedicated: storage}, 5 node(s) had volume node affinity conflict.
#   preemption: 0/6 nodes are available: 6 Preemption is not helpful for scheduling.

kubectl describe pvc data-web-0 -n demo
# Events:
#   Normal  WaitForFirstConsumer  persistentvolume-controller
#   waiting for first consumer to be created before binding
```

Read the pod message as an arithmetic proof: six nodes, five rejected for "volume node affinity conflict" (they are not node-7, so the local PV cannot be used there), one rejected for the taint (node-7 itself). The one node that could satisfy the volume is the one the pod cannot land on. The PVC event is not an error, it is the normal waiting message; the cause lives on the pod. The catch for newcomers is to chase the PVC because it is the "storage" object. The fix always starts at the pod's FailedScheduling message.

### Fix options and which one to pick

| Option | When | Cost |
|---|---|---|
| Add a toleration to the workload | The node is dedicated storage and this workload is meant to use it | Safest: scoped to the workload; pair with nodeSelector so it is intended |
| Retaint or remove the taint | The taint is stale, or wrongly applied | Affects every other workload on that node; blast radius is wide |
| Change StorageClass topology / `allowedTopologies` | The volume could live on a non-tainted node | Requires new volumes; data does not move |
| Move the volume (restore to another PV/node) | The data must run elsewhere | Slow and risky; last resort |

A platform engineer reaches for the toleration first, delivered through whatever mechanism owns the workload (the Helm values, or a Kyverno rule if tenants are not supposed to hand-write tolerations). Removing the taint is the tempting one-liner and the wrong default because it undoes an isolation decision someone made on purpose.

```yaml
spec:
  tolerations:
    - key: dedicated
      operator: Equal
      value: storage
      effect: NoSchedule
```

This allows the pod to land on nodes tainted `dedicated=storage:NoSchedule`. Remember from the Kubernetes guide that a toleration only permits; the PV's `nodeAffinity` is what attracts here. In a vCluster, remember also that this must reach the pod that the **host** scheduler sees, so a toleration added by a host-side mutate rule and a toleration written by the tenant are both valid sources, and the host copy is the one that counts.

---

## ★ The drill, worked end to end

The task: `curl https://app.team-a.example.org/healthz` fails. You have access to the vCluster and, as the platform engineer, to the host. Narrate "outside in".

### Step 1: read the curl

```bash
curl -sv https://app.team-a.example.org/healthz -o /dev/null 2>&1 | grep -E "^(\*|<)" | head -20
```

```text
* Connected to app.team-a.example.org (203.0.113.40) port 443
* SSL connection using TLSv1.3
< HTTP/2 404
< server: envoy
< content-length: 0
```

Say: "DNS resolves, TLS completes, I get an Envoy 404 with an empty body. The gateway is alive and serving this hostname's certificate, but no route matched. The fault is at or before the route." That one paragraph rules out DNS, the load balancer and the listener certificate in under a minute. A 503 here would have sent you to Step 4 directly.

### Step 2: the Gateway

```bash
kubectl --context host get gateway -A
```

```text
NAMESPACE           NAME         CLASS   ADDRESS        PROGRAMMED   AGE
platform-gateways   public-web   envoy   203.0.113.40   True         41d
```

`PROGRAMMED=True` and an address that matches the one curl connected to. Check the listener for attached routes.

```bash
kubectl --context host -n platform-gateways get gateway public-web \
  -o jsonpath='{range .status.listeners[*]}{.name}{"  attached="}{.attachedRoutes}{"\n"}{end}'
```

```text
https  attached=0
```

`attachedRoutes=0` confirms it: the Gateway is healthy and nothing is attached to the `https` listener. Now the route.

### Step 3: the route

Inside the vCluster:

```bash
vcluster connect team-a --namespace vc-team-a
kubectl get httproute app -n team-a-app -o yaml
```

```yaml
status:
  parents:
    - parentRef:
        name: shared-web
        namespace: shared-gateways
        sectionName: https
      controllerName: gateway.envoyproxy.io/gatewayclass-controller
      conditions:
        - type: Accepted
          status: "False"
          reason: NotAllowedByListeners
          message: Listener does not allow route from namespace team-a-app
        - type: ResolvedRefs
          status: "False"
          reason: RefNotPermitted
          message: Backend ref to Service shared-services/app-v1 not permitted by any ReferenceGrant
```

Two faults at once, which is the interview twist. `NotAllowedByListeners` is the Gateway owner saying no: the listener's `allowedRoutes` does not include this namespace. `RefNotPermitted` is the backend owner saying no: the Service lives in `shared-services` and nobody granted the route access. Fix both, in their respective owner namespaces.

If the route had **no status at all**, you would check events instead, because the syncer may have refused to sync it:

```bash
kubectl get events -n team-a-app --field-selector involvedObject.name=app
```

```text
Warning  RefNotPermitted  httproute/app  route namespace "team-a-app" not allowed by listener "https" of gateway shared-gateways/shared-web
```

Fix 1 (platform team owns the Gateway policy): label the tenant namespace so the listener's selector matches. In default single-namespace mode the syncer checks the label on the namespace inside the vCluster; in multi-namespace mode the host's mapped namespace is the one the gateway controller checks.

```bash
kubectl label namespace team-a-app gateway-access=public-web
```

or widen the listener:

```yaml
allowedRoutes:
  namespaces:
    from: Selector
    selector:
      matchLabels:
        gateway-access: public-web
```

Fix 2, in `shared-services` (the backend's owner):

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: ReferenceGrant
metadata:
  name: allow-team-a-routes
  namespace: shared-services
spec:
  from:
    - group: gateway.networking.k8s.io
      kind: HTTPRoute
      namespace: team-a-app
  to:
    - group: ""
      kind: Service
      name: app-v1
```

Pinning `to.name` narrows the grant to one Service, which is the least-privilege form and the better answer in the room. After both fixes, re-read the route; both conditions should flip. If they do and curl now returns a 503, you are one layer in.

### Step 4: service and endpoints

```bash
kubectl get endpointslices -n shared-services -l kubernetes.io/service-name=app-v1
```

```text
NAME             ADDRESSTYPE   PORTS   ENDPOINTS   AGE
app-v1-x7k2p     IPv4          8080    <unset>     41d
```

No endpoints. The Service exists and its selector is plausible, but no Ready pod backs it. This is the Kubernetes guide's Scenario 5 territory (selector, targetPort, Ready), so check pods next.

```bash
kubectl get pods -n shared-services -l app=app-v1
```

```text
NAME       READY   STATUS    RESTARTS   AGE
app-v1-0   0/1     Pending   0          3h
```

Pending. Here is the vCluster fork. **Inside the vCluster** the tenant describe says:

```bash
kubectl describe pod app-v1-0 -n shared-services
```

```text
Events:
  Warning  FailedScheduling  ... 0/6 nodes are available: pod has unbound immediate PersistentVolumeClaims.
```

The tenant-side message is vague (the virtual API server does not know host nodes). **On the host**, with the rewritten name:

```bash
kubectl --context host -n vc-team-a get pods | grep app-v1
kubectl --context host -n vc-team-a describe pod app-v1-0-x-shared-services-x-team-a
```

```text
Events:
  Warning  FailedScheduling  ... 0/6 nodes are available: 1 node(s) had untolerated taint
  {dedicated: storage}, 5 node(s) had volume node affinity conflict.
```

### Step 5: the PVC and the taint

```bash
kubectl --context host -n vc-team-a describe pvc data-app-v1-0-x-shared-services-x-team-a
```

```text
StorageClass:  local-nvme
Status:        Pending
Events:
  Normal  WaitForFirstConsumer  waiting for first consumer to be created before binding
```

The picture is complete: a WaitForFirstConsumer PVC whose only eligible PV lives on a node tainted `dedicated=storage:NoSchedule`, and a pod with no matching toleration. The PVC is waiting on the pod and the pod is blocked by the taint, so both stay Pending and the Service has no endpoints.

Fix: add the toleration to the workload (in the tenant's Deployment or StatefulSet, or through the platform's mechanism), pair it with a selector so the intent is explicit.

```yaml
spec:
  template:
    spec:
      nodeSelector:
        storage-tier: nvme
      tolerations:
        - key: dedicated
          operator: Equal
          value: storage
          effect: NoSchedule
```

Because a StatefulSet's pod template is mostly mutable (tolerations are, via the template), applying this rolls the pod. The new pod is scheduled to node-7, the PVC binds, and the pod goes Ready.

### Step 6: verify end to end

```bash
kubectl get httproute app -n team-a-app \
  -o jsonpath='{range .status.parents[0].conditions[*]}{.type}={.status} {.reason}{"\n"}{end}'
kubectl get endpointslices -n shared-services -l kubernetes.io/service-name=app-v1
curl -s -o /dev/null -w "%{http_code}\n" https://app.team-a.example.org/healthz
```

```text
Accepted=True Accepted
ResolvedRefs=True ResolvedRefs
NAME             ADDRESSTYPE   PORTS   ENDPOINTS     AGE
app-v1-x7k2p     IPv4          8080    10.42.7.19    41d
200
```

All conditions True, an endpoint present, curl returns 200. Close the loop out loud: "Two independent faults, route permission and a taint blocking the volume's only node. I would also ask why the taint was not covered by the workload's template, and add a Kyverno validate or a chart default so the next tenant does not hit it."

---

## ★ Practice drills

### Drill 1: 404 and the route says Accepted=False, NoMatchingListenerHostname

Symptom: curl returns a gateway 404. The route exists, `attachedRoutes` is 0. Ranked causes: listener hostname and route hostnames do not intersect; route `sectionName` points at a different listener; a wildcard listener `*.example.org` versus a route host `app.team-a.example.org` is fine, but `*.team-a.example.org` versus `app.example.org` is not.

```bash
kubectl get gateway public-web -n platform-gateways -o jsonpath='{.spec.listeners[*].hostname}{"\n"}'
kubectl get httproute app -n team-a-app -o jsonpath='{.spec.hostnames}{"\n"}'
kubectl get httproute app -n team-a-app -o jsonpath='{.status.parents[*].conditions[?(@.type=="Accepted")].reason}{"\n"}'
```

Fix at the owner: if the platform's listener is correct, change the route's `hostnames`; if the tenant needs a domain the listener does not cover, the platform adds a listener or a ListenerSet. The catch: no apply-time error is raised for a hostname that cannot match, so this fails silently unless you read status.

### Drill 2: HTTPS listener not Accepted, TLS Secret in another namespace

Symptom: TLS handshake fails or the listener shows `ResolvedRefs=False`. The wildcard Secret lives in `cert-store`, the Gateway in `platform-gateways`.

```bash
kubectl get gateway public-web -n platform-gateways -o jsonpath='{.status.listeners[?(@.name=="https")].conditions}' | jq .
```

```text
[{"type":"ResolvedRefs","status":"False","reason":"RefNotPermitted",
  "message":"Secret cert-store/team-a-wildcard not permitted by any ReferenceGrant"}]
```

Fix: a ReferenceGrant in `cert-store` with `from.kind: Gateway`, `from.namespace: platform-gateways`, `to.kind: Secret`. The catch: the grant goes in the **Secret's** namespace, and the `from` kind is Gateway, not HTTPRoute. Mixing these up is the most common version of this mistake.

### Drill 3: Weighted canary sending 100% to the wrong backend

Symptom: a 90/10 split sends everything to v2. Ranked causes: weights written on the wrong list or with a typo (`weight: 0` on v1); two rules, the more specific path rule overriding; an implementation that treats a missing `weight` as 1 and an explicit `0` as drain.

```bash
kubectl get httproute app -n team-a-app -o jsonpath='{range .spec.rules[*].backendRefs[*]}{.name}{"="}{.weight}{"\n"}{end}'
for i in $(seq 1 50); do curl -s https://app.team-a.example.org/version; echo; done | sort | uniq -c
```

Fix: set both weights explicitly and check there is no second rule with a longer prefix match capturing the traffic. The catch: weights are relative, so `weight: 1` and `weight: 9` give 10/90; a backend with no endpoints still receives its share and returns 503s, which can look like a flaky app rather than a canary pointing at a dead Service.

### Drill 4: A tenant PVC is Pending because the host quota is exhausted

Symptom: PVC Pending inside the vCluster, no useful event for the tenant. Ranked causes: host `ResourceQuota` on the vCluster's namespace (`requests.storage` or PVC count); StorageClass with no capacity; WaitForFirstConsumer waiting on an unscheduled pod.

```bash
kubectl --context host -n vc-team-a describe resourcequota
kubectl --context host -n vc-team-a get pvc
kubectl --context host -n vc-team-a describe pvc data-x-demo-x-team-a
```

```text
Name:             vc-team-a-quota
Resource          Used    Hard
requests.storage  980Gi   1Ti
persistentvolumeclaims  24  25
```

Fix at the owner: raise the quota (a platform decision), or have the tenant delete unused PVCs. The catch: quota is enforced where the object is created, which is the **host** namespace, so the tenant's own virtual `ResourceQuota` can show plenty of room while the host one is full. The failure message is often a `forbidden: exceeded quota` on the syncer's create, visible in syncer logs.

### Drill 5: A vCluster pod is Running but DNS fails

Symptom: the app logs `no such host` for a Service name; the pod is Running and Ready. Ranked causes: the vCluster's CoreDNS pod is down or not synced; the Service being resolved was never synced to the host (disabled resource, or a name that only exists in the virtual cluster as an ExternalName); the pod's `ndots` search path produces many failed lookups (see the Linux guide's "DNS and `ndots`").

```bash
kubectl get pods -n kube-system -l k8s-app=kube-dns
kubectl run dnscheck --image=busybox:1.36 --restart=Never -it --rm -- nslookup app-v1.shared-services.svc.cluster.local
kubectl --context host -n vc-team-a get pods | grep coredns
```

Fix: restore CoreDNS (in a vCluster it is usually a synced pod in the host namespace, so check the host event log for it too), or enable the missing sync. The catch: tenant "cluster.local" names resolve inside the virtual cluster's CoreDNS, not the host's, so the host's DNS being healthy proves nothing.

### Drill 6: Gateway has no address because the GatewayClass controller is not running

Symptom: `kubectl get gateway` shows an empty ADDRESS and `PROGRAMMED` is blank or False; routes show `Accepted=False, reason Pending`. Ranked causes: the controller (Envoy Gateway, Cilium operator, NGINX Gateway Fabric) is not running or is crash-looping; the GatewayClass is not `Accepted`; the cluster has no LoadBalancer provider so the data-plane Service stays `<pending>`.

```bash
kubectl get gatewayclass
kubectl get gateway -A
kubectl -n envoy-gateway-system get pods
kubectl -n envoy-gateway-system get svc
```

```text
NAME    CONTROLLER                                       ACCEPTED   AGE
envoy   gateway.envoyproxy.io/gatewayclass-controller    Unknown    41d
```

Fix: restore the controller first, since nothing downstream will reconcile without it; then check for the LB provisioner. The catch: a `Pending` route reason means "no controller has reconciled this", which is not a problem with the route at all. On bare metal or MicroK8s-style clusters, the data-plane Service may never get an external IP without MetalLB or equivalent, and a vCluster does not synthesize addresses.

---

## Question bank

Questions are grouped loosely from "what is it" to "what would you do". Answers are the short version you would say aloud.

| Question | What they are testing | Concise answer |
|---|---|---|
| What is a vCluster? | Basic model | A control plane per tenant running as pods in a host namespace, plus a syncer that copies selected objects (pods, services, PVCs) to the host where they actually run. |
| vCluster vs namespaces vs a dedicated cluster? | Tradeoff reasoning | Namespaces are cheap but share the API server and CRDs. vCluster gives each tenant an API server and CRD freedom on shared nodes. Dedicated clusters give hard isolation at full cost. None of the first two isolate the kernel. |
| What does the syncer do? | Mechanism | Watches the virtual API server and the host namespace; copies enabled resource kinds to the host with rewritten names, and copies status and events back. |
| Who schedules a vCluster pod? | Layer awareness | The host scheduler by default, onto host nodes, so host taints, selectors and quota apply. An optional virtual scheduler exists but host constraints still hold at the kubelet and admission. |
| What is the host name of tenant pod `web` in ns `demo`, vCluster `team-a`? | Debug skill | `web-x-demo-x-team-a` in the host namespace that holds the vCluster. |
| Which resources sync by default? | Config knowledge | Pods, services, endpoints, PVCs, configmaps, secrets to host; events from host. Ingresses, Gateway API, PVs, StorageClasses, nodes and CRs are opt-in. |
| A tenant creates an Ingress and nothing happens. Why? | Gotcha | `sync.toHost.ingresses` is off by default, so the object exists only in the virtual cluster. |
| Tenant sees Pending, cause is invisible. Where do you look? | Cross-boundary debugging | Host side: describe the renamed pod, check taints, host ResourceQuota, and PVC events. |
| Ingress vs Gateway API? | Fluency | Gateway API splits roles (GatewayClass, Gateway, Route), is typed instead of annotation-driven, and has explicit cross-namespace permission with allowedRoutes and ReferenceGrant. |
| Who owns which Gateway API object? | Role model | Infra provider owns GatewayClass, platform or cluster operator owns Gateway, app teams own HTTPRoute. |
| What is `allowedRoutes`? | Listener policy | A listener field that restricts which namespaces and route kinds may attach; default namespaces `from: Same`. |
| What is a ReferenceGrant and which namespace does it live in? | Cross-namespace permission | It lets a resource in one namespace reference one in another. It lives in the **target** namespace, because the owner of the referenced object must consent. |
| What are the two uses of a ReferenceGrant in Gateway API? | Detail | Route to a Service in another namespace (from HTTPRoute, to Service), and Gateway to a TLS Secret in another namespace (from Gateway, to Secret). |
| How do you debug a route that is not attached? | Method | Read `status.parents[].conditions` on the route, then `status.listeners[]` on the Gateway (`attachedRoutes`), then events if status is empty (syncer in a vCluster). |
| What do Accepted and ResolvedRefs mean on a route? | Status literacy | Accepted: the Gateway agreed to attach it (listener allows, hostname matches, parent exists). ResolvedRefs: every backendRef resolved (exists, permitted). Accepted but not ResolvedRefs gives a 503. |
| NotAllowedByListeners vs RefNotPermitted? | Precision | The first is the Gateway owner's allowedRoutes saying no; the second is the backend or Secret owner's missing ReferenceGrant. Different owners, different fix namespaces. |
| 404 versus 503 from the gateway? | Layer reading | 404: the gateway has no matching route (fault at or before the route). 503: a route matched but the backend is unresolved or has no ready endpoints (fault at or after the Service). |
| Gateway has no address. What do you check? | Ordering | GatewayClass Accepted, controller pods running, data-plane Service type and LB provisioner, then Gateway `Programmed` reason. |
| Listener hostname versus route hostname? | Silent failure | They must intersect or the route never attaches; no apply-time error, only `NoMatchingListenerHostname`. |
| How do you do a canary in Gateway API? | Feature | Two `backendRefs` with relative `weight`s on one rule; weights are not percentages. |
| How does WaitForFirstConsumer interact with taints? | Crossover | The PVC binds only after a pod is scheduled; if the only node satisfying the PV's nodeAffinity is tainted and the pod lacks the toleration, pod and PVC both stay Pending. |
| Pod Pending with `volume node affinity conflict`. Meaning? | Reading events | The pod's bound or candidate PV is pinned to a node the pod cannot be placed on, or no node satisfies both the PV and pod constraints. |
| Toleration vs nodeSelector for dedicated nodes? | Scheduling catch | A toleration permits; it does not attract. Use a taint to repel others and a selector or affinity to attract yours. |
| Which fix for the taint blocking a PVC? | Judgment | Add a toleration (plus selector) to the workload; avoid removing the taint, which undoes an isolation choice for every workload on that node. |
| Validate vs mutate vs generate rules in Kyverno? | Concepts | Validate allows or denies; mutate changes the request; generate creates other resources in response to an event. |
| Enforce vs Audit, and how do you roll out a new policy? | Operations | Enforce blocks at admission; Audit records in PolicyReports. Ship as Audit, read reports, fix or exempt offenders, then Enforce, with the webhook scoped and replicated. |
| How would you let tenants self-serve routes safely with Kyverno? | Design | Validate hostnames against the tenant's domains, generate the namespace label and ReferenceGrants at onboarding, require backends in the same namespace, keep Gateway listeners platform-owned. |
| How do you tell a Kyverno rejection from a Gateway rejection? | Diagnosis | Kyverno denies at apply time with an admission webhook error (or shows in a PolicyReport); the Gateway controller writes a condition on the route status after the object exists. |
| Where does Kyverno run with vCluster? | Architecture | Inside each vCluster for tenant-owned policy, or one host Kyverno covering virtual API servers via vCluster's external admission enforcement; host Kyverno also sees synced pods. |
| Can a Kyverno policy cause a scheduling failure? | Insight | Yes: a mutate rule that adds, strips, or fails to add tolerations or selectors changes the pod the scheduler sees. Inspect the host pod YAML and last-applied-patches. |
| Which Gateway API implementations do you know? | Landscape | Envoy Gateway, Cilium, Istio, NGINX Gateway Fabric, Traefik, kgateway; all conformant to recent releases, with differences in extension policies and defaults. |
| Version skew between virtual and host control planes? | Operations | Upgrade host first, then vClusters, and re-test sync; a virtual API newer than the host can accept manifests the host side cannot translate. |

---

## How to say it in the room

### Narrate the funnel

Open with the frame, then keep to it. A narration that works under pressure:

"I will go from the outside in: gateway, route, service, pod, volume. First the curl, to see which layer fails. Then the Gateway's Programmed status and the listener's attached routes. Then the route's parent conditions, which tell me whether the Gateway accepted it and whether its backends resolved. Then the Service's EndpointSlices, then the pod's events, then the PVC. In a vCluster I check both sides, because the tenant sees the symptom and the host holds the cause."

Say the layer before you run the command, and say what the output means after. Interviewers are scoring the reasoning, and a wrong guess that you rule out cleanly scores better than a lucky command you cannot explain.

Two lines worth having ready: "404 means the gateway does not know this request belongs to anyone; 503 means it knows and nobody is home." And: "A toleration permits, it does not attract, so I would pair it with a selector."

### The honest bridge

Do not bluff. A line that is true and strong:

"I have not run vCluster or the Gateway API in production. My production experience is a single Ingress fronting several services on MicroK8s, and I hold the CKA and CKAD, so scheduling, taints, PVC binding and storage classes are things I know well underneath. What is new to me is the control-plane split and the status model. The way I reason about it is the same as for Ingress: find the owner of each object, read what that owner's controller wrote back in status, and fix at the owner layer rather than patching the symptom."

Then show it: name the one vCluster fact you know cold (the default sync list and that the host scheduler places pods), and the one Gateway API fact (`allowedRoutes` defaults to `Same` and ReferenceGrants live in the target namespace). Two precise facts earn more trust than ten vague ones.

### Facts to treat as time-sensitive

Marked as of writing: vCluster 0.37 (config under `sync.toHost` and `sync.fromHost`, Gateway API sync under `sync.toHost.gatewayApi`), Gateway API 1.6 (HTTPRoute, GRPCRoute, ReferenceGrant, ListenerSet and TLSRoute are standard channel), Kyverno 1.19 (CEL policy types are v1, `ClusterPolicy` deprecated). Flag names for `vcluster connect` and the exact syncer container name vary by version; confirm with `--help` and `kubectl get pod -o yaml` on the day. The condition types and reasons above are stable across Gateway API releases and across implementations.
