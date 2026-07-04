## How to read what changed and what did not

Python moves slower than JavaScript's yearly edition cycle, but 3.14 (released October 2025) is a real inflection point: deferred annotation evaluation went from opt-in to default, template strings shipped, subinterpreters entered the standard library, and free-threaded builds went from experimental to officially supported. Frame your own instinct like this in the room: the syntax that used to signal seniority (understanding the GIL, knowing `%`-formatting) is table stakes now, and the topics that separate senior from staff are the data model, the concurrency model, and knowing precisely which recent changes are real versus still a proposal.

| Topic | Status | Why |
|---|---|---|
| `%`-formatting, `str.format()` | Faded | f-strings (3.6) and now t-strings (3.14) cover almost every case |
| `from __future__ import annotations` | Faded as of 3.14 | deferred evaluation is the default now (PEP 649/749), the import is a no-op |
| `typing.List`, `typing.Dict`, `Optional[X]` | Faded | builtin generics (`list[int]`) and `X \| None` (3.9/3.10) replaced them |
| "Python cannot do real threads" | Partly faded | free-threaded builds are officially supported (3.14, PEP 779), though most production code still runs the GIL build |
| The GIL as a scaling constraint | Evergreen, more nuanced | still the default build; still decides process versus thread versus async |
| Closures, scope (LEGB) | Evergreen | the late-binding loop trap still catches people |
| Descriptors and the data model | Evergreen, more central | dataclasses, ORMs, and Pydantic are all built on it |
| Context managers | Evergreen | resource safety is tested in nearly every round |

The sections below open with the object model, because everything else (mutability, closures, the data model) is a consequence of it, then move through the language features, then land on the flagship section: idiomatic implementations of the patterns actually asked in live coding.

---

## 1. The object model: names, references, and identity

Every value in Python is an object, and a variable is a name bound to an object, not a box that holds one. Assignment binds a name to whatever object is on the right; it never copies. Two names can point at the same object, and mutating through one name is visible through the other, which is the single most consequential fact in the language.

```python
a = [1, 2, 3]
b = a                # b is another name for the SAME list object
b.append(4)
a                     # [1, 2, 3, 4], both names see the mutation
```

`is` checks identity (are these the same object), and `==` checks equality (does `__eq__` say these are equal). They agree for immutable primitives most of the time, which is exactly what makes the disagreement a good puzzle. CPython caches small integers from -5 to 256 and some string literals as an implementation detail, not a language guarantee, so `is` can appear to work on small integers and silently stop working once you leave that range.

```python
x, y = 256, 256
x is y                # True, CPython reuses the cached int object
x, y = 257, 257
x is y                # False in most builds, two distinct objects
x == y                # True regardless, value equality does not care about identity
```

The catch to name explicitly: never use `is` for value comparison. Use it only for `None`, sentinels, and singleton checks, where identity is the actual question being asked.

---

## 2. Mutability, copying, and the default-argument trap

Immutable types (`int`, `float`, `str`, `tuple`, `frozenset`, `bytes`) cannot be changed in place, so "modifying" one always produces a new object. Mutable types (`list`, `dict`, `set`, most user-defined objects) can be changed in place, and that is exactly where sharing becomes dangerous.

The single most-asked gotcha in this territory is the mutable default argument. Default values are evaluated once, at function definition time, not on every call, so a mutable default is one object shared across every call that does not pass its own.

```python
def append_item(item, bucket=[]):    # bucket is created ONCE, when the function is defined
    bucket.append(item)
    return bucket

append_item(1)        # [1]
append_item(2)        # [1, 2], the same list object leaked across calls
```

The fix is to default to `None` and create the mutable value fresh inside the body.

```python
def append_item(item, bucket=None):
    bucket = [] if bucket is None else bucket
    bucket.append(item)
    return bucket
```

Dataclasses close this hole at the language level: `@dataclass` raises a `ValueError` if you write a mutable default directly, and forces you to use `field(default_factory=list)`, which runs the factory fresh per instance. Know that this is the same bug, just caught earlier.

Copying has the same shallow-versus-deep split as any language. `list(x)`, `x[:]`, and `copy.copy(x)` copy the top level only, so nested mutable objects stay shared between the original and the copy. `copy.deepcopy(x)` recursively clones everything, including cycles (it keeps a memo dict so it does not recurse forever on self-referential structures), but it is slower and cannot clone objects that hold external resources like open sockets or locks unless the class defines a `__deepcopy__` hook.

```python
original = {"a": 1, "nested": {"b": 2}}
shallow = original.copy()
shallow["nested"]["b"] = 99      # also changes original["nested"]["b"], shared reference

import copy
deep = copy.deepcopy(original)
deep["nested"]["b"] = 99         # original is untouched
```

---

## 3. Scope and closures: LEGB and the late-binding trap

Name resolution follows LEGB, checked in order: Local (the current function), Enclosing (any enclosing function), Global (the module), Built-in (`len`, `print`, and friends). A closure is a function that keeps access to names from an enclosing scope after that scope has returned, and like JavaScript, every nested function is a closure over its definition scope, not a special opt-in feature.

The trap is that closures capture the *name*, not the value at the moment of creation. A closure built inside a loop reads whatever the loop variable holds when the closure actually runs, which is normally the value left over after the loop finishes. This is Python's version of the `var`-in-a-loop trap.

```python
fns = [lambda: i for i in range(3)]
[f() for f in fns]              # [2, 2, 2], every lambda shares the same 'i' binding

fns = [lambda i=i: i for i in range(3)]   # fix: bind the CURRENT value as a default argument
[f() for f in fns]              # [0, 1, 2], defaults are evaluated at definition time
```

Assigning to a name inside a nested function makes that name local to the nested function for its entire body, even on lines before the assignment, which is a separate and equally common trap. `nonlocal` tells the nested function to rebind the enclosing function's variable instead of shadowing it, and `global` does the same for the module scope. Without one of these, an in-place-looking `count += 1` inside a closure raises `UnboundLocalError`, not the value you expected.

```python
def make_counter():
    count = 0
    def increment():
        nonlocal count      # without this, 'count += 1' below creates a new local and raises UnboundLocalError
        count += 1
        return count
    return increment
```

Comprehensions get their own scope in Python 3 (list, set, dict, and generator expressions all do), so a variable used inside one does not leak into, or clobber, an outer variable of the same name, unlike a plain `for` loop. The one exception: the iterable of the outermost `for` clause is evaluated in the enclosing scope before the comprehension's own scope starts.

---

## 4. The data model: what makes a class a class

Python's data model, the `__dunder__` methods, is the single most load-bearing feature for a staff conversation, because dataclasses, ORMs, and validation libraries are all thin layers over it.

The `__eq__`/`__hash__` contract is the one that bites people. If you define `__eq__` on a class, Python automatically sets `__hash__` to `None` unless you also define it, because equal objects are required to hash equally, and the default identity-based hash can no longer guarantee that once you have redefined what "equal" means. The result: your objects silently become unhashable, and you find out the first time someone puts one in a `set` or uses it as a dict key.

```python
class Point:
    def __init__(self, x, y): self.x, self.y = x, y
    def __eq__(self, other): return (self.x, self.y) == (other.x, other.y)
    # no __hash__ defined, so Point is now unhashable

{Point(1, 2)}    # TypeError: unhashable type: 'Point'
```

The fix is to define `__hash__` consistently with `__eq__`, or reach for `@dataclass(frozen=True)`, which generates both correctly for you.

The iterator protocol underlies every `for` loop and unpacking: an object is iterable if `__iter__` returns an iterator, and an iterator is anything with `__next__` that raises `StopIteration` when exhausted. `__getattr__` is called only when normal attribute lookup fails, the right hook for lazy attributes or proxies; `__getattribute__` intercepts *every* attribute access unconditionally, and referencing `self.anything` inside it without care recurses infinitely, so reach for `__getattr__` unless you specifically need to override the whole lookup.

`__slots__` removes the per-instance `__dict__` and replaces it with a fixed C-level slot layout, which meaningfully cuts memory when you have millions of instances and blocks accidental dynamic attributes as a side effect. The catch: it breaks straightforward multiple inheritance from more than one slotted base, and you must add `'__weakref__'` explicitly if anything needs a weak reference to your instances.

```python
class Point:
    __slots__ = ('x', 'y')
    def __init__(self, x, y): self.x, self.y = x, y

p = Point(1, 2)
p.z = 3    # AttributeError: no __dict__, no room for a new attribute
```

`@dataclass` is the modern idiom for plain data holders: it generates `__init__`, `__repr__`, and `__eq__` from annotated fields, `frozen=True` adds a correct `__hash__` and blocks reassignment, and `field(default_factory=...)` is the sanctioned escape from the mutable-default trap in section 2.

---

## 5. Iterators, generators, and laziness

A generator function (any function with `yield`) pauses at each `yield`, holding its full local state on a suspended frame, and resumes exactly there on the next `next()` call. This is far cheaper than building a list up front when you only need to walk the values once.

```python
def read_large_file(path):
    with open(path) as f:
        for line in f:
            yield line.strip()     # one line in memory at a time, never the whole file
```

`yield from` delegates iteration (and exception propagation) to a sub-generator or any iterable, which is how generator-based pipelines compose without manual loop-and-yield boilerplate. A generator expression, `(x * x for x in range(n))`, is lazy the same way: it produces values on demand rather than building the whole sequence, so use one whenever you only need a single pass, and reach for a list only when you need length, random access, or to iterate more than once.

`itertools` is the standard toolbox for lazy pipelines: `islice` for a lazy slice, `chain` to concatenate iterables without copying, `tee` to fan one iterator out into several independent ones. `groupby` is the one with a real gotcha: it only groups *consecutive* runs of equal keys, so ungrouped or unsorted input silently produces many small groups instead of the few large ones you expected. Sort by the grouping key first.

The exhaustion catch applies to every iterator, generator or otherwise: once consumed, it stays consumed. Iterating it again yields nothing, with no error, which is a real production bug when a generator is accidentally shared between two consumers or materialized twice.

```python
gen = (x * x for x in range(3))
list(gen)         # [0, 1, 4]
list(gen)         # [], already exhausted, silently
```

---

## 6. Decorators and descriptors

A decorator is an ordinary function that takes a callable and returns a replacement. `@decorator` above `def f` desugars to `f = decorator(f)`, applied exactly once, at definition time, not on every call. `functools.wraps` copies the original function's `__name__`, `__doc__`, and other metadata onto the wrapper; skip it and every decorated function's introspection, stack trace, and `help()` output shows `wrapper` instead of the real name.

```python
import functools, time

def timed(fn):
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        start = time.perf_counter()
        try:
            return fn(*args, **kwargs)
        finally:
            print(f"{fn.__name__} took {time.perf_counter() - start:.4f}s")
    return wrapper
```

Descriptors are the mechanism underneath `property`, `classmethod`, `staticmethod`, and most ORM field types. Any object placed on a *class* that defines `__get__` (and optionally `__set__`/`__delete__`) controls attribute access for every instance of that class. A descriptor that defines `__set__` (a "data descriptor") takes priority over the instance's own `__dict__`; one that only defines `__get__` does not, which is why plain methods can be shadowed by an instance attribute of the same name but a `property` cannot.

```python
class Celsius:
    def __set_name__(self, owner, name):
        self._name = "_" + name          # called automatically, gives the descriptor its own attribute name
    def __get__(self, instance, owner):
        return getattr(instance, self._name, None)
    def __set__(self, instance, value):
        if value < -273.15:
            raise ValueError("below absolute zero")
        setattr(instance, self._name, value)

class Weather:
    temp = Celsius()
```

This is exactly what `@property` compiles down to internally, which is why an ORM or a validation library can make a field look like a plain attribute while still validating or lazily loading behind the scenes.

---

## 7. Context managers and deterministic cleanup

`with` guarantees `__exit__` runs on the way out of the block, whether the block returns normally or raises, which is Python's answer to writing `try`/`finally` by hand for every file, lock, socket, or transaction.

```python
class Transaction:
    def __enter__(self):
        self.conn.begin()
        return self.conn
    def __exit__(self, exc_type, exc, tb):
        if exc_type is None:
            self.conn.commit()
        else:
            self.conn.rollback()
        return False    # False (or None) lets the exception propagate; True would silently swallow it
```

`contextlib.contextmanager` turns a generator function into a context manager without writing a class: everything before `yield` is `__enter__`, everything after is `__exit__`, and wrapping the `yield` in `try`/`except`/`else` is how you route the commit-versus-rollback decision.

```python
import contextlib

@contextlib.contextmanager
def transaction(conn):
    conn.begin()
    try:
        yield conn
    except Exception:
        conn.rollback()
        raise
    else:
        conn.commit()
```

`contextlib.ExitStack` is for a number of context managers that is not known until runtime, such as opening every file in a list, or building up cleanup steps conditionally as a function runs. Every context manager entered through the stack is exited in reverse order when the stack itself exits.

```python
with contextlib.ExitStack() as stack:
    files = [stack.enter_context(open(p)) for p in paths]
    # every opened file is closed, in reverse order, when the with-block exits
```

Async resources need the async variants, `__aenter__`/`__aexit__` and `async with`. The catch worth naming: there is no automatic bridge between the two. Wrapping an async resource in a plain `with` either fails outright or, worse, runs cleanup without awaiting it, so pick the async form end to end whenever the resource is async.

---

## 8. The type system today

Python's typing is dynamic and duck-typed at runtime, full stop. Annotations (`x: int`) are optional and, by themselves, do nothing at execution time; a type checker (mypy, pyright) or a runtime validator (Pydantic) is what turns an annotation into an enforced guarantee.

The 3.14 headline is deferred annotation evaluation becoming the default (PEP 649 and PEP 749). Historically, annotations were evaluated eagerly at function or class definition time, which broke straightforward forward references (a class annotated with itself, or two classes referencing each other) and forced the workaround of putting `from __future__ import annotations` at the top of every file, turning every annotation into an unevaluated string. In 3.14, annotations are evaluated lazily on first access instead, through a generated function rather than a stringified blob, so forward references just work, most new code does not need the future import at all, and `typing.get_type_hints` still resolves everything correctly whenever something actually inspects it. The one catch: code that depended on annotations running eagerly as a side effect at class-body time behaves differently now.

```python
class Tree:
    left: "Tree | None" = None      # in 3.14 the quotes and the future import are no longer required
    right: Tree | None = None
```

Builtin generics replaced the parallel `typing` hierarchy: `list[int]`, `dict[str, int]`, and `tuple[int, ...]` have worked directly since 3.9, no `typing.List` import needed, and `X | Y` (3.10) replaced `Optional[X]` and `Union[X, Y]` as the everyday union syntax. `typing.Protocol` (PEP 544) gives structural typing: a class satisfies a `Protocol` by having the right shape, with no explicit inheritance required, the same idea as a Go interface or a TypeScript structural type, and `@runtime_checkable` lets `isinstance` check for attribute presence (not full signatures) against one. `TypedDict` describes the shape of a plain dict at an API boundary without creating a real class. `Self` (3.11, PEP 673) types "an instance of whatever class this actually is," correctly through inheritance, replacing the older `TypeVar('T', bound=...)` workaround.

Reach the catch every time: none of this is enforced by the interpreter itself. `def f(x: int): return x` happily accepts a string at runtime; the annotation is a promise to tooling, not a guard.

---

## 9. Error handling: EAFP, exception groups, and the chain

Idiomatic Python favors EAFP (easier to ask forgiveness than permission) over LBYL (look before you leap): try the operation and catch the specific exception, rather than checking a precondition first. The reason is not style, it is correctness: a check and the operation it guards are rarely atomic, so a file can be deleted between an `os.path.exists` check and the `open` call that follows it. EAFP collapses that race to a single operation.

```python
# LBYL: two separate operations, a race between them
if key in d:
    value = d[key]

# EAFP: one operation, race-free, and the idiomatic choice
try:
    value = d[key]
except KeyError:
    value = default
```

`raise ... from ...` chains exceptions explicitly, setting `__cause__`, so a translated exception still carries the original traceback with an honest "the above exception was the direct cause" note. A bare `raise` inside an `except` block sets `__context__` implicitly, which is noisier and less intentional than stating the cause on purpose.

Exception groups (3.11, PEP 654) let code raise several unrelated exceptions from concurrent work as a single `ExceptionGroup` object, most notably from `asyncio.TaskGroup` (section 11). `except*` matches against the exceptions *inside* the group individually rather than matching the group as a whole, so different failure types can be handled separately even though they arrived together.

```python
try:
    async with asyncio.TaskGroup() as tg:
        tg.create_task(fetch_a())
        tg.create_task(fetch_b())
except* ValueError as eg:
    for e in eg.exceptions: log(e)
except* TimeoutError as eg:
    for e in eg.exceptions: schedule_retry(e)
```

Two catches worth naming out loud. A bare `except:` (not `except Exception:`) also catches `KeyboardInterrupt` and `SystemExit`, so it can swallow a user's Ctrl-C or block a clean shutdown. And a `return` (or `break`) inside a `finally` block silently discards any exception in flight, no warning, no traceback, which is one of the more surprising control-flow gotchas in the language.

---

## 10. Concurrency, briefly: the GIL, free threading, and subinterpreters

The mental model, restated at the language level rather than the tuning level: one process runs under the Global Interpreter Lock by default, so threads buy I/O concurrency but not CPU parallelism; `asyncio` gives cooperative single-thread concurrency through an event loop, the same conceptual shape as JavaScript's; `multiprocessing` buys real CPU parallelism at the cost of process startup and serializing data across the process boundary.

3.14 changed two things at the language level. Free-threaded builds (run as `python3.14t`, PEP 779) moved from experimental in 3.13 to officially supported, meaning a build that removes the GIL entirely is now a first-class option, at roughly 5 to 10 percent single-threaded overhead, though C extensions that have not yet been updated still force the GIL back on for that process. And `concurrent.interpreters` (PEP 734) brought subinterpreters into the standard library: multiple interpreters, each with its own GIL, running in one process and communicating over explicit channels rather than shared memory, a middle ground between the isolation of processes and the low overhead of threads.

For the GIL's tradeoffs in depth, the asyncio-versus-threading-versus-multiprocessing decision tree, and a worked `asyncio.Queue` producer-consumer pipeline, see the FastAPI backend guide; this section is deliberately about how the language models concurrency, not how to tune a service around it.

---

## 11. Idioms to implement: worker pools, caches, retries, and rate limits

This is the section that gets asked live. Each pattern below is a model implementation, paired with the anti-pattern it replaces and the reason.

**Bounded concurrency: an asyncio worker pool.** `asyncio.gather(*(worker(item) for item in items))` fires every coroutine at once, so ten thousand items means ten thousand concurrent sockets, DB connections, or rate-limited calls hitting whatever is on the other end simultaneously. A worker pool caps how many run at once while keeping the "start everything, wait once" shape.

```python
import asyncio

async def worker_pool(items, worker, limit):
    sem = asyncio.Semaphore(limit)

    async def run_one(item):
        async with sem:                 # blocks here once 'limit' workers are already inside
            return await worker(item)

    async with asyncio.TaskGroup() as tg:   # structured concurrency: waits for every task, collects every failure
        tasks = [tg.create_task(run_one(item)) for item in items]

    return [t.result() for t in tasks]
```

Key point: `TaskGroup` over `gather` also fixes an older footgun. With `gather`'s default `return_exceptions=False`, the first failure cancels the remaining tasks but returns before they have actually finished cancelling, so cleanup can still be running when your `except` block starts. `TaskGroup` waits for every child task to fully finish before propagating, and raises an `ExceptionGroup` with every failure instead of just the first one.

**Request cache with single-flight de-duplication.** `functools.lru_cache` is the default answer to "cache this," but it has a specific hole under concurrency: the check-and-store is not atomic across an `await`, so N concurrent calls for the same missing key can all miss the cache and all make the real call, the same thundering-herd bug the worker pool avoided, now at the cache layer. Single-flight fixes it: the first caller stores its in-flight future as the cache entry itself, so later callers for the same key await that future instead of starting a second call.

```python
import asyncio

class SingleFlightCache:
    def __init__(self):
        self._entries: dict[str, asyncio.Future] = {}

    async def get(self, key, fetch):
        if key in self._entries:
            return await self._entries[key]      # join the call already in flight, no new request

        future = asyncio.get_running_loop().create_future()
        self._entries[key] = future
        try:
            result = await fetch(key)
            future.set_result(result)
            return result
        except Exception as exc:
            future.set_exception(exc)
            raise
        finally:
            del self._entries[key]               # never cache a failure, and never hold the slot forever
```

Key point: plain `lru_cache` is still correct for pure, fast, synchronous functions, there is no `await` point inside for two callers to interleave on. Single-flight is specifically for async I/O, where two callers really can race.

**Retry with exponential backoff and jitter.** Real resilience against a flaky dependency, and jitter is the detail that separates a working retry from one that makes an outage worse: without it, every client that failed at the same moment also retries at the same moment, hammering the dependency in lockstep right as it is recovering.

```python
import asyncio, random

async def retry(fn, *, attempts=4, base=0.2, max_delay=5.0):
    for attempt in range(attempts):
        try:
            return await fn()
        except RetryableError:
            if attempt == attempts - 1:
                raise
            delay = min(max_delay, base * 2 ** attempt)
            await asyncio.sleep(delay + random.uniform(0, delay * 0.1))   # jitter breaks the lockstep
```

**Token-bucket rate limiter, and an LRU cache from scratch.** A token bucket refills continuously rather than resetting on a fixed window, which smooths bursts instead of allowing a spike right at every window boundary.

```python
import asyncio, time

class TokenBucket:
    def __init__(self, rate, capacity):
        self.rate, self.capacity = rate, capacity
        self.tokens = capacity
        self.last = time.monotonic()
        self._lock = asyncio.Lock()

    async def acquire(self):
        async with self._lock:
            now = time.monotonic()
            self.tokens = min(self.capacity, self.tokens + (now - self.last) * self.rate)
            self.last = now
            if self.tokens < 1:
                wait = (1 - self.tokens) / self.rate
                await asyncio.sleep(wait)
                self.tokens = 0
            else:
                self.tokens -= 1
```

An LRU cache built from scratch is the companion question, and `OrderedDict` is the right tool because it is a dict backed by a doubly linked list, giving O(1) move-to-end and pop-from-front, which is exactly the two operations an LRU needs.

```python
from collections import OrderedDict

class LRUCache:
    def __init__(self, capacity):
        self.capacity = capacity
        self._data: OrderedDict = OrderedDict()

    def get(self, key):
        if key not in self._data:
            return None
        self._data.move_to_end(key)         # mark as most recently used
        return self._data[key]

    def put(self, key, value):
        if key in self._data:
            self._data.move_to_end(key)
        self._data[key] = value
        if len(self._data) > self.capacity:
            self._data.popitem(last=False)  # evict the least recently used entry
```

Key point: `functools.lru_cache` already does this internally, so hand-rolling one in an interview is a signal that you understand the eviction mechanism, not a suggestion to replace the standard tool in production.

---

## 12. Python 3.14 features worth name-dropping

Knowing these signals that you have kept current, which staff postings ask for explicitly.

Template strings (PEP 750) add a `t"..."` prefix that looks like an f-string but produces a `Template` object holding the literal parts and interpolations unevaluated, rather than a finished string. A processing function decides how to render it, which is exactly the shape you want for auto-escaping HTML, safely parameterizing SQL, or building a small DSL. The catch: a t-string is not a drop-in replacement for an f-string; `print(t"hi {name}")` prints a `Template` repr, not "hi Ada", until something renders it.

```python
from string.templatelib import Template

def render_html(template: Template) -> str:
    parts = []
    for item in template:
        if isinstance(item, str):
            parts.append(item)
        else:
            parts.append(html_escape(str(item.value)))   # every interpolation escaped, injection-safe by construction
    return "".join(parts)

name = "<script>"
render_html(t"Hello {name}")    # "Hello &lt;script&gt;", safe by default
```

`match`/`case` (3.10) is worth a mention as structural pattern matching, not a value switch: it matches on shape, with guards, and destructures as it matches.

```python
match command.split():
    case ["go", direction] if direction in DIRECTIONS:
        move(direction)
    case ["look"]:
        describe_room()
    case _:
        print("unknown command")
```

Rounding out the current edition: `tomllib` (3.11) parses TOML natively, no third-party dependency needed to read `pyproject.toml`; `pathlib` remains the evergreen replacement for manual `os.path` string joining; exception groups and `except*` (section 9) are still worth naming as 3.11-and-later, not brand new, since interviewers sometimes assume they are newer than they are.

What is not shipped, so do not claim it: verify any feature you have only seen discussed against the current `docs.python.org/3.14/whatsnew` page before naming it, because a proposal under active discussion is not the same as a released feature, and claiming otherwise reads as exactly the stale-knowledge signal this guide is trying to help you avoid.

---

## 13. Predict-the-output puzzles

These test whether you reason about the mechanism, not whether you have memorized the syntax. Read the code, predict the output, then check.

```python
# Puzzle 1: the default-argument trap
def add(item, bucket=[]):
    bucket.append(item)
    return bucket

print(add(1))    # [1]
print(add(2))    # [1, 2], the same list object, shared across every call
```

```python
# Puzzle 2: closures capture the name, not a snapshot of the value
fns = [lambda: i for i in range(3)]
print([f() for f in fns])    # [2, 2, 2]
```

```python
# Puzzle 3: identity versus equality
a, b = 256, 256
print(a is b)     # True, small ints are cached (-5 to 256)
a, b = 257, 257
print(a is b)     # False in most builds, two distinct objects
print(a == b)     # True regardless, value equality never depends on identity
```

```python
# Puzzle 4: a generator runs exactly once
gen = (x * x for x in range(3))
print(list(gen))    # [0, 1, 4]
print(list(gen))    # [], already exhausted, no error
```

```python
# Puzzle 5: overriding __eq__ silently removes __hash__
class Pair:
    def __init__(self, a, b): self.a, self.b = a, b
    def __eq__(self, other): return (self.a, self.b) == (other.a, other.b)

{Pair(1, 2)}    # TypeError: unhashable type: 'Pair'
```

```python
# Puzzle 6: a return inside finally discards the in-flight exception
def f():
    try:
        raise ValueError("boom")
    finally:
        return "swallowed"

print(f())    # 'swallowed', the ValueError never propagates
```

```python
# Puzzle 7: assignment makes a name local for the whole function, retroactively
count = 0
def bump():
    print(count)      # UnboundLocalError, not 0
    count = count + 1
bump()
```

---

## 14. What staff-level actually demonstrates

The trivia filters candidates; it is not the goal. Above the senior line, interviewers want to see the mechanism explained, the tradeoff named instead of the rule recited, and a language detail connected to a failure mode you have actually debugged. When you hit one of these caveats, do three things: say what happens, say why the interpreter does that, and say where it bites in production. Do not just answer that a mutable default argument is a bug; explain that defaults are evaluated once at definition time, that the same list object is therefore reused across every call missing that argument, and that this is exactly the kind of leak that shows up as "why does this cache have entries from a request that never touched it."

Cross-reference rather than re-derive: point to the FastAPI guide for the GIL, the asyncio-versus-threading-versus-multiprocessing decision, and worker tuning under load, and to the data-libraries guide for NumPy and Pandas. This guide's job is the language underneath all of it, the object model, the data model, and the idioms you are expected to write cold.
