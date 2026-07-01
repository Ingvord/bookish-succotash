## How to use this guide

You are preparing for a round that assumes you have run relational databases in
production. The questions are not about syntax; they are about what happens when
things go wrong, what the trade-offs are, and whether you can name the mechanism
behind a slow query or a failed transaction. This guide covers PostgreSQL as the
primary target, with a MySQL/MariaDB delta at the end. Both PostgreSQL 17 and the
current LTS, MySQL 8.4, are the reference versions.

Read the playbooks section last: they give you a framework for the two most common
"walk me through your investigation" questions. The "Common interview questions"
section at the end mirrors the rapid-fire shape of the actual screen.

---

## The mental model: what a query planner does

Before any question about indexes or slow queries, you need one reframe: the
database does not execute the SQL you wrote; it executes the plan the query planner
chose, and the planner makes that choice based on statistics, not certainty.

The planner holds a statistics catalog (called `pg_statistic` in Postgres) that
stores histograms of column value distributions, the number of distinct values, and
the fraction that are null. Given a query, it generates candidate plans, estimates
the cost of each in abstract units (disk pages read plus CPU), and picks the
cheapest. Its cost estimate is only as good as the statistics are fresh.

That is the root cause of the most common class of production issue: the planner
chooses a bad plan not because the index is missing but because stale statistics
made a table look small when it is now large, or the value distribution changed so
that what was selective yesterday is now a near-full-scan today. The answer to
"query was fast last week, slow today" almost always starts here.

---

## Sequential scan vs index scan

These are the two main access paths, and the planner chooses between them using its
selectivity estimate.

A **sequential scan** reads every page of the table in storage order. It uses
prefetch-friendly sequential I/O and needs no extra structure. For a query that
returns a large fraction of the rows, it is faster than an index scan because the
index would require a random-read per matching row.

An **index scan** reads the index structure (a B-tree by default) to find matching
row pointers, then fetches those rows from the heap (the table storage). Each row
fetch is a random read. It is faster when the query is highly selective, meaning
only a small fraction of rows match.

The crossover point is approximately 5 to 10 percent of rows, but the exact
threshold depends on the physical layout of the table. If matching rows are
clustered together on disk (the table was recently loaded in order, or a `CLUSTER`
command was run), random reads are cheaper and the index wins at a higher
selectivity. If the table is fragmented, the random-read cost is higher and the
planner may prefer a sequential scan sooner.

There is a third path, the **index-only scan** (or "covering index"), where all
columns the query needs are in the index itself. Postgres can satisfy the query
without touching the heap at all, skipping the random-read penalty entirely. This
is the most efficient path for selective queries on large tables.

```sql
-- Force an index-only scan possibility: include both filter and projection columns
CREATE INDEX ON orders (created_at, status, total)
  WHERE status = 'pending';
-- EXPLAIN will show "Index Only Scan" if the visibility map allows it
EXPLAIN (ANALYZE, BUFFERS)
  SELECT total FROM orders WHERE created_at > now() - interval '1 day'
    AND status = 'pending';
```

The key diagnostic: `EXPLAIN ANALYZE` shows which plan was chosen and the actual
versus estimated row counts. A large gap between them is the tell for stale
statistics.

---

## MVCC: the mechanism behind read consistency

MVCC (Multi-Version Concurrency Control) solves a hard problem: how do you let
readers and writers proceed in parallel without either blocking the other or
reading a partially-written state?

The answer is that the database keeps multiple versions of each row. When a
transaction writes a row, it does not overwrite the old value; it creates a new
version stamped with its transaction ID. Readers see the version that was current
at their transaction start, determined by whether each version's create and delete
transaction IDs fall within the reader's snapshot. A long-running reader will
continue to see the snapshot it started with even if many writes happen behind it.

The catch is that old versions accumulate. Postgres calls them dead tuples. A row
updated ten times has ten versions on disk, but only one is live for any current
transaction. The rest are dead tuples consuming space and degrading scan
performance because every sequential scan has to skip over them. MVCC also causes
the "transaction ID wraparound" problem: Postgres uses 32-bit transaction IDs, so
after 2 billion transactions a wraparound would make old visible rows appear to be
in the future. Postgres prevents this with VACUUM.

MySQL's InnoDB implements MVCC differently: old versions live in the undo log
rather than inline in the heap. The effect on readers is similar (snapshot
isolation), but the cleanup mechanism differs (purge thread vs Postgres VACUUM).

---

## WAL: durability on disk

WAL (Write-Ahead Log) is how the database guarantees that a committed transaction
survives a crash. Before any data page is modified on disk, the modification is
first written sequentially to the WAL. If the server crashes and restarts, it
replays the WAL from the last checkpoint to reconstruct any in-memory changes that
had not been flushed to the data files.

Why sequential before random? Writing sequentially to the WAL is fast because it is
an append, and the OS can batch the flush. Writing the modified data pages is slow
because they are scattered across the file. WAL lets Postgres acknowledge a commit
to the client as soon as the WAL record is on disk, without waiting for the slower
random write to the data file.

WAL has two major operational uses beyond crash recovery. First, it is the
mechanism for replication: streaming replication ships WAL records to standby
servers, which replay them to stay in sync. Second, it is the raw material for
point-in-time recovery: archive all WAL records and you can reconstruct the
database at any past moment.

The catch: WAL is append-only and never shrinks by default. `wal_level`, `archive_mode`,
and replication slots determine how long WAL is retained. A replication slot that
no standby is consuming will cause WAL to accumulate indefinitely and fill the disk.
This is a common production incident.

---

## VACUUM and autovacuum

VACUUM does two distinct jobs. First, it marks dead tuples (old row versions from
MVCC) as free space so that future inserts can reuse the pages. Second, and more
urgently, it advances the "oldest transaction ID seen" counter to prevent wraparound.

Autovacuum runs these jobs automatically in the background based on thresholds: when
the number of dead tuples in a table exceeds `autovacuum_vacuum_threshold` plus
`autovacuum_vacuum_scale_factor` times the table size, a VACUUM run is triggered.

VACUUM becomes operationally important in three situations:

**Bloat on write-heavy tables.** A table that is updated or deleted frequently
accumulates dead tuples faster than autovacuum can reclaim them, especially under
load. Pages fill with dead tuples, scans slow down because they must skip the dead
rows, and the table file grows even as the live row count stays constant. A sign:
the table size (from `pg_relation_size`) is much larger than the live row count
would justify.

**Wraparound prevention.** Every table has an age measured in transaction IDs.
When a table's age approaches 2 billion, Postgres enters an emergency
"wraparound safe mode" and will refuse all writes until VACUUM runs on that table.
This is a real production outage scenario. Monitoring `pg_stat_user_tables.n_dead_tup`
and `pg_stat_user_tables.last_autovacuum` is standard practice.

**Post-bulk-load.** After a large INSERT or COPY, the table has no dead tuples but
the statistics are stale. Running `ANALYZE` (statistics only) or `VACUUM ANALYZE`
after a bulk load is a standard maintenance step.

```sql
-- Check for bloated tables
SELECT relname, n_dead_tup, n_live_tup,
       round(n_dead_tup * 100.0 / NULLIF(n_live_tup + n_dead_tup, 0), 1) AS pct_dead,
       last_autovacuum
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC
LIMIT 10;
```

---

## Deadlocks

A deadlock occurs when two transactions each hold a lock the other needs, so both
wait forever. The database detects the cycle (typically within a second) and
terminates one transaction with an error, releasing its locks so the other can
proceed. The terminated transaction must be retried by the application.

The pattern to know: deadlocks on the same table almost always mean two transactions
are acquiring row locks in different orders. Transaction A locks row 1 then row 2;
transaction B locks row 2 then row 1. They meet in the middle. The standard fix is
to ensure all transactions that touch multiple rows do so in a consistent, canonical
order (by primary key, for example).

The log entry to look for in Postgres: `ERROR: deadlock detected`, followed by a
detail showing the two transactions and the locks. The `log_lock_waits` setting
(default: off) logs lock waits that exceed `deadlock_timeout` (default: 1 second)
and is worth enabling in production.

---

## Locking: optimistic vs pessimistic

Both strategies manage concurrent access to the same data, but they differ in when
the lock is acquired and what happens under contention.

**Pessimistic locking** acquires a lock before reading the row, using `SELECT ... FOR UPDATE`. No other transaction can modify the row until the lock is released at commit. It is safe: you are guaranteed the data has not changed. The cost is contention: high-traffic rows become a bottleneck, and long transactions with `FOR UPDATE` can cascade into lock chains.

**Optimistic locking** reads the row without locking, performs business logic, then
re-reads at update time and aborts if the data changed. The usual mechanism is a
version column: `UPDATE ... SET version = version + 1 WHERE id = ? AND version = ?`.
If zero rows are updated, someone else changed it and the application retries. No
lock is held during the read or the business logic, so concurrency is high. The
cost is retry complexity and write amplification on contended rows.

Choose pessimistic when the conflict rate is high (multiple writers on the same row
frequently, e.g., an inventory reservation) or when the business logic is expensive
to redo. Choose optimistic when reads vastly outnumber writes on a row and retries
are cheap, e.g., updating a user profile.

```sql
-- Pessimistic: lock the row for the duration of the transaction
BEGIN;
SELECT * FROM accounts WHERE id = 42 FOR UPDATE;
-- ... business logic ...
UPDATE accounts SET balance = balance - 100 WHERE id = 42;
COMMIT;

-- Optimistic: read, check, conditional update
-- Application reads: SELECT id, balance, version FROM accounts WHERE id = 42
-- Application updates:
UPDATE accounts
SET balance = balance - 100, version = version + 1
WHERE id = 42 AND version = 3;
-- If 0 rows updated: conflict, retry the whole read-compute-write cycle
```

---

## ACID: the four properties, ranked for payments

ACID describes the four guarantees a database transaction provides. The
acronym is taught as a flat list, but for a payment system the four properties
have different weight and different failure modes in a distributed setup.

**Atomicity:** every operation in a transaction succeeds, or the transaction
is rolled back as if it never happened. Debit and credit succeed together or
neither commits. Within a single Postgres instance this is enforced by the
write-ahead log: an uncommitted transaction can always be rolled back by
replaying the undo information. The hard part is atomicity across services:
when Payments and Identity run in separate databases, a crash between the
debit commit and the credit commit leaves both accounts in an inconsistent
state. The solutions are a distributed transaction (two-phase commit, high
coordination cost) or an outbox-backed compensation pattern (saga), which
is covered in the Backend System Design guide.

**Consistency:** a transaction brings the database from one valid state to
another. This is the property enforced by constraints (foreign keys, `CHECK`
constraints, unique indexes) and by application-level invariants (balance must
not go negative). Consistency is the property the database cannot fully
enforce on your behalf; it only enforces the constraints you declare. The
invariant that "a debit must not exceed the balance" is an application
invariant, enforced in code. Forgetting to lock the row before reading the
balance is how consistency is violated even with a transaction.

**Isolation:** concurrent transactions must not interfere with each other.
Postgres defaults to `READ COMMITTED`, which means a transaction can read rows
committed by other transactions between its own statements. For a payment
system this creates a TOCTOU race: read the balance (`SELECT balance`), check
it is sufficient, then debit (`UPDATE balance = balance - amount`). Between
the read and the update, another transaction may have debited the same account.
The update executes, and the balance goes negative.

The fix is either a pessimistic lock (`SELECT ... FOR UPDATE` holds the row
lock through the check and the update, so no concurrent debit can interleave)
or a constraint-based check inside the update itself:

```sql
UPDATE accounts
SET balance = balance - 100
WHERE id = 42 AND balance >= 100;
-- Check that 1 row was updated; if 0, the balance was insufficient
```

Switching to `REPEATABLE READ` or `SERIALIZABLE` closes some races but not
all: `SERIALIZABLE` detects conflicting serial orderings and aborts one
transaction, requiring a retry. The isolation trade-off is covered in the MVCC
section above, which explains how Postgres uses row versioning to implement
each isolation level without reader-writer blocking.

**Durability:** a committed transaction survives process crashes and power
failures. Postgres guarantees this through the write-ahead log (WAL): changes
are written to the WAL before the commit is acknowledged to the client. On
recovery, Postgres replays the WAL from the last checkpoint. The WAL section
above covers the mechanics. The catch: `synchronous_commit = off` disables
the WAL flush before acknowledgement, gaining throughput at the cost of losing
the last few commits on a crash. Acceptable for analytics; not for payment
ledgers.

Framing ACID for an interviewer: start with atomicity and isolation, because
those are the two that have visible failure modes in production payment systems.
Consistency and durability are largely guaranteed by the database if you declare
your constraints and leave `synchronous_commit` on.

---

## Connection pooling

Postgres creates a new OS process for each client connection. Each process costs
about 5 to 10 MB of RAM and has startup overhead. A naive application that opens a
connection per request or holds connections open during slow I/O will exhaust
`max_connections` (default: 100, often raised to 200-400) and cause connection
errors under load.

A connection pool sits between the application and the database. It maintains a
fixed set of server connections and multiplexes application requests across them.
The most widely used tools are **PgBouncer** (transaction-level pooling, the
common production choice) and **pgpool-II** (also handles read/write splitting).
ORMs have their own built-in pools but they are per-process and can still exhaust
the database limit on multi-process deployments.

The sizing rule of thumb: the Postgres documentation suggests one connection per
CPU core for CPU-bound workloads, with total connections rarely exceeding 200-400
even on large servers. Above that, the context-switching overhead in the OS
outweighs the parallelism benefit.

The catch: PgBouncer transaction-level pooling is incompatible with prepared
statements in some configurations (each statement is prepared on whatever backend
connection happens to be used) and with `SET` commands, advisory locks, and `LISTEN/NOTIFY`
that must persist across multiple statements.

---

## Index strategy

The default Postgres index is a B-tree, which supports equality (`=`) and range
(`<`, `>`, `BETWEEN`), and works with `ORDER BY`. The B-tree covers the vast
majority of use cases.

Other types to know: **GIN** (Generalized Inverted Index) for full-text search,
JSONB containment, and array operators. **GiST** for geometric types and
exclusion constraints. **BRIN** (Block Range Index) for very large tables where
data is naturally ordered by insert (timestamps, sequential IDs), because BRIN
stores only the min/max per range of pages instead of individual row pointers, so
it is tiny and fast to maintain at the cost of less precision.

**Partial indexes** cover only the rows where a predicate is true. An index on
`(created_at) WHERE status = 'pending'` is small, fast to update, and highly
selective for the exact query it targets.

**Composite indexes** serve queries that filter on multiple columns. The column
order matters: a composite index on `(a, b)` can answer queries on `a` alone or on
`(a, b)` together, but not on `b` alone (the "leftmost prefix rule").

The planner will skip an index when the query uses a function on the indexed column
(`WHERE lower(email) = 'foo'` ignores an index on `email`; you need a functional
index: `CREATE INDEX ON users (lower(email))`). It will also skip an index if the
type coercion between the literal and the column type prevents a match.

---

## jOOQ and Flyway: type-safe SQL and migrations

jOOQ is the primary Postgres interface at a number of Java-heavy fintech
companies and is increasingly common across the industry. Understanding the
paradigm, even before hands-on use, lets you talk about the trade-off
accurately.

**jOOQ** is a type-safe SQL builder. It generates Java classes from the live
database schema using a code-generation step, so every table, column, and type
has a corresponding Java type. The compiler catches column-name typos and
type mismatches that a string-based query or a JPA `@Query` annotation would
surface only at runtime.

A jOOQ select query:

```java
// DSLContext is the entry point, injected by the jOOQ Spring Boot starter
List<AccountRecord> accounts = dsl
    .selectFrom(ACCOUNTS)
    .where(ACCOUNTS.CURRENCY.eq("GBP")
        .and(ACCOUNTS.BALANCE.gt(BigDecimal.ZERO)))
    .orderBy(ACCOUNTS.CREATED_AT.desc())
    .limit(100)
    .fetchInto(AccountRecord.class);
```

`ACCOUNTS`, `ACCOUNTS.CURRENCY`, and `ACCOUNTS.BALANCE` are generated classes.
If a migration renames the `balance` column to `amount`, the generated class
changes and `ACCOUNTS.BALANCE` no longer compiles. The build fails at compile
time rather than at runtime when a customer triggers the query.

jOOQ is not an ORM. It does not manage an identity map, lazy-load associations,
or maintain a first-level cache. You write SQL semantics in Java syntax and get
exactly the query you wrote, with the query text visible in the generated SQL
log. For query-intensive work (reporting, ledger queries, complex joins) this
is preferable to Hibernate's N+1-prone generated SQL.

The catch: jOOQ's generated code must be regenerated on every schema change.
The standard build sequence is: Flyway migration runs (applying the schema
change to the database), then jOOQ codegen runs (reading the updated schema
and regenerating the Java classes), then the application compiles. This couples
the build to a running database, which requires a test-database instance or a
containerized Postgres (Testcontainers works here) in the CI pipeline. That
operational overhead is the trade for compile-time safety.

**Flyway** manages database schema migrations as versioned SQL files applied
in order. Each migration file is named with a version prefix (`V1__create_accounts_table.sql`,
`V2__add_currency_column.sql`). Flyway records applied migrations in a
`flyway_schema_history` table so the migration state is tracked and repeatable
across environments: running Flyway on a fresh CI database, a developer
laptop, and production applies exactly the same set of migrations in the same
order.

```sql
-- V1__create_accounts_table.sql
CREATE TABLE accounts (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    currency    CHAR(3)        NOT NULL,
    balance     NUMERIC(19, 4) NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ    NOT NULL DEFAULT now()
);
```

The catch: migrations are immutable once applied. You never edit a shipped
migration file. Flyway checksums each applied migration and compares the
checksum on every startup: if a previously-applied file has changed, Flyway
refuses to start the application. The correct procedure is to add a new
migration (`V3__rename_balance_to_amount.sql`) rather than editing `V1`.
This immutability is what makes the migration history a reliable audit trail
for schema evolution.

---

## Sharding: scaling writes horizontally

Sharding splits data across multiple database instances (shards) so that each
handles a fraction of the total write load. Reads often go to the same shard as the
write, since the row's location is known.

**Hash sharding** applies a hash function to the shard key (typically a user ID or
account ID) and assigns the result to a shard bucket. Distribution is uniform and
predictable. Adding a new shard requires rehashing and migrating rows, which is
expensive. Consistent hashing reduces migration cost by remapping only the keys
assigned to the added/removed node.

**Range sharding** assigns rows to shards by a continuous key range (e.g., users
0-999999 go to shard 0, 1000000-1999999 to shard 1). Adding a new shard is
simple: split a range. The catch is **hotspots**: if nearly all activity is in the
most recent range (for a date-keyed table, the current day), one shard handles most
writes while the others are idle.

The operational cost of sharding is high: cross-shard joins must be done in the
application, cross-shard transactions require distributed coordination (two-phase
commit), and schema migrations must be applied to every shard. Postgres 17's native
declarative partitioning handles hash and range partitioning within a single
instance, which covers many "I need sharding" use cases at much lower complexity.

---

## MySQL/MariaDB: the key delta

The primary production MySQL storage engine is **InnoDB**, which uses MVCC (with
old versions in the undo log rather than the heap), row-level locking, B-tree
clustered primary key indexes (the entire row lives in the primary key leaf, unlike
Postgres's heap), and ACID transactions. InnoDB's clustered index means that a
primary key lookup is a single tree traversal to the row, while a secondary index
lookup requires two traversals (secondary index to primary key, then primary key to
row), a property called a "double lookup" that affects index design.

**Replication** is MySQL's strength. MySQL's binary log (binlog) is the replication
mechanism and is separate from InnoDB's redo log. Traditional MySQL replication is
statement-based or row-based; Group Replication and InnoDB Cluster add multi-primary
synchronous replication for near-five-nines availability.

**MySQL 8.4 LTS** (released April 2024, supported to April 2032) is the current
production recommendation. MySQL 8.0 reached EOL in April 2026. MySQL 9.x is the
Innovation track with shorter support. **MariaDB** is a community fork with
compatible wire protocol and its own storage engine ecosystem; its optimizer and
replication differ from MySQL in ways that matter at scale.

**Differences that bite in production:**
- MySQL's default transaction isolation level is `REPEATABLE READ`; Postgres defaults
  to `READ COMMITTED`. `REPEATABLE READ` in MySQL means a transaction sees the same
  snapshot for its lifetime, which can cause "phantom read" surprises when
  long-running transactions see stale data.
- MySQL has no `VACUUM`; InnoDB's purge thread handles old undo log versions
  automatically, but long-running transactions prevent purge and grow the undo
  tablespace.
- Case sensitivity in identifiers and collation defaults differ between MySQL and
  Postgres, a source of subtle bugs in migration.

---

## Diagnosis playbooks

### Low CPU but slow queries

The query is waiting on something other than compute. Work through this checklist
in order:

1. **Lock waits.** Check `pg_locks` joined to `pg_stat_activity` for blocked
   queries. A query waiting for a lock shows `wait_event_type = 'Lock'`.
2. **I/O.** Check `pg_stat_bgwriter` for high `buffers_clean` and
   `pg_statio_user_tables` for high heap_blks_read (disk reads, not cache hits).
   Also check OS-level I/O with `iostat`.
3. **Index usage.** Run `EXPLAIN (ANALYZE, BUFFERS)` on the slow query. If it shows
   a sequential scan on a large table, check for a missing index, a function
   preventing index use, or stale statistics.
4. **Connection count.** If `pg_stat_activity` shows many `idle in transaction`
   connections, they may be holding locks or exhausting the pool.

### Fast last week, slow today

Nothing in the code changed, but the query degraded. The culprits in order of
likelihood:

1. **Stale statistics / plan change.** The table grew or the value distribution
   shifted, the planner chose a different plan. Run `EXPLAIN (ANALYZE, BUFFERS)` and
   compare estimated vs actual rows. If they diverge, run `ANALYZE tablename` and
   re-check.
2. **Table bloat.** Check `n_dead_tup` vs `n_live_tup` in `pg_stat_user_tables`.
   If the table is large with many dead tuples, run `VACUUM ANALYZE`.
3. **New data patterns.** A new customer or batch load changed the data
   distribution. A once-selective value is now common; a partial index no longer
   covers the hot path.
4. **Lock contention from a new background job.** Check `pg_locks` and
   `pg_stat_activity` for recently added jobs or scheduled tasks.
5. **Hardware or configuration change.** Check if `shared_buffers`, `work_mem`, or
   `effective_cache_size` changed. A reduction in `effective_cache_size` makes the
   planner pessimistic about what fits in the OS cache and may prefer sequential
   scans.

---

## Common interview questions

**What is the difference between an index scan and a sequential scan? When does
Postgres choose one over the other?**
Testing: whether you understand the planner's cost model.
A sequential scan reads all pages in order; an index scan traverses the B-tree then
fetches rows by random-read. The planner chooses based on selectivity: if only a
small fraction of rows match (roughly under 5-10 percent), the index's random reads
cost less than reading all pages; above that, sequential I/O wins. The exact
threshold depends on table layout and the `effective_cache_size` setting.

**What is MVCC and what problem does it solve?**
Testing: whether you know why readers do not block writers.
MVCC keeps multiple versions of each row. Readers see the version that was live at
their transaction start and never block on writers because they are not touching the
current version. Writers create new versions rather than overwriting. The catch is
dead tuple accumulation: old versions must be cleaned up by VACUUM.

**What is WAL and why does it matter for durability?**
Testing: operational knowledge of the commit path.
WAL (Write-Ahead Log) is a sequential log written before any data page is modified.
A commit is acknowledged once the WAL record is on disk, not when the data page is
flushed. On crash, Postgres replays the WAL to recover. WAL also drives replication
(streaming WAL to standbys) and point-in-time recovery (archiving WAL records).

**What does VACUUM do and when does it become operationally important?**
Testing: whether you have run Postgres in production at scale.
VACUUM marks dead tuples (old MVCC row versions) as reusable space and advances the
transaction ID counter to prevent wraparound. It becomes critical when: a
write-heavy table accumulates bloat faster than autovacuum handles it, causing slow
scans and growing file size; or when a table's age approaches the 2-billion-ID
wraparound limit, which causes Postgres to refuse writes until VACUUM runs.

**What is a deadlock and how does the database resolve it?**
Testing: whether you know the mechanism and the fix.
A deadlock is a cycle: transaction A holds lock X and waits for Y; transaction B
holds Y and waits for X. The database detects the cycle (within `deadlock_timeout`,
default 1 second) and kills one transaction with an error, releasing its locks. The
fix is canonical lock ordering: ensure all transactions that lock multiple rows do
so in the same order.

**Connection pooling: what is it and why does it exist?**
Testing: operational understanding of Postgres connection cost.
Postgres spawns an OS process per connection, costing 5-10 MB RAM and startup time.
Under load, a naive one-connection-per-request application exhausts `max_connections`
and gets errors. A pool (PgBouncer, pgpool) maintains a fixed set of server
connections and multiplexes application requests across them. Transaction-level
pooling (PgBouncer's default) is most efficient but incompatible with prepared
statements in some configurations.

**Optimistic vs pessimistic locking: when would you choose each?**
Testing: whether you think about contention.
Pessimistic (`SELECT ... FOR UPDATE`) acquires the lock before reading; safe but
serializes all concurrent writers on that row. Optimistic reads freely and does a
conditional update on a version column, retrying on conflict; high concurrency but
adds retry logic. Use pessimistic when conflict rate is high or the business logic
is expensive to redo (inventory reservation). Use optimistic when reads dwarf writes
and retries are cheap (profile update).

**Explain database sharding. What are the trade-offs of hash vs range sharding?**
Testing: whether you understand the full cost.
Sharding splits data across instances by a shard key. Hash sharding distributes
uniformly but requires rehashing to add shards. Range sharding splits on key ranges
(easier to add shards) but creates hotspots if activity concentrates in one range
(e.g., current date). The cross-cutting cost of both: no cross-shard joins in the
database, cross-shard transactions require distributed coordination, and schema
migrations must hit every shard.

**A query was fast last week and is slow today. Nothing in the code changed. What
do you investigate?**
Testing: whether you think like a DBA, not a developer.
First, run `EXPLAIN ANALYZE` on the slow query and look for a plan change or a
large gap between estimated and actual row counts, which signals stale statistics.
Run `ANALYZE` on the table and re-check. Second, look for table bloat via
`n_dead_tup` in `pg_stat_user_tables`. Third, check for new lock contention from a
recently added job. Fourth, check if a data distribution shift made a selective
value common enough that the planner stopped using the index.
