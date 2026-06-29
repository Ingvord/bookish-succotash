# Interview Question Bank: Coding + Frontend Knowledge

This is a preparation bank for the "coding + frontend knowledge questions" round. It pairs the questions an interviewer is likely to ask with what they are really testing, a concise answer, and code where it helps. It assumes the Visable Staff Frontend role: Vue, testing, large codebases, a multi-brand design system, SSR, and AI-assisted development. It complements the JavaScript deep-dive and the Vue guides rather than repeating them.

## How the hour usually runs

A 60-minute deep dive with live coding typically splits into a short warm-up, around 25 to 35 minutes of live coding on a shared editor, and the rest on knowledge and architecture discussion. The coding task is rarely an algorithm puzzle for a frontend role. It is usually a utility, an async problem, a small component, or "implement this browser or framework primitive." Two behaviors score more than raw speed: think aloud so they can follow your reasoning, and ask clarifying questions before you type. State your assumptions, start with the simplest correct version, then handle edge cases out loud.

---

## 1. Live-coding tasks, with model solutions

These are the ones that come up again and again. Practice typing them cold.

**Implement debounce and throttle, and explain the difference.** Debounce waits until activity stops, so it fires once after the last call plus a delay, good for search input and resize. Throttle fires at most once per interval during continuous activity, good for scroll and pointer move.

```js
function debounce(fn, delay) {
  let timer
  return function (...args) {
    clearTimeout(timer)
    timer = setTimeout(() => fn.apply(this, args), delay)
  }
}

function throttle(fn, interval) {
  let last = 0
  return function (...args) {
    const now = Date.now()
    if (now - last >= interval) {
      last = now
      fn.apply(this, args)
    }
  }
}
```

**Deep clone an object.** Lead with the built-in: `structuredClone` handles nested objects, arrays, `Map`, `Set`, `Date`, and cycles, but not functions or DOM nodes. Then implement it to show you understand cycles and own keys.

```js
function deepClone(value, seen = new WeakMap()) {
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return seen.get(value)          // break cycles
  const copy = Array.isArray(value) ? [] : {}
  seen.set(value, copy)
  for (const key of Reflect.ownKeys(value)) {
    copy[key] = deepClone(value[key], seen)
  }
  return copy
}
```

**Build a small event emitter (pub/sub).** Tests data structures and API design. Returning an unsubscribe function from `on` is the detail that signals maturity.

```js
class EventEmitter {
  #listeners = new Map()
  on(event, fn) {
    if (!this.#listeners.has(event)) this.#listeners.set(event, new Set())
    this.#listeners.get(event).add(fn)
    return () => this.off(event, fn)                   // unsubscribe handle
  }
  off(event, fn) { this.#listeners.get(event)?.delete(fn) }
  emit(event, ...args) {
    this.#listeners.get(event)?.forEach(fn => fn(...args))
  }
}
```

**Implement `Promise.all` from scratch.** Tests understanding of promises and ordering. The key points: preserve input order regardless of settle order, resolve only when the count hits zero, and reject on the first rejection.

```js
function promiseAll(items) {
  return new Promise((resolve, reject) => {
    const results = []
    let remaining = items.length
    if (remaining === 0) return resolve(results)
    items.forEach((item, i) => {
      Promise.resolve(item).then(
        value => { results[i] = value; if (--remaining === 0) resolve(results) },
        reject                                         // first rejection wins
      )
    })
  })
}
```

**Memoize a pure function.** Watch the cache key: `JSON.stringify` of arguments is the quick default, with the caveat that it fails on functions, cyclic args, and key order in objects.

```js
function memoize(fn, keyFn = (...args) => JSON.stringify(args)) {
  const cache = new Map()
  return function (...args) {
    const key = keyFn(...args)
    if (cache.has(key)) return cache.get(key)
    const result = fn.apply(this, args)
    cache.set(key, result)
    return result
  }
}
```

**Curry a function.** Demonstrates closures and `fn.length`.

```js
function curry(fn) {
  return function curried(...args) {
    return args.length >= fn.length
      ? fn.apply(this, args)
      : (...rest) => curried.apply(this, [...args, ...rest])
  }
}
```

**Flatten a nested array.** Mention the built-in `arr.flat(Infinity)` first, then show recursion.

```js
function flatten(arr) {
  return arr.reduce(
    (acc, item) => acc.concat(Array.isArray(item) ? flatten(item) : item),
    []
  )
}
```

**Implement an LRU cache.** A frequent staff-level task. A `Map` keeps insertion order, so the oldest key is `keys().next().value`, and re-inserting on access marks an entry most-recent.

```js
class LRUCache {
  #max
  #map = new Map()
  constructor(max) { this.#max = max }
  get(key) {
    if (!this.#map.has(key)) return undefined
    const value = this.#map.get(key)
    this.#map.delete(key); this.#map.set(key, value)   // mark most-recent
    return value
  }
  set(key, value) {
    if (this.#map.has(key)) this.#map.delete(key)
    this.#map.set(key, value)
    if (this.#map.size > this.#max) {
      this.#map.delete(this.#map.keys().next().value)  // evict least-recent
    }
  }
}
```

**Retry an async call with exponential backoff.** Real-world resilience, and a good place to mention jitter to avoid thundering herds.

```js
async function retry(fn, { retries = 3, base = 200 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (attempt >= retries) throw err
      const delay = base * 2 ** attempt + Math.random() * 100   // backoff + jitter
      await new Promise(r => setTimeout(r, delay))
    }
  }
}
```

**Implement a worker pool (bounded concurrency).** You have more items than you can process simultaneously: open sockets, API rate limits, DB connections. `Promise.all(items.map(fn))` fires everything at once and blows the limit; `for...of` with `await` is serial and wastes idle capacity. A worker pool sits in between: spawn N coroutines that share a cursor and each grab the next item after their previous `await` resolves. The pattern only helps I/O-bound work (for CPU-bound computation you need `worker_threads`).

```js
async function workerPool(limit, items, fn) {
  const results = new Array(items.length)
  let cursor = 0
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++          // safe: JS is single-threaded, no race
      results[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}
```

Key points to land: `cursor++` is atomic because only one coroutine runs at a time; results preserve input order regardless of completion order; workers self-throttle because a worker can only grab the next item after its `await` resolves; rejected jobs must also release their slot or the pool stalls. Common mistakes: polling with `while (active >= limit) await sleep(10)` (the `await` itself is the gate); unbounded `Promise.all`; and forgetting to attach `.catch()` before storing a promise in a variable, which Node flags as an unhandled rejection in that gap.

**Build a typeahead search that cancels stale requests.** This is the highest-value frontend coding task because it hides a real bug: a slow earlier response arriving after a newer one and overwriting it. `AbortController` cancels the in-flight request on each new keystroke, which fixes both the waste and the out-of-order overwrite.

```js
let controller
async function search(query) {
  controller?.abort()                       // cancel the previous request
  controller = new AbortController()
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`, {
      signal: controller.signal,
    })
    return await res.json()
  } catch (err) {
    if (err.name !== 'AbortError') throw err  // ignore intentional cancellations
  }
}
```

**Implement Vue-style reactivity.** A favorite for a Vue role, because it proves you understand what the framework does rather than just using it. The whole model is: track the running effect when a property is read, re-run those effects when it is written, using a `Proxy`.

```js
let activeEffect = null
function effect(fn) { activeEffect = fn; fn(); activeEffect = null }

function reactive(target) {
  const deps = new Map()
  return new Proxy(target, {
    get(obj, key) {
      if (activeEffect) {
        if (!deps.has(key)) deps.set(key, new Set())
        deps.get(key).add(activeEffect)        // track
      }
      return obj[key]
    },
    set(obj, key, value) {
      obj[key] = value
      deps.get(key)?.forEach(run => run())     // trigger
      return true
    },
  })
}
```

For Vue component katas (debounced search component, reusable input with `defineModel`, a Pinia store), see the Vue guide. Expect at least one to be done live in a sandbox.

---

## 2. JavaScript fundamentals they will probe verbally

These overlap with the JavaScript deep-dive guide, so here are the exact phrasings to expect, with the one-line hook for each. Explain the mechanism, not just the rule.

Expect: "What is a closure and where does it bite?" (functions retain their definition scope; stale closures and the `var` loop trap). "How is `this` determined?" (the call site, four binding rules, arrows capture lexically). "Walk me through the event loop." (sync stack, then drain all microtasks, then one macrotask, repeat). "What is the difference between `==` and `===`?" (coercion versus strict, and `Object.is` for `NaN` and signed zero). "How does prototypal inheritance work?" (the chain, and `class` as sugar over it). "What causes memory leaks in an SPA?" (timers, detached nodes, listeners, growing caches, and `WeakMap` plus `AbortController` as fixes).

---

## 3. Browser and rendering

**Describe the critical rendering path.** The browser parses HTML into the DOM and CSS into the CSSOM, combines them into the render tree, runs layout to compute geometry, then paints pixels, and composites layers. Render-blocking CSS and synchronous scripts delay first paint, which is why critical CSS is inlined and scripts are deferred.

**Reflow versus repaint, and layout thrashing.** A reflow (layout) recomputes geometry and is expensive, a repaint only redraws pixels for a style change like color. Layout thrashing is reading a layout property like `offsetHeight` and then writing a style in a loop, forcing the browser to recompute layout synchronously each iteration. The fix is to batch reads, then batch writes, and to animate only `transform` and `opacity`, which the compositor can handle without layout.

**`setTimeout` versus `requestAnimationFrame`.** `requestAnimationFrame` runs right before the next paint at the display refresh rate, so it is correct for animation, while `setTimeout` is untethered from the frame and causes jank.

**Event delegation, bubbling, and capturing.** Events flow down in the capture phase and back up in the bubble phase. Delegation attaches one listener on a common ancestor and inspects `event.target`, which scales to many or dynamic children and is the idiomatic way to handle lists.

```js
list.addEventListener('click', (e) => {
  const item = e.target.closest('li[data-id]')
  if (item) select(item.dataset.id)
})
```

**Why do frameworks use a virtual DOM.** Direct DOM mutation is slow and imperative. A virtual DOM lets the framework compute the minimal set of real changes by diffing, and lets you write declarative state-to-view code. Note that this is a tradeoff, and newer approaches such as Vue's Vapor mode and signal-based libraries skip the virtual DOM for less overhead.

---

## 4. CSS

**Explain the box model and `box-sizing`.** Width by default applies to the content box, with padding and border added outside it. `box-sizing: border-box` makes width include padding and border, which is why it is the common reset.

**How does specificity and the cascade decide a winner.** Specificity ranks inline, then id, then class, attribute, and pseudo-class, then element. Ties break by source order. `!important` overrides normal declarations and should be a last resort. Cascade layers now let you order groups of rules explicitly, which tames specificity wars in large codebases.

**Flexbox versus Grid.** Flexbox lays out along one axis and is right for components like toolbars and rows. Grid lays out in two dimensions and is right for page and section layout. They compose, with Grid for the macro structure and Flexbox inside cells.

**What creates a stacking context, and why does `z-index` not work sometimes.** Properties like `position` with a `z-index`, `opacity` below one, `transform`, and `filter` create a new stacking context. A child cannot escape its parent's context, so a high `z-index` does nothing if an ancestor sits lower in a separate context. That mismatch is the usual cause of "z-index not working."

**Modern CSS worth naming.** Container queries style by parent size rather than viewport, which is the real unlock for reusable components. The `:has()` parent selector, logical properties for internationalization, custom properties for theming, and cascade layers are all current and relevant to a multi-brand design system.

---

## 5. Accessibility

**What is your approach to accessibility.** Semantic HTML first, ARIA second. Native elements like `button`, `a`, `label`, and `nav` bring focus, keyboard behavior, and roles for free, so reach for ARIA only to fill gaps, since wrong ARIA is worse than none.

**How do you make a custom widget accessible.** It must be reachable and operable by keyboard, expose the right role and state, and manage focus. A modal traps focus while open, returns focus to the trigger on close, and closes on Escape. Dynamic updates announce through an `aria-live` region.

**Common failures interviewers check for.** Inputs without associated labels, images without meaningful `alt`, click handlers on non-interactive `div`s with no keyboard path, and insufficient color contrast against WCAG ratios.

---

## 6. Performance and Core Web Vitals

**Name the Core Web Vitals and their thresholds.** Largest Contentful Paint under 2.5 seconds for loading, Interaction to Next Paint under 200 milliseconds for responsiveness, and Cumulative Layout Shift under 0.1 for visual stability, each judged at the 75th percentile of real users. INP replaced First Input Delay in March 2024 and measures every interaction, not just the first. Some 2026 sources claim Google tightened LCP toward 2.0 seconds, so it is worth verifying the current number on web.dev, but 2.5 seconds is the long-standing answer.

**How do you fix each.** For LCP: server-side rendering, preloading the hero image, inlining critical CSS, and `font-display: swap`. For INP: break long tasks, defer non-critical JavaScript, and yield to the main thread, since INP is mostly a JavaScript-architecture problem. For CLS: set explicit width and height on images, videos, and ad slots, and reserve space for dynamic content.

**General frontend performance levers.** Code splitting and route-level lazy loading to shrink the initial bundle, tree shaking to drop dead code, responsive and lazy-loaded images, bundle analysis with a performance budget enforced in CI, and virtualization for long lists so the DOM holds only visible rows. Memory leaks matter here too, covered in the JavaScript guide.

**How would you render a gallery of 10,000+ images without freezing the browser?** The answer is three separate problems. The DOM, the network, and the decode pipeline each need their own mitigation, and the interviewer is checking whether you see all three independently.

Virtualize the list first: mount only the DOM nodes visible in the viewport. In React, `@tanstack/react-virtual` (`useVirtualizer`) is the modern choice; `react-window` is the stable predecessor. In Vue, `vue-virtual-scroller` (`RecycleScroller`) reuses a fixed DOM node pool. In ExtJS, a `Ext.data.BufferedStore` with the buffered renderer fetches and discards pages outside the visible window natively. In Webix, `view: 'dataview'` with `datafetch` and `loadahead` handles dynamic loading out of the box. A spacer element maintains scroll height without rendering off-screen nodes, so the browser never holds 10,000 `<img>` elements simultaneously.

Lazy-load images via `IntersectionObserver` so the network fetches only as items approach the viewport. Observe each placeholder, swap in `src` on intersection, and call `unobserve` immediately to prevent re-triggering on scroll-out. The `loading="lazy"` HTML attribute is the zero-JavaScript baseline for static content.

```js
const observer = new IntersectionObserver(
  entries => entries.forEach(entry => {
    if (!entry.isIntersecting) return
    entry.target.src = entry.target.dataset.src   // swap in real URL
    observer.unobserve(entry.target)              // stop watching, prevents re-fetch
  }),
  { rootMargin: '200px' }   // start loading 200 px before the viewport edge
)
document.querySelectorAll('img[data-src]').forEach(img => observer.observe(img))
```

For very large source assets, fetch a low-resolution proxy first and upgrade to full resolution only on explicit user request. Use `URL.createObjectURL` for the blob URL and `URL.revokeObjectURL` when you replace it, or you leak memory for every image browsed.

Move decode off the main thread: add `decoding="async"` to every gallery image as a free baseline, use `img.decode()` when you need to control the exact moment an image enters the DOM, and reach for `createImageBitmap()` in a Web Worker when profiling confirms main-thread decode is the measured bottleneck. The Worker path moves decoding fully off the main thread but requires drawing into a `<canvas>` rather than `<img>`.

The full per-framework treatment, including the Worker plus `createImageBitmap` decode path, is in the Frontend System Design guide worked example.

---

## 7. Networking and the web platform

**How does HTTP caching work.** `Cache-Control` sets freshness, so hashed static assets get `max-age` far in the future with `immutable`, while HTML gets `no-cache` so new deploys appear immediately. `ETag` enables revalidation: the browser sends `If-None-Match` and the server answers `304 Not Modified` when nothing changed.

**What is CORS and how do you resolve a CORS error.** The browser blocks cross-origin requests unless the server opts in with `Access-Control-Allow-Origin` and related headers. Non-simple requests trigger a preflight `OPTIONS` call the server must answer. The fix is server configuration, not a frontend change, and in development a dev-server proxy avoids it.

**REST versus GraphQL.** REST is simple, cacheable over HTTP, and can over- or under-fetch. GraphQL lets the client request exactly the fields it needs in one round trip, at the cost of more server complexity and harder HTTP caching. Choose by data shape and client diversity.

**Real-time transport choices.** Polling is simplest and wasteful, Server-Sent Events give one-way server-to-client streaming over HTTP, and WebSockets give full duplex for chat and collaboration. Pick the lightest one that meets the need.

**Client storage options.** Cookies travel with every request and suit auth tokens with `HttpOnly` and `SameSite`. `localStorage` and `sessionStorage` are synchronous string stores for small data, and IndexedDB is the asynchronous database for large or structured client data.

---

## 8. Build tooling and modules

These came up in a live round and are quick-fire knowledge checks. Give the mechanism in a sentence or two; the dedicated modules-and-build guide carries the depth.

**What is the difference between CommonJS and ES Modules?** CommonJS (`require` and `module.exports`) is dynamic and synchronous, resolved at runtime, so an import can be conditional or computed. ES Modules (`import` and `export`) are static and analyzable at parse time, asynchronous, with live bindings and strict mode by default. ESM is the standard in browsers and modern Node.

**Which is more efficient for tree-shaking, and why?** ES Modules, decisively. Tree-shaking is dead-code elimination, which requires the bundler to prove an export is unused, and ESM's static structure makes that provable. CommonJS's dynamic `require` and runtime-assembled exports do not, so unused CommonJS code generally ships. The levers: prefer a library's ESM build (`lodash-es` over `lodash`), use named imports, and set `"sideEffects": false`.

**Why is Vite so fast?** Two separate mechanisms, and naming the distinction is the senior answer. In development it does not bundle at all: it serves native ES Modules and transforms files on demand, so startup is near-constant regardless of app size, with dependencies pre-bundled once. In production it bundles with a Rust-native engine. As of Vite 8 (March 2026) a single Rust bundler, Rolldown, handles both dev and build, replacing the older esbuild-plus-Rollup split and reporting roughly 10 to 30 times faster production builds. Verify the current engine, since it has changed more than once.

**Difference between dependencies, devDependencies, and peerDependencies?** `dependencies` are needed at runtime and install with your package. `devDependencies` are build and test tooling, skipped by production installs and by consumers. `peerDependencies` are provided by the host so a single shared instance is used. The classic bug to mention: putting a framework like Vue in a component library's `dependencies` gives consumers a second Vue instance, which breaks reactivity and provide/inject; it belongs in `peerDependencies`.

---

## 9. Security

**How do you prevent XSS.** Never inject untrusted strings as HTML. Frameworks escape interpolated text by default, so the danger is the escape hatch: Vue's `v-html` and React's `dangerouslySetInnerHTML`. If you must render user HTML, sanitize it with a vetted library such as DOMPurify, and add a Content Security Policy as defense in depth.

```
Content-Security-Policy: default-src 'self'; script-src 'self'
```

**How do you prevent CSRF.** Mark session cookies `SameSite=Lax` or `Strict`, and for state-changing requests use anti-CSRF tokens or require a custom header that a cross-site form cannot set.

**Supply chain and dependencies.** Pin versions, commit the lockfile, audit dependencies, and treat a transitive package as code you ship, because it is.

---

## 10. Vue-specific knowledge

**How does Vue 3 reactivity work.** It wraps state in a `Proxy` that tracks which effect is running when a property is read and re-runs those effects when the property is written. That is the `reactive` and `effect` pair from the coding section, and `ref` is the same idea boxed for primitives.

**Composition API versus Options API, and why Composition at scale.** Options groups code by kind (data, methods, computed), which scatters one feature across the file as a component grows. Composition groups by feature and extracts reusable logic into composables, which is why it is the default for large components and a design system.

**Quick hits they may fire.** `:key` must be a stable id so the diff matches nodes correctly. `nextTick` waits for the DOM to flush after a state change. `provide` and `inject` distribute values like theme without prop drilling. Scoped slots let a consumer control rendering while the component owns structure, which is the seam a multi-brand design system needs. Pinia is the state library, with `storeToRefs` to keep reactivity when destructuring.

**SSR and hydration.** With Nuxt, the server renders HTML and the client hydrates it. A hydration mismatch happens when the client's first render differs from the server's, caused by browser-only branches, dates, or random values during render, so gate browser-only code behind `onMounted` or `import.meta.client`.

**Vue performance levers.** `v-once` for static subtrees, `v-memo` to skip re-render unless dependencies change, `shallowRef` for large objects you replace wholesale, `defineAsyncComponent` for lazy loading, and `KeepAlive` to cache toggled components.

---

## 11. Testing

**What is your testing strategy.** A pyramid: many fast unit tests, fewer integration tests, and a thin layer of end-to-end tests for critical user journeys. Heavy reliance on slow end-to-end tests is a smell.

**What do you test in a component.** Behavior through the public interface, meaning rendered output and emitted events, not internal refs or private methods. Testing internals makes refactors break tests that should not break.

**Tooling and pitfalls.** Vue Test Utils with `mount` or `shallowMount`, Vitest as the runner on a Vite project, and Cypress for end-to-end. Mock the network at the boundary, for example with MSW, rather than stubbing deep internals. Flaky tests usually come from real timers, unawaited async, or shared state, so use fake timers, await DOM updates, and isolate each test.

---

## 12. Architecture and design systems

This is where a staff candidate is really assessed. The posting asks for consistency across many codebases and a multi-brand design system, so expect open-ended design questions.

**How would you design a reusable component API.** Keep the surface small and predictable: props for input, events for output, slots for composition. Prefer composition over a forest of boolean flags, expose design tokens rather than hard-coded values, and document the contract. A component is a contract, and stability of that contract is what makes it reusable.

**How do you support multiple brands from one system.** Drive appearance from design tokens as CSS custom properties, switch the token set per brand at the theme boundary, and keep structure and behavior shared. Scoped slots and sensible defaults let each brand override rendering without forking the component.

**How do you keep many codebases consistent.** Shared packages in a monorepo for the design system and utilities, a single source of truth for tokens, shared lint and format and TypeScript config, and codemods for sweeping migrations. Consistency comes from tooling and shared primitives, not from documents people are asked to follow.

**How would you migrate a large legacy frontend.** Incrementally. Establish the target, carve a seam, migrate route by route or component by component behind a consistent interface, keep both running during the transition, and avoid a big-bang rewrite that stalls feature work. Your 18 years across Angular, Webix, and ExtJS is direct evidence you have done this under real constraints.

**When would you reach for micro-frontends.** Only when independent teams need independent deploy cadences on a large product, and you accept the cost in shared-dependency duplication, runtime integration, and consistency overhead. For most products a well-factored monorepo is simpler and better.

---

## 13. AI-assisted development

The posting explicitly wants a proven record of using AI to solve practical problems and improve team efficiency, so prepare a concrete, honest narrative rather than a slogan. Cover where you apply it (scaffolding, tests, refactors, exploring an unfamiliar API, reviewing diffs), how you keep it safe (treat output as a draft, lean on types and tests as guardrails, review every line you ship), and how it helped the team (faster onboarding to a codebase, less boilerplate, more time on design). The signal they want is judgment: you know what to delegate and what to verify, not that you accept whatever the model emits.

---

## 14. Staff-level and behavioral questions

Expect a few of these, and answer with specifics and tradeoffs.

"Tell me about the most complex project you owned end to end." Pick one long-running project, state the constraints, the decisions you made, and what you would change. "Describe a technical disagreement and how you resolved it." Show that you can disagree, then commit, and that you optimize for the outcome over being right. "How do you raise engineering standards on a team." Talk about shared tooling, review culture, and pragmatic standards that people actually adopt. "How do you decide between two approaches under time pressure." Show a framework: reversible decisions move fast, one-way doors get more rigor.

---

## 15. How to answer well

Three habits carry the round. Think aloud, because they are evaluating reasoning, not just the final answer. Ask before assuming, because clarifying the requirement is itself a senior signal. And connect each answer to a real failure mode you have seen, because lived experience explained calmly reads as more senior than reciting definitions. When you hit a caveat, say what happens, why the platform does that, and where it bites in production.
