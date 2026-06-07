## The application-server model, and when to still choose it

Jakarta EE (formerly Java EE, before Oracle handed the platform to the Eclipse Foundation) is a set of specifications, not a product. You write against the API, and a compliant runtime supplies the implementation. That indirection is the whole philosophy: your war file should run on TomEE, Payara, WildFly, or Open Liberty without code changes, because every server ships vendor implementations of the same `jakarta.*` interfaces.

At staff level the interviewer wants to hear *why* this model exists and *when* it stops paying off. The application server centralizes cross-cutting infrastructure (connection pools, transaction managers, security realms, thread pools) so that many deployed applications share one tuned runtime. That was a strong fit when one server hosted dozens of internal apps. It is a weaker fit when you ship one service per container, because the container already gives you isolation and the orchestrator already gives you scaling, so the server's multi-tenancy is dead weight.

The single most important fact to state cleanly: as of Jakarta EE 9 the namespace migrated from `javax.*` to `jakarta.*`. This was a hard break caused by Oracle retaining the `javax` trademark. Any library, any tutorial, any Stack Overflow answer using `javax.servlet` or `javax.persistence` is pre-2020 and will not compile against a modern server. Jakarta EE 10 and 11 build on that namespace and add records support, CDI Lite, and alignment with newer Java LTS releases.

```java
// Pre-Jakarta EE 9 (will NOT compile on a modern server)
import javax.ws.rs.GET;
import javax.persistence.Entity;

// Jakarta EE 9+ (the only correct form today)
import jakarta.ws.rs.GET;
import jakarta.persistence.Entity;
```

---

## Project bootstrap: a Jakarta EE web profile app

A clean bootstrap signals that you understand the platform without a framework holding your hand. The Maven `war` packaging plus the `jakartaee-api` dependency in `provided` scope is the canonical setup. `provided` matters: the server supplies the implementation at runtime, so bundling it into the war causes classloader conflicts.

```xml
<project>
  <packaging>war</packaging>
  <dependencies>
    <dependency>
      <groupId>jakarta.platform</groupId>
      <artifactId>jakarta.jakartaee-api</artifactId>
      <version>10.0.0</version>
      <scope>provided</scope>
    </dependency>
  </dependencies>
</project>
```

The application bootstraps through a single JAX-RS activator class. No `web.xml` is required in the modern model; the annotation registers the REST application and its base path.

```java
import jakarta.ws.rs.ApplicationPath;
import jakarta.ws.rs.core.Application;

@ApplicationPath("/api")
public class RestActivator extends Application {
    // Empty body: the server scans for @Path and @Provider classes.
}
```

A health endpoint and a simple resource complete the skeleton. Notice there is no `main` method: the server owns the lifecycle, your code is a set of managed components it discovers and wires.

```java
import jakarta.ws.rs.*;
import jakarta.ws.rs.core.MediaType;

@Path("/orders")
@Produces(MediaType.APPLICATION_JSON)
public class OrderResource {

    @Inject OrderService service;

    @GET @Path("/{id}")
    public Order get(@PathParam("id") long id) {
        return service.findOrThrow(id);
    }
}
```

---

## CDI: the dependency-injection core

Contexts and Dependency Injection (CDI) is the spine of modern Jakarta EE. Everything composes through it: you annotate a class with a scope, inject it elsewhere with `@Inject`, and the container manages instantiation and lifecycle. The scopes are the part people fumble in interviews, so be precise.

`@ApplicationScoped` is one instance for the whole application (the default choice for stateless services). `@RequestScoped` is one instance per HTTP request. `@SessionScoped` is one per user session and requires `Serializable`. `@Dependent` (the default if you annotate nothing) means the bean's lifecycle is bound to whatever injected it.

```java
import jakarta.enterprise.context.ApplicationScoped;
import jakarta.inject.Inject;

@ApplicationScoped
public class OrderService {

    @Inject OrderRepository repo;   // field injection: convenient, hard to unit test

    public Order findOrThrow(long id) {
        return repo.find(id)
            .orElseThrow(() -> new NotFoundException("order " + id));
    }
}
```

The staff-level trap is scope mismatch. Injecting a `@RequestScoped` bean into an `@ApplicationScoped` one looks broken, because the application-scoped bean outlives every request. CDI solves this with a client proxy: the injected reference is a thin proxy that resolves the real request-scoped instance per call. This works but it is invisible, and it is why CDI beans cannot be `final` and need a no-arg constructor. If someone marks a bean `final` and injection mysteriously fails, this is why.

Prefer constructor injection over field injection. It makes dependencies explicit, allows `final` fields, and lets you instantiate the class in a unit test without a CDI container.

```java
@ApplicationScoped
public class OrderService {
    private final OrderRepository repo;

    @Inject
    public OrderService(OrderRepository repo) {   // testable without a container
        this.repo = repo;
    }
}
```

---

## JAX-RS: REST endpoints and the provider model

JAX-RS handles HTTP. The annotations (`@GET`, `@POST`, `@Path`, `@QueryParam`) map methods to requests, and the runtime handles serialization via a registered JSON provider (JSON-B by default in Jakarta EE). The extension point worth knowing is the provider: `ExceptionMapper`, `ContainerRequestFilter`, and `MessageBodyWriter` let you centralize cross-cutting behavior instead of repeating it per endpoint.

A clean exception-mapping strategy is a frequent staff signal. Do not let raw exceptions leak stack traces to clients; map them to a stable error contract.

```java
import jakarta.ws.rs.ext.*;
import jakarta.ws.rs.core.Response;

@Provider
public class NotFoundMapper implements ExceptionMapper<NotFoundException> {
    @Override
    public Response toResponse(NotFoundException e) {
        return Response.status(404)
            .entity(new ApiError("not_found", e.getMessage()))
            .build();
    }
}
```

The caveat is that JAX-RS is synchronous by default: the request thread blocks until the method returns. For long calls use `@Suspended AsyncResponse` or return a `CompletionStage` so the request thread is released. On Java 21+ this matters less because virtual threads make blocking cheap again, which is discussed below.

---

## JPA and persistence: the traps that show seniority

JPA (with Hibernate as the usual implementation) maps objects to tables. The mechanics are easy; the production failures are the interview content. Three traps dominate.

The N+1 select problem: you load a list of orders, then access each order's line items in a loop, and the lazy collection triggers one query per order. The fix is a fetch join or an entity graph, fetching the association in the original query.

```java
// N+1: one query for orders, then one per order for its lines
List<Order> orders = em.createQuery("select o from Order o", Order.class).getResultList();
orders.forEach(o -> o.getLines().size());   // triggers N extra queries

// Fixed: a single join fetch
List<Order> orders = em.createQuery(
    "select distinct o from Order o join fetch o.lines", Order.class).getResultList();
```

The `LazyInitializationException`: a lazy association is accessed after the persistence context (and its transaction) has closed. The correct fix is to fetch what the caller needs inside the transaction boundary, never to make everything `EAGER` (which reintroduces N+1 globally) and never to keep the session open across the view layer (the discredited open-session-in-view anti-pattern).

Transaction demarcation: in Jakarta EE you declare transactions, you do not manage them by hand. `@Transactional` on a CDI bean method opens and commits a transaction around the call. The subtlety is that self-invocation (one method on the bean calling another `@Transactional` method on `this`) bypasses the interceptor, because the proxy is not involved. Cross-bean calls work; same-bean calls silently do not.

```java
import jakarta.transaction.Transactional;

@ApplicationScoped
public class OrderService {

    @Transactional
    public Order place(NewOrder cmd) {
        Order o = repo.save(new Order(cmd));
        // calling this.audit() here would NOT start a new transaction
        return o;
    }
}
```

---

## TomEE: Tomcat with an EE profile

TomEE is Apache Tomcat with the Jakarta EE Web Profile bolted on. That sentence is the whole pitch and a good interview answer. Plain Tomcat is a servlet container: it gives you Servlets, JSP, and WebSocket, nothing more. TomEE adds CDI (OpenWebBeans), JPA (OpenJPA or Hibernate), JAX-RS (CXF), JMS, and JTA, so you get the Web Profile on Tomcat's small, familiar, fast-starting base.

The distinction interviewers probe is Web Profile versus Full Platform. The Web Profile covers what most services need: Servlets, CDI, JAX-RS, JPA, Bean Validation, JTA. The Full Platform adds the heavyweight pieces (full EJB with remote interfaces, JMS as a mandated broker, Jakarta Connectors). TomEE ships variants: the `webprofile` and `microprofile` builds for services, `plume` and `plus` for fuller stacks. Pick the smallest one that covers your specs.

Why choose TomEE over plain Tomcat plus a framework? Because you get container-managed JTA transactions and a managed datasource without assembling them yourself, on a runtime your ops team already knows how to operate. Why choose it over a heavier server like WildFly or Payara? Faster startup, smaller footprint, and you avoid the full EE machinery you will not use.

Datasource configuration lives in `tomee.xml` or `resources.xml`, and the server exposes it through JNDI, which JPA then references by name.

```xml
<!-- tomee.xml -->
<tomee>
  <Resource id="ordersDB" type="javax.sql.DataSource">
    JdbcDriver  org.postgresql.Driver
    JdbcUrl     jdbc:postgresql://db:5432/orders
    UserName    app
    Password    ${DB_PASSWORD}
    MaxActive   50
    MaxIdle     10
  </Resource>
</tomee>
```

`MaxActive` is the connection-pool ceiling and it is a load-bearing number, covered in the metrics section. The packaging story is simple: build a war, drop it in `webapps/`, or run TomEE embedded for tests via the Arquillian or the TomEE Maven plugin.

---

## Concurrency: thread-per-request and the virtual-thread shift

The classic application server uses a thread-per-request model: a bounded pool of OS threads (Tomcat's connector defaults near 200) each handle one request start to finish, blocking on I/O. This is simple to reason about and it is why JPA and JDBC are written as blocking APIs. The cost is that a slow downstream dependency ties up a thread doing nothing, and once all 200 threads are parked on a slow call, the server stops accepting work even though the CPU is idle. This is thread-pool exhaustion, and it is the classic outage in this architecture.

Java 21 virtual threads (Project Loom) change the calculus. A virtual thread is cheap (you can have millions), and a blocking call parks the virtual thread while freeing the underlying carrier OS thread. The blocking, readable, thread-per-request style now scales to high concurrency without the pool ceiling. On Tomcat/TomEE you enable a virtual-thread executor on the connector, and your existing blocking JAX-RS and JPA code benefits with no rewrite.

```java
// Tomcat 10.1+ : back the connector with a virtual-thread executor
connector.getProtocolHandler()
    .setExecutor(Executors.newVirtualThreadPerTaskExecutor());
```

The staff caveat: virtual threads are not free of footguns. They pin to their carrier thread inside `synchronized` blocks and native calls, so a hot path guarded by `synchronized` (older connection pools, some logging frameworks) negates the benefit. Replace `synchronized` with `ReentrantLock` on hot paths, and verify your JDBC pool is Loom-friendly.

---

## Non-blocking I/O: the caveats and gotchas

Before virtual threads, the way to scale past the thread-per-request ceiling on a classic server was non-blocking, asynchronous I/O: release the request thread while a slow operation is in flight, and resume on a callback when it completes. The platform offers this at two layers. Servlet async (`request.startAsync()`, since Servlet 3.0) detaches request processing from the container thread; Servlet non-blocking I/O (`ReadListener`/`WriteListener`, since 3.1) drives the request and response bodies through callbacks instead of blocking reads and writes. JAX-RS exposes the same capability more ergonomically through `@Suspended AsyncResponse` and by returning a `CompletionStage`. The model works, and it was the right tool for years, but it is studded with traps that interviewers use to separate people who have read about it from people who have run it.

The first and most important gotcha: async does not create throughput, it only releases a thread. If you call `startAsync()` and then do blocking JDBC on some other pool's thread, you have not removed the block, you have merely moved it, and you now have two thread pools to size instead of one. Async only helps when the offloaded work is itself non-blocking (an async HTTP client, a non-blocking driver) or when the point is purely to free the container thread for a genuinely long wait. Hand-waving "we made it async so it scales" without a non-blocking downstream is the classic shallow answer.

```java
// Gotcha: this is "async" but still blocks a thread on the JDBC call.
@GET @Path("/{id}")
public void get(@PathParam("id") long id, @Suspended AsyncResponse async) {
    executor.submit(() -> {            // freed the request thread...
        Order o = repo.find(id);       // ...but THIS thread now blocks on JDBC
        async.resume(o);               // no throughput gained, just relocated
    });
}
```

The deepest trap is context loss. The request thread carries a stack of `ThreadLocal`-backed context: the Jakarta security context (the authenticated principal), the JTA transaction, the CDI request scope, and the SLF4J MDC used for correlation IDs in logs. All of it is bound to the thread, not the request. The instant you resume on a different thread, that context is gone: `@RequestScoped` beans throw `ContextNotActiveException` or resolve to the wrong instance, the security principal is null, and your structured logs lose their request ID exactly when you need it to debug the async path. The fix is explicit context propagation (MicroProfile Context Propagation, or capturing and restoring the values by hand around the handoff), and the discipline is to assume nothing thread-bound survives a thread switch.

```java
// MicroProfile Context Propagation: capture request context, restore it on the worker.
@Inject ThreadContext threadContext;

CompletableFuture<Order> load(long id) {
    return threadContext.withContextCapture(            // snapshot CDI/security/MDC now
        CompletableFuture.supplyAsync(() -> repo.find(id), executor));
}
```

Transactions deserve their own warning because the failure is silent. A JTA transaction is thread-bound: you cannot begin it on the request thread and commit it on a callback thread, and a `@Transactional` boundary does not stretch across an async handoff. Code that splits a unit of work across threads either runs outside any transaction (writes auto-commit individually, so a later failure leaves partial data) or throws an obscure transaction-association error. Keep the entire transactional unit on one thread; if you must go async, complete the transaction fully before the handoff and treat the async continuation as a separate unit.

Servlet-level non-blocking I/O adds its own callback hazards. With a `ReadListener` you may only read while `isReady()` returns true, and reading outside `onDataAvailable()` corrupts the stream; ignoring `isReady()` and reading eagerly defeats the whole point and can buffer an unbounded request body into memory, which is a denial-of-service vector (backpressure exists precisely so a fast client cannot force you to buffer faster than you consume). Exceptions thrown inside these callbacks do not flow into the container's normal error handling or your `ExceptionMapper`; they surface on `onError()`, and if you do not implement it the request leaks. And every async request needs an explicit timeout via `AsyncContext.setTimeout` plus an `AsyncListener`, because without one a downstream that never responds leaves the async context (and its resources) hung indefinitely rather than failing cleanly.

```java
// Async timeouts and errors are opt-in: without this, a stalled call leaks the context.
AsyncContext ctx = request.startAsync();
ctx.setTimeout(5_000);
ctx.addListener(new AsyncListener() {
    public void onTimeout(AsyncEvent e) { complete(e, 504); }
    public void onError(AsyncEvent e)   { complete(e, 500); }   // callback errors land here, not in an ExceptionMapper
    public void onComplete(AsyncEvent e) {}
    public void onStartAsync(AsyncEvent e) {}
});
```

Two more practical costs to name. Debuggability degrades sharply: a blocking stack trace tells the whole story in one frame, while an async failure is scattered across thread handoffs and callback boundaries, so a single logical request has no single stack, which is why correlation IDs in the MDC (the thing context loss silently breaks) matter so much here. And the programming model is simply harder to reason about, which means more bugs per feature, so the complexity has to buy real scalability to be worth it.

That trade-off is the staff-level conclusion, and on a modern JVM it usually points the other way. The entire reason for hand-rolled non-blocking I/O on a classic server was to escape the thread-per-request ceiling, and Java 21 virtual threads remove that ceiling while keeping the blocking, readable, single-stack style: no context loss, no transaction-across-threads problem, no callback error plumbing, normal stack traces. So on Jakarta EE or TomEE running Java 21+, prefer virtual threads for I/O-bound scaling and reserve explicit non-blocking I/O for the narrow cases that genuinely need it, chiefly streaming large or long-lived response bodies (server-sent events, large downloads) where you want to push data incrementally without holding a thread for the whole transfer. Reaching for reactive or callback-based NIO as a default in 2026, when virtual threads exist, is the choice an interviewer will push back on.

---

## The java.nio package: channels, buffers, selectors

The async features above are the framework's view; underneath them sits the standard non-blocking I/O package, `java.nio` ("New I/O"). You rarely write it by hand, but knowing its three abstractions explains how the server's NIO connector, Netty, and every reactive runtime actually work, and that mechanism is fair game at staff level. A `Buffer` (almost always a `ByteBuffer`) is a fixed-size container for the bytes in flight. A `Channel` (`SocketChannel`, `ServerSocketChannel`, `FileChannel`) is a bidirectional connection to a socket or file that reads and writes through buffers. A `Selector` is the multiplexer that lets one thread watch many channels at once.

The pivot from blocking I/O is a single call: `channel.configureBlocking(false)`. A non-blocking channel's `read` returns immediately with whatever bytes are available (possibly zero) instead of parking the thread until data arrives. You then register the channel with a `Selector` declaring the events you care about (`OP_ACCEPT`, `OP_READ`, `OP_WRITE`), and a single thread loops on `selector.select()`, which blocks until *any* registered channel is ready, then hands you the ready set. One thread services thousands of connections because it only ever wakes for sockets that actually have work. This is the reactor pattern, and it is the event loop, expressed in standard library terms.

```java
Selector selector = Selector.open();
serverChannel.configureBlocking(false);
serverChannel.register(selector, SelectionKey.OP_ACCEPT);

while (true) {
    selector.select();                                   // blocks until a channel is ready
    Iterator<SelectionKey> it = selector.selectedKeys().iterator();
    while (it.hasNext()) {
        SelectionKey key = it.next();
        it.remove();                                     // gotcha: must remove, or it re-fires
        if (key.isReadable()) {
            SocketChannel ch = (SocketChannel) key.channel();
            int n = ch.read(buffer);                     // returns now, even if 0 bytes
            // ...handle bytes...
        }
    }
}
```

The `ByteBuffer` is where people get cut, because it is a stateful cursor, not a simple array. It tracks `position`, `limit`, and `capacity`, and you switch between filling and draining it with `flip()` (after writing into it, before reading out), `clear()` (reset to fill again), and `compact()` (keep unread bytes, make room for more). The canonical bug is reading from a buffer without calling `flip()` first, which reads garbage from beyond the data you wrote. A second gotcha is direct versus heap buffers: `ByteBuffer.allocateDirect()` lives off-heap so the OS can do zero-copy transfers (faster for sockets) but is expensive to allocate and is not bounded by the normal heap, so pooling direct buffers and leaking them are both real concerns.

The honest staff framing: raw `java.nio` is verbose, easy to get subtly wrong (partial reads, partial writes, buffer state, registering `OP_WRITE` only when a write would block), and almost nobody should hand-roll a selector loop in production. The point of learning it is to understand what Netty and the Tomcat NIO connector do for you, to reason about their tuning and failure modes, and to recognize that a single selector thread that does any blocking work inside the loop stalls every connection it serves, which is the low-level version of the event-loop rule stated earlier.

---

## Non-blocking algorithms: CAS, atomics, and lock-free design

"Non-blocking" also describes a family of concurrency algorithms that coordinate threads without locks, and the distinction from non-blocking I/O is a common interview clarification: same adjective, different problem. A lock-free algorithm guarantees that the system as a whole makes progress even if individual threads stall, because no thread can hold a lock that blocks the others. The hardware primitive underneath is compare-and-swap (CAS): an atomic "if this memory location still holds the value I last read, set it to this new value, otherwise tell me you failed." The `java.util.concurrent.atomic` package exposes it through `AtomicInteger`, `AtomicLong`, and `AtomicReference`, whose `compareAndSet` maps to a single CPU instruction.

The design pattern that replaces a lock is the CAS retry loop: read the current value, compute the new value, attempt to swap it in, and if another thread changed it in between, loop and try again on the fresh value. There is no blocking; a losing thread simply retries.

```java
// A lock-free counter: no synchronized, no lock, just retry on contention.
AtomicLong counter = new AtomicLong();

long incrementAndGet() {
    long prev, next;
    do {
        prev = counter.get();
        next = prev + 1;
    } while (!counter.compareAndSet(prev, next));   // retry if someone else won the race
    return next;
}
```

Two traps define the staff-level answer. The first is the ABA problem: a CAS checks the value, not the history, so if another thread changes the slot from A to B and back to A, your `compareAndSet(A, ...)` succeeds even though the world moved underneath you. This is harmless for a counter but corrupts pointer-based structures like a lock-free stack, where a recycled node makes a stale pointer look current. The fix is to version the reference with `AtomicStampedReference`, so the CAS compares value *and* stamp and the reused-A no longer matches the old stamp. The second is contention: CAS is cheap when uncontended but degrades under heavy write contention, because many threads burn CPU retrying the same loop. For a hot counter this is why `LongAdder` usually beats `AtomicLong`: it stripes the count across multiple cells so threads rarely collide, and sums them only when read. Reaching for `LongAdder` on a high-traffic metric is a small detail that reads as experience.

The library already ships the hard cases, so the practical skill is choosing them, not writing them. `ConcurrentHashMap` and `ConcurrentLinkedQueue` are non-blocking (or finely lock-striped) structures you should prefer over a `synchronized` wrapper for concurrent access. The selection rule: reach for atomics and lock-free structures on simple, single-variable, low-to-moderate-contention hot paths (counters, flags, single references, CAS-guarded state machines), use `LongAdder` when a counter is genuinely hot, and fall back to a `ReentrantLock` or `synchronized` when you must update several variables under one consistent invariant, because a multi-word atomic update is exactly what CAS cannot express and where hand-rolled lock-free code becomes subtly wrong. And remember the correctness floor underneath all of it: `volatile` and the atomics provide the happens-before visibility guarantees that make a value written by one thread reliably visible to another, which plain fields do not.

---

## Production metrics: RPS, latency, and the nines

Staff interviews expect you to attach numbers to claims. The figures below are order-of-magnitude defaults for a well-tuned single instance; quote them as ranges and always say "measure before you trust."

| Metric | Typical figure (one tuned instance) | What moves it |
|---|---|---|
| Throughput | 2k to 10k RPS for light JSON endpoints | Payload size, DB round-trips per request, pool limits |
| Latency p50 | 5 to 30 ms | In-process work, cache hit rate |
| Latency p99 | 50 to 300 ms | GC pauses, pool waits, downstream tails |
| Startup | 3 to 10 s (TomEE web profile) | Classpath scanning, datasource init |
| Heap | 256 MB to 1 GB | Cache sizes, request concurrency |

The latency numbers worth internalizing are percentiles, not averages. The average hides the tail; p99 and p99.9 are where users feel pain, and in a request that fans out to several services the tail compounds (if each of five calls has a 1-in-100 slow response, roughly 1 in 20 requests hits at least one slow call). Always report p50/p95/p99, never the mean.

The connection pool is usually the real throughput ceiling, not the CPU. Little's Law gives the intuition: concurrency equals throughput times latency. If each request holds a DB connection for 10 ms and you have 50 connections, the ceiling is 50 / 0.010 = 5000 RPS regardless of how many request threads exist. Sizing the request thread pool far above the connection pool just moves the queue and inflates latency. Size the pool to the database's capacity, not to optimism.

The "nines" translate availability percentages into a downtime budget, and you should know the common rows cold.

| Availability | Downtime per year | Downtime per 30 days |
|---|---|---|
| 99% (two nines) | 3.65 days | 7.2 hours |
| 99.9% (three nines) | 8.77 hours | 43.2 minutes |
| 99.95% | 4.38 hours | 21.6 minutes |
| 99.99% (four nines) | 52.6 minutes | 4.32 minutes |
| 99.999% (five nines) | 5.26 minutes | 25.9 seconds |

The staff point is that a single application server instance cannot reach four nines, because routine restarts, deploys, and JVM crashes exceed a 52-minute yearly budget. Three or more nines is an architecture property (redundant instances behind a load balancer, rolling deploys, health checks), not a property of the server itself.

---

## Staff-level caveats and the questions behind them

The classloader hierarchy is the source of the platform's most confusing errors. A `ClassCastException` between two classes that look identical, or `NoClassDefFoundError` for a class you can see on disk, almost always means a library is bundled in the war while the server also provides it, so two classloaders each have their own copy. The discipline is to keep server-provided APIs in `provided` scope and never ship a second copy.

Deploy-time safety is the rest of the answer. The application-server model historically encouraged hot redeploy into a running server, which leaks classloaders and slowly poisons the JVM until a restart. In a container world, do not hot-redeploy: bake one war into one immutable image and roll instances. This converts the server's weakness (slow, leaky redeploy) into a non-issue.

Know when to walk away from this stack. Choose Jakarta EE or TomEE when you have an existing EE estate, a team fluent in it, standards-portability requirements, or container-managed JTA across multiple datasources that you do not want to hand-roll. Reach for the cloud-native JVM stacks (Quarkus, Micronaut) when startup time and memory footprint are first-class concerns, typically for serverless or aggressive horizontal autoscaling, where a 5-second startup and a 512 MB floor are liabilities. Being able to draw that line, with numbers, is the difference between knowing the framework and owning the decision.
