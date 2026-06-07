## How to use this guide

The four language guides in this set each end with a metrics section that gestures at load balancing, caching, the availability "nines," and request percentiles. This is the shared reference those sections point to. It is deliberately framework-agnostic: an interviewer probing a Kotlin/Spring shop, a Node fleet, or a Python service expects the same vocabulary here, because these concerns live in the architecture, not the language. Treat it as the system-design backbone behind every backend round.

---

## Load balancing: L4 versus L7

A load balancer spreads requests across many instances so that no one instance is a bottleneck or a single point of failure. The first distinction to state cleanly is the layer it operates at. A Layer 4 load balancer works at the TCP/UDP level: it forwards packets based on IP and port without reading the payload, so it is fast and protocol-agnostic but cannot make decisions based on the HTTP request. A Layer 7 load balancer terminates the connection, reads the HTTP request, and can route on path, header, host, or cookie, at the cost of more work per request. Most application traffic uses L7 (AWS ALB, Nginx, Envoy, HAProxy in HTTP mode); L4 (AWS NLB, HAProxy in TCP mode) is for raw throughput, non-HTTP protocols, or when you want TLS to pass through untouched.

The balancing algorithm is the next layer of the answer. Round-robin rotates through instances evenly and is the sensible default when instances are uniform and requests are cheap. Least-connections routes to the instance with the fewest active connections, which is better when request durations vary widely, because it avoids piling long requests onto an already-busy node. Consistent hashing maps a key (a user ID, a cache key) to an instance so the same key reliably hits the same node, which is essential for cache locality and sticky routing; its virtue is that adding or removing one node remaps only a small fraction of keys instead of reshuffling everything.

| Algorithm | Routes by | Best when |
|---|---|---|
| Round-robin | Rotation | Uniform instances, cheap uniform requests |
| Least-connections | Fewest active conns | Highly variable request durations |
| Weighted | Capacity weights | Heterogeneous instance sizes |
| Consistent hashing | Hash of a key | Cache locality, sticky routing, sharding |

Two operational pieces complete the picture. Health checks let the balancer stop routing to a sick instance: an active check periodically probes a `/health` endpoint and ejects failing nodes, which is what actually delivers availability, since a balancer that keeps sending traffic to a dead node provides no redundancy. Distinguish liveness (is the process up) from readiness (is it ready to serve, with warm caches and live dependencies), and only route to ready instances. Sticky sessions (session affinity) pin a user to one instance, usually via a cookie; treat them as a smell, because they undermine even balancing and make a node's failure lose those users' state. The better design is stateless instances with shared session state in Redis, so any instance can serve any request and you can roll deploys freely.

TLS termination is the last decision: terminate at the load balancer (simplest, lets the LB inspect and route on L7, but traffic is plaintext inside the network) or re-encrypt to the backend (mTLS for zero-trust internal networks). State where you terminate and why, because it determines what the balancer can see and what your internal threat model assumes.

---

## Caching: the layers and the hard parts

Caching trades freshness for speed and load reduction by keeping a copy of expensive-to-produce data close to where it is needed. The senior framing is to name the layers, because caching is not one thing: the browser cache (client-side, controlled by HTTP headers), the CDN (edge cache for static and cacheable responses near the user), the application cache (an in-process or shared cache like Redis for computed results and hot rows), and the database's own buffer cache. Each layer absorbs load the layers below it never see; a request served from CDN never touches your origin at all.

The application-cache pattern interviewers probe most is cache-aside (lazy loading): the application checks the cache, and on a miss reads the database, populates the cache, and returns. It is simple and resilient (a cache outage degrades to slower direct reads, not an error), which is why it is the default.

```text
read(key):
  v = cache.get(key)
  if v is not None: return v          # hit
  v = db.read(key)                    # miss: go to source
  cache.set(key, v, ttl=300)          # populate for next time
  return v
```

The alternatives trade simplicity for consistency. Write-through writes to cache and database together on every write, keeping the cache always fresh at the cost of write latency. Write-back (write-behind) writes to cache immediately and flushes to the database asynchronously, which is fast but risks data loss if the cache dies before the flush. Choose cache-aside for read-heavy workloads that tolerate slightly stale data; reach for write-through only when reads must never see stale values and you accept slower writes.

The hard part of caching, and the staff-level content, is invalidation and the failure modes. Stale data: the cache holds a value the database has since changed. The blunt fix is a short TTL so staleness is time-bounded; the precise fix is explicit invalidation on write (delete or update the key when the underlying row changes), which is correct but couples writes to cache knowledge. The classic failure modes each have a name worth knowing:

- **Cache stampede (thundering herd)**: a hot key expires and thousands of concurrent requests all miss and hit the database at once, possibly toppling it. Defend with a short lock or "single-flight" so only one request recomputes while others wait, with request coalescing, or with probabilistic early expiration that refreshes a hot key slightly before it expires.
- **Cache penetration**: requests for keys that do not exist bypass the cache and always hit the database (often a scraping or attack pattern). Defend by caching the negative result (a "not found" marker with a short TTL) or with a Bloom filter of known keys.
- **Cache avalanche**: many keys expire simultaneously (for example, all set with the same TTL at deploy), flooding the database. Defend by jittering TTLs so expirations spread out.

Eviction is the last piece: when a fixed-size cache fills, it evicts by a policy, usually LRU (least recently used) or LFU (least frequently used). Sizing and eviction policy directly set your hit rate, and hit rate is the metric that determines whether the cache is earning its place; a cache below roughly 80 to 90 percent hit rate on hot data is often more operational risk than benefit.

---

## Security: the baseline that is assumed, not asked

Security questions at staff level assume a working baseline and probe whether you build it in by default. Encrypt in transit with TLS everywhere, including internal service-to-service traffic in a zero-trust model; terminate or re-encrypt deliberately (see load balancing). Manage secrets in a dedicated store (AWS Secrets Manager, Vault, cloud KMS), injected at runtime, never committed to source or baked into images; rotation should be possible without a code change.

The OWASP Top 10 is the checklist interviewers expect you to internalize rather than recite. The high-frequency items: injection (SQL and command), prevented by parameterized queries and never string-concatenating untrusted input; broken access control, the most common serious flaw, where authorization is checked inconsistently or missing on an endpoint; cryptographic failures, like storing passwords unhashed or using weak algorithms; and security misconfiguration, like permissive CORS, verbose error pages, or default credentials. The unifying principle is to validate and encode at trust boundaries: validate input on the way in (reject malformed data at the edge), encode output on the way out (so data cannot be interpreted as code by the next consumer).

```python
# Injection defense: parameterized query, never string interpolation
# WRONG: f"SELECT * FROM orders WHERE id = {user_input}"   <- SQL injection
cur.execute("SELECT * FROM orders WHERE id = %s", (user_input,))   # safe
```

Rate limiting is both a security and a reliability control: it caps how fast any client can hit you, blunting brute-force, scraping, and accidental floods. The common algorithm is a token bucket (each client gets tokens that refill at a fixed rate; a request spends one, and an empty bucket means rejection with HTTP 429), usually enforced at the gateway or load balancer so abusive traffic dies before it reaches application capacity. Pair it with sensible request timeouts and payload-size limits so a single slow or huge request cannot exhaust resources.

---

## Authentication versus authorization

Keep the two words distinct, because conflating them is an instant tell. Authentication (authn) establishes *who* you are; authorization (authz) determines *what* you may do. They are separate stages, and a request passes authn first, then authz.

For authentication, the central design choice is server-side sessions versus tokens. A session stores state on the server (or in a shared store like Redis) and hands the client an opaque session ID in a cookie; every request looks up the session. Tokens, typically a JWT, are self-contained: the server signs a token carrying the user's identity and claims, and the client presents it on each request, so the server validates the signature without a lookup. The trade-off is the heart of the question: sessions are trivially revocable (delete the server record) but require shared session storage to scale horizontally; JWTs are stateless and scale without shared storage but are hard to revoke before they expire, because anyone holding a valid signed token is trusted until expiry.

| Aspect | Server-side sessions | JWT (stateless) |
|---|---|---|
| State | Stored server-side | Carried by the client |
| Revocation | Immediate (delete record) | Hard until expiry |
| Horizontal scaling | Needs shared session store | No shared state needed |
| Payload visibility | Opaque ID only | Claims readable (signed, not encrypted) |

The standard resolution to JWT's revocation weakness is the short-lived access token plus a long-lived refresh token: the access token expires in minutes (so a leaked one is useless quickly), and the client exchanges a refresh token for a new access token, with the refresh token revocable server-side. Two correctness notes that read as senior: a JWT is signed, not encrypted, so never put secrets in its claims (anyone can decode them); and store tokens carefully (an HttpOnly, Secure, SameSite cookie resists XSS theft better than `localStorage`).

For delegated authentication you reach for OAuth2 and OIDC, and stating their relationship correctly matters. OAuth2 is an *authorization* framework for granting a third party scoped access to resources without sharing the password (the access-token grant). OpenID Connect (OIDC) is a thin identity layer on top of OAuth2 that adds an ID token, turning it into *authentication* ("log in with Google"). The flow to know is Authorization Code with PKCE, now the recommended flow for web and mobile apps, where the client redirects to the identity provider, receives a short-lived code, and exchanges it server-side for tokens, with PKCE preventing code interception.

Authorization models split into RBAC and ABAC. Role-Based Access Control grants permissions to roles and roles to users (admin, editor, viewer); it is simple and audit-friendly and covers most needs. Attribute-Based Access Control decides from attributes of the user, resource, and context (department equals owner, time is business hours, region matches), which is far more expressive but harder to reason about and test. The pragmatic answer is RBAC by default, ABAC where the rules genuinely depend on data relationships. The architectural question that follows is *where* authorization lives: coarse checks (is this caller authenticated, does it hold this scope) belong at the API gateway, while fine-grained checks (may *this* user edit *this specific* order) must live in the service, because only the service knows the resource's ownership. Putting all authz at the gateway leaks domain rules out of the service; putting all of it in the service duplicates coarse checks everywhere. Split by granularity.

---

## The reliability vocabulary: nines, percentiles, RPS

This is the shared numeric language the language guides defer to. Three quantities recur, and you should be near-instantly fluent in each.

Throughput (requests per second, RPS) is how much load the system serves. Its ceiling is rarely the web framework; it is usually a downstream resource, and Little's Law gives the bound: concurrency equals throughput times latency. If each request holds one of a 50-connection database pool for 10 milliseconds, the ceiling is 50 / 0.010 = 5000 RPS regardless of how many app instances you run, because the pool, not the CPU, is the constraint. This is why "just add instances" stops helping past a point, and naming the real bottleneck (the pool, the database, a downstream service) is the staff-level move.

Latency must be reported as percentiles, never as an average, because the average hides the tail and the tail is what users feel. p50 (median) is the typical experience, p99 is the unlucky one-in-a-hundred, p99.9 is the rare but real worst case. The compounding effect is the insight to volunteer: in a request that fans out to several backends, the slowest one sets the latency, so tail latencies multiply. If each of five parallel calls is slow 1 percent of the time, roughly 1 in 20 requests (1 minus 0.99 to the fifth) hits at least one slow call, so the overall p95 is governed by each dependency's p99. Reducing tail latency is therefore worth more than reducing the median at scale.

The availability "nines" convert an uptime target into a concrete downtime budget, and the common rows should be instant recall.

| Availability | Downtime per year | Downtime per 30 days | Per day |
|---|---|---|---|
| 99% (two nines) | 3.65 days | 7.2 hours | 14.4 min |
| 99.9% (three nines) | 8.77 hours | 43.2 minutes | 1.44 min |
| 99.95% | 4.38 hours | 21.6 minutes | 43 s |
| 99.99% (four nines) | 52.6 minutes | 4.32 minutes | 8.6 s |
| 99.999% (five nines) | 5.26 minutes | 25.9 seconds | 0.86 s |

The point to make with this table is that high availability is an architecture property, not a setting. A single instance cannot reach three nines, because one deploy, one crash, or one bad release exceeds a 43-minute monthly budget. Each added nine costs disproportionately more (redundancy across zones, automated failover, progressive rollouts, fast rollback), so the senior question is never "how do we get five nines" but "what availability does this service actually need, and what does the next nine cost." Many internal services are fine at three nines; only the critical path warrants four.

---

## SLI, SLO, and the error budget

The framework that ties throughput, latency, and availability into a decision tool is the SLI/SLO/error-budget model, and it is the natural close to a system-design round. A Service Level Indicator (SLI) is a measured signal of health: request success rate, p99 latency, availability. A Service Level Objective (SLO) is the target for an SLI over a window: "99.9 percent of requests succeed within 200 milliseconds, measured over 28 days." A Service Level Agreement (SLA) is the contractual version with consequences, and it is always looser than the internal SLO so you have headroom before breaching the contract.

The error budget is the operational payoff, and explaining it signals real production maturity. If the SLO is 99.9 percent, then 0.1 percent of requests are *allowed* to fail; that allowance is the error budget, and it is a resource you spend deliberately. When the budget is healthy, you ship faster and take more risk, because you have room to absorb a bad deploy. When you have burned the budget, you freeze risky changes and pour effort into reliability until it recovers. This reframes the eternal tension between shipping features and keeping things stable as a number both sides can see: reliability is not infinite and not free, the budget says exactly how much risk this period can afford, and a deploy that would blow the remaining budget waits. That is the staff-level synthesis the whole metrics conversation is building toward.
