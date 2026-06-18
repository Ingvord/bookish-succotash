## How to use this guide

You are standing at a whiteboard (or sharing a blank Excalidraw), the interviewer just said "design Uber" or "design Google Docs," and the clock is 45 minutes. This guide is the playbook for that room. It is not a catalogue of every database on earth; it is a method for driving the conversation, a scaling story you can tell from 1,000 users to 1,000,000 and beyond, the handful of distributed patterns that come up in almost every round (the outbox and its relatives), the availability numbers you are expected to recite, and two modern workloads that now show up constantly: retrieval-augmented generation (RAG) and analytics (OLAP).

This guide is the companion to **Scaling Foundations**, which is the building-blocks reference: load-balancer algorithms (L4 vs L7, round-robin vs least-connections vs consistent hashing), caching patterns and failure modes (cache-aside, stampede, penetration, avalanche), real-time transport (polling, SSE, WebSockets), auth (sessions vs JWT, OAuth2/OIDC, RBAC/ABAC), and the full nines-and-percentiles table with SLI/SLO/error budgets. Where this guide names a building block, it stays brief and points there. The depth budget here goes to the parts a system-design round actually grades: how you drive it, how you scale the three-tier baseline, the patterns, and the worked walkthroughs.

The examples throughout are drawn from real recorded interviews (ride-hailing, collaborative docs, video calls), so the moves you see are the moves that actually land in the room.

---

## Drive the room: a repeatable script

The single biggest differentiator at senior and staff level is not knowing more components; it is driving the conversation instead of being dragged through it. Interviewers say it explicitly in feedback: "the system was poorly scalable" or "the load balancer was not justified by the requirements" are process failures, not knowledge failures. Run the same six-step script every time, and narrate which step you are on so the interviewer can steer.

**Step 1: Functional requirements, then scope down to one slice.** List what the system does in user terms (a rider orders a car, a driver accepts, both get tracked, payment settles, both rate each other). Then immediately shrink the problem: "Let us design for one city first, then talk about going global." Scoping down is not dodging; it is how you fit real depth into 45 minutes, and it signals that you know a single-city ride service and a planet-scale one are different machines. The catch: do not skip the user-language pass and jump to boxes. If you cannot say what the system does in one sentence, you cannot tell what to cut.

**Step 2: Non-functional requirements, with numbers attached.** Pin down scale (how many users, what read/write ratio, what the load profile looks like across a day), availability target (three nines? four?), latency budget (is 200ms p99 fine, or is this a real-time call where 400ms is the whole budget?), consistency needs (does a stale read hurt?), and security/compliance (PII, GDPR, payment data). The catch most candidates miss: a user count is not a load profile. "1 billion users" tells you almost nothing; "1 billion users, 10 sessions/month each, peaked 8am and 6pm on weekdays" tells you the peak RPS you actually have to survive.

**Step 3: Back-of-the-envelope estimate.** Convert the numbers from step 2 into peak requests per second and storage growth. This is its own section below. Do it early, because the answer (1,000 RPS vs 1,000,000 RPS) changes the entire architecture, and doing it in front of the interviewer shows your reasoning rather than a memorized diagram.

**Step 4: High-level design on the three-tier skeleton.** Draw the happy path through client, gateway, services, and storage. Keep it to the one slice you scoped. Resist drawing a load balancer, a CDN, and five caches before any requirement has asked for them; add each component when a requirement forces it, and say which requirement. The next two sections are this step expanded.

**Step 5: Data model and storage choice.** For each major entity, say what you store, how it is keyed, the access pattern (read-heavy? write-heavy? point lookups or range scans?), and therefore what kind of store fits. "Orders are written once, updated a few times over minutes, then read rarely; that is a key-value or relational row, not a search index." Tie the store to the access pattern, never to fashion.

**Step 6: Scale, bottlenecks, tradeoffs, and wrap.** Now take the single-slice design and push it: where does it break at 10x, what do you shard, what do you replicate, what fails over. Close with the cross-cutting concerns (monitoring, disaster recovery, security) so the interviewer sees you think past the happy path.

Two habits run through all six steps. Manage the clock out loud ("we have spent five minutes here, let us move on"), and ask the interviewer what they want to dig into ("I can go deep on the payment reliability or on the geo-sharding, which is more interesting to you?"). The best interviewers will tell you exactly where the points are.

---

## Back-of-the-envelope estimation

Estimation exists to pick an architecture, not to be precise. You are deciding whether one box suffices or whether you need sharding, so round hard and aim for the right order of magnitude.

The standard chain is monthly active users to daily active users to peak requests per second. Take MAU, divide by 30 for a rough DAU (assuming reasonably even spread), multiply by actions per user per day to get daily requests, divide by 86,400 seconds, then multiply by a peak factor (typically 2x to 5x, because traffic is not flat) to get peak RPS. Watch the trap that ended one real interview badly: you cannot derive RPS from user count alone, you need the usage profile (how often and in what shape each user acts). Get the profile first, then the arithmetic is trivial.

```text
MAU ----/30----> DAU ----x actions/user/day----> requests/day
requests/day ----/86,400----> avg RPS ----x peak factor (2-5)----> peak RPS
```

Three worked examples from real rounds show how little arithmetic this takes. Ride-hailing in one large city: roughly 25M residents, assume 10% use the service in a peak hour, that is 2.5M requests spread over an hour, which lands around 700 to 1,000 RPS at the order service. That number matters because a single modern service instance handles thousands of RPS, so the headline is "this is not a high-frequency-trading load, one or two instances suffice, the hard part is reliability not raw throughput." Collaborative docs: 20M DAU, 10% create documents, at roughly 1MB per document over 10 years lands near 244TB, which says "this does not fit one disk, plan for sharding and tiering" before you have drawn a single box. Video calls: 1B users, about 10 calls/month each, 10 participants per call, works out to roughly 3,000 call-setups per second and around 30,000 concurrent calls, which tells you the signaling tier is modest but the media path is the real engineering.

Storage math is the same shape: items per day times bytes per item times retention, then decide what is hot (recent, queried often) versus cold (old, queried rarely, can move to cheaper storage). The catch: always separate the write-rate estimate from the storage estimate, because they drive different decisions (write rate sizes your ingest and queue capacity, total storage sizes your database and tiering strategy).

Latency napkins are worth memorizing at the same rough level: memory access is nanoseconds, an SSD read is tens of microseconds, a same-datacenter round trip is well under a millisecond, and a cross-continent round trip is on the order of 150ms one way (San Francisco to Tokyo is roughly that, set by the speed of light in fiber, not by your code). That last number is why a globally distributed real-time call cannot route all media through one region: 300ms round trip leaves almost nothing of a one-second budget for encoding, jitter buffering, and the last mile. For the throughput-ceiling reasoning (Little's Law: concurrency equals throughput times latency, so the connection pool, not the CPU, is usually the real cap), see the reliability-vocabulary section of Scaling Foundations.

---

## The three-tier baseline and how it scales

Almost every web system starts as the same three tiers: a presentation tier (the client and whatever serves it), an application tier (your stateless business logic), and a data tier (durable storage). The art of scaling is not replacing this shape; it is widening each tier and inserting helpers (load balancer, cache, queue, CDN) only when a specific bottleneck forces it. Below is the ladder as guidelines, not deep solutions. For each rung, note the symptom that forces the move, the move itself, and the catch.

**Around 1,000 users: one box, scale vertically.** App and database can live on a single machine or two small ones. Do not distribute anything yet. The catch is that this stage has no redundancy, so it cannot meet any real availability target; that is fine while you have no users, and it is the thing you fix first when you do.

**Around 10,000 users: split the tiers and go horizontal on the app.** The symptom is a single app box near its CPU or memory ceiling, plus the realization that one instance means one deploy or crash is a full outage. The move: put a load balancer in front of two or more stateless app instances, and move the database to its own managed host. The catch that makes the app "scale": instances must be stateless, with any session state pushed to a shared store (Redis), so any instance can serve any request and you can add, remove, or restart instances freely. The moment you keep user state in process memory and pin users to instances (sticky sessions), you have lost most of the benefit.

**Around 100,000 users: add a cache, read replicas, a CDN, a gateway, and a queue.** The symptom is the database becoming the bottleneck (reads dominate, the same hot rows are fetched constantly) and slow operations (sending email, transcoding, calling a third party) blocking request threads. The moves, each justified by its symptom: a cache (Redis, cache-aside) to absorb hot reads; database read replicas to spread read load off the primary; a CDN to serve static assets and media from the edge so they never touch your origin; an API gateway to centralize auth, routing, and rate limiting in front of the services; and an asynchronous queue so slow work happens off the request path. The catch on read replicas is replication lag: a read right after a write may hit a replica that has not caught up and return stale data, so route reads that must be fresh to the primary. The catch on the queue is that "do it later" turns one consistency problem into two systems that must agree, which is exactly what the outbox pattern in the next section exists to solve.

**Around 1,000,000 users: shard the data, go multi-AZ, split read and write paths, and carve services at the seams that hurt.** The symptom is a single database primary that can no longer hold the write volume or the dataset, and a monolith where one slow area drags the rest. The moves: shard or partition the database by a key that spreads load evenly (user ID, tenant, or a geographic key); run every tier across multiple availability zones with health-checked failover; separate the read model from the write model where reads and writes have genuinely different shapes (this is CQRS, and it pairs naturally with the analytics path later); push large blobs (images, video, documents) to object storage fronted by a CDN rather than your database; and split the monolith into services only along seams that are causing real pain, not for its own sake. The catch on sharding is the shard key: pick one that distributes evenly and matches your dominant query, because a bad key creates hot shards and forces expensive cross-shard queries, and resharding later is a major project.

**Beyond, going global: multi-region, geo-routing, data locality, and cells.** The symptom is users on other continents eating your latency budget, plus regulations (GDPR) that constrain where data may live. The moves: deploy to multiple regions; route users to the nearest healthy region (DNS or anycast based geo-routing); keep each user's data in their region for both latency and compliance; and consider cell-based architecture, where the system is partitioned into independent cells so a failure or bad deploy is contained to one cell instead of taking down everyone. The catch is the hardest one in the guide: cross-region requests are slow and cross-region data consistency is genuinely difficult, so the design goal is to keep each request and its data inside one region, and to make the rare cross-region case explicit rather than accidental. A real interview surfaced exactly this: a call created in Tokyo with a participant in San Francisco either accepts the latency or needs a deliberate mechanism to relay traffic over the provider backbone rather than the public internet.

| Scale | Forcing symptom | The move | The catch |
|---|---|---|---|
| ~1K | None yet | Single box, vertical scale | No redundancy, no real availability |
| ~10K | App box maxed; one instance = outage | LB + N stateless app instances; DB on its own host | Instances must be stateless (session state in Redis) |
| ~100K | DB read-bound; slow work blocks requests | Cache, read replicas, CDN, gateway, async queue | Replica lag; the queue adds a consistency problem |
| ~1M | Single primary maxed; monolith drags | Shard DB, multi-AZ, read/write split, blobs to object store | Shard-key choice; resharding is expensive |
| Global | Cross-continent latency; data residency | Multi-region, geo-routing, data locality, cells | Cross-region consistency is hard; keep requests region-local |

The theme that ties the ladder together, and the line that reads as senior: scale the bottleneck the metrics actually name, not everything at once. "Just add app instances" stops helping the moment the real cap is the database connection pool or a downstream service, and naming that real constraint is worth more than reciting the whole ladder.

---

## Standard distributed patterns

Once work spans more than one system (a database plus a message broker, your service plus a third party), you hit a family of consistency problems that have standard answers. These come up in almost every round, usually disguised as "how do you make sure the payment is not lost" or "how do you guarantee the notification is sent." Learn the cluster around the outbox, because that is the one interviewers probe hardest. Each is stated as what, why, and the catch. For the broker itself (partitions, consumer groups, delivery semantics) see the Kafka guide; for the transactional database mechanics see the Relational Databases guide.

**Idempotency keys (the foundation).** An operation is idempotent if doing it twice has the same effect as doing it once. In a distributed system, retries are inevitable (timeouts, redeliveries, user double-clicks), so any state-changing operation needs a client-supplied idempotency key that the server records: first time, do the work and store the result under the key; subsequent times with the same key, return the stored result without redoing the work. Why it matters: without it, a retried "charge the card" becomes two charges. The catch: the key must be checked and the work committed in the same transaction, or two concurrent requests with the same key can both pass the check before either writes.

**Transactional outbox (the headline pattern).** The problem it solves is the dual write: you need to update your database and publish an event to a broker, but you cannot do both atomically, so a crash between them either loses the event (DB committed, publish failed) or fires a phantom event (publish succeeded, DB rolled back). The outbox makes it atomic by writing the event into an `outbox` table in the same database transaction as the business change. A separate relay process then reads unpublished rows and pushes them to the broker, marking them sent.

```text
BEGIN TRANSACTION
  UPDATE orders SET status = 'paid' WHERE id = 123
  INSERT INTO outbox (event_type, payload, sent) VALUES ('OrderPaid', {...}, false)
COMMIT
-- a separate relay polls outbox WHERE sent = false, publishes, sets sent = true
```

Why it works: the business row and the event commit together or not at all, so the event exists exactly when the change did. The catch: the relay gives at-least-once delivery (it can publish, crash before marking sent, and publish again on restart), so every consumer must be idempotent. The recorded ride-hailing interview reinvented this pattern live for payments: write the payment state to a relational database in a transaction, then reconcile against the payment provider, which is an outbox plus reconciliation in all but name.

**Inbox / idempotent consumer.** The mirror image on the receiving side. Because delivery is at-least-once, a consumer must dedupe: record each processed message ID in a `processed_messages` table inside the same transaction that applies its effect, and skip any ID already seen. This turns at-least-once delivery into exactly-once effect, which is the property people actually mean when they say "exactly once." The catch: "exactly-once delivery" across a network is effectively impossible; what you build is at-least-once delivery plus idempotent handling, and saying it that precisely is a senior tell.

**Change data capture (CDC).** Instead of writing an outbox row yourself, tail the database's replication log (the write-ahead log) with a tool like Debezium and turn each committed change into an event. Why reach for it: it captures every change with zero application code and no dual write, and it is the natural bridge feeding a search index, a cache, or an analytics warehouse (the OLAP section). The catch: you are now coupled to the database's internal change format and ordering, and a schema change can ripple into every downstream consumer, so CDC trades application simplicity for operational coupling.

**Saga (distributed transaction without a distributed lock).** When one logical operation spans several services (reserve the ride, authorize the payment, notify the driver) and you cannot hold a transaction across all of them, a saga runs the steps as a sequence of local transactions, each emitting an event that triggers the next, with a compensating action to undo each step if a later one fails. Orchestration uses a central coordinator that tells each service what to do; choreography has each service react to events with no central brain. Why: it gets you atomic-feeling multi-service operations without a two-phase commit. The catch: there is no isolation, so intermediate states are visible (the ride shows reserved before payment clears), and you must design every compensation, including the awkward ones (you cannot un-send a notification, you can only send a correction).

**Reconciliation and polling for external systems.** Third parties (payment providers, especially) often confirm asynchronously through a webhook, and that webhook can be missed (your endpoint was down, the network dropped it, they gave up after three retries). The robust design accepts the webhook as the fast path but also runs a background reconciliation job that periodically polls for any record stuck in a pending state past a timeout and asks the provider for its true status. Why: it closes the gap where money moved but you never heard about it. The catch: you must make the provider's identifier the source of truth and treat your own state as a cache of theirs, because only they actually know whether the charge succeeded.

**Durable queue for guaranteed delivery.** When a requirement is "this must never be lost" (the ride was accepted, the rider must be notified), the answer is a persistent queue with strong delivery guarantees between the producer and the delivery worker, so a crash on the worker side does not drop the message; it is redelivered. Why: it decouples "we decided to notify" (must not be lost) from "we actually pushed to the device" (best effort, retryable). The catch: durability is not delivery, the device may still be offline, so the queue guarantees the attempt survives, not that the user sees it, and you pair it with retries and a dead-letter queue for messages that never succeed.

---

## Anti-patterns: how good architecture decays

A design round often turns to "what is the best and the worst architecture decision you have made," and the strongest answers show you understand how a clean design rots over time, not just how to draw one on a whiteboard. Three failure modes come up again and again, and each has a mechanism that prevents it.

**The distributed monolith.** A set of services live in one repository, meant to be released independently, but they are so tightly coupled (to a shared backend and to each other) that no service ships without shipping the rest. You pay the operational cost of microservices (separate deploys, network hops, partial-failure handling) while keeping the release cadence of a monolith. Why it bites: the coupling is invisible day to day and only shows up the moment you try to release one piece and discover you cannot. The catch and the fix: independent release is a property of versioned contracts at the boundaries, not of separate folders. The test to apply is concrete, can you deploy service A against the previous version of service B and have it work. If not, you have a monolith wearing a microservices costume, and splitting the repo did not split the system.

**Accidental over-abstraction.** Someone builds a beautiful general-purpose layer, clean abstractions everywhere, for one specific purpose, and it is genuinely impressive on the day it ships. Then the requirements move, as they always do, and the abstraction that fit the original purpose now fights every new one. A common symptom is an impedance mismatch between layers: one side creates resources dynamically on demand while the other (say a Terraform or other declarative infrastructure description) can only ingest them statically, so every change means bending the system backwards to reconcile the two models. Why: an abstraction encodes the assumptions you held when you wrote it, and the cost of a wrong assumption shows up only later when it breaks. The catch is YAGNI in reverse: prefer the abstraction you can delete cheaply over the elegant one you cannot, and do not build for a generality the requirements have not yet demanded.

**Architecture by drift, and Conway's law.** The worst decisions are frequently the ones nobody consciously made. The system accreted into its current shape as requirements changed, one expedient choice at a time, and no single moment is where you would say "that was the mistake." This compounds with reorganizations: a component that had a clear owner loses it when a team is restructured, and "who owns this" becomes a manhunt that ends in "I used to, but not anymore." The catch and the mechanism: ownership has to be encoded, not remembered, through CODEOWNERS files and a service catalog that names a current owner for every component, and consequential decisions have to be captured in Architecture Decision Records (see the staff-level guide on the tech-topic to ADR pipeline) so the reasoning survives the people. Drift is the default; resisting it takes an explicit mechanism.

---

## Availability: the numbers and how you buy each nine

You are expected to recite the availability budget on demand. Each nine is a downtime allowance: 99% is about 3.65 days a year, 99.9% (three nines) is about 8.8 hours a year or 43 minutes a month, 99.99% (four nines) is about 52 minutes a year, and 99.999% (five nines) is about 5 minutes a year. The full table with monthly and daily columns, plus the SLI/SLO/SLA and error-budget framing, lives in Scaling Foundations; what a design round wants is not the recitation but the mechanism: how you actually buy each nine.

The core idea: availability is an architecture property, not a config flag. A single instance cannot reach three nines, because one deploy, one crash, or one bad release blows a 43-minute monthly budget. You buy availability with redundancy and fast recovery, layer by layer:

- **Redundancy (N+1, multi-AZ).** Run at least two of everything so no single instance is a single point of failure, and spread them across availability zones so one zone outage does not take you down. This is the first and biggest jump.
- **Health-checked failover.** A redundant pair only helps if traffic actually stops going to the dead one, so health checks plus automatic failover (at the load balancer for stateless tiers, via replica promotion for databases) are what convert "we have a spare" into "we stay up."
- **Stateless app tier.** Statelessness is an availability mechanism, not just a scaling one: if instances hold no state, losing one loses no data and a deploy is a rolling replace with no downtime.
- **Replication plus automated failover for data.** A primary with a synchronously or asynchronously replicated standby, promoted automatically on failure, is how the data tier survives a node loss. Synchronous costs latency but loses nothing; asynchronous is fast but can lose the last few writes.
- **Rolling and canary deploys with fast rollback.** Most outages are self-inflicted by deploys, so shipping to a few instances first, watching the metrics, and rolling back in seconds protects more budget than almost anything else.
- **Multi-region for the top nines.** Cloud providers typically offer around three-and-a-half nines per component, so reaching four nines for the whole system usually means redundancy across regions, not just zones, with the cross-region consistency cost that implies.

Two pieces of reasoning make this section sound senior. First, the multiplication rule: a request that depends serially on several components has availability equal to the product of theirs, so three components at 99.9% each give roughly 99.7% combined, which is why you add redundancy at each link rather than hoping the chain holds. Second, every nine costs disproportionately more than the last, so the real question is never "how do we get five nines" but "what does this specific service need, and what does the next nine cost," and many internal services are perfectly fine at three.

Disaster recovery is the related drill: define your RPO (recovery point objective, how much data you can afford to lose) and RTO (recovery time objective, how fast you must be back), then design backups and failover to meet them. A neat trick from a real video-call design: if your RPO allows losing up to an hour of ephemeral session state, partition that state by time so old buckets age out and only the recent bucket is at risk, which bounds the blast radius of a data-tier failure cheaply.

---

## Case: designing for RAG

Retrieval-augmented generation now shows up in system-design rounds the way caching did a decade ago. The premise: a large language model is fluent but its knowledge is frozen at training time and it will confidently invent specifics, so you ground its answers by retrieving relevant documents at query time and putting them in the prompt. The architecture splits cleanly into an offline ingestion path and an online query path, and it scales on the exact three-tier-plus-queue ladder from earlier, so most of this you already know.

The ingestion path is a batch or streaming pipeline: take source documents, split them into chunks (a paragraph or a few hundred tokens each), run each chunk through an embedding model to get a vector, and store the vector plus the original text in a vector store. The query path is the online service: embed the user's question with the same model, do a nearest-neighbor search in the vector store for the top-k most similar chunks, optionally rerank them with a more precise model, assemble a prompt (the question plus the retrieved chunks as context), call the LLM, and stream the answer back.

```text
INGEST (offline):  docs -> chunk -> embed -> vector store
QUERY  (online):   question -> embed -> top-k vector search -> rerank
                            -> build prompt (question + chunks) -> LLM -> stream answer
```

The components map onto familiar boxes. The vector store is a database with an access pattern of nearest-neighbor search; `pgvector` (PostgreSQL with a vector extension) is the pragmatic default when your scale is modest and you already run Postgres, with dedicated vector databases for larger or higher-throughput workloads. The embedding model is a separate piece you bring yourself: Anthropic has no first-party embeddings endpoint, so you pair Claude with a dedicated embedding model (Anthropic recommends Voyage AI; other common choices are Cohere, OpenAI, or open-source models in the BGE or E5 family). The generation model is Claude; current model IDs to name in the room are `claude-opus-4-8` and `claude-sonnet-4-6` (both with a 1M-token context window) and `claude-haiku-4-5` (200K), defaulting to the most capable model unless cost or latency pushes you down a tier. Ingestion workers and a queue handle the embedding fan-out exactly like any other slow async job, and a cache in front of both the embedding step and the final answers cuts cost and latency for repeated queries.

The catches are where the interview points live, and they are mostly not about the model:

- **Chunking strategy decides retrieval quality.** Chunks too large dilute the relevant signal and waste context budget; too small lose the surrounding meaning. This unglamorous choice moves answer quality more than the model does.
- **Retrieval quality dominates model quality.** If the right chunk is not in the top-k, no model can answer from it; most "the LLM is wrong" bugs are actually "retrieval missed." Spend your effort on embeddings, chunking, and reranking before reaching for a bigger model.
- **Context window and cost are a budget, not a free lunch.** A 1M-token window tempts you to stuff in everything, but every token costs money and latency, and burying the answer in noise degrades quality. Retrieve precisely even when you could retrieve broadly; this is the "long context versus RAG" debate, and the honest answer is "both, used deliberately."
- **Grounding and hallucination.** Instruct the model to answer only from the retrieved context and to say when it cannot, and use a citations mechanism so answers point back to source passages. This is the main defense against confident fabrication.
- **Freshness via CDC or the outbox.** When a source document changes, its stale vector must be re-embedded, which is exactly the change-propagation problem from the patterns section: feed updates through CDC or an outbox into the ingestion pipeline so the index does not drift from the source.
- **Latency budget and streaming.** End-to-end latency is retrieval plus generation, and generation is the slow part, so stream tokens to the user to hide it; perceived latency is time-to-first-token, not time-to-completion.
- **Prompt injection is the new SQL injection.** Retrieved or user-supplied text can carry instructions that hijack the model ("ignore previous instructions and..."), so treat retrieved content as untrusted data, not as commands, and keep privileged instructions in a channel the retrieved text cannot spoof.

A senior cost optimization to mention: prompt caching. When many requests share a large stable prefix (a long system prompt, a fixed set of retrieved reference documents), caching that prefix means you pay full price to process it once and a small fraction on every subsequent request, which materially changes the economics of a high-traffic RAG service.

---

## Case: adding OLAP / analytics

The second modern workload is analytics, and the first thing to get right is that it is a different machine from your transactional system. OLTP (online transaction processing) is your app's database: many small reads and writes, point lookups by key, row-oriented storage, optimized for low-latency single-record operations. OLAP (online analytical processing) is for reporting and dashboards: a few enormous queries that scan and aggregate across millions of rows, column-oriented storage, optimized for throughput over latency. Running heavy analytics on the OLTP primary is the classic mistake, and the symptom is concrete: a monthly-report query takes locks and saturates I/O, and your user-facing latency spikes while it runs.

The standard architecture separates them and pipes data from one to the other. Capture changes from the OLTP database (CDC or an outbox, the same patterns again), stream them into a columnar warehouse (BigQuery, Snowflake, Redshift, or ClickHouse for low-latency analytics), and run the heavy queries there against a schema shaped for analysis (typically a star schema: a central facts table referencing dimension tables). The ingestion can be batch (periodic ETL, simpler, higher latency) or streaming (continuous, fresher, more moving parts), and the choice is a freshness-versus-complexity tradeoff you should name explicitly.

```text
OLTP (row store) --CDC/outbox--> stream --> OLAP warehouse (column store)
   point reads/writes                          scan + aggregate, star schema
   user-facing, low latency                    reporting/dashboards, high throughput
```

This connects back to two earlier ideas. It is CQRS at the storage layer: the write model (OLTP) and the read model (the warehouse, or a materialized view) are physically separate and shaped for their different jobs, kept in sync asynchronously. And it is the hot/warm/cold tiering from the estimation section: recent data stays in the fast transactional store, older data moves to cheaper analytical or archival storage, and infrequent jobs (monthly invoicing, year-end reports) read from the cold tier where a five-minute scan is perfectly acceptable. A recorded interview made this concrete: completed ride records move out of the hot order store after a few minutes, and the once-a-month invoicing for business accounts pulls from the cold store, because nobody needs millisecond access to a six-month-old receipt.

The catches: data freshness versus cost (streaming is fresher but pricier and more complex than batch, so match it to how stale the business can tolerate), and schema drift (when the OLTP schema changes, the pipeline and warehouse schema must follow, or the analytics silently break), which is the same downstream-coupling catch that CDC carries everywhere.

---

## Worked drives

Here are three end-to-end runs through the six-step script, compressed. They are predict-the-moves sketches, not full solutions; the point is to see the script and the patterns reused under time pressure. They are drawn from real recorded interviews. For more conventional practice problems (a URL shortener, a news feed, a rate limiter), the classic system-design problem sets cover them well, and the same script applies unchanged.

**Ride-hailing (Uber, one city).** Requirements: rider orders, driver accepts, both tracked live, payment settles, both rate each other; scope to one city, keep future multi-city in mind. Estimate: ~25M residents, peak around 1,000 RPS at the order service, so reliability dominates over raw throughput. Design on the skeleton: clients (rider app, driver app) to an API gateway (centralizing auth via an external identity provider, routing, rate limiting) to services (order service as the lifecycle hub, a geolocation service for nearby-driver lookup, payment, notification, rating). Real-time location and notifications go through a durable queue with strong delivery guarantees, because "the rider must learn the driver accepted" must not be lost. Payment is the hard part and is pure outbox-plus-reconciliation: write payment state in a database transaction, call the payment provider, accept its webhook as the fast confirmation, and run a reconciliation poller for anything stuck pending past a timeout, treating the provider's record as the source of truth. Scale: replicate the whole stack per city and shard by city or region as you expand, since rides are naturally local; move completed orders to cold storage within minutes and pull invoices from there.

**Collaborative docs (Google Docs).** Requirements: multiple users edit one document concurrently with rich formatting and images, link-based sharing with per-user roles (viewer, commenter, editor, owner), web and mobile. Estimate: tens of millions DAU, hundreds of TB over a decade, so storage tiering and sharding are in from the start. Design: documents in a database keyed by document ID, with the access-controlled metadata alongside; images and media go to object storage behind a CDN rather than into the document store, with access mediated so a CDN URL does not leak a private document. Concurrent editing needs conflict-free merging (CRDTs or operational transforms, the algorithm most teams pull from a library rather than build), delivered over WebSockets so each client gets a live stream of other people's edits to apply against its local copy. Authorization is the fine-grained kind that must live in the service (only the service knows whether this user may edit this specific document), with coarse authentication handled at the gateway. Scale: geo-distribute, route users to the nearest region, and accept that real-time collaboration plus global distribution is where the genuine difficulty sits.

**Video calls (Google Meet).** Requirements: small group calls (say up to 20), audio plus video plus screen share, scoped to online-only (no recording). Estimate: ~3,000 call-setups per second, ~30,000 concurrent calls, modest signaling load but heavy media. The key tradeoff is topology: a full mesh (every participant streams to every other) pushes N-1 streams per person and melts the client uplink past a handful of participants, while a central media server (an SFU, selective forwarding unit) receives each participant's stream once and forwards it, trading server compute and bandwidth for a far lighter client. Pick the SFU for anything past a few participants, and say why: it centralizes the cost where you can scale it. Signaling (who is in the call, connection setup) is a separate, lightweight service backed by an in-memory store; the media path is where the GPUs and the capacity planning go. Scale: pin each call to a region near its participants, hash calls across media servers so one call lands on one server, and treat the cross-region participant as the explicit hard case (relay over the provider backbone, accept the latency, or both).

---

## Meta: framing it in the room

The recorded interviews are a catalogue of what separates a pass from a strong pass, and almost none of it is about knowing more components.

The most common ding is adding components no requirement asked for. Drawing a CDN, a cache, and a load balancer before any requirement justifies them reads as pattern-matching, not engineering; the fix is to add each box only when a symptom forces it and to say which symptom out loud. The mirror-image mistake is forgetting the requirements that should drive components: skipping security and compliance entirely, or not noticing that cross-region users break a single-region design. Name the non-functionals early (step 2) and let them pull components in.

The second pattern is failing to name the bottleneck. When you scale, say what the actual constraint is (the database connection pool, a downstream service, the client uplink) rather than reflexively adding app instances. "Just add instances" is the answer that stops working, and showing you know where it stops is the senior move.

The framing that lands best is treating every design decision as a tradeoff with options. Out loud: "Option one is a central media server, simpler to build and it centralizes cost; option two is a mesh, cheaper on our compute but it overwhelms the client past a few users; given the requirement for up to 20 participants, I will pick option one." That option-one-versus-option-two-plus-a-reason shape (essentially an architecture decision record spoken aloud) is exactly what interviewers mean when they say they want to see your reasoning. Manage the clock, ask them where the points are, and lead every answer with the decision before the justification.

Finally, a rapid-fire bank in the question-and-answer shape, since these recur. Answer with the mechanism, then the tradeoff.

**What problem does the transactional outbox solve?** The dual write: you cannot atomically update your database and publish to a broker, so a crash between them loses or duplicates the event. The outbox writes the event into a table in the same transaction as the business change, and a relay publishes it later. The tradeoff: delivery becomes at-least-once, so consumers must be idempotent.

**How do you get exactly-once processing?** You do not get exactly-once delivery across a network; you build at-least-once delivery plus an idempotent consumer (record each processed message ID in the same transaction that applies its effect, and skip duplicates). The effect is exactly-once even though delivery is not.

**Outbox versus CDC?** Both turn a database change into an event. The outbox is explicit (your code writes an outbox row) and decoupled from the database internals; CDC is implicit (a tool tails the write-ahead log) with zero application code but tight coupling to the database's change format. Use the outbox when you want application control, CDC when you want to capture everything without touching the app.

**What is a saga and when do you reach for it?** A way to run a logical transaction across services without a distributed lock: a sequence of local transactions, each with a compensating action to undo it if a later step fails. Reach for it when one operation spans several services. The tradeoff: no isolation, so intermediate states are visible and you must design every compensation.

**OLTP versus OLAP?** OLTP is row-oriented, point reads and writes, user-facing low latency; OLAP is column-oriented, large scans and aggregations, reporting throughput. Keep them separate and pipe OLTP changes into the OLAP warehouse via CDC or an outbox, because running analytics on the transactional primary takes locks and spikes user latency.

**Sharding versus replication?** Replication copies the same data to multiple nodes (for availability and read scaling); sharding splits different data across nodes (for write and storage scaling). They are orthogonal and usually combined: shard for capacity, replicate each shard for availability. The catch is the shard key, which must spread load evenly and match your dominant query.

**When do you actually need multi-region?** When users on other continents blow your latency budget, when data-residency law requires it, or when you need availability beyond what one region's roughly three-and-a-half nines provides. The cost is real: cross-region consistency is hard, so keep each request and its data inside one region and make the rare cross-region case explicit.

**Where does authorization live in a system design?** Coarse checks (is the caller authenticated, do they hold the right scope) belong at the gateway; fine-grained checks (may this specific user edit this specific document) must live in the service, because only the service knows the resource's ownership. Putting all of it at the gateway leaks domain rules out of the service.
