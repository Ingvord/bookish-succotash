## ASGI, WSGI, and why FastAPI exists

The first thing to get right is the runtime model, because every FastAPI design decision flows from it. Traditional Python web frameworks (Flask, Django's classic path) speak WSGI, a synchronous interface: one request occupies one worker until it returns, and concurrency comes from running many worker processes or threads. ASGI is the asynchronous successor: it supports `async def` handlers and an event loop, so a single worker can hold thousands of in-flight requests as long as each one spends its time awaiting I/O rather than burning CPU. FastAPI is an ASGI framework built on Starlette (the ASGI toolkit) and Pydantic (validation), and you run it under an ASGI server, usually Uvicorn.

That async model is the same event-loop story as Node, with the same defining rule: the event loop is a single thread, and any synchronous CPU-bound or blocking call inside an `async def` freezes every concurrent request on that loop. The difference from Node is that Python lets you mix sync and async freely, which is exactly where the footguns live, so the framework gives you escape hatches (covered below) that you must use correctly.

FastAPI's headline feature is that types drive everything. You declare request and response shapes as Python type hints and Pydantic models, and the framework derives validation, serialization, and an OpenAPI schema from them automatically. The contract is the code; the documentation is generated, not maintained by hand, which is a real answer to the contract-first API question.

---

## The GIL: the constraint behind every scaling decision

The Global Interpreter Lock is the Python fact every staff interview expects you to handle correctly. In CPython, one lock allows only one thread to execute Python bytecode at a time, so threads do not give you parallel CPU execution; a multithreaded pure-Python computation runs no faster than single-threaded. This is why Python web apps scale CPU work across *processes*, not threads, and why the production deployment is "N worker processes," one per core or so.

State the nuance, because it is what separates a memorized answer from understanding. The GIL is released during blocking I/O (socket reads, file reads) and inside many C extensions (NumPy, database drivers), so threads *do* help I/O-bound and native-compute workloads even though they never help pure-Python CPU loops. And the landscape is shifting: the free-threaded build that landed experimentally in Python 3.13 (PEP 703) was promoted to officially supported in Python 3.14 (PEP 779, October 2025), bringing the single-threaded overhead down to roughly 5 to 10 percent, though some C-extension packages still re-enable the GIL until they are made thread-safe. The async model, separately, sidesteps the GIL for I/O concurrency entirely by using one thread and an event loop instead of many threads. The senior framing: until free-threading is ubiquitous, the GIL still caps pure-Python CPU parallelism within a standard process, so you scale CPU with processes and scale I/O with async, and you offload heavy CPU work out of the web process altogether.

---

## Project bootstrap: a typed FastAPI service

A clean bootstrap demonstrates the type-driven model end to end. Pydantic models define the contract, path operations declare their inputs and outputs, and FastAPI validates, serializes, and documents from those declarations.

```python
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

app = FastAPI(title="orders", version="1.0.0")

class Order(BaseModel):
    id: int
    customer: str = Field(min_length=1)
    total: float = Field(ge=0)

@app.get("/orders/{order_id}", response_model=Order)
async def get_order(order_id: int) -> Order:
    order = await repo.find(order_id)
    if order is None:
        raise HTTPException(status_code=404, detail="not_found")
    return order
```

Several things happen for free here and are worth naming in an interview. The `order_id` path parameter is validated and coerced to `int` (a non-numeric value yields a 422 automatically). The request body, where present, is validated against the Pydantic model with precise per-field errors. `response_model` filters and validates the output, so internal fields never leak. And the whole thing produces an OpenAPI document at `/openapi.json` with interactive docs at `/docs`, generated from the same types, never drifting from the implementation.

You run it under Uvicorn, and in production you front Uvicorn workers with Gunicorn (or run Uvicorn with `--workers`) to use multiple cores.

```bash
# Development: one process, auto-reload
uvicorn app:app --reload

# Production: Gunicorn managing Uvicorn workers, one per core-ish
gunicorn app:app -k uvicorn.workers.UvicornWorker -w 4 --bind 0.0.0.0:8080
```

---

## Dependency injection and lifetimes

FastAPI's dependency-injection system is one of its best features and a common source of subtle bugs, so know it precisely. A dependency is a callable declared with `Depends()`; FastAPI resolves it per request, caches it within that request (so the same dependency requested twice yields one instance per request), and supports `yield` dependencies that run setup before the handler and teardown after, which is the idiomatic place for database sessions.

```python
from fastapi import Depends

async def get_db():
    session = SessionLocal()
    try:
        yield session            # injected into the handler
    finally:
        await session.close()    # teardown runs after the response

@app.get("/orders/{order_id}")
async def get_order(order_id: int, db = Depends(get_db)):
    return await db.get(Order, order_id)
```

The lifetime caveat: dependencies are request-scoped by default, which is correct for sessions and per-request context. Application-scoped resources (a connection pool, an HTTP client, a cache client) must be created once at startup and shared, not built per request, or you exhaust connections under load. The modern idiom is the `lifespan` context manager, which replaces the deprecated `@app.on_event` startup/shutdown hooks.

```python
from contextlib import asynccontextmanager

@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.http = httpx.AsyncClient()   # one shared client for the whole app
    yield
    await app.state.http.aclose()          # clean shutdown

app = FastAPI(lifespan=lifespan)
```

---

## Async done right: the blocking trap

The single most common FastAPI production bug is blocking the event loop, and explaining it crisply is a strong staff signal. If you declare a handler `async def`, it runs *on the event loop*, and any synchronous blocking call inside it (a synchronous database driver, `requests.get`, `time.sleep`, a heavy CPU computation) blocks the entire loop, stalling every other concurrent request. The symptom is brutal: latency that is fine at low load collapses under concurrency, because requests that should interleave are serialized behind blocking calls.

There are three correct responses, and choosing among them is the skill. First, use async-native libraries inside `async def`: an async database driver (`asyncpg`, `databases`, SQLAlchemy's async engine), `httpx.AsyncClient` instead of `requests`, `asyncio.sleep` instead of `time.sleep`. Second, if you only have a synchronous library, define the handler as plain `def` (not `async def`): FastAPI automatically runs `def` handlers in a thread pool, off the event loop, so they cannot block it. Third, for genuine CPU-bound work, offload it explicitly to a thread or process pool, or better, to a task queue outside the web process entirely.

```python
import anyio

# WRONG: blocking call on the event loop, stalls all concurrent requests
@app.get("/report")
async def report():
    data = requests.get("https://slow")     # blocks the loop
    return heavy_cpu_transform(data.json())  # also blocks the loop

# RIGHT: async I/O, and CPU work pushed to a worker thread
@app.get("/report")
async def report():
    resp = await http.get("https://slow")            # non-blocking I/O
    return await anyio.to_thread.run_sync(            # CPU work off the loop
        heavy_cpu_transform, resp.json()
    )
```

The counterintuitive rule worth stating outright: a *synchronous* `def` handler can be safer than a badly written `async def` one, because FastAPI threads the sync handler off the loop, whereas a blocking call in an async handler poisons the whole worker. "Async everywhere" is not the goal; "never block the loop" is.

---

## Concurrency for I/O-bound data pipelines: asyncio vs threading vs multiprocessing

Instrument backends running at kilohertz data rates make the concurrency choice visible in a way web services rarely do. The stakes are concrete: pick the wrong model and you either hit a bottleneck that has nothing to do with Python, or you introduce the unbounded-memory failure that only appears at production data rates.

### The three-way choice, and why the GIL is a non-issue here

Lead with the rule: the GIL only serializes Python bytecode. It is released during blocking I/O (socket reads, file reads) and inside C extensions like NumPy and SciPy. At kilohertz detector rates the bottleneck is waiting on the detector socket, not executing bytecode, so the GIL never becomes the limit. This is the answer to give when an interviewer asks whether the GIL makes Python unsuitable for scientific data collection: it does not, because the work is either I/O-bound (GIL released during the kernel wait) or NumPy-bound (GIL released inside the C layer). The three-way decision comes down to which bottleneck you actually have.

| Workload | GIL relevant? | Right tool |
|---|---|---|
| Socket/file reads, network detectors | No (GIL released during I/O) | asyncio event loop or thread pool |
| NumPy/SciPy array processing | No (GIL released in C layer) | asyncio.to_thread + ThreadPoolExecutor |
| Pure-Python CPU loops | Yes (GIL held) | multiprocessing / ProcessPoolExecutor |
| Mixed I/O + array compute | No (for both legs) | asyncio loop + to_thread for array work |

The catch: the three tools are not interchangeable. Threads work for I/O-bound and GIL-releasing native compute but not for pure-Python CPU loops (each thread still waits its turn for the GIL, so four threads are slower than one due to contention overhead). Processes parallelize anything but pay a serialization cost on every data crossing (pickling a 10 MB NumPy frame across a process boundary costs more than processing it on a thread where NumPy already drops the GIL). asyncio scales I/O concurrency furthest with the lowest overhead, but any synchronous call on the event-loop thread still stalls everything, as the prior section showed.

### Your Node.js event loop translates directly to asyncio

If you come from Node, the asyncio mental model is the same event-loop story: one thread runs a loop that drives I/O callbacks and resumes suspended coroutines, and no two async steps run concurrently unless you explicitly create tasks. The APIs have different names, but the semantics are one-to-one.

```text
Node.js                              asyncio / Python
---------------------------          -----------------------------------
event loop (libuv)               ->  asyncio event loop
async function / await           ->  async def coroutine / await
Promise.all([...])               ->  asyncio.gather(coro1, coro2, ...)
new Promise(resolve, reject)     ->  asyncio.Future (or asyncio.create_task)
EventEmitter / net.Socket        ->  asyncio.Protocol + transport
stream backpressure              ->  asyncio.Queue(maxsize=N) + transport.pause_reading()
worker_threads (I/O offload)     ->  asyncio.to_thread / loop.run_in_executor(ThreadPool)
worker_threads (CPU offload)     ->  loop.run_in_executor(ProcessPoolExecutor)
setTimeout / setInterval         ->  loop.call_later / asyncio.sleep in a loop
```

The one real divergence: Node mostly prevents you from calling blocking synchronous code from inside an async function (it would block the main thread visibly and is hard to do accidentally). Python lets you make that mistake silently inside a coroutine, which is exactly the blocking-the-loop footgun the prior section described. Everything else maps cleanly: once you internalize the event-loop model from Node, asyncio is a vocabulary swap, not a conceptual shift.

### Producer-consumer with asyncio.Queue (the kHz pipeline)

The canonical pattern for kilohertz instrument data is a producer coroutine reading detector frames and pushing them into a bounded `asyncio.Queue`, with a pool of consumer tasks draining and processing. The queue is the coupling point: it decouples the read rate from the compute rate, and its `maxsize` is what makes backpressure explicit rather than implicit.

```python
import asyncio
import numpy as np
from typing import Optional

async def producer(queue: asyncio.Queue, detector) -> None:
    """Read frames from the detector and push them into the pipeline queue.
    Suspends on await queue.put() when the queue is full, which is the
    backpressure signal: the consumer is falling behind, so slow the reader."""
    while True:
        frame: Optional[np.ndarray] = await detector.read_frame()
        if frame is None:
            break
        await queue.put(frame)    # suspends here when queue.maxsize is reached
    await queue.put(None)         # sentinel: one None tells all consumers to drain and exit

async def consumer(queue: asyncio.Queue, worker_id: int) -> None:
    """Pull frames from the queue and process them. Propagates the shutdown
    sentinel so every sibling worker also receives it and exits cleanly."""
    while True:
        frame = await queue.get()
        if frame is None:         # received the shutdown sentinel
            await queue.put(None) # pass it along for the next sibling
            queue.task_done()
            return
        await process_frame(frame)
        queue.task_done()

async def run_pipeline(detector, n_workers: int = 4) -> None:
    # Bound the queue: 1000 frames * 1 MB/frame = 1 GB ceiling, not unbounded growth
    queue: asyncio.Queue = asyncio.Queue(maxsize=1000)
    # Start consumers first so nothing piles up before they are listening
    workers = [
        asyncio.create_task(consumer(queue, i))
        for i in range(n_workers)
    ]
    await producer(queue, detector)  # runs until the detector signals EOF
    await asyncio.gather(*workers)   # wait for all consumers to drain cleanly
```

The `maxsize=1000` is the critical line. An unbounded queue silently accumulates every unprocessed frame in memory. At 1 kHz with 1 MB frames that is 1 GB per second of memory growth before any alarm fires. With a bounded queue, `await queue.put()` suspends the producer when the queue is full, applying backpressure all the way back to the read loop. The consumer count is a tuning knob: start with one per core for compute-heavy frames, or fewer if the pipeline is mostly NumPy (which releases the GIL and gets real thread-level parallelism from a smaller pool).

### NumPy releases the GIL: safe array work from async context

NumPy vectorized operations (reductions, FFTs, matrix math) execute inside C extensions that release the GIL for their duration. This means a NumPy computation running on a thread-pool worker runs genuinely in parallel with the asyncio event-loop thread and with other NumPy threads. The correct pattern is `asyncio.to_thread` (or `loop.run_in_executor` with a shared pool), which submits a callable to the thread pool and returns an awaitable. The event loop suspends the coroutine, keeps draining the socket, and resumes when the thread finishes.

```python
import asyncio
import numpy as np
from concurrent.futures import ThreadPoolExecutor

# A shared pool avoids creating threads per frame; size to available cores
_pool = ThreadPoolExecutor(max_workers=4)

def reduce_frame(frame: np.ndarray) -> float:
    """Pure NumPy: FFT magnitude + RMS reduction. Releases the GIL throughout,
    so this function runs truly in parallel with other threads and the event loop."""
    spectrum = np.fft.rfft(frame.astype(np.float64))
    rms = float(np.sqrt((np.abs(spectrum) ** 2).mean()))
    return rms

async def process_frame(frame: np.ndarray) -> float:
    """Offload the NumPy work to a thread so the event loop remains free
    to keep draining the detector socket while the array is being crunched."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(_pool, reduce_frame, frame)
    # asyncio.to_thread(reduce_frame, frame) is equivalent using the default executor
```

The catch: `asyncio.to_thread` and `ThreadPoolExecutor` are the right choice only when the callable releases the GIL. For pure-Python CPU loops, threads buy nothing because each thread still waits for the GIL, and the switching overhead makes four threads slower than one. For those workloads, use `ProcessPoolExecutor` and accept the pickling cost on every argument and return value. A practical test: if swapping from one thread to four threads on your workload does not improve throughput, the GIL is the bottleneck; switch to processes.

```python
from concurrent.futures import ProcessPoolExecutor

# For pure-Python CPU work that cannot release the GIL
_proc_pool = ProcessPoolExecutor(max_workers=4)

async def heavy_pure_python(data: list) -> int:
    """GIL-bound in a ThreadPool; ProcessPool gives true parallelism at the cost
    of pickling data across the process boundary on every call."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(_proc_pool, compute_pure_python, data)
```

### Detector socket via asyncio.Protocol and readable transport

For raw socket connections to a hardware detector, `asyncio.Protocol` gives you the low-level transport/protocol split that mirrors Node's `net.Socket` plus `EventEmitter`. The transport owns the socket and the OS buffer; the protocol owns the framing and application logic. You subclass `asyncio.Protocol` and implement three methods: `connection_made` (receives the transport handle), `data_received` (called with arbitrary-sized byte chunks as they arrive), and `connection_lost`.

```python
import asyncio
from typing import Iterator

FRAME_SIZE = 1024 * 1024  # 1 MB per detector frame (example fixed-size framing)

def split_frames(buf: bytearray) -> Iterator[bytes]:
    """Yield complete fixed-size frames from the accumulation buffer.
    Real protocols use a length header or sync word; fixed size shown here for clarity."""
    while len(buf) >= FRAME_SIZE:
        yield bytes(buf[:FRAME_SIZE])
        del buf[:FRAME_SIZE]

class DetectorProtocol(asyncio.Protocol):
    def __init__(self, queue: asyncio.Queue) -> None:
        self.queue = queue
        self.buf = bytearray()          # accumulates partial frames between calls
        self.transport: asyncio.Transport
        self._paused = False

    def connection_made(self, transport: asyncio.Transport) -> None:
        self.transport = transport
        print(f"Connected: {transport.get_extra_info('peername')}")

    def data_received(self, data: bytes) -> None:
        """Called by the event loop whenever bytes arrive. May be called with
        partial frames or multiple frames in one chunk; never assume frame alignment."""
        self.buf.extend(data)
        for frame in split_frames(self.buf):
            try:
                self.queue.put_nowait(frame)
            except asyncio.QueueFull:
                # Consumer pipeline is falling behind: pause reads at the socket
                # level so the OS buffer absorbs the backpressure instead of memory
                self.transport.pause_reading()
                self._paused = True
                break  # remaining buf data waits until resume_producing is called

    def resume_producing(self) -> None:
        """Call from the consumer when the queue drops below a low-water threshold."""
        if self._paused:
            self.transport.resume_reading()
            self._paused = False

    def connection_lost(self, exc: Exception | None) -> None:
        print(f"Detector disconnected: {exc!r}")

async def run_detector(host: str, port: int) -> None:
    queue: asyncio.Queue = asyncio.Queue(maxsize=1000)
    loop = asyncio.get_running_loop()
    _, protocol = await loop.create_connection(
        lambda: DetectorProtocol(queue), host, port
    )
    workers = [asyncio.create_task(consumer(queue, i)) for i in range(4)]
    await asyncio.gather(*workers)
```

The catch is twofold. First, `data_received` delivers arbitrary-sized byte chunks that are never aligned to frame boundaries. You must buffer in `self.buf` and de-frame yourself; a common bug is assuming each `data_received` call contains exactly one complete frame. Second, forgetting `transport.pause_reading()` when the queue fills reintroduces the unbounded-memory failure at the socket layer: the OS keeps delivering data into `data_received`, each call appends to `self.buf` or the queue, and memory grows without bound. The `pause_reading` / `resume_reading` pair is the correct backpressure mechanism at the transport level, not an optional optimization.

The higher-level alternative is `asyncio.open_connection`, which returns `(StreamReader, StreamWriter)` and handles the internal buffering for you. Use it when the protocol is line-based or simple binary and you want `await reader.read(N)` in a loop. Reach for `Protocol` directly when you need fine-grained `pause_reading` / `resume_reading` control, when the framing is complex, or when you need transport factories that the streams API does not expose (TLS transports, Unix domain sockets, UDP via `create_datagram_endpoint`).

---

## Pydantic v2, validation, and contract-first APIs

Pydantic is the validation and serialization engine, and the v1-to-v2 migration is a frequent interview topic because the rewrite was substantial. Pydantic v2's core is implemented in Rust (`pydantic-core`), making validation 5 to 50 times faster, which matters because in a typical FastAPI request, validation and serialization are a real slice of the CPU budget. The API changed: `BaseSettings` moved to a separate `pydantic-settings` package, validators use the new `@field_validator`/`@model_validator` decorators, `.dict()` became `.model_dump()`, and config moved from an inner `Config` class to `model_config`. Knowing these names signals you have actually done the migration.

```python
from pydantic import BaseModel, field_validator

class NewOrder(BaseModel):
    customer: str
    items: list[str]

    @field_validator("items")     # v2 syntax; v1 used @validator
    @classmethod
    def non_empty(cls, v: list[str]) -> list[str]:
        if not v:
            raise ValueError("order must have items")
        return v
```

Because the OpenAPI schema is generated from these models, FastAPI supports a contract-verified workflow that answers the JD's API-design point directly. You either let the code be the source of truth and generate the spec, or, for contract-first shops, you keep a hand-authored OpenAPI document as the agreed contract and verify the implementation against it in CI (schemathesis can fuzz the API against the spec). Either way the discipline is that the contract is enforced mechanically, not by convention, and consumers can generate typed clients from the published schema.

---

## Production metrics: RPS, latency, and the nines

Quote numbers as order-of-magnitude defaults for one Uvicorn worker on one modern core, to be measured rather than trusted. Python's per-request overhead is higher than the JVM's or Node's, so absolute RPS is lower, and the deployment leans on multiple workers.

| Metric | Typical figure (one worker, one core) | What moves it |
|---|---|---|
| Throughput, trivial JSON | 3k to 15k RPS | Pydantic version (v2 is much faster), payload size |
| Throughput, one async DB call | 1k to 5k RPS | DB latency, pool size, async driver |
| Latency p50 | 2 to 15 ms | In-process work, validation cost |
| Latency p99 | 30 to 200 ms | Blocking calls leaking onto the loop, GC, downstream tails |
| Memory per worker | 80 to 300 MB | Loaded libraries (ML stacks balloon this), caches |

Report percentiles, not the mean: the average hides the tail, and a request that fans out to several services compounds the tail, so p99 and p99.9 are where users feel pain. The Python-specific latency killer to watch for is a blocking call sneaking onto the event loop; it shows up as p99 latency that explodes under concurrency while p50 stays fine, a fingerprint distinct from a uniformly slow dependency.

Sizing the worker count is the core Python deployment decision. Because the GIL caps pure-Python CPU parallelism per process, you run roughly one worker per core (a common starting point is `2 x cores + 1` for mixed workloads, fewer for memory-heavy apps), and each worker carries the full memory footprint, so a 300 MB ML-laden app times eight workers is 2.4 GB before serving a request. Little's Law still bounds throughput (concurrency = throughput x latency): a 20-connection async pool with 10 ms hold time ceilings around 2000 RPS per pool regardless of worker count, so the database, not Python, is usually the real limit.

| Availability | Downtime per year | Downtime per 30 days |
|---|---|---|
| 99% | 3.65 days | 7.2 hours |
| 99.9% | 8.77 hours | 43.2 minutes |
| 99.99% | 52.6 minutes | 4.32 minutes |
| 99.999% | 5.26 minutes | 25.9 seconds |

As elsewhere, no single worker or process reaches three or four nines on its own; high availability comes from multiple replicas behind a load balancer with health-checked routing and zero-downtime rolling deploys, and the error budget (detailed in the scaling-foundations guide) is the number that governs how much risk each deploy may spend.

---

## Staff-level caveats and when to reach elsewhere

Offload heavy work, do not host it in the web process. CPU-bound tasks (image processing, report generation, ML inference) and slow background jobs belong on a task queue (Celery, Dramatiq, ARQ, or RQ) with separate worker processes, so the web tier stays responsive and scales independently. A web request that does 30 seconds of CPU work is an architecture mistake no amount of async fixes; the request should enqueue the job and return immediately, and the client polls or receives a webhook.

Three more caveats that read as senior. Typing is a discipline, not decoration: FastAPI leans on type hints for correctness, so run mypy or pyright in CI, because a wrong annotation produces a wrong schema and a wrong client. Dependency and environment management has consolidated on faster tooling (uv, Poetry) and pinned lockfiles; reproducible builds matter more in Python than in compiled ecosystems because so much is resolved at runtime. And observability should include OpenTelemetry traces plus a metric that catches the blocking-the-loop failure, since standard latency graphs alone will not tell you the loop is starved.

Close on framework framing. FastAPI is the right default for new Python APIs: async-native, type-driven, OpenAPI for free, excellent for I/O-bound microservices and as a serving layer in front of ML models. Reach for Django when you want a batteries-included monolith with an ORM, admin, and auth out of the box and your workload is request-response CRUD. Reach for a heavier or different runtime entirely when you are CPU-bound at the core and Python's per-request overhead and GIL make it the wrong tool, in which case the senior move is to push that hot path to a compiled service and keep FastAPI as the typed, well-documented edge.

---

## Common interview questions

These recur for any FastAPI or async-Python role. Most answers come back to the event loop and the GIL.

**WSGI versus ASGI?** WSGI is the synchronous interface (Flask, classic Django): one request occupies one worker until it returns, and concurrency comes from many workers or threads. ASGI is the async successor: it supports `async def` and an event loop, so one worker holds thousands of in-flight requests as long as each spends its time awaiting I/O rather than burning CPU. FastAPI is ASGI, run under Uvicorn.

**Explain the GIL and how it shapes scaling.** CPython's Global Interpreter Lock lets only one thread execute Python bytecode at a time, so threads give no parallel speedup for pure-Python CPU work; that is why you scale CPU across processes, one worker per core-ish. The nuance: the GIL is released during blocking I/O and inside many C extensions, so threads do help I/O-bound and native-compute work, and async sidesteps the GIL for I/O concurrency by using one thread and an event loop.

**When does FastAPI run a handler in a thread pool?** When you define it as plain `def` rather than `async def`, FastAPI runs it in a thread pool, off the event loop, so blocking calls inside it cannot stall the loop. An `async def` handler runs directly on the loop, so a blocking call inside it freezes every concurrent request.

**Describe the blocking-the-loop trap and how to fix it.** A synchronous blocking call (`requests.get`, `time.sleep`, a sync DB driver, heavy CPU) inside an `async def` handler blocks the whole event loop, so latency that is fine at low load collapses under concurrency. Three fixes: use async-native libraries (`httpx.AsyncClient`, `asyncpg`, `asyncio.sleep`) inside `async def`; or make the handler plain `def` so FastAPI threads it off the loop; or offload genuine CPU work to a thread/process pool or a task queue.

```python
# CPU work pushed off the loop instead of blocking it
result = await anyio.to_thread.run_sync(heavy_cpu_transform, data)
```

**What changed in Pydantic v2?** The core was rewritten in Rust, making validation 5 to 50 times faster. The API shifted too: `BaseSettings` moved to `pydantic-settings`, validators became `@field_validator`/`@model_validator`, `.dict()` became `.model_dump()`, and the inner `Config` class became `model_config`.

**How do you share an application-scoped resource like a connection pool?** Create it once in a `lifespan` context manager at startup and store it on `app.state`, then close it on shutdown; do not build it per request, or you exhaust connections under load. The `lifespan` manager replaces the deprecated `@app.on_event` hooks.

**How do you size worker count?** Because the GIL caps pure-Python CPU parallelism per process, run roughly one worker per core (a common start is `2 * cores + 1`, fewer for memory-heavy apps), and remember each worker carries the full memory footprint, so an ML-laden app times eight workers can be gigabytes before serving a request. The real throughput ceiling is usually the database pool, by Little's Law, not the worker count.

**How do you handle CPU-bound or slow background work?** Push it out of the web process onto a task queue (Celery, Dramatiq, ARQ) with separate workers, so the web tier stays responsive and scales independently. A request that does 30 seconds of CPU work is an architecture mistake no amount of async fixes; it should enqueue the job and return immediately.

**Contract-first or code-first OpenAPI?** FastAPI generates the OpenAPI schema from your type hints and Pydantic models, so code-first is the default and the docs never drift. For contract-first shops, keep a hand-authored spec as the agreed contract and verify the implementation against it in CI (schemathesis can fuzz the API against the spec). Either way the contract is enforced mechanically, and consumers generate typed clients from the published schema.

**Asyncio vs threading vs multiprocessing for instrument data collection?** At kilohertz detector rates the work is socket-wait dominated (I/O-bound), so asyncio gives the most concurrency per thread: one event loop holds thousands of in-flight reads simultaneously. The GIL is released during blocking I/O and inside NumPy, so it is not the bottleneck here. Use `asyncio.to_thread` with a `ThreadPoolExecutor` for NumPy array work alongside the event loop, because NumPy releases the GIL and worker threads get genuine parallelism. Reserve `ProcessPoolExecutor` (multiprocessing) for pure-Python CPU loops where the GIL cannot be released; it pays a pickling cost on every data crossing but removes the serialization constraint entirely.

**Why is the GIL not a problem for an I/O-bound scientific pipeline?** The GIL only serializes Python bytecode. Detector reads spend time in the kernel waiting for socket data: no bytecode runs, so no GIL is held, and hundreds of pending reads coexist in one event-loop thread. NumPy vectorized operations (FFT, reductions, array math) run inside C extensions that release the GIL, so a thread pool of NumPy workers runs genuinely in parallel with the asyncio loop and with each other. The GIL becomes a bottleneck only when the pipeline bottleneck shifts to a pure-Python CPU loop, which a well-designed instrument pipeline avoids by expressing the compute as NumPy operations or by pushing it to a process pool.
