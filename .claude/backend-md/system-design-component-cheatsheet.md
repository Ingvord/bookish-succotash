## How to use this sheet

You are about to draw a box on a whiteboard: a cache, a queue, a search cluster. This sheet exists for the ten seconds before you do. The interviewer is not grading how many boxes you know. They are grading whether each box you draw has a reason, and the reason is almost never "that is what everyone draws".

The rule for the whole guide: **every component beyond the boring baseline must name three things**. The requirement that forces it, the number that crosses its threshold, and what it costs you. If you cannot say all three, the box does not go on the board yet. You can still mention it as the next step and name the trigger that would add it.

Use the guide in three passes. Before the interview, read the mental model and the worked cases. During prep drills, cover the right-hand columns of the master tables and try to predict them. In the room, use the reverse index (requirement phrase to minimal answer) as a lookup. This is the decision layer: it tells you *whether* to add a component. The deep dives ([Redis](../db/redis-prep.html), [Kafka](../messaging/kafka-prep.html), [Elasticsearch](../db/elasticsearch-prep.html), [Vector DBs](../db/vector-db-prep.html)) tell you *how* once the answer is yes, and the [Backend System Design guide](backend-system-design-guide.html) covers the scaling ladder and the room-driving script.

Facts here are checked as of October 2026: PostgreSQL 18 is the stable major (19 is in beta), Redis 8.x ships under a tri-license (AGPLv3, SSPLv1, RSALv2) while Valkey 9.x is the BSD fork, and Kafka 4.x is KRaft-only with Share Groups (queue semantics) generally available since 4.2. Versions and licenses move; the trade-offs underneath them mostly do not.

---

## Mental model: every box buys one property and charges rent

Each component buys exactly one property you could not cheaply get without it: faster reads, decoupled writes, full-text relevance, replay, horizontal write scale. It also charges rent, and the rent is paid forever, not once.

The rent has three parts:

- **Operational burden.** Another thing to deploy, upgrade, monitor, back up, secure, and get paged for at 3am.
- **A new failure mode.** Cache down, broker down, search cluster red. The system now has to behave sensibly when this box is unavailable, and you have to say how.
- **A new consistency boundary.** The moment data lives in two places (database and cache, database and search index, database and broker), the copies can disagree. Stale cache, replication lag, dual writes that half-succeed. This is the rent that actually bites in production.

So the question is never "would a cache help?" (it nearly always would, a little). The question is "does the benefit exceed this rent at *this* scale?" At 50 requests per second, the answer is almost always no.

**The boring baseline** is the default you start from and defend departures from: a load balancer, stateless app instances, one PostgreSQL primary (plus a replica when you need availability or read headroom), object storage for blobs, and a CDN for static assets. That stack serves a startling amount of traffic. A well-tuned single Postgres node handles on the order of tens of thousands of simple indexed reads per second and thousands to low tens of thousands of write transactions per second, which covers most interview prompts that say "10 million users" once you convert users to QPS.

**Postgres-first** is the corollary, and the theme of this whole guide. Postgres can be your job queue (`SELECT ... FOR UPDATE SKIP LOCKED`), your full-text search (`tsvector` with a GIN index), your fuzzy matcher (`pg_trgm`), your vector store (`pgvector`), your scheduler (a jobs table plus cron), and your pub/sub for small fan-out (`LISTEN/NOTIFY`). It will not win every benchmark against the specialist. It wins on one fewer system to run and no consistency boundary, and that trade is correct until a measured number says otherwise.

The catch: "Postgres-first" is not "Postgres-only". When the prompt genuinely has the numbers (a billion documents, a million events per second, multi-consumer replay), the specialist is the right answer. The skill being tested is telling the two situations apart out loud.

---

## Master tables: what each component buys and costs

Read each row as: *add it when* (the trigger, ideally with a number), *what it buys*, *what it costs or where it bites*, and *what to try first* instead. The last column is the one that keeps you out of over-engineering.

### Storage

| Component | Add it when | Buys you | Costs you / the catch | Try first |
|---|---|---|---|---|
| **PostgreSQL** (primary) | Default for any relational, transactional data | ACID, joins, constraints, rich indexing (B-tree, GIN, GiST, BRIN), JSONB, mature tooling | Single-writer ceiling; vertical scale only for writes; long transactions and bloat need care | Nothing; this is the start |
| **Read replica** | Reads dominate and one node is CPU-bound, or you need failover | Read scale-out, a warm standby, analytics isolation | Replication lag: read-your-writes breaks unless you route those reads to the primary | Add an index, fix the N+1 query |
| **Partitioning** (same node) | One table passes roughly 100M to 1B rows or you drop data by time range | Cheap retention (drop a partition), smaller indexes, partition pruning | Partition key must appear in queries or you scan everything; unique constraints must include the key | Better indexes, archive old rows |
| **Sharding** | A single primary cannot hold the write rate or the dataset (think multi-TB hot data, tens of thousands of sustained writes per second) | Horizontal write and storage scale | Cross-shard joins and transactions are gone; the shard key is nearly irreversible; resharding is a project | Bigger instance, partitioning, move cold data out |
| **DynamoDB / Cassandra** (wide-column, key-value) | Access pattern is known and key-based, you need single-digit-ms at huge scale, or writes are very high and multi-region | Predictable latency at any scale, built-in sharding and replication | You model around queries; ad-hoc queries and joins are painful; hot partitions; consistency is tunable and subtle | Postgres with the right index |
| **MongoDB** (document) | Genuinely schema-fluid documents read and written as a unit | Flexible schema, document-shaped reads | Cross-document transactions and joins are weaker; flexible schema becomes inconsistent data without discipline | Postgres `jsonb` column |
| **Object storage** (S3) | Any blob: images, video, exports, backups, large attachments | Cheap, durable, effectively unlimited | Not a filesystem: no append, higher latency, eventual-consistency history; serve through a CDN | Never put blobs in the database |

### Caching and edge

| Component | Add it when | Buys you | Costs you / the catch | Try first |
|---|---|---|---|---|
| **In-process cache** | Small, read-mostly, tolerance for brief staleness (config, feature flags, reference data) | Zero network hop, trivial to build | Each instance caches separately: inconsistent across the fleet, memory duplicated | A short TTL and a map |
| **Redis / Valkey** (as cache) | Measured DB load from repeated identical reads, hot keys, and a hit rate you can reasonably expect above ~80% | Sub-millisecond reads (~100K ops/s per node), shields the database | Invalidation (the hard part), stampedes on expiry, a new outage mode, memory cost; cold cache can melt the DB behind it | Index the query; add a read replica |
| **CDN** | Static assets, public media, cacheable GET responses, global users | Latency by geography, offloads origin, absorbs spikes | Purge and versioning discipline; useless for per-user dynamic responses | Cache headers and fingerprinted filenames |

### Async and messaging

| Component | Add it when | Buys you | Costs you / the catch | Try first |
|---|---|---|---|---|
| **Postgres job table** (`SKIP LOCKED`) | Background work up to roughly a few thousand jobs per second, and the job is created in a DB transaction anyway | Transactional enqueue (job exists iff the row committed), retries, visibility, no new system | Polling load and table bloat at high rates; no fan-out to many consumers | A plain `status` column and one worker |
| **Redis lists / Streams** | Lightweight queue with consumer groups, low latency, loss of a few messages on failover is tolerable | Fast, simple, Streams give consumer groups and acks | Durability depends on persistence config and failover; not a log you replay for days | Postgres job table |
| **SQS / RabbitMQ** | Work queue semantics: one consumer per message, retries, dead-letter, rate smoothing | Managed or mature, per-message ack, DLQ, no partition thinking | No long-term replay; ordering is limited or costs throughput | Postgres job table |
| **Kafka** | Many independent consumers of the same stream, replay, event rates in the hundreds of thousands per second, CDC pipelines, event sourcing | Durable ordered log, replay, huge throughput, consumer independence | Operationally heavy; ordering is per partition only; partition count is hard to change; consumer lag and rebalances; exactly-once is narrow | Postgres table, Redis Streams, or SQS |
| **Outbox pattern** | You must update the DB *and* publish an event reliably | Atomic "state change plus event", no lost or phantom events | Poller or CDC relay to run; consumers must be idempotent (at-least-once) | Skip the event if nothing consumes it |
| **Workflow engine** (Temporal, Step Functions) | Long-running, multi-step, compensating flows with human or time waits | Durable state machine, retries, timers, visibility | Learning curve, determinism rules, another cluster | A jobs table with a `step` column |

### Search and retrieval

| Component | Add it when | Buys you | Costs you / the catch | Try first |
|---|---|---|---|---|
| **Postgres FTS** (`tsvector` + GIN) | Keyword search on data you already store, up to a few million documents, single or few languages | Stemming, ranking (`ts_rank`), phrase search, transactional with your data, zero sync | Weaker relevance tuning; no built-in typo tolerance; ranking over very large result sets gets slow; no native faceting | This is the first try |
| **`pg_trgm`** | Typo tolerance, `ILIKE '%foo%'`, autocomplete-ish matching | Fuzzy and substring search backed by a GIN or GiST index | Index size; similarity thresholds need tuning; not semantic | Prefix search with a B-tree |
| **Elasticsearch / OpenSearch** | Heavy relevance tuning, facets and aggregations at scale, many languages and analyzers, log or event search, tens of millions of documents and up | Rich analyzers, scoring control, fast aggregations, horizontal scale | A second copy of your data to keep in sync (index lag, reindexing); heavyweight cluster (shards, heap, mappings); no transactions | Postgres FTS plus `pg_trgm` |
| **pgvector** | Semantic search or RAG up to a few million vectors, filters that join to relational data | Vectors beside your rows, metadata filters in plain SQL, one system | Recall and latency degrade at large scale; index builds and memory heavy; fewer ANN tuning options | This is the first try |
| **Dedicated vector DB** | Tens of millions to billions of vectors, strict latency at high QPS, heavy filtered ANN | Purpose-built indexes, scale-out, quantization | Another store to sync; filtered search and updates have their own quirks | pgvector |

### Analytics and time series

| Component | Add it when | Buys you | Costs you / the catch | Try first |
|---|---|---|---|---|
| **Analytics on a replica** | Reports and dashboards that hurt the primary | Isolation with zero new tech | Long queries on replicas can conflict with replication; still row-store speed | Run it nightly or on a schedule |
| **Materialized view / rollup table** | Dashboards that repeat the same aggregation | Pre-computed answers, instant reads | Refresh cost and staleness; you maintain the definition | Index plus `GROUP BY` |
| **TimescaleDB / partitioned time series** | Append-heavy metrics or events with time-range queries | Compression, time-bucketing, retention policies, still SQL | Extension to operate; not for arbitrary OLAP | Native partitioning by time |
| **ClickHouse / warehouse** | Scans and aggregations over hundreds of millions to billions of rows, many dimensions, sub-second dashboards | Columnar speed, great compression | A second system plus an ingestion pipeline (ETL or CDC); poor at point updates | A replica with rollups |
| **Stream processing** (Flink, Kafka Streams) | Continuous windowed computation with sub-second freshness | Real-time aggregates, joins over streams | State management, exactly-once subtleties, heavy ops | A periodic batch job |

### Traffic and coordination

| Component | Add it when | Buys you | Costs you / the catch | Try first |
|---|---|---|---|---|
| **Load balancer** | More than one app instance (so almost always) | Distribution, health checks, zero-downtime deploys | Must be redundant itself; sticky sessions undermine stateless scaling | Required; no cheaper alternative |
| **API gateway** | Many services or external clients needing auth, throttling, routing in one place | Central cross-cutting concerns | A hop and a choke point; becomes a mini-monolith if loaded with logic | Do it in the LB or app middleware |
| **Rate limiter** | Protecting an endpoint or a paid tier | Fairness, abuse protection | Needs shared counters (usually Redis); limits are approximate across nodes | A per-instance limiter if one node fronts traffic |
| **Distributed lock** | Mutual exclusion across instances for a real side effect | Prevents double-execution | Locks expire and clients pause: needs fencing tokens; easy to get subtly wrong | A DB row lock, a unique constraint, or an advisory lock |
| **WebSocket / SSE gateway** | Server push at scale (chat, live feeds, presence) | Low-latency push | Stateful connections: sticky routing, reconnect storms, fan-out layer | Polling every few seconds, or SSE |
| **Microservices split** | Teams blocked on each other, parts with wildly different scaling or compliance needs | Independent deploys and scale | Network failures, distributed transactions, observability tax, org overhead | A modular monolith |
| **Service mesh** | Dozens of services needing uniform mTLS, retries, and telemetry | Policy without app code | Operational complexity, latency, resource overhead | A shared library or sidecar-free setup |

---

## Reverse index: from the requirement to the minimal answer

This is the lookup table. The interviewer says a phrase; you reach for the left-most column and say the trigger that would upgrade it. The catch for every row is the same: the minimal answer is a starting point you defend with a number, not a claim that the big tool is wrong.

| They say | Minimal answer | Upgrade trigger |
|---|---|---|
| "Users search products / posts" | Postgres FTS plus `pg_trgm` | Facets over millions of docs, relevance tuning, many languages, or a search QPS the primary cannot spare |
| "Send emails / notifications" | Jobs table with `SKIP LOCKED`, or SQS | Multiple independent consumers of the same event, or replay |
| "Real-time feed / timeline" | Fan-out on read from Postgres with an index; cache the hot head | Celebrity fan-out writes too heavy: hybrid fan-out-on-write for normal users |
| "Leaderboard" | Sorted index in Postgres at small scale; Redis sorted set (`ZADD`) when ranks must be live | Millions of updates per minute or sub-ms rank queries |
| "Analytics dashboard" | Replica plus materialized view or rollup table | Scans over hundreds of millions of rows: ClickHouse or a warehouse |
| "File / image upload" | Presigned URL straight to object storage; row in Postgres with the key | Transcoding or scanning: async job on the queue |
| "Exactly-once payments" | Idempotency key plus a unique constraint, DB transaction | Cross-service flow: outbox plus idempotent consumers |
| "Global users, low latency" | CDN for static and cacheable reads; one region primary | Write latency or data residency forces multi-region |
| "Rate limit the API" | Per-instance limiter, or Redis counter | Many instances needing a shared budget: Redis token bucket |
| "Chat / presence" | WebSocket gateway plus Postgres for history; Redis pub/sub for cross-node fan-out | Millions of concurrent connections: dedicated connection tier |
| "Recommendations / semantic search" | pgvector for embeddings | Tens of millions of vectors with tight latency: dedicated vector DB |
| "Audit log / event history" | Append-only Postgres table, partitioned by time | Multi-consumer streaming or replay: Kafka |
| "Schedule recurring work" | Cron plus a jobs table | Long-running multi-step flows with timers: workflow engine |
| "Handle traffic spikes" | CDN, autoscaling stateless app, queue the slow work | Sustained load that the DB cannot take: replicas, then caching |

---

## Numbers that justify a box

A component earns its box when a number crosses a threshold. These are order-of-magnitude figures for sizing arguments, not benchmarks. Hardware, schema, and workload move them by 3x to 10x either way, so say "on the order of" in the room and show the arithmetic.

| Fact | Rough figure | Why it matters |
|---|---|---|
| Daily active users to average QPS | DAU x actions per user / 86,400; peak is about 3x to 10x average | 10M DAU at 10 actions each is about 1,150 average QPS, roughly 5K to 10K peak: a single DB can serve this |
| Single Postgres node, simple indexed reads | Tens of thousands per second | Most "scale" prompts do not exceed this |
| Single Postgres node, write transactions | Thousands to low tens of thousands per second | Sharding is a last resort |
| Redis / Valkey single node | About 100K ops/s (more with pipelining) | One cache node usually covers a whole product |
| Kafka throughput | Tens of MB/s per partition; clusters reach millions of messages per second | You need Kafka for fan-out and replay, rarely for raw volume under about 10K messages/s |
| Postgres FTS comfort zone | A few million documents per index | Beyond tens of millions, or with heavy faceting, Elasticsearch pulls ahead |
| pgvector comfort zone | A few million vectors | Beyond tens of millions, a dedicated store pays |
| Cache hit rate worth the rent | Above roughly 80% | Below that, the cache adds latency and a failure mode for little offload |
| Read-to-write ratio | 10:1 to 100:1 for most products | High ratios favor cache and replicas; write-heavy favors partitioning and queues |

The back-of-envelope habit is the real skill: **convert the users to QPS and storage before choosing anything**. Say the number, compare it to one node, and only then decide. If one node covers it with headroom, the correct design is the boring one plus a named upgrade path.

Treat these figures as the least stable content in the guide. The structure (compare your number to the single-node ceiling) is evergreen; the exact ceilings drift with hardware and versions. Re-derive them when an interviewer pushes.

---

## Worked cases: when the boring answer wins

Each case follows the same shape: the prompt, the diagram people draw by reflex, the right-sized design, the exact trigger that would flip the decision, and the sentence to say in the room.

### Case 1: Postgres full-text search instead of Elasticsearch

**The prompt:** "Design product search for a store with 2 million products and about 20 searches per second at peak."

**The reflex diagram:** App writes to Postgres, a Kafka topic carries change events, a consumer indexes into an Elasticsearch cluster, the search API queries Elasticsearch. Four new moving parts, a sync pipeline, and an index that is always slightly behind the source of truth.

**The right-sized design:** Keep search inside Postgres. Add a generated `tsvector` column and a GIN index for keyword ranking, and `pg_trgm` for typo tolerance on the title. The search is transactional with the product row, so there is no sync lag and no reindex job.

The schema and queries below show the whole thing. The prose that follows explains why each part is there.

```sql
ALTER TABLE products
  ADD COLUMN search tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B')
  ) STORED;

CREATE INDEX products_search_idx ON products USING GIN (search);
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX products_title_trgm_idx ON products USING GIN (title gin_trgm_ops);

-- ranked keyword search
SELECT id, title, ts_rank(search, q) AS rank
FROM products, websearch_to_tsquery('english', 'wireless headphones') AS q
WHERE search @@ q
ORDER BY rank DESC
LIMIT 20;

-- typo-tolerant fallback on the title
SELECT id, title, similarity(title, 'wirless headfones') AS sim
FROM products
WHERE title % 'wirless headfones'
ORDER BY sim DESC
LIMIT 20;
```

The weights (`A` for title, `B` for description) make title matches outrank body matches, which covers the relevance most catalogs need. The generated column keeps the vector in step with the row automatically, so there is no application code to forget. The trigram query handles the misspelling that the stemmer cannot.

The numbers: 2M rows with a GIN index answers in tens of milliseconds, and 20 QPS is a rounding error for a Postgres node. The catch to name out loud: `ts_rank` has to score every matching row before the sort, so very broad queries (a one-letter term matching a million rows) get slow, and you cap that with a result limit and minimum query length.

**The flip trigger:** add Elasticsearch or OpenSearch when you need rich faceted navigation with live counts across many attributes, heavy relevance tuning (synonyms, per-field boosting, learning to rank), many languages with per-language analyzers, tens of millions of documents, or a search QPS that would steal capacity from the transactional workload. At that point the sync pipeline is worth its rent.

**Say in the room:** "At 2M products and 20 QPS, Postgres FTS with a GIN index is enough and keeps search transactionally consistent with the catalog. I would add Elasticsearch when we need faceting at scale or relevance tuning that Postgres cannot express, and I would feed it through an outbox so the index is rebuildable."

### Case 2: Redis without Kafka

**The prompt:** "Design a notification system: users get an email or push when something happens. About 5 million notifications a day."

**The reflex diagram:** Service emits an event to Kafka, a notification consumer group reads it, fans out to email, SMS, and push topics, each with its own consumers and a dead-letter topic.

**The right-sized design:** 5M a day is about 58 per second on average, maybe 500 per second at peak. That is far below what any queue struggles with. Write the notification as a row in a `notification_jobs` table in the same transaction as the business change, and run a few workers that claim rows with `SKIP LOCKED`.

```sql
-- claim a batch safely across many workers
WITH next AS (
  SELECT id
  FROM notification_jobs
  WHERE status = 'pending' AND run_at <= now()
  ORDER BY run_at
  LIMIT 50
  FOR UPDATE SKIP LOCKED
)
UPDATE notification_jobs j
SET status = 'processing', locked_at = now(), attempts = attempts + 1
FROM next
WHERE j.id = next.id
RETURNING j.*;
```

`SKIP LOCKED` lets many workers pull from the same table without blocking each other or double-claiming a row. The job exists if and only if the business transaction committed, which a separate broker cannot give you without an outbox. If you want lower latency or no polling, Redis Streams or SQS is the next step up, not Kafka.

The catch: at-least-once delivery means a worker crash after sending but before marking done will resend, so make the send idempotent (a dedup key per notification). A stuck `processing` row needs a reaper that resets rows whose `locked_at` is too old.

**The flip trigger:** adopt Kafka when several independent systems must consume the same event (notifications, analytics, search indexing, fraud), when you need to replay history to rebuild a downstream, when sustained rates reach the hundreds of thousands per second, or when you do change-data-capture into other stores. Kafka's value is the retained, replayable log with many readers, not just "async".

**Say in the room:** "A few hundred notifications a second is well within a transactional jobs table with SKIP LOCKED, and it removes the dual-write problem. The moment a second team needs the same events, or we need replay, that is when the log earns its operational cost and I would introduce Kafka via an outbox."

### Case 3: No cache at all

**The prompt:** "Design a profile service for 1 million users. Profile pages are read far more than written."

**The reflex diagram:** App, Redis cache with cache-aside logic, invalidation on update, and Postgres behind it.

**The right-sized design:** 1M users with each viewing a few profiles a day is a few hundred reads per second at peak. A primary-key lookup in Postgres takes well under a millisecond when the row is in memory, and the working set (1M rows at about 1 KB is 1 GB) fits in the buffer cache already. Postgres *is* your cache for this workload. Add a CDN in front for the avatar images and the public, cacheable parts of the page.

The catch that people forget: a cache is not free correctness-wise. Cache-aside has a race (a reader repopulates stale data just after a writer invalidates), TTLs are a guess, and a cold or flushed cache sends the full load at the database at once. You trade a latency win you do not need for a staleness bug you will have.

**The flip trigger:** add Redis once metrics show it. Concretely: database CPU is high because of repeated identical reads, the p99 read latency misses its target, or you have a few extremely hot keys (a celebrity profile). Then cache those keys specifically, with a short TTL and a stampede guard, and state the staleness you accept.

**Say in the room:** "I would not add a cache until the numbers ask for it. The whole working set fits in Postgres memory, so the database is already serving this from RAM. If we see hot keys or DB CPU pressure, I would cache those specifically and tell you the staleness window."

### Case 4: Outbox table instead of dual writes

**The prompt:** "When an order is placed, update the database and tell other services."

**The reflex diagram:** The handler writes to Postgres and then publishes to Kafka in the same function. It looks atomic. It is not.

**The failure:** If the process crashes between the commit and the publish, the order exists and nobody hears about it. If you publish first and the commit fails, downstream sees an order that never existed. There is no transaction spanning both systems.

**The right-sized design:** In the same transaction that writes the order, insert a row into an `outbox` table. A small relay (a poller, or CDC via logical replication) reads unsent rows and publishes them, then marks them sent.

```sql
BEGIN;
INSERT INTO orders (id, customer_id, total) VALUES (42, 7, 99.00);
INSERT INTO outbox (aggregate_id, type, payload)
VALUES (42, 'OrderPlaced', '{"orderId":42,"total":99.00}');
COMMIT;
```

Because both inserts share one transaction, either both exist or neither does. The relay gives you at-least-once delivery, so consumers must be idempotent (dedupe on an event id). The catch is the relay itself: it has to be monitored for lag, and a poller adds a little latency.

The right-sizing insight: if nothing consumes the event yet, do not publish it at all. And if the only consumer is a worker in your own service, the jobs table from Case 2 *is* the outbox.

**The flip trigger:** adopt a CDC tool such as Debezium reading the write-ahead log when polling load or latency becomes a problem, or when many tables need event streams without touching application code.

**Say in the room:** "I would not dual write, because there is no atomicity across the DB and the broker. I would insert an outbox row in the same transaction and relay it, with idempotent consumers."

### Case 5: pgvector instead of a dedicated vector database

**The prompt:** "Add semantic search over our support articles for a RAG assistant. About 500,000 articles."

**The reflex diagram:** Embedding pipeline writes to a dedicated vector database, a separate metadata store holds the article text and permissions, and the app joins the two in code.

**The right-sized design:** 500K vectors is comfortably inside pgvector territory. Store the embedding in a `vector` column next to the article row, add an HNSW index, and filter by tenant or permissions in the same SQL statement.

```sql
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE articles ADD COLUMN embedding vector(1536);
CREATE INDEX articles_embedding_idx
  ON articles USING hnsw (embedding vector_cosine_ops);

SELECT id, title
FROM articles
WHERE tenant_id = 7 AND published
ORDER BY embedding <=> $1
LIMIT 8;
```

The metadata filter and the nearest-neighbor search happen in one query against one store, so permissions can never drift from the vectors. The catch: HNSW indexes use real memory and slow bulk inserts, and filtering that removes most rows can reduce recall if the index is not tuned for it.

**The flip trigger:** move to a dedicated vector database when you reach tens of millions to billions of vectors, need strict latency at high QPS under heavy filtering, or need quantization and scale-out that pgvector's single-node model cannot give. See the [Vector DB guide](../db/vector-db-prep.html) for that world.

**Say in the room:** "Half a million vectors fit in pgvector, and keeping them next to the rows means permission filters are just a WHERE clause. I would move to a dedicated store when vector count or filtered latency forces it."

### Case 6: Modular monolith instead of microservices

**The prompt:** "Design a food-delivery backend." The reflex is a box per noun: user service, restaurant service, order service, payment service, delivery service, notification service, each with its own database.

**The right-sized design:** One deployable with clear internal modules (`orders`, `restaurants`, `payments`, `delivery`), each owning its tables and exposing an interface to the others. You get the boundaries without the network.

What the split costs: every call that used to be a function is now a network call that can fail, time out, or be slow. A transaction spanning orders and payments becomes a saga. Debugging needs distributed tracing. You need service discovery, per-service CI, and an on-call rotation for each.

The honest reasons to split: independent teams blocked on a shared deploy, one component with very different scaling needs (video transcoding versus CRUD), or a hard compliance boundary (payment data). None of those is "the prompt has many nouns".

**The flip trigger:** carve a service out at a seam that hurts, with a named reason, and start with the one that has a distinct scaling or ownership profile.

**Say in the room:** "I would start as a modular monolith with enforced module boundaries, and extract a service when a specific module needs independent scaling or a separate team owns it. That gives me the seams without the distributed-systems tax up front."

### Case 7: Vertical scale and replicas instead of sharding

**The prompt:** "The database is slow. We have 200 GB of data and 3,000 requests per second."

**The reflex:** shard the database.

**The right-sized design:** 200 GB and 3K QPS is small. Check the slow query log, add the missing index, fix the N+1 queries, move to a bigger instance (memory first, so the working set stays in RAM), and add a read replica for read-heavy endpoints. Partition the one giant append-only table by time if there is one.

The catch with sharding that makes it a last resort: you lose cross-shard joins and transactions, the shard key choice is nearly irreversible, hot shards appear, and resharding is a multi-week migration. The symptom that justifies it is specific: the write rate or the hot dataset no longer fits one primary even after the cheaper moves.

**The flip trigger:** sustained write throughput beyond what the largest practical primary handles, or a hot dataset in the multi-terabyte range that cannot be archived or partitioned away.

**Say in the room:** "At 200 GB and 3K QPS I would fix indexes and queries, scale up, add a replica, and partition by time. Sharding is where I go when writes outgrow a single primary, and I would pick the shard key from the dominant access pattern."

### Case 8: Cron plus a jobs table instead of a workflow engine, and a replica instead of ClickHouse

**The prompt:** "Generate nightly reports and show an internal sales dashboard."

**The reflex:** Airflow or Temporal for the scheduling, ClickHouse for the reporting, Kafka to feed it.

**The right-sized design:** A cron entry (or the platform scheduler) inserts a row into the jobs table, a worker runs the report, and the result lands in a table or object storage. The dashboard reads a materialized view or a rollup table on a read replica, refreshed on a schedule. For tens of millions of rows this answers in seconds.

The catch: a materialized view refresh locks or costs CPU, and the dashboard shows data as of the last refresh, which you state honestly ("fresh within 15 minutes"). Long analytical queries on a replica can be cancelled by replication conflicts, so tune the standby settings or run them on a dedicated replica.

**The flip trigger:** a workflow engine when flows run for days with timers, human approvals, and compensating steps. ClickHouse or a warehouse when scans cover hundreds of millions to billions of rows across many dimensions and the dashboard needs sub-second response.

**Say in the room:** "For a nightly report and an internal dashboard, a jobs table plus a rollup on a replica is enough and gives me one system. The warehouse comes in when the scan size or the dimensionality outgrows row-store aggregation."

---

## Practice drills

For each prompt, write down the components you would draw and the number that justifies each before reading the answer. The aim is to practice saying "not yet" with a reason.

**Drill 1: URL shortener, 10K DAU.** Answer: app, Postgres with a unique index on the short code, CDN or redirect caching headers. Generate codes from a sequence encoded in base62 or a random token with a unique constraint. Peak QPS is single digits to tens. No cache, no queue. Flip: a viral link with extreme hot-key read volume adds a cache for hot codes; click analytics at high volume adds an async pipeline.

**Drill 2: Chat for 1M users.** Answer: WebSocket gateway tier (stateful, sticky), message store in Postgres partitioned by conversation and time, presence in Redis with TTL keys, Redis pub/sub or a lightweight bus to route a message to the node holding the recipient's connection. The honest catch is connection count and fan-out, not the database. Flip: very large group chats or global scale push toward a dedicated messaging backbone and wide-column storage.

**Drill 3: Rate limiter for a public API.** Answer: token bucket in Redis keyed by client and window, with a Lua script or atomic command for the check-and-decrement. A per-instance limiter is acceptable if one node fronts traffic. The catch: Redis down means you choose fail-open or fail-closed deliberately.

**Drill 4: Image sharing app, 500K DAU.** Answer: presigned uploads to object storage, a thumbnail job on a jobs table or SQS, CDN for delivery, Postgres for metadata and a follower graph, fan-out on read for the feed. The numbers (roughly 6 to 60 requests per second) do not justify Kafka or sharding. Flip: celebrity accounts push toward fan-out hybrids.

**Drill 5: E-commerce checkout with payments.** Answer: Postgres transaction for the order, an idempotency key on the payment request with a unique constraint, an outbox row for downstream events, and idempotent consumers. No distributed transaction: use a saga only if payment is truly a separate service. The catch to name: the payment provider call can time out after succeeding, so you reconcile by idempotency key.

**Drill 6: Real-time analytics dashboard for 50M events a day.** Answer: 50M a day is about 580 per second average, which one Postgres or TimescaleDB handles with partitioning and rollups. Land events in a time-partitioned table, aggregate into rollup tables. Flip: billions of events or ad-hoc multi-dimensional slicing pushes you to ClickHouse, with Kafka only if several consumers need the stream.

**Drill 7: Search-as-you-type for 5M items.** Answer: start with `pg_trgm` and prefix indexes, and measure latency. The honest answer to "does this scale" is a number: if p95 latency or QPS misses the target, move to Elasticsearch with edge n-gram analyzers, fed by an outbox.

**Drill 8: "Design YouTube."** Answer: say the real constraint first (video bytes dominate, not metadata). Object storage plus a transcoding job pipeline plus CDN carries most of the design; metadata stays in Postgres. Here the big boxes are justified (queue for transcoding, CDN, object storage) because the numbers force them, and you say so.

---

## Meta: framing it in the room

The whole technique compresses into one sentence you can reuse: **"I would start with X, and the metric that makes me add Y is Z."** It shows you know the specialist exists, that you know what it costs, and that you add it on evidence. That is the senior signal, and it costs nothing to say.

**When they say "what if it grows 100x?"** Do not redraw the diagram. Name the first bottleneck the arithmetic predicts, name the move for it, and say what you would watch to know it is time. "At 100x we are at about 100K QPS; reads go first, so replicas and then a cache; writes become the issue past about 20K per second, which is where partitioning and then sharding come in." Evolve one box at a time, in the order the metrics would force them.

**When the prompt really is big.** Sometimes the numbers are enormous: a billion events a day, hundreds of millions of vectors, global writes. Then the triggers fire and the big components are correct. The discipline is the same: say *which* number fired *which* trigger. A Kafka box drawn because the rate demands it is fine; a Kafka box drawn out of habit is the failure this guide is about.

**Name the rent out loud.** For every box you do add, spend one sentence on what it costs: the consistency boundary it creates and how you handle it (outbox, TTL, idempotent consumers). This is what separates a design from a diagram.

**Be honest about uncertainty.** If you do not know a figure, say it is an estimate and show how you would measure it. A confident, labeled estimate beats a precise-sounding number you cannot defend.

For depth once a component earns its box, go to the specialist guides: [Redis](../db/redis-prep.html), [Kafka](../messaging/kafka-prep.html), [Elasticsearch](../db/elasticsearch-prep.html), [Vector DBs](../db/vector-db-prep.html), [Relational DB](../db/relational-db-prep.html), [Scaling Foundations](../backend/scaling-foundations-prep.html), and the [Backend System Design guide](backend-system-design-guide.html) for the room-driving script and scaling ladder.
