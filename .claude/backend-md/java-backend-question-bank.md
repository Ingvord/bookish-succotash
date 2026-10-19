## How this round works

This is a breadth round. Expect an interviewer to move from the JVM heap to a Spring transaction to a Kafka retry topic in the space of twenty minutes, then finish with two whiteboard problems. Nobody expects a lecture on each topic. They are listening for one thing: do you give the mechanism, and do you name the catch? "Use a thread pool" is a feature. "Size it from the wait-to-compute ratio, and know that a full queue silently defers the rejection policy until after the queue fills" is an answer.

The 25 questions fall into eight clusters, and this guide follows them in order:

1. **JVM internals** (1 to 3): allocation, escape analysis, JIT
2. **Collections and functional Java** (4 to 8): lists, `Collector`, `Optional`, lambdas
3. **Thread pools** (9 to 10): sizing and saturation
4. **Spring transactions** (11 to 13): propagation, isolation, rollback
5. **APIs and microservices** (14 to 18): rate limiting, pagination, outbox, service auth, tracing
6. **Messaging** (19 to 20): poison messages, retry topics, dead letter topics
7. **JPA and Hibernate** (21 to 23): fetching strategies, EAGER, dirty checking
8. **Coding** (24 to 25): median of two sorted arrays, LRU cache

Version baseline for this guide: Java 25 is the current LTS and JDK 27 reached general availability on 15 September 2026 as a non-LTS release. Spring Framework 7 ships `@Retryable` and `@ConcurrencyLimit` in core. Where an answer depends on a version, the version is named. Everything about HotSpot internals (tiers, thresholds, EA) is stable across these releases; exact flag defaults are worth confirming with `-XX:+PrintFlagsFinal` on the JVM you actually run.

Each answer below follows one shape: the question in bold, a short italic note on what the interviewer is testing, then the answer with its catch.

---

## The mental model: every answer is a cost, then a failure mode

Almost every question in this list has the same skeleton. A mechanism has a **cost model** (what it pays for, as a function of what), and it has a **failure mode** (what it does when you push it past the design point). The answers that sound senior state both in one breath.

| Topic | Cost model | Failure mode |
|---|---|---|
| Temporary objects | Allocation is a pointer bump; young GC pays for survivors, not garbage | Premature promotion, GC pauses when allocation rate outruns the young gen |
| `CopyOnWriteArrayList` | Reads free, every write copies the array | Write-heavy use turns O(1) appends into O(n) each |
| Thread pool | Threads buy parallelism up to the bottleneck resource | Unbounded queue hides saturation until the heap is gone |
| `@Transactional` | Proxy wraps the call, commit on return | Self-invocation skips the proxy; checked exceptions commit |
| Offset pagination | Database scans and discards `OFFSET` rows | Page 50,000 is 50,000 times slower than page 1 |
| `EAGER` fetch | Loads the graph on every load | One query becomes hundreds, on paths that never needed the data |

Hold that table in your head. When a question is unfamiliar, ask "what does this cost, and what happens at 10x load?" and you will land close to the right answer.

---

## JVM: allocation, escape analysis, and the JIT

**1. What happens when you create millions of temporary objects inside a loop?** *Testing whether you know that allocation is cheap and the real cost is elsewhere.* Creating a short-lived object on HotSpot is nearly free. Each thread owns a **TLAB** (thread-local allocation buffer), a private slice of eden, so `new` is a pointer bump plus a bounds check: a handful of instructions, no lock, no CAS. Dead objects cost nothing to reclaim, because a young collection copies only the **live** objects out of eden and then resets the whole region. Young GC cost scales with survivors, not with garbage.

The catch is that "millions of temporaries" hurts in four indirect ways:

- **Allocation rate sets GC frequency.** With a 200 MB eden and an allocation rate of 1 GB/s, you run five young collections a second. Each is a short stop-the-world pause plus copying, so p99 latency picks up a regular tick.
- **Premature promotion.** If a collection happens while a batch of temporaries is still live (a loop that builds a large intermediate list, say), those objects are copied to survivor space and then promoted to old gen after a few cycles. Now they die in old gen, where only a more expensive collection reclaims them.
- **Cache and memory bandwidth.** Streaming through fresh memory at GB/s evicts useful cache lines. The loop is slower than the instruction count suggests.
- **Humongous objects in G1.** An allocation of half a region size or more (region size is 1 to 32 MB depending on heap) goes straight to a special old-gen path. A loop that allocates large arrays can trigger concurrent cycles for no good reason.

The usual offenders in real code are boxing (`Integer` in a `Map<Integer, Integer>` hot loop), string concatenation with `+` inside a loop, `stream()` pipelines created per element, and `String.format` in logging calls.

```java
// Allocates a StringBuilder and a String per iteration, plus boxed Longs.
long sum = 0;
Map<Long, Long> counts = new HashMap<>();
for (long i = 0; i < 50_000_000L; i++) {
    counts.merge(i % 1000, 1L, Long::sum);   // boxes key and value every call
    String tag = "id-" + i;                  // new String every iteration
    sum += tag.length();
}
```

Before changing anything, measure. Run with `-Xlog:gc*` to see young GC frequency and pause times, use JFR's allocation profiling (or async-profiler in `alloc` mode) to find the allocation sites, and use JMH with `-prof gc` to get bytes allocated per operation. The fix, if the data demands one, is usually structural: primitive collections or arrays, a reused `StringBuilder`, `mapToInt` instead of boxed streams. Do not reach for object pooling on small objects. A pooled object is long-lived by design, so it lives in old gen and every write of a young reference into it dirties a card, which taxes the GC more than the allocation ever did.

**2. Explain escape analysis and how the JVM can optimize object allocation.** *Testing whether you know what the optimizer does to your `new`.* Escape analysis (EA) is a C2 compiler phase that asks of each allocation: can a reference to this object be seen outside the method (or thread) that created it? If the object never **escapes**, C2 can drop the heap allocation entirely.

An object escapes if the reference is stored in a field of a heap object or a static, returned, passed to a call that is not inlined, or published to another thread. If it does not, three optimizations become legal:

- **Scalar replacement.** The object is never built. Its fields become local variables (often registers), and the allocation, the header, and the later GC work disappear.
- **Lock elision.** A `synchronized` block on a non-escaping object can never contend, so the lock is removed.
- **Stack-like allocation effect.** HotSpot does not allocate on the stack; scalar replacement gives the same payoff by deleting the object.

```java
record Point(double x, double y) {}

static double dist(double ax, double ay, double bx, double by) {
    Point a = new Point(ax, ay);   // does not escape if dist() and the
    Point b = new Point(bx, by);   // accessors are inlined into the caller
    double dx = a.x() - b.x(), dy = a.y() - b.y();
    return Math.sqrt(dx * dx + dy * dy);
}
```

After C2 compiles and inlines this, both `Point` allocations are scalar-replaced and the machine code is just arithmetic.

The catch is that EA is **fragile and invisible**. It only works when everything the object touches is inlined, so a method over the inlining size limit, a megamorphic call site, or a single non-inlined call that receives the object makes it escape and the optimization silently vanishes. HotSpot's C2 EA is flow-insensitive: if the object escapes on any path, even a rare error path, the whole allocation stays. (GraalVM's compiler does partial escape analysis, which materializes the object only on the escaping branch.) EA also works only in C2-compiled code, not in the interpreter or C1, so it applies only after warmup. Never write code that depends on it. Prove it with a JMH benchmark using `-prof gc`: allocation per op dropping to near zero is the signature, and flipping `-XX:-DoEscapeAnalysis` should bring it back.

**3. What is JIT compilation? How does the JVM optimize frequently executed code?** *Testing the tiered model and, more importantly, speculation and deoptimization.* The JVM starts by interpreting bytecode, counts invocations and loop back-edges per method, and compiles the hot ones to native code at runtime. HotSpot uses **tiered compilation**: tier 0 is the interpreter, tiers 1 to 3 are C1 (fast compile, light optimization, tier 3 adds profiling), and tier 4 is C2 (slow compile, aggressive optimization, using the profile gathered in tier 3). Rough promotion points are hundreds of invocations for C1 and thousands for C2, plus back-edge counters that trigger **OSR** (on-stack replacement) so a long-running loop in `main` can switch to compiled code mid-execution.

What C2 does with the profile:

- **Inlining.** The single most important optimization, because it exposes everything else. Small methods (under about 35 bytecodes) inline always; hot ones up to about 325. A call site that has only ever seen one receiver class (monomorphic) is inlined with a cheap type guard; two classes (bimorphic) also inline; three or more (megamorphic) fall back to a vtable call that cannot be inlined.
- **Speculative optimization.** If a branch has never been taken, C2 compiles it out as an "uncommon trap". If a class hierarchy has one implementor, it devirtualizes the call.
- **Loop optimizations**: unrolling, range-check elimination, vectorization with SIMD.
- **Escape analysis, lock elision, dead-code elimination, constant folding.**

The catch is **deoptimization**. Speculation can be wrong: a new subclass loads, or the "never taken" branch is taken. The JVM then throws away the compiled code, falls back to the interpreter, and recompiles. A production symptom is a latency spike right after a deploy or when a rare code path first fires, because the compiled code for the whole hot method is invalidated.

Other consequences you should be able to name: **warmup** (the first minutes of a fresh pod are slower, so benchmark after warmup with JMH, never with a single `System.nanoTime()` around a loop), **code cache** exhaustion (`-XX:ReservedCodeCacheSize`; when full, compilation stops and the app slows with no error), and the container effect (a pod limited to 1 CPU shares that CPU between your threads and the compiler threads, so warmup is much longer). Mitigations: AppCDS and the ahead-of-time cache work from Project Leyden (which stores class loading and, since JDK 25, method profiles from a training run), or GraalVM native image when startup matters more than peak throughput. Useful flags for investigation: `-XX:+PrintCompilation` and `-XX:+UnlockDiagnosticVMOptions -XX:+PrintInlining`.

---

## Collections and functional Java

**4. Compare ArrayList and LinkedList for a high-throughput production application.** *Testing whether you reason from hardware or recite Big-O tables.* The textbook says `LinkedList` has O(1) insertion and `ArrayList` has O(n), and the textbook is wrong in practice. Answer: use `ArrayList`, and use `ArrayDeque` when you need a queue or deque. `LinkedList` is almost never the right choice.

Why:

- **Memory.** An `ArrayList` stores one 4-byte reference per element (compressed oops) in a contiguous array. A `LinkedList` node is an object with a 12-byte header and three references (`item`, `next`, `prev`), 24 bytes before the element itself. For a million `Integer`s that is roughly 4 MB of references versus 24 MB of nodes, plus garbage-collector work proportional to the object count.
- **Cache behavior.** Walking an `ArrayList` is a sequential scan that the hardware prefetcher loves. Walking a `LinkedList` is pointer chasing across the heap, where each hop is a probable cache miss (tens to a hundred nanoseconds against a nanosecond for a hit). Iteration is often 5x to 10x slower.
- **Random access.** `get(i)` is O(1) versus O(n).
- **The insertion claim.** "O(1) insert" is O(1) only if you already hold the node. Finding the position is O(n) pointer chasing. Inserting in the middle of an `ArrayList` is a `System.arraycopy`, a memmove at memory-bandwidth speed, which beats the pointer walk for any realistic size.

The catch for `ArrayList`: growth is by 1.5x with a full copy, so a list you know will hold 100,000 elements should be created with `new ArrayList<>(100_000)`. Removing from the front is O(n); if that is your access pattern, you wanted `ArrayDeque`. In high-throughput service code the real answer is often "neither": a bounded `ArrayBlockingQueue` or a concurrent structure, since neither list is thread-safe.

**5. Explain how CopyOnWriteArrayList works and when it becomes a bad choice.** *Testing whether you know the write cost and the snapshot semantics.* It keeps its elements in a `volatile` array. Reads are plain volatile reads of that array reference, with no locking at all. Every mutation takes a lock, copies the entire array, modifies the copy, and publishes it by assigning the new array to the volatile field. Iterators capture the array reference at creation, so they iterate a **snapshot**: they never throw `ConcurrentModificationException`, never see later writes, and do not support `remove()` through the iterator.

```java
// Ideal use: a listener registry. Reads (event dispatch) vastly outnumber writes (subscribe).
private final List<EventListener> listeners = new CopyOnWriteArrayList<>();

void publish(Event e) {
    for (EventListener l : listeners) {   // snapshot: safe even if a listener unsubscribes itself
        l.onEvent(e);
    }
}
```

The loop is safe even if a listener removes itself during dispatch, which is exactly the property that makes this class worth having.

It becomes a bad choice when:

- **Writes are frequent.** Each `add` is O(n) copy plus garbage. Filling it with n elements one at a time is O(n²) and churns the young gen. At 100,000 elements, one append copies about 400 KB.
- **The list is large**, for the same reason, plus a transient 2x memory spike per write.
- **You need read-your-writes while iterating.** The snapshot is deliberately stale.
- **Writers contend.** All writes serialize on one lock.

Alternatives depend on the need: batch writes with `addAll` (one copy), hold an immutable list in an `AtomicReference` and swap it, use `ConcurrentLinkedQueue` for queue semantics, or `Collections.synchronizedList` when write-heavy and you accept locked reads.

**6. How would you create a custom Collector?** *Testing whether you understand the four functions and why a combiner exists.* A `Collector<T, A, R>` is four functions plus a set of characteristics. The **supplier** creates a mutable accumulator `A`, the **accumulator** folds one element into it, the **combiner** merges two accumulators (needed so a parallel stream can fold sub-ranges independently and join them), and the **finisher** converts `A` to the result `R`. `Collector.of(...)` builds one without implementing the interface.

A useful example is a "top N by comparator" collector that holds only N elements in memory, regardless of stream size:

```java
public static <T> Collector<T, ?, List<T>> topN(int n, Comparator<? super T> cmp) {
    return Collector.of(
        () -> new PriorityQueue<T>(n + 1, cmp),                // min-heap: smallest of the kept N on top
        (heap, t) -> { heap.add(t); if (heap.size() > n) heap.poll(); },
        (left, right) -> {                                      // merge two partial heaps
            left.addAll(right);
            while (left.size() > n) left.poll();
            return left;
        },
        heap -> {                                               // finisher: sorted, best first
            List<T> out = new ArrayList<>(heap);
            out.sort(cmp.reversed());
            return out;
        },
        Collector.Characteristics.UNORDERED);
}

// usage
List<Order> top3 = orders.stream().collect(topN(3, Comparator.comparing(Order::total)));
```

The heap keeps the N largest seen so far; each insertion evicts the smallest, so memory is O(N) and time is O(M log N) for M elements. The combiner makes it correct under `parallelStream()`.

The catches, which interviewers like: the combiner must be **associative** and must not mutate shared state, or parallel results are wrong. The accumulator must only touch its own `A` (never a captured outer variable). Characteristics are promises: `UNORDERED` says encounter order does not matter, `IDENTITY_FINISH` says the finisher is a cast and can be skipped, `CONCURRENT` says one accumulator may be written by many threads (so `A` must be thread-safe). Declaring one falsely produces wrong results that only show up in parallel. Also note that for most needs, `Collectors.teeing`, `groupingBy` with a downstream collector, or `collectingAndThen` compose existing collectors without writing a new one.

**7. Explain Optional and situations where using it can actually make code worse.** *Testing taste: do you know what it was designed for?* `Optional<T>` was designed for one job: a **return type** that says "there may be no result" and forces the caller to deal with it, mostly in stream pipelines (`findFirst`, `max`). Its authors have said it was never meant as a general null replacement.

It makes code worse when used:

- **As a field.** It is not `Serializable`, it adds an object and a pointer per field, and frameworks (JPA, Jackson) handle it poorly. A nullable field with a nullable getter returning `Optional` is the idiomatic form.
- **As a method parameter.** The caller must now wrap, and you still have to handle `null` for the `Optional` itself. Overload the method or use a nullable parameter with a documented contract.
- **Inside collections.** `List<Optional<X>>` and `Map<K, Optional<V>>` are almost always a modeling error. Use an absent key or an empty list.
- **With `isPresent()` followed by `get()`.** That is a null check with extra allocation and ceremony, and `get()` without a check throws `NoSuchElementException`. Use `orElse`, `orElseThrow`, `map`, `ifPresentOrElse`.
- **With an eager `orElse`.** `orElse(expensive())` evaluates `expensive()` even when a value is present; `orElseGet(() -> expensive())` is lazy. This is a real performance bug in hot paths.
- **In hot loops.** Each `Optional` is an allocation, which escape analysis may remove but cannot be relied on to. Use `OptionalInt` and friends for primitives.

```java
// Reads well: Optional as a return type, composed with map and orElseThrow.
String city = userRepo.findById(id)
        .map(User::address)
        .map(Address::city)
        .orElseThrow(() -> new NotFoundException("no city for " + id));
```

Never call `Optional.of(maybeNull)` (it throws `NullPointerException`; use `ofNullable`), and never assign `null` to an `Optional` variable. `Optional` is also a value-based class: do not synchronize on it or compare by identity.

**8. Compare Java lambdas with anonymous inner classes internally.** *Testing whether you know `invokedynamic`.* They look interchangeable and compile completely differently.

An **anonymous class** is compiled by `javac` to its own class file (`Outer$1.class`), loaded by the class loader like any other class. Each evaluation of the `new Foo() { ... }` expression allocates a fresh instance, and in an instance context it always holds a hidden reference to the enclosing `this`, whether it needs it or not. Inside it, `this` means the anonymous object itself.

A **lambda** body is compiled into a private synthetic method (such as `lambda$main$0`) in the enclosing class, and the lambda expression becomes an `invokedynamic` call site. The first time that site executes, the bootstrap method `LambdaMetafactory.metafactory` spins a hidden class (defined at runtime, not on disk) that implements the functional interface and delegates to the synthetic method, then links it to the call site permanently. Consequences:

- **No class file per lambda**, so smaller jars and no per-lambda class-loading cost at load time.
- **A non-capturing lambda is a singleton**: the call site returns the same cached instance every time. A capturing lambda allocates one instance per evaluation, holding only the captured values.
- **`this` means the enclosing instance**, and a lambda captures `this` only if its body uses it. Anonymous classes always capture it, which is a classic memory leak (a long-lived listener pinning a whole activity or service).
- **Lambdas can target only functional interfaces**; anonymous classes can extend classes, hold state, and implement several methods.

The catch is startup: the first execution of each lambda call site pays the bootstrap and class-spinning cost, which adds up in a large app with thousands of lambdas and is one reason AppCDS and AOT caches archive lambda forms. Steady-state performance is equal or better for lambdas, since the JIT inlines through the `invokedynamic` target. Do not rely on lambda identity or `toString()`, and expect different stack-trace frames (`lambda$...`).

---

## Thread pools

**9. How would you choose the optimal thread-pool size for CPU-bound versus I/O-bound tasks?** *Testing whether you size from a model and then measure.* For **CPU-bound** work, threads beyond the core count only add context switches and cache thrash, so size at about `N_cpu` (or `N_cpu + 1` to cover the occasional page fault). For **I/O-bound** work, threads spend most of their time waiting, so you can run more of them than cores. The classic formula (from *Java Concurrency in Practice*) is:

```text
threads = N_cpu * target_utilization * (1 + wait_time / compute_time)
```

With 8 cores, 100% target utilization, and a task that waits 90 ms on a database for every 10 ms of CPU, that is `8 * (1 + 90/10) = 80` threads. Little's law gives the same answer from the other side: concurrency in flight `L = throughput * latency`. To sustain 800 requests/s at 100 ms each you need about 80 requests in flight.

The catch is that the formula sizes the pool for the CPU, but the real limit is usually **a downstream resource**: the database connection pool (if it has 20 connections, an 80-thread pool just queues 60 threads on the pool, burning memory), a rate-limited third-party API, or a remote service's capacity. Size to the tightest bottleneck, then load test, because wait and compute times drift as the system changes. Keep separate pools per dependency (a **bulkhead**) so one slow dependency cannot starve the others. Also, in a container, `Runtime.availableProcessors()` reflects the CPU limit, not the host, so check what the JVM actually sees.

On Java 21 and later, the better answer for I/O-bound work is **virtual threads**: one per task, no pool to size, and a blocked virtual thread frees its carrier. Since JDK 24 (JEP 491), blocking inside `synchronized` no longer pins the carrier, which removed the most common reason virtual threads stalled; remaining pins come from native frames and class initialization. The sizing problem does not vanish, it moves: with no pool limit, protect the downstream with a `Semaphore` or Spring Framework 7's `@ConcurrencyLimit`.

**10. What happens when a thread pool's queue becomes full?** *Testing whether you know the order in which `ThreadPoolExecutor` escalates.* The order is counterintuitive. A `ThreadPoolExecutor` with `corePoolSize` C, `maximumPoolSize` M, and a work queue behaves like this on `execute()`:

1. Fewer than C threads running: start a new thread, even if others are idle.
2. Otherwise, try to enqueue the task.
3. Only if the **queue is full**, start extra threads up to M.
4. If M threads are running and the queue is full: invoke the `RejectedExecutionHandler`.

The handler options are `AbortPolicy` (the default, throws `RejectedExecutionException`), `CallerRunsPolicy` (the submitting thread runs the task itself), `DiscardPolicy` (drops silently), and `DiscardOldestPolicy` (drops the head of the queue and retries).

The catches:

- **`Executors.newFixedThreadPool(n)` uses an unbounded `LinkedBlockingQueue`**, so step 3 never happens and the pool never rejects. Under overload the queue grows until the heap is exhausted, and latency for every queued task climbs first. This is one of the most common production incidents in Java services.
- **`newCachedThreadPool()` uses a `SynchronousQueue` and an unbounded maximum**, so overload creates thousands of threads instead.
- **`CallerRunsPolicy` provides backpressure** (the producer slows down because it is busy working), which is often what you want, but if the caller is a Tomcat request thread it stalls that request, and if it is a Kafka consumer thread it can exceed `max.poll.interval.ms` and trigger a rebalance.
- **`DiscardPolicy` is silent data loss.**

```java
ThreadPoolExecutor pool = new ThreadPoolExecutor(
        8, 32,                                  // core, max
        60, TimeUnit.SECONDS,
        new ArrayBlockingQueue<>(200),          // bounded: overload becomes visible
        new ThreadFactoryBuilder().setNameFormat("orders-%d").build(),
        new ThreadPoolExecutor.CallerRunsPolicy());   // slow the producer instead of dropping
```

A bounded queue plus an explicit rejection policy turns overload into a signal you can alert on. Export queue depth, active count, and rejected count as metrics. Whichever policy you pick, decide it consciously and make it observable.

---

## Spring transactions

**11. What is the difference between REQUIRED, REQUIRES_NEW, NESTED, and MANDATORY propagation?** *Testing whether you know what happens to the physical transaction.* Propagation defines what a `@Transactional` method does when called while a transaction already exists.

| Propagation | Transaction exists | No transaction | Failure behavior |
|---|---|---|---|
| `REQUIRED` (default) | Joins it | Starts one | Inner failure marks the shared transaction rollback-only |
| `REQUIRES_NEW` | Suspends it, starts an independent one | Starts one | Inner commit or rollback is independent of the outer |
| `NESTED` | Creates a **savepoint** inside it | Starts one | Inner rollback goes back to the savepoint; outer can continue |
| `MANDATORY` | Joins it | Throws `IllegalTransactionStateException` | Asserts a caller-owned transaction |

Practical uses: `REQUIRES_NEW` for work that must persist even if the caller rolls back (an audit log row, a failed-attempt counter). `NESTED` for "try this part and recover if it fails" inside a bigger unit. `MANDATORY` for repository-style code that must never run outside a service-layer transaction.

The catches are what make this a senior question:

- **`REQUIRES_NEW` needs a second database connection while holding the first.** If every request thread does this, a pool of 10 connections can fully deadlock with 10 threads each holding one connection and waiting for another. Size the pool for it or avoid nested `REQUIRES_NEW`.
- **`NESTED` is savepoint-based, so it needs JDBC savepoint support.** `DataSourceTransactionManager` allows it by default; `JpaTransactionManager` needs `setNestedTransactionAllowed(true)`, and even then the persistence context is not rolled back with the savepoint, so entities modified in the failed inner block stay modified in memory. It is rarely worth it with JPA.
- **Self-invocation bypasses the proxy.** `@Transactional` is applied by a Spring AOP proxy, so `this.otherMethod()` inside the same class runs with no transaction logic at all, whatever its annotation says. The same applies to `private` and `final` methods. Fix by moving the method to another bean.

**12. Explain transaction isolation levels and phantom reads.** *Testing whether you map each level to the anomaly it permits, and know the databases differ.* Isolation controls what a transaction can see of concurrent transactions' work. The SQL standard defines four levels by the anomalies they allow:

| Level | Dirty read | Non-repeatable read | Phantom read |
|---|---|---|---|
| `READ_UNCOMMITTED` | possible | possible | possible |
| `READ_COMMITTED` | no | possible | possible |
| `REPEATABLE_READ` | no | no | possible (by the standard) |
| `SERIALIZABLE` | no | no | no |

A **dirty read** sees uncommitted data. A **non-repeatable read** reads the same row twice and gets different values because another transaction committed an update between them. A **phantom read** runs the same range query twice (`WHERE amount > 100`) and gets a different **set of rows** because another transaction inserted or deleted a matching row.

```sql
-- Transaction A                              -- Transaction B
BEGIN;
SELECT count(*) FROM orders WHERE status='NEW';  -- 10
                                              INSERT INTO orders(status) VALUES ('NEW'); COMMIT;
SELECT count(*) FROM orders WHERE status='NEW';  -- 11  (phantom)
```

The catch: **the standard's table is not what your database does.** PostgreSQL defaults to `READ COMMITTED`; its `REPEATABLE READ` is snapshot isolation and does prevent phantoms, but still allows **write skew** (two transactions each read an overlapping set and write disjoint rows, jointly violating an invariant). PostgreSQL's `SERIALIZABLE` uses serializable snapshot isolation and aborts with SQLSTATE `40001`, so the application must retry. MySQL InnoDB defaults to `REPEATABLE READ`, where consistent reads use a snapshot but locking reads (`SELECT ... FOR UPDATE`) take next-key locks that block inserts into the range. Higher isolation costs throughput and produces more lock waits or serialization failures. The practical alternative to `SERIALIZABLE` is a targeted fix: `SELECT ... FOR UPDATE`, a unique constraint, or optimistic locking with a `@Version` column. In Spring, set it with `@Transactional(isolation = Isolation.SERIALIZABLE)`, and remember it applies only when this call starts the transaction, not when it joins an existing one.

**13. What happens when an exception occurs inside a @Transactional method?** *Testing the default rollback rule and the rollback-only trap.* By default Spring rolls back on **unchecked** exceptions (`RuntimeException` and `Error`) and **commits on checked exceptions**. That is inherited from the EJB convention, and it surprises people: a method that throws `IOException` or your own `extends Exception` commits whatever it already wrote. Opt in with `@Transactional(rollbackFor = Exception.class)`, or make your business exceptions unchecked.

The trap with `REQUIRED` propagation: the inner method and the outer method share one physical transaction. When an inner `@Transactional` method throws a runtime exception, the proxy marks the shared transaction **rollback-only** as the exception passes through. If the outer method catches the exception and carries on, the outer commit fails with `UnexpectedRollbackException: Transaction silently rolled back because it has been marked as rollback-only`.

```java
@Transactional
public void placeOrder(Order o) {
    orderRepo.save(o);
    try {
        loyaltyService.addPoints(o);     // @Transactional(REQUIRED) throws RuntimeException
    } catch (RuntimeException e) {
        log.warn("points failed", e);    // swallowed, but the transaction is already rollback-only
    }
}   // commit attempt -> UnexpectedRollbackException; the order is NOT saved
```

If the points failure should not undo the order, give `addPoints` `REQUIRES_NEW` (so it commits or fails independently) or move it after the commit with `@TransactionalEventListener(phase = AFTER_COMMIT)`.

Other related catches: a failure on the commit itself (a deferred constraint, a serialization failure) surfaces after your method body finishes, outside any `try` inside it; the exception is also translated, so catch Spring's `DataAccessException` hierarchy, not `SQLException`; and `@Transactional(readOnly = true)` is a hint, not a guarantee, though with Hibernate it also skips dirty-checking work (see question 23).

---

## APIs and microservices

**14. How would you protect a REST API from excessive traffic?** *Testing layered defense, not a single library.* Defend at several layers, because each stops a different failure.

1. **Edge (CDN, WAF, load balancer).** Blocks volumetric abuse and bots before they reach your servers.
2. **API gateway rate limiting**, per client (API key, user ID, or IP). The usual algorithm is a **token bucket**: a bucket refills at a steady rate (say 100 tokens/s) up to a capacity (burst of 200), and each request spends a token. It allows controlled bursts and enforces an average. Alternatives: a fixed window (simple, but allows 2x the limit across a window boundary), sliding window counter (smooth, a little more state), leaky bucket (smooths output rate).
3. **Application-level limits** for finer rules (per tenant, per endpoint cost): Bucket4j or Resilience4j `RateLimiter`. With more than one instance, the counters must be **shared**, typically in Redis with an atomic Lua script (otherwise each of N instances allows the full limit, and the real limit is N times higher).
4. **Concurrency and load shedding.** Rate limits cap request rate, but a slow dependency makes requests pile up regardless. Limit in-flight requests (a bulkhead, or `@ConcurrencyLimit` in Spring Framework 7), set timeouts everywhere, and shed load with a fast `503` when saturated instead of queueing until everything is slow.

Respond with `429 Too Many Requests` and a `Retry-After` header so well-behaved clients back off; add rate-limit headers for visibility. The catches: the limiter itself must not become a single point of failure (decide fail-open or fail-closed when Redis is down; fail-open is common for public APIs, fail-closed for expensive or sensitive ones), limiting by IP punishes users behind a NAT and is trivially bypassed by botnets, and retries from clients can amplify an overload, so pair limits with exponential backoff and jitter on the client side.

**15. How would you design pagination for millions of records?** *Testing whether you know why `OFFSET` fails.* The naive approach is `LIMIT 50 OFFSET 1000000`. The database cannot jump to row 1,000,000; it reads and discards a million rows to return 50, so page N costs O(N). Deep pages get slower and slower, and concurrent inserts shift the window so users see duplicates or miss rows.

The scalable design is **keyset (seek) pagination**: remember the last row you returned and ask for rows after it, using an indexed, unique, stable sort key.

```sql
-- Index: CREATE INDEX idx_orders_created_id ON orders (created_at DESC, id DESC);
SELECT id, created_at, total
FROM orders
WHERE (created_at, id) < (:lastCreatedAt, :lastId)   -- the cursor from the previous page
ORDER BY created_at DESC, id DESC
LIMIT 50;
```

Cost is a single index seek plus 50 rows, the same on page 1 and page 100,000. The `id` tiebreaker is essential: `created_at` alone is not unique, and without a unique tiebreaker rows get skipped or repeated at page boundaries. The API returns an **opaque cursor** (base64 of the last key values) instead of a page number. Spring Data supports this directly with `ScrollPosition` and `Window`.

The tradeoffs: no random jump to "page 500", no cheap total count (an exact `COUNT(*)` on millions of rows is itself a scan in PostgreSQL, so return an estimate or "more available" flag instead), and the sort must match an index, so every sortable column needs one. Verify with `EXPLAIN` that the row-value comparison actually uses the index on your database version. If the product truly needs page numbers (an admin grid), keep offset pagination but cap the depth and require filters.

**16. Explain the Outbox Pattern and why it is useful in microservices.** *Testing whether you understand the dual-write problem.* A service often must update its database and publish an event (`OrderCreated`) to Kafka. These are two systems with no shared transaction. If you commit first and the publish fails, downstream never hears about the order. If you publish first and the commit fails, downstream hears about an order that does not exist. This is the **dual-write problem**, and no ordering of the two calls fixes it.

The outbox pattern removes it: write the event as a row in an `outbox` table **in the same local database transaction** as the business change. Either both commit or neither does. A separate **relay** then reads the outbox and publishes to the broker, marking rows sent.

```java
@Transactional
public void placeOrder(Order order) {
    orderRepo.save(order);
    outboxRepo.save(new OutboxEvent(
            UUID.randomUUID(), "Order", order.getId(), "OrderCreated", toJson(order)));
}   // one commit covers both rows; nothing talks to Kafka here
```

The relay is either a **poller** (a scheduled job running `SELECT ... FROM outbox WHERE sent = false ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED`, which lets several relay instances work without colliding) or **change data capture** (Debezium tails the database log and publishes outbox inserts, with its outbox event router; lower latency and no polling load, but more infrastructure).

The catches: delivery is **at-least-once**. The relay can publish and crash before marking the row sent, so it publishes again. Consumers must be **idempotent** (dedupe on the event ID, using an inbox table or a unique constraint). For per-aggregate ordering, use the aggregate ID as the Kafka message key. The outbox table needs a cleanup job, or it grows without bound and the poller query slows. And polling adds latency equal to the poll interval.

**17. How would you handle service-to-service authentication?** *Testing whether you separate "which service" from "on behalf of which user."* Two separate questions get conflated here: proving **service identity**, and carrying **end-user context**.

For service identity, the common options:

- **mTLS.** Both sides present certificates, so the connection itself authenticates the caller. Usually delivered by a service mesh (Istio, Linkerd) or SPIFFE/SPIRE, which issue short-lived workload certificates and rotate them automatically, so application code never touches keys.
- **OAuth 2.0 client credentials.** The calling service gets a short-lived JWT access token from the authorization server and sends it as a bearer token. The receiver validates the signature, expiry, **audience** (`aud`: the token was meant for me), and scopes. Cache the token until shortly before it expires instead of fetching one per call.
- **Network policy** (Kubernetes `NetworkPolicy`) as defense in depth, not as the sole control.

For user context, do not forward the user's own token blindly to every downstream service (a compromised service can replay it elsewhere). Use **token exchange** (RFC 8693) to mint a narrowly scoped token for the next hop, or pass the user identity as a signed claim inside the service's own token.

The catches: long-lived static API keys and shared secrets are the failure mode this question probes, since they leak and are never rotated. Validating a JWT's signature but skipping `aud` and `iss` checks lets any token from the same issuer work against any service. A token cache must handle clock skew and concurrent refresh. And mTLS proves who the caller is, not what it is allowed to do, so you still need authorization on top.

**18. How would you implement distributed tracing across microservices?** *Testing context propagation, which is where tracing breaks.* A **trace** is the full journey of a request, made of **spans** (one per operation). Every span carries the trace ID, so a backend (Jaeger, Tempo, Zipkin) can stitch spans from different services into one tree. The standard wire format is the W3C `traceparent` header:

```text
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
             ver  trace-id (16 bytes hex)          parent span-id   flags (sampled)
```

In Spring Boot you use **Micrometer Tracing** with an OpenTelemetry bridge and exporter (OTLP). Instrumented clients (`RestClient`, `WebClient`, `RestTemplate` built from the Boot builders), servers, JDBC, and messaging inject and extract the header automatically. For Kafka, enable observation on the template and listener containers so the trace context travels in record headers. Put the trace ID in your logs via MDC (Boot does this for you) so you can jump from a log line to the trace and back.

The catches, which is where real incidents hide:

- **Context is thread-local.** It is lost whenever work hops threads: a raw `ExecutorService`, `CompletableFuture.supplyAsync`, and reactive chains. Wrap executors with Micrometer's context-propagation support or the instrumented Spring executors.
- **A single uninstrumented hop** (a service, a queue consumer, a scheduled job) breaks the chain into two unrelated traces.
- **Sampling.** Tracing every request at high traffic is expensive. Head-based sampling (decide at the entry, say 10%) is cheap but may miss the rare slow or failed request; tail-based sampling (decide after seeing the whole trace, in the OpenTelemetry Collector) keeps errors and slow traces but requires buffering. Spring Boot's default sampling probability is 10%, so "I see no trace for this request" is often just sampling.
- **High-cardinality attributes** on spans or metrics (user IDs, full URLs) inflate cost.

---

## Messaging: poison messages, retry topics, and dead letter topics

**19. How would you handle poison messages?** *Testing whether you know a poison message blocks the partition.* A poison message is one that can never be processed successfully: malformed payload, a schema the consumer cannot deserialize, or data that violates an invariant. In Kafka a consumer processes a partition strictly in order, so if it fails and retries forever, **everything behind that record is stuck**, and consumer lag grows.

The strategy is to bound retries and then park the message:

1. **Classify.** A transient failure (database timeout, downstream 503) deserves retries. A permanent failure (bad JSON, validation error) deserves none.
2. **Retry a bounded number of times** with backoff.
3. **Publish to a dead letter topic (DLT)** with the original record and failure metadata, commit the offset, and move on.
4. **Alert and make it replayable.**

Deserialization failures happen before your listener runs, in the consumer's `poll()`, and by default they cause an endless loop. Wrap the deserializer in `ErrorHandlingDeserializer`, which turns the failure into a `DeserializationException` carried with the raw bytes, so the error handler can route it.

```java
@Bean
DefaultErrorHandler errorHandler(KafkaTemplate<Object, Object> template) {
    var recoverer = new DeadLetterPublishingRecoverer(template);          // publishes to <topic>.DLT
    var handler = new DefaultErrorHandler(recoverer, new FixedBackOff(1000L, 3L)); // 3 retries, 1s apart
    handler.addNotRetryableExceptions(ValidationException.class);        // permanent: straight to DLT
    return handler;
}
```

Spring Kafka already treats several exceptions as non-retryable by default (`DeserializationException`, `MessageConversionException`, `ClassCastException`, among others), so they skip the retries and go straight to the DLT.

The catches: blocking retries with a long backoff stall the whole partition, so keep them short or use retry topics (next question). The DLT must be monitored; an unwatched DLT is just a slower way of losing data. Include the original topic, partition, offset, and exception in headers (the recoverer does) so a person can diagnose and replay. And the DLT publish itself can fail, so decide what happens then (the default handler re-seeks and retries the record).

**20. Explain retry topics and Dead Letter Topics.** *Testing the ordering tradeoff of non-blocking retry.* With **blocking retry** (the `DefaultErrorHandler` above), the consumer re-attempts the failed record in place and the partition waits. With **non-blocking retry**, a failed record is published to a **retry topic** and the main consumer immediately moves on. A separate consumer reads the retry topic after a delay. If it fails again it goes to the next retry topic with a longer delay, and when the attempts are exhausted it lands in the **dead letter topic**, where it waits for a human or a repair job.

```java
@RetryableTopic(
        attempts = "4",                                   // 1 original + 3 retries
        backOff = @BackOff(delay = 1000, multiplier = 2.0, maxDelay = 10_000),
        dltStrategy = DltStrategy.FAIL_ON_ERROR,
        exclude = { ValidationException.class })          // never retry these
@KafkaListener(topics = "orders")
void handle(OrderEvent event) { orderService.process(event); }

@DltHandler
void handleDlt(OrderEvent event, @Header(KafkaHeaders.EXCEPTION_MESSAGE) String reason) {
    log.error("order {} dead-lettered: {}", event.id(), reason);   // alert, persist for replay
}
```

Spring creates topics such as `orders-retry-1000`, `orders-retry-2000`, `orders-retry-4000`, and `orders-dlt`. The retry consumer pauses the partition until the record's scheduled time arrives, rather than sleeping a thread, so delays do not trip `max.poll.interval.ms`.

The catches:

- **Ordering is lost.** A retried record is processed after later records for the same key. If events must be applied in order (an `OrderCancelled` after `OrderCreated`), non-blocking retry breaks that, and you need blocking retry for that flow or consumer logic that tolerates out-of-order events.
- **More topics and more partitions to manage**, and DLT partitioning must match or be handled (the recoverer writes to the same partition number by default, so the DLT needs at least as many partitions).
- **Duplicates.** Delivery is at-least-once, so handlers must be idempotent.
- **Poison pills at scale.** A burst of failures floods the retry topics; keep retry counts small and consider a circuit breaker so a dead downstream does not send every message through all the retries.

Rule of thumb: blocking retry (short, bounded) for ordered streams; retry topics for independent events where throughput matters more than order; a DLT in both cases, with an alert and a replay tool.

---

## JPA and Hibernate

**21. Compare JOIN FETCH, Entity Graphs, batch fetching, and lazy loading.** *Testing whether you can solve N+1 and know what each fix costs.* The problem they all address is **N+1**: one query loads N parents, then touching a lazy collection on each parent fires N more queries.

| Technique | How it works | Catch |
|---|---|---|
| **Lazy loading** (default for collections) | Loads the association on first access, through a proxy or collection wrapper | N+1 when you iterate; `LazyInitializationException` outside the session |
| **`JOIN FETCH`** (JPQL) | One query with a SQL join loads parent and association together | Cartesian blowup with multiple collections; pagination applied in memory |
| **`@EntityGraph`** | Declares the fetch plan outside the query (annotation or `EntityManager` hint) | Same SQL consequences as `JOIN FETCH`, but reusable per repository method |
| **Batch fetching** (`@BatchSize`, `hibernate.default_batch_fetch_size`) | Lazy loads, but initializes up to K collections per query with `IN (?, ?, ...)` | N+1 becomes N/K + 1 queries; still more than one round trip |

```java
// One query, parent and children together.
@Query("select o from Order o join fetch o.items where o.status = :s")
List<Order> findWithItems(@Param("s") Status s);

// Same intent, declared on the repository method.
@EntityGraph(attributePaths = {"items", "customer"})
List<Order> findByStatus(Status s);
```

The catches are specific and commonly probed:

- **Collection `JOIN FETCH` multiplies rows.** An order with 10 items returns 10 rows, and Hibernate de-duplicates in memory. Fetching two `List` collections at once is a Cartesian product (orders x items x payments) and throws `MultipleBagFetchException`. Use `Set`, or fetch one collection per query.
- **Pagination with collection fetch breaks.** `setMaxResults` cannot limit parents when the SQL returns multiple rows per parent, so Hibernate fetches **everything** and paginates in memory, logging `HHH90003004: firstResult/maxResults specified with collection fetch; applying in memory`. On a million-row table this is an outage. The fix: paginate parent IDs first, then fetch the children for those IDs, or use batch fetching.
- **`@ManyToOne` fetched with a join is fine**, since it adds columns, not rows.
- **Lazy loading needs an open session.** The usual escape is Open Session In View, which keeps the session open through view rendering and hides N+1 behind a working page. Disable it (`spring.jpa.open-in-view=false`) and fetch what you need explicitly.

Practical default: leave associations lazy, set `default_batch_fetch_size` to 16 to 100 as a safety net, and use `JOIN FETCH` or an entity graph on queries where you know you need the data. Also consider DTO projections for read-only views, which skip the entity machinery entirely.

**22. Why can EAGER fetching create serious production performance problems?** *Testing whether you know EAGER is a global mapping decision that queries cannot override.* `FetchType.EAGER` on a mapping means "always load this with the owner." It is fixed in the mapping, so every query on that entity pays for it, including the ones that never touch the association.

The mechanics that hurt:

- **`@ManyToOne` and `@OneToOne` default to EAGER** in JPA, which surprises people. Add `fetch = LAZY` explicitly on every one of them.
- **`em.find()` / `findById` honors EAGER with a join, but JPQL, Criteria, and Spring Data derived queries do not.** They load the owners first, then Hibernate sees the EAGER associations and fires **secondary selects**, one per owner. A query returning 500 orders with an EAGER `customer` runs 501 queries, and nobody wrote that N+1; the mapping did.
- **It cascades.** If `Customer` has an EAGER `Address` which has an EAGER `Region`, loading one order walks the whole graph. In a densely connected model, one load can pull a large part of the database into memory.
- **Join fetches can multiply rows** when EAGER collections are involved, producing large result sets.
- **You cannot opt out per use case.** A lazy mapping can be made eager for one query with `JOIN FETCH`; an eager mapping cannot be made lazy for one query. That asymmetry is why the rule is **lazy in the mapping, eager per query**.

The symptoms in production: a simple endpoint with 800 SQL statements in the log, memory growth and long GC pauses from large object graphs in the persistence context, and slowness that grows with data volume while the code looks innocent. Detect it with `hibernate.generate_statistics`, a query-count assertion in tests (Hypersistence Utils or Hibernate's `StatementInspector`), and the `p6spy` or datasource-proxy SQL log. Fix by switching mappings to `LAZY` and loading explicitly where needed.

**23. Explain Hibernate dirty checking.** *Testing whether you know why you never call `save()` on a managed entity.* When Hibernate loads an entity into the persistence context, it keeps a **snapshot** of its property values (the "loaded state") next to the live object. You modify the entity with plain setters. At **flush** time (before a query that could be affected, and at commit), Hibernate compares each managed entity's current values with its snapshot, and for every entity that differs it generates an `UPDATE`. That is why this works with no explicit save:

```java
@Transactional
public void rename(Long id, String name) {
    Customer c = customerRepo.findById(id).orElseThrow();   // loaded and snapshotted
    c.setName(name);                                        // no save() call
}   // flush at commit: snapshot differs -> UPDATE customer SET name=? ... WHERE id=?
```

The catches:

- **The cost is O(managed entities x properties) per flush.** Loading 50,000 entities in one transaction means 50,000 snapshot copies in memory and 50,000 comparisons at every flush, even if you changed one. Batch jobs that load a lot of entities slow down quadratically-ish and run out of heap. Mitigations: process in chunks and `flush()` then `clear()` the persistence context, use a stateless session, or skip entities altogether with bulk JPQL or JDBC.
- **Read-only transactions skip it.** `@Transactional(readOnly = true)` makes Spring tell Hibernate to treat loaded entities as read-only: no snapshot is kept and no dirty check runs. Use it for query-only service methods; it is a real saving, not only a hint.
- **The `UPDATE` writes all columns by default**, because the statement is cached at startup. `@DynamicUpdate` generates SQL with only the changed columns, at the cost of building SQL per update. It helps for wide rows or tables with large `TEXT` and `JSON` columns.
- **Bytecode enhancement** (build-time) lets the entity track its own changes, avoiding the snapshot comparison.
- **Only managed entities are tracked.** A detached entity (loaded in another transaction, or after `clear()`) changes silently do nothing until `merge()`. The flip side is that a change you did not intend, in a managed entity, is persisted.
- **Flush order surprises.** Flush can fire before a JPQL query that touches the same table, so the update happens earlier than the end of the method.

---

## Coding: median of two sorted arrays

**24. Design an algorithm to find the median of two sorted arrays in O(log(min(n, m))).** *Testing whether you can find the binary search hidden in a problem, and handle the edge cases.* Merging both arrays is O(n + m), which is the answer to give first and then improve. The faster idea: the median splits the combined data into a left half and a right half of equal size, where every left element is at most every right element. So instead of merging, binary search for **where to cut the shorter array**.

Take `a` as the shorter array (swap if not), with sizes m <= n. Pick a cut `i` in `a` (so `a[0..i-1]` goes to the left half). The left half needs `half = (m + n + 1) / 2` elements in total, so the cut in `b` is forced: `j = half - i`. The cut is correct when both cross-conditions hold:

```text
a[i-1] <= b[j]     and     b[j-1] <= a[i]
```

If `a[i-1] > b[j]`, `a` contributes too many on the left, so move the cut left. If `b[j-1] > a[i]`, move it right. Sentinels (negative and positive infinity) cover the cuts at the edges, where `i` or `j` is 0 or the full length.

```java
static double median(int[] a, int[] b) {
    if (a.length > b.length) return median(b, a);        // binary search the shorter one
    int m = a.length, n = b.length;
    if (m + n == 0) throw new IllegalArgumentException("both arrays empty");
    int half = (m + n + 1) / 2;
    int lo = 0, hi = m;
    while (lo <= hi) {
        int i = (lo + hi) >>> 1;                         // cut in a
        int j = half - i;                                // cut in b
        int aLeft  = (i == 0) ? Integer.MIN_VALUE : a[i - 1];
        int aRight = (i == m) ? Integer.MAX_VALUE : a[i];
        int bLeft  = (j == 0) ? Integer.MIN_VALUE : b[j - 1];
        int bRight = (j == n) ? Integer.MAX_VALUE : b[j];
        if (aLeft <= bRight && bLeft <= aRight) {        // valid partition
            int maxLeft = Math.max(aLeft, bLeft);
            if (((m + n) & 1) == 1) return maxLeft;      // odd: largest of the left half
            int minRight = Math.min(aRight, bRight);
            return ((double) maxLeft + minRight) / 2.0;  // even: average the two middle values
        } else if (aLeft > bRight) {
            hi = i - 1;                                  // took too many from a
        } else {
            lo = i + 1;                                  // took too few from a
        }
    }
    throw new IllegalArgumentException("inputs are not sorted");
}
```

Dry run with `a = [2]`, `b = [1, 3]` (already ordered shorter first, m = 1, n = 2, half = 2). First cut `i = 0`, `j = 2`: `aLeft = -inf`, `aRight = 2`, `bLeft = 3`, `bRight = +inf`. The check `bLeft <= aRight` is `3 <= 2`, false, and `aLeft > bRight` is false, so move right: `lo = 1`. Next `i = 1`, `j = 1`: `aLeft = 2`, `aRight = +inf`, `bLeft = 1`, `bRight = 3`. Both conditions hold. Total length is odd, so the median is `max(2, 1) = 2`, which matches the merged array `[1, 2, 3]`.

Complexity is O(log min(n, m)) time and O(1) space, because the search range is the shorter array only. The catches that interviewers check: **swap so you search the shorter array** (otherwise `j` can go negative or exceed `n`), use **`(m + n + 1) / 2`** so the left half holds the extra element for odd totals, use `>>>` or `lo + (hi - lo) / 2` against overflow, cast to `double` before adding the two middle values (int overflow on large values), and handle one empty array (it works: `m = 0`, so `i` is always 0).

---

## Coding: LRU cache

**25. Implement LRU Cache using HashMap + Doubly Linked List and explain concurrency concerns.** *Testing O(1) design and whether you notice that a cache read is a write.* An LRU (least recently used) cache evicts the entry that has gone unused longest. Both `get` and `put` must be O(1), which needs two structures working together: a `HashMap<K, Node>` for O(1) lookup, and a doubly linked list ordered by recency (head = most recent, tail = least recent) so that moving a node to the front and removing the tail are O(1) pointer updates. A singly linked list cannot unlink a node without its predecessor; the `prev` pointer is what makes removal O(1).

Two sentinel nodes (a dummy head and dummy tail) remove every null and edge-case check:

```java
public class LruCache<K, V> {
    private static final class Node<K, V> {
        K key; V value; Node<K, V> prev, next;
        Node(K k, V v) { key = k; value = v; }
    }

    private final int capacity;
    private final Map<K, Node<K, V>> index = new HashMap<>();
    private final Node<K, V> head = new Node<>(null, null);   // sentinel: most recent side
    private final Node<K, V> tail = new Node<>(null, null);   // sentinel: least recent side

    public LruCache(int capacity) {
        if (capacity <= 0) throw new IllegalArgumentException("capacity must be positive");
        this.capacity = capacity;
        head.next = tail;
        tail.prev = head;
    }

    public synchronized V get(K key) {
        Node<K, V> n = index.get(key);
        if (n == null) return null;
        unlink(n);
        pushFront(n);                       // a read reorders the list
        return n.value;
    }

    public synchronized void put(K key, V value) {
        Node<K, V> n = index.get(key);
        if (n != null) {
            n.value = value;
            unlink(n);
            pushFront(n);
            return;
        }
        if (index.size() == capacity) {
            Node<K, V> lru = tail.prev;     // least recently used
            unlink(lru);
            index.remove(lru.key);          // the node stores its key for exactly this reason
        }
        n = new Node<>(key, value);
        index.put(key, n);
        pushFront(n);
    }

    private void unlink(Node<K, V> n) { n.prev.next = n.next; n.next.prev = n.prev; }

    private void pushFront(Node<K, V> n) {
        n.next = head.next; n.prev = head;
        head.next.prev = n; head.next = n;
    }
}
```

The node stores its own key so that eviction can remove the map entry in O(1) when all it holds is the tail node. Every operation is a map lookup plus a constant number of pointer assignments.

In production Java you would often write far less code, because `LinkedHashMap` is exactly this structure. Constructing it with `accessOrder = true` reorders entries on `get`, and overriding `removeEldestEntry` evicts automatically:

```java
class SimpleLru<K, V> extends LinkedHashMap<K, V> {
    private final int capacity;
    SimpleLru(int capacity) { super(16, 0.75f, true); this.capacity = capacity; }   // true = access order
    @Override protected boolean removeEldestEntry(Map.Entry<K, V> eldest) { return size() > capacity; }
}
```

**Concurrency is the real question.** The synchronized version above is correct but has a hidden problem: **`get` mutates shared state** (it reorders the list), so a cache that looks read-mostly is actually write-only from the locking perspective. You cannot use a read-write lock to let readers proceed in parallel, and a plain `ConcurrentHashMap` in front of an unsynchronized list corrupts the pointers. Options, in increasing order of sophistication:

- **One coarse lock** (`synchronized` or `ReentrantLock`): simple and correct, the right answer up to moderate contention. Keep the critical section tiny and never call loaders or I/O while holding it.
- **Lock striping**: split into N independent segments by `hash(key) % N`, each with its own lock and its own LRU list. Contention falls by about N, but eviction is now per segment, so global recency is approximate.
- **Record accesses in a buffer and apply them in batches.** Reads append to a lock-free buffer and a single thread (or whoever holds the lock) replays them to reorder the list. This is how Caffeine works: reads never take the main lock, and its W-TinyLFU policy tracks frequency as well as recency, which gives a better hit rate than pure LRU on scan-heavy workloads.
- **Cache stampede.** When many threads miss on the same key, they all call the loader. Use `computeIfAbsent`-style loading with per-key locking (Caffeine's `LoadingCache`), and keep loaders short, since a slow loader inside a coarse lock stalls the entire cache.

The practical answer to say aloud: implement the O(1) design to show you understand it, then say that in production you would use Caffeine, with a size bound, an expiry, and `recordStats()` so the hit rate is observable. For the lock-free and memory-model background behind the buffered approach, see the Java Concurrency guide in this set.

---

## Rapid-fire recap

One line per question, for the hour before the interview. Each line is the mechanism, then the catch.

1. **Millions of temporaries:** allocation is a TLAB pointer bump and dead objects are free; the cost is allocation rate (GC frequency) and premature promotion.
2. **Escape analysis:** C2 scalar-replaces and lock-elides objects that never escape, but only if everything is inlined, and it is invisible and fragile.
3. **JIT:** tiered interpreter, C1, C2 with profile-driven inlining and speculation; the catch is deoptimization and warmup.
4. **ArrayList vs LinkedList:** `ArrayList` (or `ArrayDeque`); contiguous memory and 4 bytes per element beat O(1) insert that needs an O(n) pointer walk.
5. **CopyOnWriteArrayList:** lock-free reads on a snapshot, full array copy on every write; bad when writes are frequent or the list is large.
6. **Custom Collector:** supplier, accumulator, combiner, finisher; the combiner must be associative and characteristics must be true.
7. **Optional:** a return type only; not a field, parameter, or collection element; `orElseGet` for lazy defaults.
8. **Lambdas vs anonymous classes:** `invokedynamic` and a hidden class versus a class file per instance; non-capturing lambdas are singletons and `this` means the enclosing instance.
9. **Pool sizing:** about N for CPU-bound, `N * (1 + wait/compute)` for I/O-bound, capped by the downstream resource; virtual threads for I/O plus a semaphore.
10. **Full queue:** core threads, then queue, then up to max, then the rejection handler; `newFixedThreadPool` has an unbounded queue and never rejects.
11. **Propagation:** `REQUIRED` joins, `REQUIRES_NEW` suspends and needs a second connection, `NESTED` is a savepoint, `MANDATORY` asserts; self-invocation skips the proxy.
12. **Isolation:** dirty, non-repeatable, phantom reads by level; PostgreSQL and MySQL differ from the standard, and write skew survives snapshot isolation.
13. **Exception in `@Transactional`:** rollback on unchecked only; an inner failure marks the shared transaction rollback-only, so a swallowed exception ends in `UnexpectedRollbackException`.
14. **Rate limiting:** layers (edge, gateway, app, concurrency limit); token bucket with shared state in Redis; return `429` with `Retry-After`.
15. **Pagination:** keyset with a unique tiebreaker and an opaque cursor; offset is O(offset); no random page jump or exact count.
16. **Outbox:** write the event in the same transaction as the data, relay by poller or CDC; at-least-once, so idempotent consumers.
17. **Service auth:** mTLS or client-credentials JWT with audience checks, short-lived and cached; token exchange for user context.
18. **Tracing:** W3C `traceparent` through Micrometer Tracing and OpenTelemetry; the failure is lost context across threads and sampling.
19. **Poison messages:** classify, retry a bounded number of times, dead-letter; `ErrorHandlingDeserializer` for bad bytes; a stuck record blocks the partition.
20. **Retry topics and DLT:** non-blocking retry through delayed topics, then the DLT; ordering is lost and handlers must be idempotent.
21. **Fetching:** lazy plus `JOIN FETCH`, entity graph, or batch size; collection fetch multiplies rows and breaks database pagination.
22. **EAGER:** fixed in the mapping, silently produces N+1 for JPQL queries, and cannot be made lazy per query.
23. **Dirty checking:** snapshot versus current state at flush; cost grows with managed entities; `readOnly = true` and chunked `clear()` help.
24. **Median of two sorted arrays:** binary search the cut in the shorter array with sentinels; O(log min(n, m)).
25. **LRU cache:** hash map plus doubly linked list with sentinels; `get` is a write, so use a coarse lock, striping, or Caffeine's buffered reads.

---

## In the room

Treat this round as a conversation about trade-offs, and keep each answer to about ninety seconds: the mechanism in one or two sentences, the catch in one, then stop and let the interviewer pull on the thread they care about. Rambling through everything you know about `@Transactional` reads as unfocused, while one precise sentence about rollback-only transactions reads as someone who has been paged for it.

A few habits that separate answers:

- **Lead with the recommendation, then the reason.** "ArrayList, because the node overhead and cache misses make LinkedList slower even for inserts" beats starting from Big-O definitions.
- **Name what you would measure.** For anything about performance (temporaries, EA, JIT, pool sizing), say how you would verify it: JMH with `-prof gc`, JFR, GC logs, queue depth metrics. It signals that you do not trust folklore.
- **Say what you would not do.** "I would not add object pooling here" and "I would not use `SERIALIZABLE`; I would use a unique constraint" show judgment, which is the point of a senior round.
- **Flag version-dependent claims.** Virtual-thread pinning changed in JDK 24, Spring Framework 7 added built-in retry and concurrency limiting, and PostgreSQL and MySQL differ on isolation. Naming the version beats a confident wrong answer.
- **On the coding questions, talk before you type.** State the brute force and its cost, name the data structure or invariant that improves it, write it with sentinels, then dry run a tiny input out loud. For the median problem, saying "I am binary searching the cut position in the shorter array" in the first minute is most of the credit.

If you are asked something outside this list, fall back to the mental model at the top: what does it cost, and what does it do at ten times the load? That question gets you to a defensible answer on almost any backend topic. For deeper background, the Java Concurrency guide covers the memory model and lock-free structures behind questions 5, 9, 10, and 25, the Java Classic guide covers JPA and transaction behavior in an application server, and the Kafka and Relational Database guides cover the messaging and isolation material in more depth.
