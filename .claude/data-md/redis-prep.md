## How to use this guide

Redis questions in a backend interview are almost never about commands. They are
about the mechanical consequences of Redis's design: what happens under memory
pressure, why Pub/Sub loses messages, what cluster does to atomicity, and how you
prevent a cache stampede at 3 AM. The production-anchor signal the interviewer is
looking for is a failure mode you have actually encountered, not a definition you
recited.

This guide covers Redis 8.x (open-source). RDB/AOF defaults, eviction policy
names, and cluster topology are verified against the current documentation.

---

## The mental model: a single-threaded data-structure server

Redis is a RAM-first, single-threaded key-value store. Every command executes
sequentially in one thread (the event loop), so there are no concurrent writes and
no data races. This makes Redis fast (no lock overhead) and simple to reason about:
at the granularity of a single command, Redis is always consistent.

The catch is that "single command" granularity does not mean "multi-command
sequence is atomic." Two clients can interleave commands between your `GET` and
`SET`. The tools for multi-command atomicity are transactions (`MULTI/EXEC`) and
Lua scripts, both of which block the event loop for their duration. This is why a
long Lua script is dangerous: it freezes all other clients until it finishes.

Redis 6.0 added I/O threading (multiple threads handle network I/O while the event
loop remains single-threaded for command execution). This improves throughput on
network-bound workloads without changing the atomicity model.

---

## Persistence: RDB vs AOF

Redis is an in-memory store, but it can persist data to disk. Two mechanisms exist.

**RDB (Redis Database snapshot)** writes a point-in-time binary snapshot of the
entire dataset to disk. By default, Redis performs snapshots on a schedule: after
900 seconds if at least 1 key changed, after 300 seconds if at least 10 keys
changed, and after 60 seconds if at least 10,000 keys changed. A snapshot is also
triggered by `BGSAVE`. The snapshot forks the process and uses copy-on-write to
avoid blocking the server.

RDB is compact, fast to restore, and cheap in normal operation. The catch: you can
lose up to the last snapshot's worth of writes. If Redis crashes 5 minutes into a
900-second snapshot window and only 2 keys changed, you lose nothing; if it crashes
59 seconds into a 60-second window with 10,000 key changes, you lose all of them.

**AOF (Append-Only File)** logs every write command as it executes. On restart,
Redis replays the AOF to rebuild state. AOF is disabled by default. When enabled,
the `appendfsync` setting controls the durability-performance tradeoff:
- `always`: fsync after every command. Maximum durability, lowest throughput.
- `everysec` (recommended when using AOF): fsync once per second. At most one
  second of data loss on crash.
- `no`: let the OS flush when it wants. Fastest, most exposure.

The catch with AOF: the file grows unboundedly. Redis rewrites (compacts) it
automatically, but large AOF files slow restart time. Modern Redis uses
`aof-use-rdb-preamble yes` (the default when AOF is on): the rewrite writes an RDB
snapshot as the base and appends only recent commands, combining fast startup with
fine-grained durability.

**For session state on a standard backend service:** use AOF with `appendfsync everysec`.
Session loss is visible to users; a one-second data-loss window is usually
acceptable, and the session can be re-established by re-login. Use RDB-only only if
session loss on restart is tolerable (cache-type usage). For primary data stores,
enable both (`aof-use-rdb-preamble yes`).

---

## Memory limits and eviction policies

Redis is an in-memory store. When it exhausts available RAM, it must do something
with new write requests. The `maxmemory` directive sets the limit; when reached,
`maxmemory-policy` controls the response. The default policy is **`noeviction`**:
Redis returns an error to any write command that would allocate memory. No data is
lost, but the caller gets an error.

The eight eviction policies break into three families:

| Family | Policies | When to use |
|---|---|---|
| No eviction | `noeviction` | Primary data stores; losing keys is unacceptable |
| Volatile (only keys with TTL) | `volatile-lru`, `volatile-lfu`, `volatile-random`, `volatile-ttl` | Mixed cache and persistent data; expire the cache keys, keep the rest |
| All-keys | `allkeys-lru`, `allkeys-lfu`, `allkeys-random` | Pure cache; any key can be evicted |

`lru` (Least Recently Used) evicts the key not used longest. `lfu` (Least
Frequently Used) evicts the key used least often; more accurate for frequency-skewed
workloads (a key used once last second is evicted before a key used a thousand times
last year). `volatile-ttl` evicts the key with the shortest remaining TTL first.

Redis's LRU implementation is approximate: it samples a configurable number of keys
(default: 5, set by `maxmemory-samples`) and evicts the best candidate among the
sample. This avoids maintaining a full LRU list and is accurate enough in practice.

The catch: `allkeys-lru` looks safe for a cache, but if you store a mix of
durable (session) and cache data under the same Redis instance, it will evict
session keys too. Always use `volatile-*` policies for mixed workloads, and set
TTLs on cache keys but not on durable keys.

```
# redis.conf: pure cache configuration
maxmemory 4gb
maxmemory-policy allkeys-lfu
maxmemory-samples 10
```

---

## Pub/Sub vs Streams

Both support the "publish an event, multiple consumers receive it" model, but they
are fundamentally different in durability.

**Pub/Sub** is fire-and-forget. A publisher sends to a channel; every active
subscriber receives it. If a subscriber is offline or slow, the message is gone.
There is no buffer, no replay, no consumer group. It is appropriate for
notifications where loss is acceptable (cache invalidation signals, presence
updates) but not for anything requiring guaranteed delivery or at-least-once
processing.

**Redis Streams** (available since Redis 5.0) are an append-only log with consumer
groups, acknowledgement, and replay. Each entry gets a unique ID. Consumer groups
allow multiple independent consumers to read from the stream; each consumer gets a
different subset of messages (like Kafka consumer groups). Unacknowledged messages
stay in the "Pending Entries List" and can be re-delivered after a timeout.

Streams wins over Pub/Sub when: you need at-least-once delivery, consumers can be
temporarily offline, you need to replay from an offset, or multiple independent
consumer groups must process the same event stream independently.

The catch: Streams have a memory cost proportional to their length. Set `MAXLEN`
(or `MAXLEN ~` for approximate trimming) to bound the size, accepting that old
entries are dropped. Unlike Kafka, Redis Streams do not persist beyond `maxmemory`
constraints or the configured trim.

```
# Pub/Sub: no delivery guarantees
PUBLISH notifications "user:42:logged-in"

# Streams: with consumer group and ACK
XADD events * type login user_id 42
XGROUP CREATE events workers $ MKSTREAM
XREADGROUP GROUP workers consumer-1 COUNT 10 BLOCK 2000 STREAMS events >
# After processing: XACK events workers <message-id>
```

---

## Redis Cluster

A standalone Redis instance is bounded by one server's RAM and one CPU's single-thread
throughput. Redis Cluster shards data across multiple nodes using a fixed 16384
hash slots. Each key is assigned to a slot via `CRC16(key) mod 16384`. Each master
node owns a range of slots. Masters can have replica nodes.

When a client sends a command for a key on a different node, the server responds
with a `MOVED` redirect telling the client which node owns that slot. Smart clients
cache the slot map and route directly.

Failure handling: if a master fails, its replicas hold an election among themselves.
If a replica wins, it is promoted to master and the cluster updates the slot map.
The process takes a few seconds; during that time, commands to the failed shard
return errors. The cluster requires at least 3 masters (6 nodes total for HA with
one replica each) to form a quorum.

The catch for atomicity: multi-key commands (`MSET`, `MGET`, Lua scripts, `MULTI/EXEC`)
only work when all keys map to the same hash slot. Cross-slot operations fail. The
workaround is hash tags: placing `{same-tag}` in the key name forces all keys with
that tag to the same slot (`{user:42}:session` and `{user:42}:cart` land on the
same node). Overusing one hash tag creates a hotspot.

---

## Cache stampede and how to prevent it

A cache stampede (also called thundering herd) happens when a hot key expires and
many concurrent requests miss the cache simultaneously. All of them hit the backing
store in parallel, potentially overwhelming it. The key is the first request to
populate the cache; everyone else should wait, not issue duplicate queries.

**Prevention strategies:**

**Mutex/single-flight lock:** when a request misses, it acquires a Redis lock
(`SET key:lock 1 NX EX 5`) before querying the backing store. Other requests that
miss while the lock is held either wait briefly or serve the stale value. The
first acquirer refreshes the cache and releases the lock.

**Probabilistic early refresh (jitter):** extend the effective TTL before expiry.
A request checking the cache computes a probability of recomputing that increases
as the key approaches expiry. The exact formula: recompute if
`(ttl_remaining / original_ttl) < random(0, 1)`. This spreads the refresh across
multiple requests over time rather than a single thunderclap.

**Stale-while-revalidate:** serve the stale value immediately and trigger a
background refresh. Requires storing the expiry time alongside the value so the
application knows to refresh, even while serving stale data.

TTL jitter (randomizing cache expiry times by ±10%) prevents **cache avalanche**
(many keys expiring simultaneously), which is the population-level version of the
same problem.

---

## Rate limiting with Redis

A rate limiter using Redis typically uses one of two algorithms.

**Fixed-window counter:** store a counter per client per time window
(`INCR user:42:2026-06-12:14:23`). If the counter exceeds the limit, reject.
Reset on window rollover. Simple but has a boundary burst problem: a client can
send limit requests at the end of window N and limit requests at the start of
window N+1, creating 2x the limit in a short period.

**Sliding-window log / token bucket with Lua:** more accurate. A Lua script is
atomic in Redis (blocks the event loop for its duration), so a check-and-increment
or check-and-consume can be done without a race condition between `GET` and `SET`.

```lua
-- Sliding window using sorted set (score = timestamp)
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
-- Remove entries outside the window
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)
if count < limit then
  redis.call('ZADD', key, now, now)
  redis.call('EXPIRE', key, window / 1000)
  return 1  -- allowed
end
return 0  -- rejected
```

Why Lua: two separate commands (`ZCARD` then `ZADD`) can be interleaved by another
client between them. Lua executes atomically. An alternative is Redis transactions
(`MULTI/EXEC`), but transactions require a `WATCH` to detect conflicts and retry,
adding latency. Lua is simpler for this pattern.

The operational catch: a long-running Lua script holds the event loop. Keep scripts
short (tens of microseconds) and never call `redis.call` in a loop over large data.

---

## EXPIRE vs EXPIREAT

`EXPIRE key seconds` sets a TTL relative to now. `EXPIREAT key unix-timestamp` sets
an absolute expiry.

The distinction matters in two scenarios. First, **coordinated expiry**: if ten
services each cache the same data and you want them all to expire at midnight for a
daily rotation, `EXPIREAT` with the midnight timestamp achieves that without drift.
`EXPIRE 86400` would drift by the number of seconds each cached it after midnight.

Second, **TTL after restore**: when migrating or restoring a dataset, `EXPIREAT`
preserves the original expiry semantics. `EXPIRE` relative to now would extend all
TTLs to match the restore time rather than the original creation time.

The catch: server clock skew. `EXPIREAT` depends on the wall clock. If the Redis
server's clock is out of sync with the application server's clock, keys may expire
earlier or later than intended. `EXPIRE` is immune to this because it is relative.

---

## Common interview questions

**What is the difference between Redis RDB and AOF persistence? Which would you use
for session state?**
Testing: operational knowledge of the durability tradeoff.
RDB writes periodic binary snapshots (default schedule: 900/300/60 second
intervals). AOF logs every write command, disabled by default; `appendfsync everysec`
gives at-most-one-second data loss. For session state: AOF with `everysec` because
session loss is visible to users and a one-second loss window is usually acceptable.
Modern Redis uses both with `aof-use-rdb-preamble yes` for fast startup plus
fine-grained durability.

**What happens when Redis runs out of memory? What eviction policies exist and when
would you choose each?**
Testing: whether you know the default behavior.
The default policy is `noeviction`: Redis returns an error on write commands that
would allocate memory. No data is lost. For a pure cache, `allkeys-lru` or
`allkeys-lfu` evicts keys to make room; `lfu` is better for frequency-skewed
workloads. For mixed cache-and-persistent data, use `volatile-lru` with TTLs on
cache keys but not on durable keys, so only cache keys are eligible for eviction.

**What is the difference between Redis Pub/Sub and Redis Streams? When does Streams
win?**
Testing: whether you have hit message-loss in production.
Pub/Sub is fire-and-forget: a subscriber that is offline misses messages, no
replay, no consumer group. Streams are an append-only log with consumer groups, ACK,
and replay. Streams wins whenever you need at-least-once delivery, consumers can be
temporarily offline, or multiple independent pipelines must process the same events.

**What is a Redis cluster and how does it handle node failure?**
Testing: whether you understand slot-based sharding.
Cluster distributes 16384 hash slots across master nodes. On master failure, the
replicas elect a new master in a few seconds; commands to that shard fail during
the election. Multi-key operations (MGET, Lua) must have all keys in the same slot
or they fail. Hash tags (`{tag}`) force co-location, but overusing one tag creates
a hotspot.

**What is cache stampede and how do you prevent it?**
Testing: production failure mode knowledge.
A stampede is when a hot key expires and many concurrent requests all miss and hit
the backing store simultaneously. Prevent it with a distributed mutex (first miss
acquires a Redis lock; others wait or serve stale), probabilistic early refresh
(recompute with increasing probability as TTL drops), or stale-while-revalidate
(serve stale immediately, refresh in background).

**You are using Redis as a rate limiter. Walk me through the implementation.**
Testing: atomicity reasoning.
Use a sliding window with a sorted set or a token bucket. The critical requirement
is atomic check-and-update: two separate commands (`GET` then `SET`) can be
interleaved. Use a Lua script (executes atomically in the event loop) or a Redis
transaction (`WATCH/MULTI/EXEC`). Lua is simpler. The script removes expired
entries from the window, counts what remains, and either adds the new entry
(allowed) or rejects. Keep the Lua script short; it blocks all other clients for
its duration.

**What is the difference between EXPIRE and EXPIREAT? Where does the choice matter?**
Testing: edge-case awareness.
`EXPIRE` sets a relative TTL in seconds from now. `EXPIREAT` sets an absolute Unix
timestamp. Use `EXPIREAT` when multiple services must expire the same data at a
fixed wall-clock time (e.g., midnight rotation) or when restoring data and
preserving original expiry semantics. `EXPIRE` is immune to server clock skew;
`EXPIREAT` depends on the wall clock being in sync.
