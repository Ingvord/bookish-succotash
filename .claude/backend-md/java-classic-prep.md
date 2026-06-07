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
