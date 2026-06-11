## How to use this guide

Kafka interview questions probe one of two things: whether you understand the log
abstraction well enough to reason from first principles about ordering, delivery,
and scaling; or whether you have operated Kafka and can name what breaks and why. A
definition answer ("Kafka is a distributed message broker") scores at the floor.
The production-anchor question ("have you hit this?") separates preparation from
experience.

This guide covers Apache Kafka 4.x. Kafka 4.0 removed ZooKeeper; all clusters now
run in KRaft mode. `exactly_once_v2` is the current recommended setting for
exactly-once Kafka Streams. Kafka 4.2.0 is the current stable release (February
2026).

---

## The mental model: a partitioned, ordered, durable log

The reframe that makes every Kafka concept fall into place: Kafka is not a message
queue. It is a distributed commit log. A topic is a named log, partitioned for
parallelism. Within a partition, every record has an immutable offset. Consumers
read by storing and advancing an offset, not by the broker deleting the record.
Records stay in the log until they age out (retention) or are compacted away.

Consequences of this model:

- The same data can be read by multiple independent consumers without the broker
  tracking who has read what. Adding a consumer does not slow down existing ones.
- A consumer can replay by resetting its offset. This is how you backfill a new
  downstream system or recover from a processing bug.
- The broker is simpler (no per-consumer delivery state) and therefore faster.
  The consumer owns its offset, which moves complexity to the right place.

The contrast with a traditional queue: a queue typically deletes a message once
consumed and tracks which consumer holds each message. Kafka does neither. This
means Kafka cannot do fine-grained per-message negative acknowledgement the way
RabbitMQ can, but it scales to much higher throughput with simpler broker internals.

---

## Topics, partitions, and offsets

A **topic** is a named feed of records. It is divided into **partitions**, each of
which is an ordered, immutable log stored on one broker (replicated to others).
Within a partition, records have sequential **offsets** starting at 0.

Partitions are the unit of parallelism and the unit of ordering. Kafka guarantees
order only within a partition, not across partitions of the same topic. If you need
all events for a given user, account, or instrument to be processed in order, you
must route them to the same partition by setting the key to the distinguishing
field. The producer hashes the key to select a partition: `murmur2(key) mod num_partitions`.
Records with no key are distributed round-robin.

Partitions are also the unit of replication. Each partition has one leader replica
(which handles all reads and writes) and zero or more follower replicas on other
brokers. The set of replicas that are caught up to the leader is the ISR
(In-Sync Replicas).

```text
Topic: orders  (3 partitions, replication-factor 3)

Partition 0:  [offset 0] [offset 1] [offset 2] ...   leader: broker-1
              replicas: broker-2 (follower), broker-3 (follower)

Partition 1:  [offset 0] [offset 1] ...               leader: broker-2
              replicas: broker-1, broker-3

Partition 2:  [offset 0] [offset 1] ...               leader: broker-3
              replicas: broker-1, broker-2
```

---

## ISR and what happens when a broker falls out

The **ISR** (In-Sync Replicas) is the set of replicas that are fully caught up to
the leader within `replica.lag.time.max.ms` (default: 30 seconds). The leader
tracks each follower's progress. A follower that falls behind (because the broker
is overloaded, a network partition, or a GC pause) is removed from the ISR.

Durability depends on the ISR. The producer setting `acks=all` (or `acks=-1`) means
"wait for all in-sync replicas to acknowledge before returning success." If the ISR
shrinks to 1 (just the leader), `acks=all` is effectively `acks=1`, so the leader
failing immediately after ack would lose the record.

The `min.insync.replicas` setting guards against this: with `min.insync.replicas=2`
and `acks=all`, a produce request fails if fewer than 2 replicas are in-sync,
forcing the producer to retry rather than silently writing to a barely-replicated
partition.

When the leader broker fails, one ISR follower is elected as the new leader by the
KRaft controller. Replicas not in the ISR ("unclean") are not eligible for
election unless `unclean.leader.election.enable=true` (off by default), which would
risk data loss.

---

## Consumer groups: parallel consumption

A **consumer group** is a set of consumers that together read all partitions of a
topic. The broker assigns partitions to consumers within a group: each partition is
read by exactly one consumer in the group at a time. Consumers in the same group do
not see the same record twice.

**Maximum parallelism** is bounded by the number of partitions. If a topic has 12
partitions and a consumer group has 12 consumers, each consumer reads 1 partition.
Adding a 13th consumer leaves it idle. If you want more parallelism than the
current partition count allows, you must increase the partition count (a
non-reversible operation that requires re-hashing key-based partitioning).

**Independent consumer groups** each maintain their own offsets. Two consumer groups
on the same topic read independently, from potentially different positions. This is
how Kafka supports fan-out: a billing service and an analytics service can each
consume the same topic at their own pace.

**Rebalancing** happens when a consumer joins or leaves the group, or a consumer
fails to send a heartbeat within `session.timeout.ms`. During a rebalance, all
consumers in the group stop consuming (the "stop the world" rebalance), partitions
are reassigned, and consumers resume. A rebalance is the main source of consumer-lag
spikes and is worth monitoring. Kafka's cooperative rebalancing (KIP-429, enabled
by default in recent clients) reduces stop-the-world time by only reassigning
partitions that actually need to move.

```text
Topic: events (4 partitions)

Consumer group A (3 consumers):
  consumer-1: partitions 0, 1
  consumer-2: partition 2
  consumer-3: partition 3

Consumer group B (2 consumers):
  consumer-4: partitions 0, 2
  consumer-5: partitions 1, 3
  (group A and B are fully independent)
```

---

## Delivery semantics: at-least-once vs exactly-once

Kafka's delivery semantics are determined by producer configuration and consumer
commit strategy.

**At-most-once** delivery means the producer does not retry failed sends and the
consumer commits offsets before processing. Records can be lost (send fails and is
not retried; consumer commits and then crashes before processing). This is rarely
acceptable.

**At-least-once** delivery means the producer retries on failure (`retries > 0`,
now the default) and the consumer commits offsets after processing. Records can be
duplicated: the broker receives the record, acks, the ack is lost in the network,
the producer retries, and the broker stores a second copy. The consumer side: the
consumer processes, crashes before committing, restarts, and re-reads the same
record. At-least-once is the default behavior and the right choice when idempotent
downstream processing is cheap.

**Exactly-once** means each record is processed exactly once end-to-end. Kafka's
implementation requires two components:

**Idempotent producer:** enabled with `enable.idempotence=true` (default since
Kafka 3.0). Each producer instance gets a PID (producer ID) and each record gets a
sequence number per partition. The broker deduplicates retried records using the
PID and sequence number.

**Transactions:** a producer wraps a batch of writes (across multiple partitions
and topics) in a transaction. `beginTransaction`, writes, `commitTransaction`
atomically: consumers with `isolation.level=read_committed` only see committed
transactions. Aborted transactions are invisible. Kafka Streams uses transactions
internally; the setting `processing.guarantee=exactly_once_v2` enables this.

The cost of exactly-once: transactions add latency (the coordinator must log the
transaction begin/commit to a durable topic), reduce throughput (smaller batches
due to fencing checks), and require `read_committed` isolation on consumers
(which filters out in-flight transaction data). For Kafka Streams, `exactly_once_v2`
(introduced in 2.5) is recommended over the older `exactly_once` because it uses
one transaction per partition rather than one per task, reducing coordinator load.

---

## Log compaction vs retention

Kafka topics have two cleanup strategies.

**Retention** (the default) deletes segments older than `retention.ms` (default:
7 days) or larger than `retention.bytes`. It is right for event streams where older
data is simply not needed: application logs, metrics, raw clickstreams.

**Log compaction** retains the latest record for each key, discarding older records
with the same key. The log becomes a snapshot of the current value per key. It is
right for changelog topics: a database change-event stream, a user-profile update
stream, or a cache-invalidation changelog. A consumer that joins late and reads the
compacted topic gets the current state without replaying the full history.

The catch: compaction is not immediate. Kafka's cleaner thread runs in the
background and compacts the "dirty" (unconsumed) portion of the log. Consumers may
see duplicate keys before compaction runs, and a tombstone record (a record with a
null value) marks a key as deleted; the tombstone itself is retained for
`delete.retention.ms` (default: 24 hours) before being removed, to give consumers
time to read the deletion event.

---

## Consumer lag: how to diagnose and fix

**Consumer lag** is the number of records in the partition that the consumer group
has not yet processed: `(latest offset) - (committed offset)`. Lag growing means
the consumer is processing more slowly than new records arrive.

**Diagnosis steps:**

1. **Measure lag precisely.** Use `kafka-consumer-groups.sh --describe` or a
   monitoring system (Kafka JMX, Prometheus+Grafana) to see lag per consumer group
   per partition. Uneven lag across partitions often points to a hotspot: one
   partition receives disproportionate volume because all records share the same
   key.
2. **Check consumer throughput.** Is processing time per record increasing? A slow
   downstream call (database, API) blocks the consumer thread and reduces
   throughput. Add per-record processing timing.
3. **Check partition count vs consumer count.** If the topic has 4 partitions and
   the consumer group has 1 instance, adding 3 more instances (up to 4) doubles or
   quadruples throughput.
4. **Check GC pauses.** A JVM consumer that pauses for GC may exceed
   `session.timeout.ms` and trigger a rebalance, stalling consumption for seconds.
5. **Check network and disk I/O on the broker.** A lagging ISR follower can slow
   the leader if `acks=all` is set (the leader waits for in-sync replicas).
6. **Check rebalance frequency.** Frequent rebalances (every few minutes) indicate
   session timeouts (tune `heartbeat.interval.ms` and `session.timeout.ms`) or
   consumer crashes.

**Fixes in order of invasiveness:**
- Tune batch size and `max.poll.records` to reduce per-poll overhead.
- Add consumer instances (up to partition count).
- Increase partition count (irreversible; requires verifying key-based routing still
  distributes correctly).
- Move slow processing off the Kafka thread (async dispatch to a thread pool, re-ingest
  results).

---

## Ordering guarantees

Kafka guarantees strict ordering within a partition. To guarantee that all events
for a logical entity (a user, an instrument, an order) are processed in order, all
events for that entity must go to the same partition. You achieve this by setting
the record key to the entity identifier and relying on the default `murmur2(key) mod
num_partitions` assignment.

The catch: if you increase the partition count, the hash assignment changes. An
entity that was on partition 2 moves to partition 5. If in-flight records are
already in partition 2 and new records go to partition 5, a consumer group
processes them on different threads and ordering is no longer guaranteed for records
spanning the partition boundary. The operational practice is to drain a topic to
zero lag before repartitioning, or to use a separate topic and migration window.

For cross-partition ordering (events from multiple entities that must be globally
ordered), Kafka does not help directly. You need a single partition (losing
parallelism), a sequence number embedded in the records (ordering in the consumer),
or an external coordination mechanism.

---

## Message queue vs event log

This is the architectural question that the "messaging and data" section of a
system-design interview builds around.

A **message queue** (RabbitMQ, SQS, ActiveMQ) is designed for task distribution:
a message is delivered to one consumer, acknowledged when processed, and then
deleted. The broker tracks delivery state per message. Adding consumers speeds up
processing. Loss is avoided by acknowledgements. It suits: background job
processing, work distribution to a fleet of workers, RPC-over-queue patterns.

An **event log** (Kafka) records what happened and holds it durably. Many consumers
read independently. Adding a consumer does not speed up any other consumer. Data is
retained by time or compaction, not by delivery. It suits: building read models from
a shared event source, audit logs, event-sourcing, CDC (change-data capture),
streaming analytics.

The distinction matters architecturally when you need fan-out (multiple independent
pipelines on the same events) or replay (rebuilding a service from scratch from
historical data). A queue cannot do either without significant extra engineering. An
event log does both natively. Kafka is the wrong choice when you need per-message
TTL, sophisticated dead-letter handling, priority queues, or per-message
negative-acknowledgement, where a traditional queue is simpler.

---

## Common interview questions

**What is a consumer group and what problem does it solve?**
Testing: core Kafka partitioning model.
A consumer group is a set of consumers that together read all partitions of a
topic, each partition assigned to exactly one consumer at a time. It scales
consumption horizontally without duplicate processing within the group. Independent
groups read the same topic fully independently. Maximum parallelism equals the
number of partitions; additional consumers beyond that are idle.

**What is the difference between at-least-once and exactly-once delivery in Kafka?
What does exactly-once cost you?**
Testing: operational delivery semantics knowledge.
At-least-once is the default: producers retry on failure, consumers commit after
processing. Duplicates are possible (retried send, consumer crash before commit).
Exactly-once requires an idempotent producer (deduplication by PID and sequence
number) plus transactions (atomic cross-partition writes, `read_committed` consumer
isolation). It costs latency (transaction coordinator overhead), lower throughput
(fencing checks), and `read_committed` consumers filtering in-flight data.

**A Kafka consumer is falling behind. How do you diagnose and fix it?**
Testing: production operations knowledge.
Measure lag per partition with `kafka-consumer-groups.sh`. Uneven lag suggests a
partition hotspot (one key dominating). Check processing time per record for slow
downstream calls. Verify consumer count vs partition count (max parallelism = number
of partitions). Check GC pauses causing session timeouts and rebalances. Check
broker I/O. Fix in order: tune `max.poll.records`, add consumers up to partition
count, increase partition count if needed (irreversible, check key routing).

**What is log compaction and when would you use it over retention?**
Testing: log design knowledge.
Log compaction retains the latest record per key, discarding older records with the
same key. Use it for changelog topics: database CDC, user profile snapshots, cache
invalidation changelogs. A late-joining consumer reads current state without
replaying full history. Use retention for event streams where old data is simply not
needed (logs, raw events). Tombstone records (null value) mark deletions.

**What determines the maximum parallelism of a Kafka consumer group?**
Testing: fundamental constraint.
The number of partitions in the topic. Each partition is consumed by at most one
consumer in a group at a time. A 12-partition topic with 12 consumers: full
parallelism. A 13th consumer is idle. Increasing partition count allows more
parallelism but is irreversible and disrupts key-based routing for in-flight records.

**What is ISR and what happens when a broker falls out of it?**
Testing: replication and durability model.
ISR (In-Sync Replicas) is the set of replicas caught up to the leader within
`replica.lag.time.max.ms`. With `acks=all`, the leader waits for all ISR members to
acknowledge. If a follower falls behind (overload, network, GC), it is removed from
the ISR; `acks=all` then requires fewer acknowledgements, reducing durability.
`min.insync.replicas=2` prevents writes when too few replicas are in-sync, forcing
producers to retry rather than silently accepting low-durability writes. On leader
failure, only ISR members are eligible for election by default.

**How would you use Kafka to guarantee per-instrument event ordering?**
Testing: application of the partition model.
Set the record key to the instrument identifier. The producer hashes the key to
select a partition: all events for the same instrument always land in the same
partition and are processed in offset order by the consumer. Within a partition,
Kafka guarantees order. The catch: if you increase the partition count, the
key-to-partition mapping changes; drain to zero lag before repartitioning. Cross-
instrument global ordering cannot be guaranteed by Kafka alone; it requires a single
partition (losing parallelism) or application-level sequencing.

**What is the difference between a message queue and an event log? When does the
distinction matter architecturally?**
Testing: system-design vocabulary.
A message queue delivers each message to one consumer and deletes it on
acknowledgement; the broker tracks per-message delivery state. An event log
(Kafka) retains records by time or compaction; any number of independent consumers
read from any offset. The distinction matters when you need fan-out (multiple
independent pipelines on the same events) or replay (rebuilding a service from
historical data), both of which a queue handles poorly. Kafka is the wrong choice
when you need per-message TTL, priority queues, or fine-grained per-message
negative-acknowledgement.
