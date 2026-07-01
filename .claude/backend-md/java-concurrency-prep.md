## Why lock-free, and the ladder from `synchronized` to CAS

The cost of a lock is not the acquisition itself. It is the **blocking**: when one thread holds a lock, every other thread that wants it parks, yields its CPU slice, and waits for the OS to schedule it back. Under low contention that pause is cheap. Under high contention, throughput collapses and latency becomes unpredictable because threads spend more time waiting than working.

The concurrency ladder has three rungs. At the bottom is **blocking** (`synchronized`, `ReentrantLock`): a thread that cannot proceed waits indefinitely. In the middle is **lock-free**: the system as a whole always makes progress even if a given thread retries, because no thread holds a resource that blocks the others. At the top is **wait-free**: every thread individually makes progress in a bounded number of steps regardless of what others do. Wait-free is rarely achievable without hardware support; lock-free is the practical target.

The catch: lock-free code is harder to write, harder to reason about, and wins only under genuine contention. Under low contention, `synchronized` is JIT-inlined to nearly zero cost through biased locking and lock elision. Reaching for `AtomicReference` on a map that is written once and read a million times adds complexity without returning anything. Profile first, reach for lock-free structures second.

---

## The memory model you need before touching lock-free code

Lock-free code coordinates threads through shared memory. Without a model that defines which writes become visible to which reads, and when, shared-memory coordination is undefined behavior in any non-trivial sense. The Java Memory Model (JMM), formalized in JSR-133 and made concrete in Java 5, answers this question through the **happens-before** relation.

Two operations are ordered by happens-before when a later read is guaranteed to see the result of an earlier write. The key edges a practitioner must have cold:

- **Volatile write/read.** A `volatile` write happens-before every subsequent `volatile` read of the same variable. "Subsequent" means in wall-clock time: some thread writes `v = 1`, and any thread that reads `v` afterward and observes that write also sees all writes the writing thread did before that `volatile` write.
- **Monitor unlock/lock.** Exiting a `synchronized` block happens-before the next thread enters `synchronized` on the same monitor.
- **Thread start/join.** `Thread.start()` happens-before any action in the started thread. All actions in a thread happen-before `Thread.join()` returns in the joining thread.
- **CAS as a volatile access.** A successful `compareAndSet` on an `AtomicXxx` carries volatile semantics: the CAS is a volatile write, so it happens-before any subsequent read that observes its result. A failed CAS is still a volatile read.

Without a happens-before edge, the CPU and the JIT compiler are free to reorder instructions, keep values in registers, or hold them in write buffers. Two CPUs with private caches can observe writes in different orders. What looks like sequential code can execute in any order the hardware finds convenient, constrained only by single-thread correctness, because the JVM specification permits those reorderings.

The practical rule: **every field read by one thread and written by another must be `volatile`, accessed under a lock, or accessed through an `Atomic*` type.** Plain fields have no cross-thread guarantee, not even primitive `int`. The JIT will optimize aggressively around them.

```java
// Not safe: the JIT may hoist the read of `running` out of the loop,
// caching it in a register and never re-reading from memory.
boolean running = true;   // plain field, no visibility guarantee

void loop() {
    while (running) { /* work */ }    // may spin forever after stop() is called
}

void stop() { running = false; }      // write may never become visible to looping thread
```

Mark `running` as `volatile` and the JIT must reload it from memory on every loop iteration. That is the visibility guarantee `volatile` buys, at a small throughput cost per access.

**Acquire/release** is the finer-grained model that lock-free structures use internally. A release write pairs with an acquire read on the same address: the release write happens-before the acquire read. This is cheaper than full sequential consistency (`volatile` in Java), and it is the level that `VarHandle` exposes directly. The rule of thumb: publish data via a release write, consume it via an acquire read, and the consumer will see all writes the producer did before the release.

The full JMM, including final-field freeze, the semantics of `synchronized` on partially constructed objects, and compiler-fence placement under tiered compilation, is a subject in itself. The subset above is what you need to reason correctly about atomics and lock-free code. A deeper guide in this series covers the rest.

---

## Atomics and CAS: the hardware primitive

The `java.util.concurrent.atomic` package wraps the CPU's compare-and-swap instruction. The classic guide for this series (Java Classic: Jakarta EE) covers the core pattern, the ABA problem, `LongAdder`, and the selection rule between them. Take that as the baseline; the following goes one level deeper.

**How CAS interacts with the JMM.** `AtomicLong.compareAndSet` is specified as both a volatile read and a volatile write on the target variable. A successful CAS establishes a happens-before edge: all writes the winner thread did before the CAS are visible to any thread that later reads the updated value with at least acquire semantics. A failed CAS is still a volatile read, so the losing thread sees the current committed value and any writes that happened-before it. This visibility guarantee is what makes CAS safe as a coordination primitive rather than just a fast trick.

**`compareAndExchange` (Java 9+).** The standard `compareAndSet` returns `boolean`. The newer `compareAndExchange` returns the witness value: the actual value found in memory at the time of the attempt, whether it succeeded or not. This folds the read-on-failure and the retry into one operation without a separate `get()` call.

```java
AtomicReference<String> ref = new AtomicReference<>("initial");

// Returns what was actually in memory, not just success/failure.
String witness = ref.compareAndExchange("initial", "updated");
if (witness.equals("initial")) {
    // CAS succeeded; ref now holds "updated"
} else {
    // CAS failed; witness is the current value, use it to compute the next attempt
}
```

**`weakCompareAndSet`.** On some non-x86 architectures (ARM, POWER), a store-conditional instruction can fail spuriously even when the value matches. `weakCompareAndSet` exposes this: it may return `false` even when the old value is current, with no ordering guarantee on failure. The payoff is lower cost on weakly-ordered hardware. On x86, a strong CAS is the only option, so `weakCompareAndSet` degenerates to a normal CAS. Use it inside a retry loop where a spurious failure just causes one extra iteration and you want the cheapest possible per-attempt cost.

**Contention and `LongAdder` revisited.** `LongAdder` beats `AtomicLong` under contention because it splits the count across a `Striped64` base cell plus a lazily allocated `Cell[]` array, with each cell padded to 128 bytes to occupy two cache lines and prevent false sharing. Threads increment their own cell when they detect contention (the CAS on the base cell fails), and `sum()` adds them all. The tradeoff is that `sum()` is not atomic across all cells: a read that spans cells can be concurrent with increments, so `LongAdder.sum()` is an approximation under load. Correct for metrics; wrong for anything that needs a precise snapshot.

---

## VarHandle: the modern replacement for `Unsafe`

Before Java 9, code that needed fine-grained memory-order control, or CAS on array elements and non-public fields, reached for `sun.misc.Unsafe`. That class is an internal JVM API: it bypasses the normal object model and the JDK uses it for its own performance-critical structures. Using it in application code ties you to internal details that can change without notice (and have, across Java releases). Java 9 (JEP 193) introduced `VarHandle` as the supported replacement.

A `VarHandle` is a typed, access-checked reference to a variable: a field, an array element, or an off-heap memory segment. You obtain one at class-loading time via `MethodHandles.Lookup` and store it as a `static final` so the JIT can treat it as a constant.

```java
import java.lang.invoke.*;

class Counter {
    private volatile long count = 0;

    private static final VarHandle COUNT;
    static {
        try {
            COUNT = MethodHandles.lookup()
                .findVarHandle(Counter.class, "count", long.class);
        } catch (ReflectiveOperationException e) {
            throw new ExceptionInInitializerError(e);
        }
    }

    long increment() {
        return (long) COUNT.getAndAdd(this, 1L);   // atomic fetch-and-add, release semantics
    }
}
```

**Access modes** are the key concept. `VarHandle` exposes four levels, in rising cost order:

| Mode | Ordering | Typical use |
|---|---|---|
| Plain | None; compiler may reorder freely | Trusted single-thread access or between explicit fences |
| Opaque | No tear; progress guarantee; no cross-variable ordering | Lazy one-shot flags |
| Acquire / Release | Release write happens-before paired acquire read | Producer/consumer handoff |
| Volatile | Sequential consistency (full fence) | Equivalent to a `volatile` field access |

For a producer/consumer handoff where you want the consumer to see all work the producer did, use release on the producer side and acquire on the consumer side. You pay less than full volatile SC while still getting the necessary happens-before edge.

```java
// Producer: write payload first (plain), then signal readiness with a release-write.
PAYLOAD.set(this, computeResult());           // plain write
READY.setRelease(this, true);                 // release-write; pairs with consumer's acquire

// Consumer: acquire-read the flag, then plain-read the payload.
if ((boolean) READY.getAcquire(this)) {       // acquire-read: all prior releases visible
    Object result = PAYLOAD.get(this);        // plain read is safe; happens-after the acquire
}
```

`getAndAdd`, `compareAndSet`, `compareAndExchange`, and `getAndSet` are available at volatile, acquire/release, and opaque levels. The `weakCompareAndSet` variants map to the weak CAS described in the previous section.

**Explicit fences.** `VarHandle` also exposes static fence methods: `fullFence()` (equivalent to `mfence` on x86), `acquireFence()`, `releaseFence()`, `loadLoadFence()`, and `storeStoreFence()`. These apply a fence to a region of plain accesses rather than a single variable access. They appear in the internals of high-throughput data structures such as the Disruptor and in high-performance serialization code. In most application code, prefer access modes over raw fences because the intent is clearer and the JIT can optimize access modes more aggressively.

The catch on `VarHandle`: obtaining the handle requires matching the field name, declaring class, and type exactly. A mismatch throws `NoSuchFieldException` at class initialization. Always store handles in `static final` fields so the failure surfaces immediately at startup, not at the first access in production.

---

## Concurrent collections and their internals

The `java.util.concurrent` package ships production-quality concurrent data structures. Knowing their internals, not just their names, is what separates working knowledge from staff-level fluency.

**`ConcurrentHashMap`.** Java 7 used 16 segments, each a separate `ReentrantLock`-guarded hash table. Java 8 replaced this with a single `Node[]` bin array, where locking is per-bin, not per-segment. An insert into an empty bin uses a CAS on the bin slot and requires no lock at all. An insert into a non-empty bin locks only that bin's head node with `synchronized(binHead)`, so two inserts collide only when they hash to the same bin.

When a bin's linked list exceeds eight entries, it converts to a `TreeBin` (a red-black tree), taking lookup from O(n) to O(log n). Resize doubles the table and migrates bins incrementally using forwarding nodes: threads that arrive during migration help transfer bins rather than waiting on a single thread to finish.

`size()` is maintained through a combination of CAS on a `baseCount` field and a `CounterCell[]` array (the same design as `LongAdder`). The sum is not linearizable: it can miss concurrent modifications. Use `mappingCount()` (returns `long`) for large maps; use `size()` knowing it may be off under concurrent modification.

The other catch is `computeIfAbsent`. The computation function runs while the calling thread holds the bin-level lock. If the function calls `computeIfAbsent` on the same map with a key that hashes to the same bin, the thread tries to re-acquire the bin lock it already holds. That deadlocks. This comes up in recursive memoization.

```java
// Deadlock trap: recursive computeIfAbsent on the same map with the same bin.
ConcurrentHashMap<Integer, Integer> memo = new ConcurrentHashMap<>();

int fib(int n) {
    return memo.computeIfAbsent(n, k ->
        k < 2 ? k : fib(k - 1) + fib(k - 2)   // recursive call: deadlocks if same bin
    );
}
// Fix: compute the value outside the lambda and use putIfAbsent, or use a separate map.
```

**`ConcurrentLinkedQueue`.** A MPMC queue built on the Michael-Scott algorithm (covered in the next section). Enqueue is a two-step CAS: link the new node as the current tail's `next`, then advance `tail`. Dequeue CASes `head` forward over the dummy sentinel. The `size()` method traverses the entire chain in O(n), so avoid it in hot paths; use `isEmpty()` instead.

**`CopyOnWriteArrayList`.** Every write copies the entire backing array, writes to the copy, and atomically swaps the reference. Reads never lock and always see a consistent snapshot. The tradeoff is stark: writes are O(n) and allocate. This is correct and efficient only for lists that are read orders of magnitude more often than written, the canonical case being event-listener registries.

**`ConcurrentSkipListMap`.** A sorted concurrent map backed by a probabilistic skip list. Provides O(log n) get, put, and remove using CAS on node pointers, with no global lock. Use this when you need a `NavigableMap` (floor, ceiling, headMap, tailMap) under concurrent writes. `TreeMap` with a read-write lock is the alternative; the skip list wins under high contention because it locks at the node level rather than the tree root.

**`BlockingQueue` family.** The blocking queues are not lock-free; they use `ReentrantLock` and `Condition` to park threads on empty or full. Their value is the contract: `put` blocks when full, `take` blocks when empty, which is exactly what you want for a bounded producer-consumer channel.

| Implementation | Bound | Notes |
|---|---|---|
| `ArrayBlockingQueue` | Fixed | Single lock for both ends; lower throughput under high concurrency |
| `LinkedBlockingQueue` | Optional | Separate head/tail locks; higher throughput than array variant |
| `PriorityBlockingQueue` | Unbounded | No blocking on put; blocks only on take from empty queue |
| `SynchronousQueue` | Zero | Each put blocks until a take matches; rendezvous handoff |
| `LinkedTransferQueue` | Unbounded | Combines blocking and non-blocking paths; lower latency than linked |

The catch with `LinkedBlockingQueue`: when used as an `Executor` work queue without a bound (the `Executors.newFixedThreadPool` default), it accepts unlimited tasks. If producers consistently outrun consumers, the queue grows without limit until `OutOfMemoryError`. Always specify a bound in production and decide explicitly what to do when the queue is full: block, reject, or drop.

---

## Implementing lock-free algorithms

Understanding how the library structures work requires seeing the algorithm from scratch. Each implementation below is the canonical version, stripped to the essential steps. Every one follows the same shape: read current state, compute desired next state, CAS it in, retry if someone else changed it first.

### Treiber lock-free stack

Treiber's stack (1986) is the simplest non-trivial lock-free structure: a linked list where both push and pop operate only on the head.

```java
class TreiberStack<T> {
    private volatile Node<T> top;
    // (VarHandle TOP obtained via MethodHandles.lookup in a static initializer)

    void push(T value) {
        Node<T> node = new Node<>(value);
        Node<T> curr;
        do {
            curr = (Node<T>) TOP.getAcquire(this);  // read current top
            node.next = curr;
        } while (!TOP.compareAndSet(this, curr, node)); // retry if top changed
    }

    T pop() {
        Node<T> curr;
        do {
            curr = (Node<T>) TOP.getAcquire(this);
            if (curr == null) return null;              // stack is empty
        } while (!TOP.compareAndSet(this, curr, curr.next)); // advance head
        return curr.value;
    }

    record Node<T>(T value, Node<T> next) {
        Node(T value) { this(value, null); }
    }
}
```

Push reads the current top, sets the new node's `next` to it, and CASes `top` from the old value to the new node. If another thread changed `top` concurrently, the CAS fails and the loop retries. Pop reads the current top, then CASes `top` to `top.next`, atomically removing the head.

The ABA trap applies immediately. Thread A reads `top = Node(X)` and pauses. Thread B pops X, pushes Y, pops Y, then pushes a recycled X (same reference). When A resumes, it finds `top = Node(X)` unchanged and the CAS succeeds. But `Node(X).next` now points somewhere different, silently corrupting the structure. In pure Java without object pooling, GC prevents address reuse before the stale reference is cleared, so this is a reduced risk; but with any form of node pooling, `AtomicStampedReference<Node<T>>` is the fix.

### Michael-Scott lock-free queue

The Michael-Scott queue (1996) extends CAS to a FIFO queue with a dummy head node that decouples producers from consumers. `ConcurrentLinkedQueue` is based on a variant of this algorithm.

```java
class MSQueue<T> {
    // head and tail are VarHandle-accessed; both start pointing to a sentinel node.
    private volatile Node<T> head, tail;

    void enqueue(T value) {
        Node<T> node = new Node<>(value);
        while (true) {
            Node<T> t = (Node<T>) TAIL.getAcquire(this);
            Node<T> next = t.next;              // null if tail is truly the last node
            if (next == null) {
                if (NEXT.compareAndSet(t, null, node)) { // link new node at end
                    TAIL.compareAndSet(this, t, node);   // advance tail (may lose race)
                    return;
                }
            } else {
                TAIL.compareAndSet(this, t, next);       // help: advance lagging tail
            }
        }
    }

    T dequeue() {
        while (true) {
            Node<T> h = (Node<T>) HEAD.getAcquire(this);
            Node<T> next = h.next;
            if (next == null) return null;               // queue empty
            if (HEAD.compareAndSet(this, h, next)) {     // promote next to new sentinel
                return next.value;
            }
        }
    }

    private static class Node<T> { volatile T value; volatile Node<T> next; }
}
```

Each enqueue needs two CAS operations: one to link the new node as the tail's `next`, and one to advance `tail`. If a thread pauses between them, `tail` lags one step behind the true last node. Any subsequent thread detects this (it sees `t.next != null`) and helps advance `tail` before doing its own work. This "helping" property is what distinguishes the Michael-Scott queue: progress is guaranteed even if one thread pauses indefinitely after linking its node.

The catch: like the Treiber stack, this is ABA-vulnerable when nodes are pooled. In a non-pooled Java context, GC eliminates the hazard for the common case.

### Single-producer bounded ring buffer (Disruptor-style)

When exactly one thread produces and one or more threads consume, you can eliminate nearly all CAS operations and exploit cache-line discipline. The LMAX Disruptor (open-sourced in 2011) popularized this pattern for high-throughput event pipelines.

The core is a fixed-size ring buffer indexed by a monotonically increasing sequence number, with capacity constrained to a power of two so the modulo operation reduces to a bitwise AND.

```java
class SingleProducerRingBuffer<T> {
    private static final int SIZE = 1024;       // must be power of 2
    private final Object[] slots = new Object[SIZE];
    private final long[] published = new long[SIZE]; // one entry per slot

    // Keep each sequence on its own cache line (128 bytes = two typical lines).
    private long producerSeq = -1;              // only the producer writes this
    private volatile long consumerSeq = -1;     // only consumers write this

    void publish(T event) {
        long seq = ++producerSeq;               // no CAS needed: only one producer
        int slot = (int)(seq & (SIZE - 1));     // bitwise modulo
        slots[slot] = event;
        VarHandle.storeStoreFence();            // event must be visible before sequence
        published[slot] = seq;                  // release signal to consumers
    }

    @SuppressWarnings("unchecked")
    T consume(long expectedSeq) {
        int slot = (int)(expectedSeq & (SIZE - 1));
        while (published[slot] != expectedSeq) { /* spin-wait */ }
        VarHandle.loadLoadFence();              // read event after confirming sequence
        return (T) slots[slot];
    }
}
```

The producer never CASes because it is the sole writer of `producerSeq`. The only synchronization is the `storeStoreFence` before writing `published[slot]`, which ensures the event payload is visible before the availability signal. The consumer spins on `published[slot]` and uses a `loadLoadFence` to ensure it reads the event after the availability check. Two memory barriers per round trip instead of one CAS, plus cache-line-sequential access patterns, is what gives the Disruptor its throughput numbers (hundreds of millions of events per second on a single producer-consumer pair).

False sharing is the catch that catches almost everyone the first time. If `producerSeq` and `consumerSeq` share a 64-byte cache line, every write to either variable invalidates both CPU caches, forcing the other thread to reload. Padding each sequence variable to 128 bytes so it occupies two full cache lines eliminates this and can triple throughput on a four-core machine. Omitting the padding is one of the most surprising microbenchmark results in Java concurrent programming.

### Seqlock for multi-word reads

A seqlock lets readers observe a multi-word value without acquiring any lock, retrying only when a concurrent write is detected. Writers bracket the payload update with increments of a sequence counter; readers sample the counter before and after reading the payload, and retry if the two samples differ or if the value is odd (write in progress).

```java
class SeqLock {
    private volatile int seq = 0;       // odd while a write is in progress
    private volatile long valueA = 0;   // payload field 1
    private volatile long valueB = 0;   // payload field 2

    void write(long a, long b) {
        seq++;                          // mark write start: seq is now odd
        VarHandle.storeStoreFence();    // payload writes must follow seq increment
        valueA = a;
        valueB = b;
        VarHandle.storeStoreFence();    // final seq increment must follow payload writes
        seq++;                          // mark write done: seq is now even
    }

    long[] read() {
        int s1, s2;
        long a, b;
        do {
            s1 = seq;
            VarHandle.loadLoadFence();  // payload reads must follow seq read
            a = valueA; b = valueB;
            VarHandle.loadLoadFence();  // s2 read must follow payload reads
            s2 = seq;
        } while ((s1 & 1) == 1 || s1 != s2); // retry if write in progress or seq changed
        return new long[]{a, b};
    }
}
```

The seqlock is the right tool when readers vastly outnumber writers and the payload spans multiple fields that CAS cannot update atomically. The catch: readers spin, so a writer that stalls indefinitely starves all readers. Use it for configuration or metrics that change rarely and where write latency is bounded.

---

## Locks family, for when lock-free is the wrong call

Lock-free structures are harder to verify and win only under genuine contention. When you need to update several variables under one invariant, or when the critical section is non-trivial, `synchronized` or the explicit lock family is the right answer.

**`ReentrantLock`.** The explicit-lock alternative to `synchronized`. Same monitor semantics, but with `tryLock(timeout)` for timeout-aware acquisition, `lockInterruptibly()` for cancellable waits, and `Condition` objects for fine-grained wait/signal. Fairness is configurable: `new ReentrantLock(true)` queues threads in arrival order, preventing starvation but reducing throughput due to guaranteed context switches. The default is unfair and rarely causes starvation in practice.

The `Condition` API replaces the `Object.wait()` / `notify()` pattern with an explicit handle, and multiple conditions per lock are possible:

```java
ReentrantLock lock = new ReentrantLock();
Condition notEmpty = lock.newCondition();
Condition notFull  = lock.newCondition();

// Producer signals notEmpty; consumer signals notFull.
// Each condition wakes only the relevant waiting party.
void produce(Item item) throws InterruptedException {
    lock.lock();
    try {
        while (queue.isFull()) notFull.await();   // releases lock while waiting
        queue.add(item);
        notEmpty.signal();
    } finally { lock.unlock(); }
}
```

**`synchronized` and virtual threads.** Prior to Java 24, a virtual thread that blocked inside a `synchronized` block was pinned to its carrier platform thread for the duration, consuming a real OS thread and limiting scalability. Java 24 (JEP 491) removed this restriction: virtual threads now unmount from their carrier during `synchronized` waits, exactly as they do during `ReentrantLock.lock()`. On Java 24 and later, `synchronized` and `ReentrantLock` are equivalent for virtual-thread workloads. On Java 21 to 23 (the initial virtual-thread releases), prefer `ReentrantLock` for any critical section that blocks on I/O or other long operations.

**`ReadWriteLock` and `StampedLock`.** When reads are far more frequent than writes, multiple readers can hold a shared read lock concurrently while writes require an exclusive lock. `ReentrantReadWriteLock` (Java 5) implements this. `StampedLock` (Java 8) adds an optimistic read mode: the reader takes a stamp before reading and validates it afterward. If a writer intervened, validation fails and the reader escalates to a real read lock.

```java
StampedLock lock = new StampedLock();
double x, y;

double distance() {
    long stamp = lock.tryOptimisticRead();         // no lock acquired
    double cx = x, cy = y;
    if (!lock.validate(stamp)) {                   // did a writer intervene?
        stamp = lock.readLock();
        try { cx = x; cy = y; }
        finally { lock.unlockRead(stamp); }
    }
    return Math.sqrt(cx * cx + cy * cy);
}
```

The catch on `StampedLock`: it is not reentrant and has no `Condition` support. A thread that holds a write stamp and tries to acquire any other mode on the same lock deadlocks. Also, `StampedLock` does not implement the `Lock` interface, so it cannot be used as a drop-in replacement wherever an explicit `Lock` is expected.

**Livelock and starvation.** These are the failure modes that blocking locks introduce and lock-free structures avoid. Livelock is two or more threads that repeatedly react to each other and make no progress despite being runnable. Starvation is a thread that is perpetually pre-empted by higher-priority or more-frequent lock requesters. Fair `ReentrantLock` prevents starvation at the cost of throughput; diagnosing livelock requires thread dumps that show threads cycling without waiting on a lock.

---

## Predict-the-output: interleavings and visibility puzzles

These small programs test whether you understand the mechanism rather than the label. For each: read the code, decide on the possible outputs, then check the explanation.

**Puzzle 1: plain field, no synchronization.**

```java
class P1 {
    int x = 0;
    boolean ready = false;     // plain fields, no happens-before

    void writer() { x = 42; ready = true; }   // Thread A

    void reader() {                            // Thread B
        while (!ready) {}
        System.out.println(x);
    }
}
```

Possible outputs: `42`, `0`, or infinite loop. The JIT may hoist `ready` out of the loop (loop-invariant code motion) and cache it in a register, making the loop infinite even after `stop()`. Even if `ready = true` eventually becomes visible, the CPU may reorder `x = 42` and `ready = true`, so the reader can observe `ready = true` before `x = 42` and print `0`. Fix: mark both `volatile`, or access both under the same `synchronized` block.

**Puzzle 2: CAS under ABA with interned strings.**

```java
AtomicReference<String> ref = new AtomicReference<>("A");

// Thread 1 reads "A" and pauses.
String old = ref.get();

// Thread 2 runs:
ref.compareAndSet("A", "B");
ref.compareAndSet("B", "A");

// Thread 1 resumes:
boolean result = ref.compareAndSet(old, "C");
System.out.println(result);   // ?
```

Output: `true`. `AtomicReference.compareAndSet` uses reference equality (`==`), not `equals`. Because `"A"` is an interned string literal, all occurrences refer to the same object. Thread 2 changed the value and changed it back to the same reference, so Thread 1's CAS succeeds. In production lock-free code with pooled node objects, the same story applies: the recycled object has the same address, the CAS succeeds, and the structure is silently corrupted.

**Puzzle 3: `volatile` read ordering.**

```java
volatile int a = 0, b = 0;

void thread1() { a = 1; b = 1; }   // Thread 1

void thread2() {                    // Thread 2
    int rb = b;
    int ra = a;
    System.out.println(rb + " " + ra);
}
```

Possible outputs: `0 0`, `0 1`, `1 1`. Can `1 0` appear? No. Because `a = 1` happens-before `b = 1` (program order within Thread 1), and `b = 1` happens-before Thread 2's `volatile` read of `b` (volatile write/read edge), and that `volatile` read of `b` happens-before the subsequent read of `a` (program order within Thread 2). If Thread 2 reads `b = 1`, it must also read `a = 1`.

**Puzzle 4: `LongAdder` accuracy after quiesce.**

```java
LongAdder adder = new LongAdder();
// 1000 threads each call adder.increment() once, concurrently.
// After all threads join: adder.sum() == ?
```

Answer: exactly `1000`. `LongAdder.sum()` is an approximation only while threads are still incrementing concurrently with the read. After a quiesce (all incrementors have finished), the cells are stable and `sum()` is accurate. The approximation matters only during concurrent access.

---

## Common interview questions

The pattern for every answer: state the mechanism, then the catch.

**What is the difference between lock-free and non-blocking?** *Testing vocabulary and whether you know progress guarantees.* Non-blocking is the umbrella term: a thread can never be indefinitely blocked by a lock held by another thread. It has three sub-levels: obstruction-free (progress when running without interference), lock-free (the system as a whole always makes progress), and wait-free (every individual thread makes progress in bounded steps). Lock-free is the practical target; wait-free is rare and expensive to implement.

**What does `volatile` guarantee and what does it not guarantee?** *Testing JMM literacy, a senior-only probe.* `volatile` guarantees visibility (a write is immediately visible to any subsequent volatile read of the same variable) and prevents certain reorderings (via acquire/release fences). It does not guarantee atomicity of compound operations: `i++` on a `volatile int` is still a read-modify-write that races. On 64-bit JVMs, `volatile long` reads and writes are specified to be atomic (plain `long` is not guaranteed atomic on 32-bit JVMs). The catch: developers reach for `volatile` to fix race conditions but miss that check-then-act sequences remain racy.

**What is the ABA problem and when does it matter in Java?** *Probing whether you know real-world applicability.* ABA occurs when a CAS succeeds because a value returned to its prior state, masking an intermediate change. In Java without object pooling, GC prevents address reuse before the old reference is cleared, which eliminates the classic pointer-recycling ABA for the common case. The hazard reappears with object pooling or off-heap memory. The fix is `AtomicStampedReference`, which compares both the reference and an integer stamp, so a recycled object no longer looks unchanged.

**When would you use `StampedLock` over `ReentrantReadWriteLock`?** *Testing whether you go beyond the JavaDoc.* When reads vastly outnumber writes and you want to try reading without acquiring any lock. The optimistic path avoids CAS entirely on the happy path. Use `ReentrantReadWriteLock` when you need reentrancy, `Condition` variables, or when writes are frequent enough that the optimistic path is invalidated more often than it succeeds (a failed optimistic read pays the fallback read-lock cost, which makes it a net loss under high write rates).

**`ConcurrentHashMap.size()` returns 5. Can you trust it for a correctness decision?** *Probing whether you read source or just docs.* No, not under concurrent modification. `size()` sums `baseCount` and the distributed `CounterCell[]` without a global lock, so the result can miss concurrent puts or removes. Use it for approximate metrics or diagnostics; never as the guard in a "if size < 10, add this item" decision. Use `mappingCount()` for large maps where `int` overflow is a concern.

**What changed in `ConcurrentHashMap` between Java 7 and Java 8?** *Testing implementation knowledge, not just API.* Java 7: 16 pre-allocated segments, each a `ReentrantLock`-guarded hash table, with a fixed concurrency level. Java 8: a single bin array, CAS for inserts into empty bins, per-bin `synchronized` on the head node for non-empty bins, and red-black tree bins beyond eight entries. The result is lower contention, better memory efficiency (no pre-allocated lock objects), and O(log n) worst-case lookup per bin instead of O(n).

**Explain the `computeIfAbsent` deadlock trap.** *A real-world gotcha that surfaces in code reviews.* The computation function runs while the calling thread holds the bin-level lock for the target key. If the function recursively calls `computeIfAbsent` on the same map with a key that hashes to the same bin, the thread attempts to re-acquire the bin lock it already holds. Because the lock is on the bin node and `synchronized` is not reentrant across different logical map operations on the same bin, this deadlocks. Fix: compute the value outside the lambda, or use a separate staging structure.

---

## In the room

Come into this material knowing that interviewers ask about Java concurrency to locate the boundary between someone who has read the API surface and someone who has debugged race conditions in production. The distinguishing answers name the catch, not just the feature: not "use `volatile` for visibility" but "use `volatile` for visibility, and know it does not make compound operations atomic." Not "use `ConcurrentHashMap`" but "`size()` is approximate under concurrent modification and `computeIfAbsent` deadlocks on recursive use."

On lock-free algorithms specifically, most interviewers expect fluency with the Treiber stack and the CAS retry loop, a clear explanation of ABA and its fix, and a reasoned argument for when lock-free is the right call versus when it adds complexity for no payoff. Being able to implement the Michael-Scott queue or the ring buffer on a whiteboard, and to name the invariant each preserves and the failure mode it is still exposed to, is a strong differentiator at the senior and staff level.

This is the first guide in the Java Fundamentals series. Upcoming guides cover the Java Memory Model in full depth (reordering, final-field freeze, safe publication, and the happens-before lattice), GC and heap mechanics (G1, ZGC, Shenandoah up to Java 26, GC log reading, and tuning), threading and executors (thread lifecycle, pool sizing, `CompletableFuture`, virtual threads, and structured concurrency as finalized in Java 25), and JIT compilation (C1/C2 tiered compilation, inlining, deoptimization, GraalVM, and warmup patterns).
