## The event loop is your throughput budget

Every Node.js interview at staff level circles back to one model, so internalize it first. Node runs your JavaScript on a single thread driven by an event loop. When your code calls a non-blocking I/O API (a database query, an HTTP request, a file read), Node hands the work to libuv, which uses the OS's async facilities or a small background thread pool, and your thread moves on to the next event. When the I/O completes, its callback is queued and the loop runs it. One thread serves thousands of concurrent connections because almost no time is spent waiting; the thread is only ever doing CPU work or dispatching completed I/O.

The consequence that defines good Node code: the single thread is a shared budget, and any synchronous CPU work blocks *every* connection until it finishes. A 200-millisecond JSON transform or a synchronous crypto call does not slow one request, it freezes the whole process for 200 milliseconds, so every concurrent request's latency jumps. This is why "Node is fast for I/O-bound work and bad for CPU-bound work" is the canonical summary. The metric that makes it visible is event-loop lag: the delay between when a timer should fire and when it does. Rising lag means the loop is starved, and it is the single most important Node-specific health signal.

```js
import { monitorEventLoopDelay } from 'node:perf_hooks'

const h = monitorEventLoopDelay({ resolution: 20 })
h.enable()
setInterval(() => {
  // p99 loop lag in ms; alert when this climbs above a few ms
  console.log('loop p99 ms:', (h.percentile(99) / 1e6).toFixed(1))
  h.reset()
}, 5000)
```

The libuv thread pool (default size 4, set by `UV_THREADPOOL_SIZE`) backs a specific set of operations: file system calls, DNS lookups via `getaddrinfo`, and the `crypto` and `zlib` async functions. Network sockets do *not* use it; they use the OS event mechanism directly. A common production surprise is that heavy `bcrypt` or `zlib` usage saturates the 4-thread pool and serializes work that looked async, and the fix is to raise `UV_THREADPOOL_SIZE` to match the core count.

---

## Express: minimal core, and the structure tax

Express is a thin, unopinionated layer over Node's HTTP server. Its entire model is a chain of middleware functions, each receiving `(req, res, next)`, that either respond or call `next()` to pass control along. That minimalism is the appeal and the liability: Express gives you routing and middleware, and nothing else (no DI, no project structure, no validation, no config), so every team invents its own conventions, and large Express codebases drift toward inconsistency. Naming that tax is a senior signal.

A correct Express bootstrap is unremarkable, which is the point.

```js
import express from 'express'

const app = express()
app.use(express.json())                       // body parser middleware

app.get('/orders/:id', async (req, res, next) => {
  try {
    const order = await orderService.find(req.params.id)
    if (!order) return res.status(404).json({ error: 'not_found' })
    res.json(order)
  } catch (err) {
    next(err)                                  // forward to the error handler
  }
})
```

Two Express-specific traps appear constantly in interviews. First, middleware order is semantic: `express.json()` must run before any handler reading `req.body`, and a catch-all 404 handler must be registered *last*, because the chain is evaluated top to bottom. Second, error handling. An async handler that throws (or rejects) does not automatically reach Express's error middleware in Express 4; you must `catch` and call `next(err)`, or the request hangs until timeout. The error handler itself is identified purely by its four-argument signature, which is easy to get subtly wrong.

```js
// The error handler MUST take four args, or Express treats it as normal middleware.
app.use((err, req, res, next) => {
  req.log.error({ err }, 'unhandled')
  res.status(err.status ?? 500).json({ error: 'internal' })
})
```

Express 5 (now the default major) improves this: rejected promises from async handlers are forwarded to the error handler automatically, removing the most common footgun. Knowing which major you target, and that this changed, is the kind of detail that reads as current.

---

## NestJS: structure, DI, and the decorator model

NestJS is the answer to Express's structure problem. It is an opinionated framework (TypeScript-first, Angular-inspired) that runs on top of Express or Fastify and adds a real dependency-injection container, a module system, and a layered request pipeline. The mental model is modules that group related providers, providers (services) that are injected by type, and controllers that map routes to provider methods. For a team or a long-lived codebase, the imposed structure is the value.

```ts
import { Controller, Get, Param, Injectable, Module } from '@nestjs/common'

@Injectable()
export class OrderService {
  constructor(private readonly repo: OrderRepository) {}   // injected by type
  find(id: string) { return this.repo.findOne(id) }
}

@Controller('orders')
export class OrderController {
  constructor(private readonly orders: OrderService) {}
  @Get(':id')
  get(@Param('id') id: string) { return this.orders.find(id) }
}

@Module({ controllers: [OrderController], providers: [OrderService, OrderRepository] })
export class OrderModule {}
```

The request pipeline is Nest's structured replacement for ad-hoc Express middleware, and knowing the order and purpose of each stage is a frequent interview question. A request flows through middleware, then guards (authn/authz: return a boolean to allow or deny), then interceptors (wrap the handler for logging, caching, response shaping), then pipes (validate and transform inputs), then the handler, then interceptors again on the way out, with exception filters catching anything thrown.

```ts
// A guard: the canonical place for authorization, evaluated before the handler.
@Injectable()
export class RolesGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest()
    return req.user?.roles?.includes('admin') ?? false
  }
}
```

The DI caveats that catch people: provider scope and circular dependencies. Nest providers are singletons by default (one instance for the app), which is what you want; switching to `REQUEST` scope creates one per request and quietly makes the whole dependency chain request-scoped, which costs performance, so reach for it only when you truly need per-request state. Circular dependencies between two providers fail at startup unless you break them with `forwardRef()`, but a circular dependency is usually a design smell signaling a missing third module. Pipes are where you enforce input validation centrally: wiring a global `ValidationPipe` with class-validator decorators on your DTOs gives you contract enforcement without per-handler checks.

---

## Async correctness: the bugs that cause real outages

Most Node production incidents trace to a handful of async mistakes, and articulating them separates senior from staff.

The unhandled promise rejection: a promise rejects with no `catch`. In modern Node this terminates the process by default. The defenses are to always `await` inside a `try/catch` (or use a framework that forwards rejections), and to install a last-resort handler that logs and *crashes deliberately* rather than limping on in an unknown state.

```js
process.on('unhandledRejection', (reason) => {
  logger.fatal({ reason }, 'unhandled rejection, shutting down')
  process.exit(1)             // fail fast; let the orchestrator restart a clean process
})
```

Blocking the loop: any synchronous CPU-heavy call (a big `JSON.parse`, synchronous crypto, a tight loop) freezes all requests. Offload genuine CPU work to a `worker_thread` or a separate service; never solve it by "making it async" with a `setTimeout`, which does not add parallelism. Lost concurrency: awaiting independent operations in sequence when they could run together. `await a(); await b()` runs serially; `await Promise.all([a(), b()])` runs them concurrently and halves the latency when they are independent.

```js
// Serial: total latency = a + b
const user = await getUser(id)
const cart = await getCart(id)
// Concurrent: total latency = max(a, b)
const [user, cart] = await Promise.all([getUser(id), getCart(id)])
```

Memory leaks: the staff-level differentiator in Node, because the single long-lived process accumulates them. The usual culprits are event listeners added per request without removal (watch for the `MaxListenersExceededWarning`), unbounded in-memory caches or arrays that only grow, and closures that capture large objects and outlive their usefulness. Diagnose with heap snapshots (`--inspect` plus Chrome DevTools, or `--heapsnapshot-near-heap-limit`) and look for retained growth across snapshots, not absolute size.

---

## Scaling and production hardening

A single Node process uses one CPU core. To use a multi-core box you run multiple processes: the built-in `cluster` module forks workers sharing a port, or you run N container replicas behind a load balancer (the cloud-native default). Prefer replicas in Kubernetes, because the orchestrator already handles restart, scaling, and health, making `cluster` redundant inside a pod. Either way, Node scales horizontally by process count, not by threads.

Graceful shutdown is non-negotiable for zero-downtime deploys and a frequent "have you actually run this in production" probe. On `SIGTERM` you must stop accepting new connections, finish in-flight requests, close database pools, then exit, all within the orchestrator's grace period before it sends `SIGKILL`.

```js
const server = app.listen(8080)
process.on('SIGTERM', async () => {
  server.close(async () => {            // stop accepting, drain in-flight
    await pool.end()                    // close DB connections
    process.exit(0)
  })
  setTimeout(() => process.exit(1), 10_000).unref()   // hard cap so we never hang
})
```

The rest of the hardening checklist: structured JSON logging (pino) so logs are queryable, OpenTelemetry for traces and metrics including the event-loop-lag gauge, a `/health` (liveness) and `/ready` (readiness) split wired to orchestrator probes, request timeouts and an HTTP client with sane keep-alive and connection limits so a slow downstream cannot exhaust sockets, and a body-size limit on the JSON parser so a large payload cannot blow up memory. Validate input at the edge (class-validator in Nest, zod in Express) so malformed data never reaches business logic.

---

## Production metrics: RPS, latency, and the nines

Attach numbers to your claims; these are order-of-magnitude defaults for a single Node process on one modern core, to be measured not trusted.

| Metric | Typical figure (one process, one core) | What moves it |
|---|---|---|
| Throughput, trivial JSON | 10k to 40k RPS | Framework overhead (Fastify > Express), payload size |
| Throughput, one DB call/request | 2k to 8k RPS | DB latency, pool size, serialization |
| Latency p50 | 1 to 10 ms | In-process work, cache hits |
| Latency p99 | 20 to 150 ms | GC, loop lag spikes, downstream tails |
| Event-loop lag p99 (healthy) | under 10 ms | CPU work on the main thread |
| Resident memory | 60 to 250 MB | Cache sizes, concurrency, leaks |

Report latency as percentiles, never as a mean: the average hides the tail, and in a request that fans out to several services the tail compounds, so p99 and p99.9 are where users actually feel slowness. The Node-specific SLI to graph alongside latency is event-loop lag; when lag climbs, latency follows, and it points at CPU starvation rather than a slow dependency, which a plain latency graph cannot distinguish.

The throughput ceiling is usually downstream, not Node itself. Little's Law (concurrency = throughput x latency) gives the sizing: if each request holds one of a 20-connection pool for 10 ms, the ceiling is 20 / 0.010 = 2000 RPS per process regardless of how fast Node is, so the database pool, not the event loop, sets the limit. Scale by adding processes only after the pool and the downstream can absorb the extra load.

The availability "nines" translate a target into a downtime budget you must design for.

| Availability | Downtime per year | Downtime per 30 days |
|---|---|---|
| 99% | 3.65 days | 7.2 hours |
| 99.9% | 8.77 hours | 43.2 minutes |
| 99.99% | 52.6 minutes | 4.32 minutes |
| 99.999% | 5.26 minutes | 25.9 seconds |

The staff point: a single Node process cannot reach three or four nines, because one unhandled rejection or one deploy exceeds the budget. High availability is an architecture property (multiple replicas behind a load balancer, graceful shutdown for zero-downtime rolling deploys, health-checked routing, fail-fast-and-restart on corruption), and the metric that protects it is the error budget, which the next guide ties together with SLI and SLO.

---

## Staff-level caveats and framework choice

Pick the framework on the codebase's lifecycle and the team, not on benchmarks. Express (or Fastify, when raw throughput matters) suits small services, a single owner, or a team that wants full control and will supply its own conventions; its cost is that, without discipline, large Express apps become inconsistent. NestJS suits larger teams and long-lived codebases where the imposed module/DI structure pays for its learning curve and slightly higher overhead by keeping a big codebase coherent and testable. The wrong interview answer is "Nest is better" or "Express is faster" without that lifecycle framing.

Three caveats that read as genuinely senior. TypeScript is effectively mandatory at scale: it catches the shape errors that dynamic JavaScript ships to production, and Nest is built around it. The ecosystem's depth is a double-edged sword: npm has a package for everything, but each dependency is supply-chain surface and resident memory, so audit and minimize rather than reaching for a library per problem. And the single-threaded model means observability must include the event loop: a service that graphs CPU and latency but not loop lag is blind to its most common Node failure mode, where the process is pegged not because the box is busy but because one synchronous call is starving the loop.

---

## Common interview questions

These come up in almost every Node round. Lead with the event-loop model, because most answers trace back to it.

**Explain the event loop, and why Node is bad at CPU-bound work.** Your JavaScript runs on a single thread; non-blocking I/O is handed to libuv and the OS, and completion callbacks are queued back to the loop, so one thread serves thousands of connections that are mostly waiting. The flip side is that any synchronous CPU work blocks that one thread, freezing every concurrent request until it finishes, which is why a heavy computation belongs in a worker thread or another service.

**What uses the libuv thread pool?** File system operations, DNS via `getaddrinfo`, and the async `crypto` and `zlib` functions, default pool size four, tunable with `UV_THREADPOOL_SIZE`. Network sockets do not use it; they go straight to the OS event mechanism. Heavy `bcrypt` or `zlib` can saturate the four threads and serialize work that looked async.

**Express or NestJS, when each?** Express is a thin, unopinionated middleware layer: great for small services or a single owner who will supply their own conventions, at the cost of large codebases drifting toward inconsistency. NestJS adds a real DI container, modules, and a structured request pipeline: worth its learning curve and overhead for larger teams and long-lived codebases. Pick on lifecycle and team, not benchmarks.

**How do you handle errors in an async Express handler?** In Express 4 a rejected promise does not reach the error middleware automatically, so you must `catch` and call `next(err)`, or the request hangs until timeout. The error handler is identified purely by its four-argument signature `(err, req, res, next)`. Express 5 forwards rejected promises automatically, removing the most common footgun.

**What is the order of the NestJS request pipeline?** Middleware, then guards (authn/authz, return a boolean), then interceptors (wrap the handler), then pipes (validate and transform input), then the handler, then interceptors again on the way out, with exception filters catching anything thrown. Guards are the canonical place for authorization; pipes are where a global `ValidationPipe` enforces your DTO contract.

**Singleton versus request scope in Nest?** Providers are singletons by default, one instance for the app, which is what you want. Switching a provider to `REQUEST` scope creates one per request and quietly makes its whole dependency chain request-scoped, costing performance, so reach for it only when you truly need per-request state.

**How do you use all CPU cores?** One Node process uses one core, so you run multiple processes: the built-in `cluster` module forks workers sharing a port, or you run N container replicas behind a load balancer. Prefer replicas in Kubernetes, since the orchestrator already handles restart, scaling, and health, making `cluster` redundant inside a pod.

**Why does graceful shutdown matter, and how do you do it?** Without it, a deploy kills in-flight requests and drops connections. On `SIGTERM` you stop accepting new connections, drain in-flight requests, close database pools, then exit, all within the orchestrator's grace period, with a hard timeout so the process can never hang.

**What causes memory leaks in Node?** A long-lived single process accumulates them: event listeners added per request without removal (watch for `MaxListenersExceededWarning`), unbounded in-memory caches or arrays that only grow, and closures that capture large objects and outlive their use. Diagnose by comparing heap snapshots for retained growth, not absolute size.

**Serial versus concurrent awaits?** `await a(); await b()` runs them in sequence, so the latency is the sum; `await Promise.all([a(), b()])` runs independent operations together, so the latency is the max. Awaiting independent calls serially is a common, invisible performance bug.

```js
const [user, cart] = await Promise.all([getUser(id), getCart(id)])  // concurrent
```

**What is event-loop lag and why monitor it?** It is the delay between when a timer should fire and when it actually does, and it is the Node-specific signal that the loop is starved by CPU work. When lag climbs, latency follows, and it distinguishes a pegged loop from a slow downstream, which a plain latency graph cannot. Graph it alongside latency or you are blind to your most common failure mode.
