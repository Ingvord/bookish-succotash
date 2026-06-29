## How this round runs

You have 45 minutes with Benjamin covering coding and system design together, which is tight, so the design portion is likely 15 to 25 minutes and may grow directly out of the coding task. Treat them as connected: the component you code is often the seed of the system you then design.

This is frontend system design, and the distinction matters. Backend system design asks how to scale services and data across many machines. Frontend system design asks how to architect the client application: which rendering strategy, where state lives, how data is fetched and cached, how components compose, and how the whole thing performs and stays accessible at scale. You will reason across the client-server boundary, because you cannot design caching or data fetching without understanding the API, but the artifact you are designing is the frontend.

What Benjamin is evaluating is whether you drive the conversation: clarify the problem, structure an answer, make decisions with explicit tradeoffs, and go deep where he steers you. Listing technologies is not the signal. Reasoning about tradeoffs and failure modes is.

---

## 1. A framework to drive any frontend design question

Have a spine to structure the conversation so you never freeze on a blank prompt. A reliable one is requirements, architecture, data, interface, optimizations.

**Requirements.** Separate functional (what it does) from non-functional (how fast, which devices, what scale, accessibility, internationalization, offline). Clarify scope and constraints before designing anything, and restate them so the interviewer confirms you are solving the right problem. This step alone separates senior candidates from junior ones, because juniors start drawing immediately.

**Architecture.** The high-level component breakdown and the data flow between pieces. Draw it. A simple boxes-and-arrows sketch anchors the rest of the discussion.

**Data.** The client data model and, crucially, where each piece of state lives. Frontend state falls into four kinds, covered in section 5, and putting each in the right place is most of frontend architecture.

**Interface.** Two contracts. The server API your client consumes (endpoints, request and response shapes), and the component APIs between your own pieces (props, events, slots).

**Optimizations.** The deep dives: rendering strategy, caching, performance, accessibility, error handling, real-time. Spend the most time here and let the interviewer's interest steer which ones.

Throughout, state assumptions out loud and name tradeoffs rather than silently picking. "I will use cursor pagination here, which gives stable infinite scroll but makes jumping to page ten harder, and that tradeoff is fine for this feed" is the staff-level move.

---

## 2. Rendering strategy: the first architectural decision

Where a page renders shapes everything downstream, so decide it early and justify it. There are four strategies and the choice is a function of SEO needs, data freshness, interactivity, and infrastructure cost.

**Client-side rendering (CSR).** The server sends an empty shell and JavaScript builds the page in the browser. What it gives you: cheap hosting and rich interactivity. The catch: poor SEO and a slow first paint, because the user waits for the bundle to download and execute before seeing content. Right for authenticated dashboards behind a login, where SEO is irrelevant.

**Server-side rendering (SSR).** The server renders HTML per request, then the client hydrates it. What it gives you: fast first paint and full SEO with fresh data. The catch: server cost per request and hydration complexity, including hydration mismatches when the server and client render differently. Right for pages that need both SEO and current data, like a marketplace product page with live pricing.

**Static site generation (SSG).** Pages are rendered once at build time and served as static files. What it gives you: the fastest possible delivery from a CDN and trivial scaling. The catch: content is frozen until the next build, so it suits content that changes rarely. Right for marketing and documentation pages.

**Incremental or on-demand rendering (ISR).** A middle ground: static pages that regenerate on a schedule or on first request after invalidation. It gives near-static speed with bounded staleness, which fits a large catalog where pages change occasionally but rebuilding everything constantly is wasteful.

Modern refinements worth naming: streaming SSR sends HTML in chunks so the user sees content before all data resolves, and islands or partial hydration ship interactivity only for the components that need it, leaving the rest as static HTML.

For a B2B marketplace like this role, the likely answer is per-route: server-render or incrementally render the public catalog, company, and product pages for SEO and first paint, and client-render the authenticated dashboard where SEO does not matter. Nuxt lets you choose per route, so you are not forced into one mode for the whole app.

---

## 3. Routing modes: hash, history, and memory

Once you have chosen a rendering strategy, the routing mode is the paired decision: how a URL maps to a view, and what the server must do to support it. There are three modes, framework-agnostic in concept, and both Vue Router and React Router implement all three.

**Hash routing.** The route lives after a `#`, like `example.com/#/products`. What it gives you: it runs on any static host with zero server configuration, because the browser never sends the part after the hash to the server, so every request returns the same `index.html` and the client reads the hash to decide what to show. The catch: the URLs are ugly and effectively invisible to search engines and to the server, so you get no SEO and cannot server-render a specific route. Reach for it only when you cannot configure the server, such as a pure static file host or an embedded widget. Vue Router uses `createWebHashHistory`; React Router uses `HashRouter`.

**History (browser) routing.** Clean URLs through the HTML5 History API, like `example.com/products`. What it gives you: real, shareable, crawlable URLs and the ability to server-render each route. The catch, and the part interviewers probe, is that the server must return `index.html` for every client route, the SPA fallback, or a direct visit to or refresh of `/products` returns a 404, because the server looks for a file that does not exist. A server rewrite handles it.

```nginx
# history mode needs this, or deep links 404
location / { try_files $uri $uri/ /index.html; }
```

Use history mode for any real production single-page app. Vue Router uses `createWebHistory`; React Router uses `BrowserRouter`.

**Memory (server) routing.** The route is held in memory with no browser URL or history. What it gives you: routing where there is no address bar, namely server-side rendering and tests. Under SSR the server must resolve the route for an incoming request without a browser, so the router runs in memory, renders the matching component to HTML, and the client takes over with history routing once it hydrates. The catch: this is not a mode you pick for the browser; it is what the server uses under SSR, which frameworks like Nuxt wire up for you, and what you use in unit tests. Vue Router uses `createMemoryHistory`; React Router uses a memory or static router for the server.

```js
// Vue Router: one option selects the mode
import { createRouter, createWebHistory, createWebHashHistory, createMemoryHistory } from 'vue-router'

createRouter({ history: createWebHistory(),     routes })   // clean URLs, needs the SPA fallback above
createRouter({ history: createWebHashHistory(), routes })   // #/path, any static host, no server config
createRouter({ history: createMemoryHistory(),  routes })   // SSR and tests, no browser URL
```

The decision, and the staff-level move, is connecting the routing mode to the rendering strategy and the deployment configuration rather than treating it as an isolated flag. A server-rendered app uses memory routing on the server and history routing on the client after hydration. A normal production single-page app uses history routing and pairs it with the SPA fallback in the server config. A static-only deployment you cannot configure falls back to hash routing. Naming those connections is what separates knowing the API from understanding the system.

---

## 4. Data fetching and caching

The single insight that organizes this topic: server state and client state are different things and should be handled by different tools. Server state is data you do not own, fetched asynchronously, that can go stale and must be synchronized. Client state is data you own and control synchronously. Conflating them, for example storing fetched API data in a plain global store and managing loading and staleness by hand, is the most common frontend architecture mistake.

For server state, use a data layer built for it, such as TanStack Query (vue-query in a Vue app). It gives you caching keyed by the request, background revalidation, deduplication of in-flight requests, and a clear loading and error model, so you stop hand-rolling all of that in a store.

Caching has layers, and you should be able to name them. HTTP caching with `Cache-Control` and `ETag` lets the browser and CDN avoid redundant transfers; stale-while-revalidate serves cached content instantly and refreshes in the background. The client query cache holds fetched data keyed by query, so navigating back to a list is instant. Cache invalidation is the hard part: name your strategy, whether that is time-based expiry, explicit invalidation on mutation, or revalidation on focus.

Two patterns come up repeatedly. Optimistic updates apply a change in the UI immediately and roll back if the server rejects it, which makes an app feel instant, at the cost of handling the rollback correctly. Request cancellation prevents a slow earlier response from overwriting a newer one, the out-of-order response bug, which you fix with an AbortController per request. That last one bridges directly to the coding portion.

Pagination is an architecture choice. Offset pagination (page numbers) is simple and supports jumping to any page and SSR-friendly URLs, but it breaks when items are inserted mid-list. Cursor pagination is stable under insertion and ideal for infinite scroll, but cannot jump to an arbitrary page. State which and why.

---

## 5. State management at scale

Frontend state is four distinct kinds, and architecture is mostly about putting each in the right place rather than dumping everything into one global store.

**Local component state** is data only one component cares about, like whether a dropdown is open. Keep it in the component with `ref`.

**Shared client state** is data several components need that you own, like the current theme or a shopping cart. This is what Pinia is for.

**Server state** is fetched data, handled by the query layer from section 4, not by a plain store.

**URL state** is the one people forget, and it is the most powerful for this role. Filters, search terms, sort order, and the current page belong in the URL query string. Putting them there makes views shareable and bookmarkable, makes the browser back button work correctly, and gives you a single source of truth that survives a refresh. For a search and listing page, URL state is the backbone, not an afterthought.

The decision rule: ask who needs this state and how long it should live. One component and transient goes local. Many components and app-lived goes Pinia. Fetched from a server goes in the query cache. Should survive a refresh or be shareable goes in the URL.

---

## 6. Component architecture and the design system

Design components as contracts. Data flows down through props, changes flow up through events, and slots let a parent inject structure. A small, predictable surface is what makes a component reusable, and a forest of boolean flags is the smell to avoid: collapse `isPrimary`, `isSecondary`, `isGhost` into one `variant` union.

Separate components that hold data and logic from components that only render, the container and presentational split, so the rendering pieces stay reusable and testable in isolation.

For this role specifically, the multi-brand design system is a stated responsibility, so be ready to design one. Drive appearance from design tokens exposed as CSS custom properties, switch the token set per brand at a single theme boundary, and keep structure and behavior shared across brands. Scoped slots let each brand override how an item renders while the component keeps owning the structure, which is the seam that makes one system serve several brands without forking. Bake accessibility into the primitives so every consumer inherits it rather than reimplementing it.

---

## 7. Scaling the frontend across teams and codebases

The posting asks for consistency across many codebases, so expect a question about scale in the organizational sense.

The default answer is a monorepo with shared packages: the design system, utilities, and configuration live as versioned internal packages that every app consumes, so a token change or a lint rule propagates everywhere from one source. Consistency comes from shared tooling and shared primitives, not from documents people are asked to follow.

Micro-frontends come up as the scaling question's trap. They let independent teams deploy independently, which is genuinely useful when several teams own large, separable parts of a product on different release cadences. The cost is real: duplicated dependencies, runtime integration complexity, and the very consistency problem you were trying to solve. Name the cost and say that for most products a well-factored monorepo is simpler and better, and reach for micro-frontends only when team independence outweighs the integration tax.

Build performance and code splitting belong here too: route-level lazy loading keeps the initial bundle small, and a bundle budget enforced in continuous integration stops regressions before they ship.

---

## 8. Performance as an architectural concern

Treat performance as a design input, not a cleanup task. Anchor it to the Core Web Vitals as budgets: Largest Contentful Paint under 2.5 seconds, Interaction to Next Paint under 200 milliseconds, Cumulative Layout Shift under 0.1, at the 75th percentile of real users. Verify the current thresholds before the interview, since they shift.

The architectural levers: code splitting and route-level lazy loading to shrink the initial download, a performance budget in continuous integration to hold the line, responsive and lazy-loaded images, and avoiding layout shift by reserving space for media and dynamic content.

The lever most relevant to a B2B catalog is list virtualization. A search result set or a data table can hold thousands of rows, and rendering them all destroys performance. Virtualization (windowing) mounts only the rows currently visible plus a small buffer, keeping the DOM small regardless of result count (walked end to end in the large-image-gallery worked example below). Raise this proactively for any "design a list of many items" prompt.

Watch the network waterfall: fetch independent data in parallel rather than chaining requests, prefetch the likely next navigation, and avoid the pattern where each request waits for the previous one to discover what to fetch next.

---

## 9. Cross-cutting concerns

These are the deep dives that signal breadth when the interviewer probes.

**Internationalization.** This role is European and multi-brand, so locale handling is likely in scope. Cover locale in the URL or domain, translated message bundles loaded per locale, rendering the correct locale during SSR, and formatting numbers, dates, and currency with the `Intl` APIs rather than by hand. Mention awareness of right-to-left layouts.

**Accessibility at scale.** Semantic HTML first, ARIA only to fill gaps, keyboard operability, and focus management for overlays. The leverage point is baking it into the design system so every consumer inherits accessible primitives.

**Error handling and resilience.** Treat loading, empty, and error as first-class states for every async view, not afterthoughts. Use error boundaries so one failed component does not blank the page, retry with backoff for transient failures, and fallback UI that degrades gracefully when part of a page fails, such as results rendering even if the facets request fails.

**Observability.** Real user monitoring, web-vitals reporting, and error tracking such as Sentry, so you learn about problems from data rather than from complaints. Feature flags for safe rollout.

**Security.** Escape by default, treat `v-html` as the dangerous escape hatch and sanitize untrusted HTML, and add a Content Security Policy as defense in depth.

---

## 10. Worked example: design the product search and listing page

This is the most likely prompt for a B2B marketplace, so walk it end to end with the framework.

**Requirements.** Functional: a search box, faceted filters (category, location, attributes), a results grid, sorting, pagination or infinite scroll, and shareable result views. Non-functional: strong SEO for public pages, fast first paint, a large catalog with many concurrent users, accessible, and multi-language. Clarify the scale (tens of thousands of products) and confirm SEO matters, because that decides the rendering strategy.

**Architecture.** Sketch the component tree and data flow.

```text
URL  ?q=pumps&category=industrial&sort=relevance&page=2
     (single source of truth for the shareable view)
       |
       v
SearchPage             (route component, server-rendered on first load)
  |- SearchBar         debounced input, emits the query
  |- FilterPanel       facets fetched from the server, emits filter changes
  |- ResultsGrid
  |    \- ProductCard  (x N, only the visible window is mounted)
  |- Pagination / InfiniteScroll

Data flow on every query or filter change:
  update URL params  ->  query key changes
  data layer checks the cache:
     hit   -> render cached results, revalidate in background (SWR)
     miss  -> fetch /api/search, aborting any in-flight request first
  results render; the likely next page is prefetched
```

**Data.** Results and facets are server state, held in the query cache keyed by the full query (search term plus filters plus sort plus page), so revisiting a previous query is instant. Filters, sort, and page are URL state, so views are shareable and the back button works. Almost nothing needs a global store here, which is the point: most of this page's state belongs in the URL and the query cache, not in Pinia.

**Interface.** The server API is a search endpoint taking the query, filters, sort, and a cursor or page, returning results plus total count plus the facet counts, and possibly a separate facets endpoint. The component APIs: `SearchBar` takes the current query and emits changes, `FilterPanel` takes available facets and selected values and emits changes, `ResultsGrid` takes the result list, `ProductCard` takes one product, `Pagination` takes total and current page and emits navigation.

**Optimizations.** Server-render the first results page for SEO and fast first paint, then handle subsequent filtering with client fetches. Debounce the search input and cancel in-flight requests so a slow earlier response cannot overwrite a newer one. Virtualize the results grid so a large result set keeps the DOM small. Cache results by query key with stale-while-revalidate and prefetch the next page. Keep filters and sort in the URL for shareable, refresh-safe views. Announce result updates through an `aria-live` region and keep the filter controls keyboard operable. Localize content and format currency and numbers with `Intl`. Design the empty, error, and partial-failure states explicitly, so no results, a network error with retry, and a failed facets request that still shows results all behave well.

**Tradeoffs to voice.** Infinite scroll feels modern but hurts SEO and the back button, while numbered pages are shareable and crawlable, so for a public catalog lean toward pages or a hybrid. Server rendering costs more per request but is non-negotiable if these pages must rank. Aggressive client caching improves perceived speed but risks showing stale prices, so tune revalidation accordingly.

---

## 11. Worked example: typeahead, the bridge to the coding task

This smaller design connects directly to the coding portion, because in a combined round the coding task may be the typeahead and the design discussion extends it to production quality.

**Requirements.** Suggestions as the user types, fast, keyboard accessible, and correct under slow or out-of-order network responses.

**Design.** Debounce the input so you fetch on a pause rather than every keystroke, and enforce a minimum query length. Cancel the previous request with an AbortController on each new keystroke, which both saves work and fixes the out-of-order response bug where a slow earlier result overwrites a newer one. Cache recent queries client-side so backspacing is instant. Make it an accessible combobox: arrow keys to move through suggestions, Enter to select, Escape to close, with the right ARIA roles and an `aria-live` count. Handle the loading, empty, and error states. If you want to rank or highlight matches, mention it as an enhancement.

The bridge sentence to use in the room: "The debounce and cancellation we just coded are the core of this; making it production-grade adds the cache, the accessibility, and the loading and empty states."

---

## 12. Worked example: rendering a large image gallery

A gallery UI that must display thousands to millions of images, where source assets can be gigabytes, breaks in three independent ways under the naive approach. A `v-for` or `.map()` over 10,000 `<img>` nodes destroys the DOM. Setting `src` on all of them simultaneously saturates the network and browser memory. Decoding thousands of compressed images on the main thread freezes the UI. The same virtualization and lazy-load pattern that powers large scientific image galleries serving millions of users addresses each bottleneck separately.

### Virtual scrolling / windowing

The DOM bottleneck first. The browser holds every node in memory, runs layout on all of them, and paints them even when 9,900 are off-screen. Windowing fixes this by mounting only the nodes visible in the viewport plus a small buffer. Items above and below are replaced by a spacer element that preserves scroll height, so the browser never holds more than a few dozen `<img>` nodes regardless of total count.

The catch: you must supply item dimensions up front or measure them after render. Variable-height grids need a measurement pass that adds complexity. Windowing also removes off-DOM items from browser find-in-page and screen reader traversal, so state that tradeoff if the interviewer probes.

**React.** The modern choice is `@tanstack/react-virtual` (`useVirtualizer`), headless and framework-agnostic at its core. `react-window` is the well-known predecessor and is stable in maintained codebases; `react-virtuoso` is the alternative when variable heights are the main concern.

```js
import { useVirtualizer } from '@tanstack/react-virtual'
import { useRef } from 'react'

function ImageGallery({ images }) {
  const parentRef = useRef(null)
  const virtualizer = useVirtualizer({
    count: images.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 200,          // thumbnail height in px
    overscan: 5,                      // render 5 extra rows above/below viewport
  })

  return (
    <div ref={parentRef} style={{ height: '100vh', overflow: 'auto' }}>
      {/* Spacer: total height without rendering all items */}
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map(item => (
          <div
            key={item.key}
            style={{
              position: 'absolute',
              top: 0,
              transform: `translateY(${item.start}px)`,
              width: '100%',
              height: item.size,
            }}
          >
            <img src={images[item.index].thumbnailUrl} alt={images[item.index].title} />
          </div>
        ))}
      </div>
    </div>
  )
}
```

The `getTotalSize()` div is the spacer: it tells the browser how tall the scroll container would be if all items were rendered, without actually rendering any off-screen node.

**Vue.** `vue-virtual-scroller` is the idiomatic choice. `RecycleScroller` reuses a fixed pool of DOM nodes, swapping their content as items enter and leave, which reduces garbage collection overhead during fast scrolling. TanStack Virtual has a Vue adapter for API consistency across frameworks.

```vue
<template>
  <RecycleScroller
    class="gallery-scroller"
    :items="images"
    :item-size="200"
    key-field="id"
    v-slot="{ item }"
  >
    <img :src="item.thumbnailUrl" :alt="item.title" decoding="async" />
  </RecycleScroller>
</template>

<script setup>
import { RecycleScroller } from 'vue-virtual-scroller'
import 'vue-virtual-scroller/dist/vue-virtual-scroller.css'

defineProps({ images: Array })
</script>
```

`RecycleScroller` requires a fixed item height. For variable heights, use `DynamicScroller` paired with `DynamicScrollerItem`, which measures each item and feeds the heights back into the spacer math.

**ExtJS.** ExtJS has native windowing through `Ext.data.BufferedStore`. The buffered renderer fetches only the visible page plus a configurable lead and trail buffer, discarding pages outside the window, so the DOM stays small against a server-paginated dataset of any size.

```js
const bufferedStore = Ext.create('Ext.data.BufferedStore', {
  model: 'MyApp.model.Image',
  buffered: true,
  pageSize: 100,
  leadingBufferZone: 200,    // prefetch this many records ahead
  trailingBufferZone: 50,    // retain this many records behind
  proxy: {
    type: 'ajax',
    url: '/api/images',
    reader: { type: 'json', rootProperty: 'data', totalProperty: 'total' }
  }
})

Ext.create('Ext.view.View', {
  store: bufferedStore,
  itemTpl: '<div class="thumb"><img src="{thumbnailUrl}" alt="{title}" /></div>',
  deferInitialRefresh: true
})
```

The catch: the server must support offset or range pagination, because the buffered store fetches pages rather than holding the full dataset in memory.

**Webix.** The `dataview` component handles dynamic loading natively. Set `datafetch` to control how many items load per request and `loadahead` to preload ahead of the scroll position. No external library is needed.

```js
webix.ui({
  view: 'dataview',
  url: '/api/images',
  datafetch: 100,          // records per request
  loadahead: 200,          // prefetch this many records ahead of scroll
  template: '<div class="thumb"><img src="#thumbnailUrl#" alt="#title#" /></div>',
  type: { height: 200, width: 200 }
})
```

Webix renders only visible items and fetches adjacent pages on demand as the user scrolls. Dynamic loading is a built-in feature of `dataview` and `list`, not an add-on.

**Vanilla JS.** A hand-rolled virtualizer positions items absolutely, listens to scroll events, computes the visible range, and swaps the content of a recycled DOM node pool while adjusting the spacer height. It is feasible, but the libraries remove the hard parts: resize observer integration, variable-height measurement, and scroll momentum edge cases. Use a library in production.

### Lazy loading with IntersectionObserver

Even with windowing, the visible items must load their images without firing dozens of simultaneous network requests. `IntersectionObserver` is the browser's native mechanism: it fires a callback when an element crosses a threshold in the viewport, with zero scroll event listeners and zero manual position math. Attach an observer to each placeholder, swap in the real `src` when the callback fires, and call `unobserve` immediately after.

The catch: always call `unobserve` once `src` is set. Without it the observer keeps watching, fires again on scroll-out and scroll-back, and re-requests an image the browser already cached. Use `rootMargin` to start loading slightly before the item reaches the viewport, so there is no visible gap as the user scrolls.

```html
<!-- Placeholder: no src on initial render -->
<img class="lazy" data-src="https://cdn.example.com/thumb-42.jpg" alt="Sample image" />
```

```js
const observer = new IntersectionObserver(
  (entries) => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return
      const img = entry.target
      img.src = img.dataset.src     // swap in the real URL
      observer.unobserve(img)       // stop watching: prevents re-trigger on scroll-out
    })
  },
  { rootMargin: '200px' }           // load 200 px before entering viewport
)

document.querySelectorAll('img.lazy').forEach(img => observer.observe(img))
```

**Framework wrappers.** In React the observer lives in a `useEffect` that attaches on mount and cleans up on unmount. In Vue, a custom directive `v-lazy` is the idiomatic pattern: the `mounted` hook observes, `beforeUnmount` disconnects. In ExtJS, add observer logic in the view's item `afterrender` listener. In Webix, wire it in the `dataview`'s `onAfterRender` event: each time the component paints new items, observe the fresh `<img>` elements with their `data-src` values.

The `loading="lazy"` HTML attribute is the zero-JavaScript baseline: the browser natively defers off-screen image loading without any code. Use it as a sensible default on static content, but note it is only evaluated on initial parse, so it does not work reliably when a virtualizer recycles and repopulates DOM nodes dynamically.

### Lazy blob / proxy loading

For very large source assets, even the thumbnails can be heavy. A full-resolution image may be gigabytes; setting `src` on load for hundreds of items simultaneously saturates the network and exhausts browser memory. The pattern is to fetch a low-resolution proxy first and upgrade to full resolution only on explicit user request, keeping initial render fast and light.

The catch: `URL.createObjectURL` returns a `blob:` URL that lives in memory until you call `URL.revokeObjectURL`. Forgetting to revoke leaks a chunk of memory for every image the user browses. Revoke the proxy URL when it is replaced, and revoke any remaining URLs on component unmount.

```js
async function loadProxy(proxyUrl, imgElement) {
  const res = await fetch(proxyUrl)
  const blob = await res.blob()
  const blobUrl = URL.createObjectURL(blob)
  imgElement.src = blobUrl
  imgElement.dataset.blobUrl = blobUrl       // store for cleanup
}

async function upgradeToFullRes(fullResUrl, imgElement) {
  const prev = imgElement.dataset.blobUrl
  if (prev) URL.revokeObjectURL(prev)        // release proxy before replacing

  const res = await fetch(fullResUrl)
  const blob = await res.blob()
  const blobUrl = URL.createObjectURL(blob)
  imgElement.src = blobUrl
  imgElement.dataset.blobUrl = blobUrl
}

// Wire upgrade to an explicit user action
document.querySelectorAll('.gallery-item img').forEach(img => {
  img.addEventListener('click', () => upgradeToFullRes(img.dataset.fullSrc, img))
})
```

The `fetch`-based approach also applies when the server requires authorization headers that a plain `<img src>` cannot send. Fetch the protected resource with a token, create a blob URL from the response, and assign it to `src`.

### Thumbnail decode management

Setting `src` fires the network request, but the bottleneck does not end there. The browser must decode the compressed bytes (JPEG, WebP, AVIF) into a raw pixel buffer before painting. For a handful of images this is imperceptible. For hundreds of thumbnails loading simultaneously after a fast scroll, the decode work runs on the main thread and causes jank: dropped frames and a frozen UI.

There are three mitigations, each with a different tradeoff.

**`decoding="async"` attribute.** The simplest option: a hint to the browser to decode off the critical path. Browsers may or may not move decoding off the main thread depending on the implementation, so it is a hint, not a guarantee. Use it as a zero-effort baseline on all gallery images.

```html
<img src="thumb-42.jpg" alt="Sample" decoding="async" loading="lazy" />
```

**`img.decode()` promise API.** Create the image off-DOM, call `decode()`, and append it only after decoding completes. This ensures the image is ready before it enters the render tree, preventing a layout-blocking decode on insert. The catch: decoding still happens on the main thread, so the benefit is timing control rather than offloading. Wrap in `try/catch` because `decode()` rejects if the load fails.

```js
async function appendDecoded(src, container) {
  const img = new Image()
  img.src = src
  try {
    await img.decode()              // waits for decode; still on the main thread
    container.appendChild(img)     // no decode-on-insert jank
  } catch {
    container.appendChild(createPlaceholder())
  }
}
```

**`createImageBitmap()` in a Web Worker.** The only option that moves decode fully off the main thread. `createImageBitmap` is available inside workers: pass a `Blob` from a `fetch` response and it returns an `ImageBitmap` you can transfer back to the main thread and draw into a `<canvas>`. The catch: an `ImageBitmap` cannot be assigned to `<img src>`, so you render into a `<canvas>`, losing native `alt` text, image events, and lazy-loading attributes. Reserve this path for when profiling confirms main-thread decode is the measured bottleneck.

```js
// decode-worker.js: runs in a dedicated thread
self.onmessage = async ({ data: { id, blob } }) => {
  const bitmap = await createImageBitmap(blob)
  self.postMessage({ id, bitmap }, [bitmap])   // transfer (zero-copy), not copy
}
```

```js
// main.js
const worker = new Worker(new URL('./decode-worker.js', import.meta.url))

async function fetchAndDecode(src, canvas) {
  const res = await fetch(src)
  const blob = await res.blob()
  worker.postMessage({ id: canvas.id, blob }, [blob])   // transfer blob
}

worker.onmessage = ({ data: { id, bitmap } }) => {
  const canvas = document.getElementById(id)
  canvas.width  = bitmap.width
  canvas.height = bitmap.height
  canvas.getContext('2d').drawImage(bitmap, 0, 0)
  bitmap.close()                                         // release GPU memory
}
```

Start with `decoding="async"` on every image as a free win. Add `img.decode()` when you need precise control over when an image enters the DOM. Reach for the Worker + `createImageBitmap` path only after profiling identifies main-thread decode as the actual bottleneck.

### The through-line

Virtualize the list so the DOM holds only visible nodes. Lazy-load via `IntersectionObserver` so the network fetches images as they approach the viewport rather than all at once. For large source assets, fetch a low-resolution proxy first and upgrade only on demand, revoking blob URLs to contain memory. Move decode off the main thread: `decoding="async"` as the baseline, `img.decode()` for fine-grained timing, Worker plus `createImageBitmap` when profiling points to decode as the bottleneck. These four layers address the DOM, network, memory, and main-thread CPU bottlenecks independently. Large scientific image galleries serving millions of users are built on exactly this stack, and the same architecture applies any time you need to render more images than the browser can hold at once.

---

## 13. Enforcing patterns and best practices: worked examples

A best practice is only real if it is enforced. Stating a convention in a document relies on people remembering it; encoding it in tooling makes following it the default and violating it a failed build. That difference is what an interviewer probes for when you claim you raised standards, so be ready with the mechanism, not the intention. Below are five common frontend patterns, each as a small design plus the concrete enforcement. The through-line is identical: the mechanism runs as a required check in continuous integration, so a violation blocks the merge rather than relying on goodwill.

### Design tokens, not hardcoded values

**The practice.** Components reference design tokens exposed as CSS custom properties and never hardcode a colour or spacing value, so a brand or theme switch is a token swap rather than a code change. This is the backbone of a multi-brand design system.

**The design.** A shared component library (Button, Card, Input) consumed by two brand apps. Each brand defines a token set as CSS variables (`--color-primary`, `--space-md`), and components only ever read `var(--color-primary)`.

**The enforcement.** A stylelint rule bans raw colour and spacing literals, so the only way to style a component is through a token.

```json
{
  "rules": {
    "color-no-hex": true,
    "declaration-property-value-disallowed-list": {
      "/color/": ["/^#/", "/^rgb/", "/^hsl/"],
      "/^(margin|padding|gap|top|left|right|bottom)$/": ["/\\d+px/"]
    }
  }
}
```

Run `stylelint "src/**/*.{css,vue}"` as a required CI check. A pull request that hardcodes `#0a6b82` or `16px` fails the build, so the token discipline holds across every team without a reviewer catching it by eye.

### Module boundaries between features

**The practice.** Feature modules do not reach into each other's internals; a feature imports another only through its public entry point, and shared code never depends on a feature. This is what stops a codebase becoming a tangle where every change risks every feature.

**The design.** A dashboard structured as `src/features/{billing,users,reports}`, each exposing a public `index.ts`, plus `src/shared` for generic primitives. Billing may use `features/users` only via `users/index.ts`, never a deep path, and `src/shared` may not import any feature.

**The enforcement.** dependency-cruiser expresses the rules as readable forbidden relationships.

```js
// .dependency-cruiser.js
module.exports = {
  forbidden: [
    {
      name: 'shared-stays-generic',
      comment: 'Shared primitives must not depend on any feature.',
      severity: 'error',
      from: { path: '^src/shared' },
      to:   { path: '^src/features' },
    },
    {
      name: 'features-use-public-api',
      comment: 'Import another feature only through its index, never a deep path.',
      severity: 'error',
      from: { path: '^src/features/([^/]+)' },
      to:   { path: '^src/features/([^/]+)/.+', pathNot: '^src/features/$1/|index\\.ts$' },
    },
  ],
}
```

Run `depcruise src --config .dependency-cruiser.js` in CI. The boundary is now a property of the build, not a line in a wiki, so the architecture cannot quietly erode as teams move fast.

### Server state through the data layer, not ad-hoc fetches

**The practice.** Components never call `fetch` or an HTTP client directly. All server state flows through a typed data layer of query composables, so caching, deduplication, and error handling stay consistent everywhere. This is the architectural decision from section 4 made unbreakable.

**The design.** An `src/api` directory exposes composables like `useProductsQuery`, each wrapping the query client. Components import these and never touch the network themselves.

**The enforcement.** ESLint bans the network primitives inside component files.

```js
// eslint config, scoped to component files
{
  files: ['src/**/*.vue', 'src/components/**/*.ts'],
  rules: {
    'no-restricted-syntax': ['error', {
      selector: "CallExpression[callee.name='fetch']",
      message: 'Do not fetch in components. Use a query composable from src/api.',
    }],
    'no-restricted-imports': ['error', {
      paths: [{ name: 'axios', message: 'Import data composables from src/api, not axios.' }],
    }],
  },
}
```

A component that calls `fetch` or imports `axios` fails lint in CI, so the data layer stays the single source of truth for server state instead of slowly leaking back into components.

### Accessibility baked into the pipeline

**The practice.** Accessibility is a build requirement, not a manual audit. Components use semantic markup, and violations are caught automatically rather than discovered by a user.

**The design.** A form library (Input, Select, Checkbox) where every control has an associated label and the components ship accessible by default, so every consuming app inherits it.

**The enforcement.** A lint plugin catches markup-level issues, and an automated check catches rendered violations in tests.

```js
// eslint config
{ extends: ['plugin:vuejs-accessibility/recommended'] }
```

```js
// component test with axe
import { render } from '@testing-library/vue'
import { axe } from 'vitest-axe'
import Input from './Input.vue'

test('Input has no accessibility violations', async () => {
  const { container } = render(Input, { props: { label: 'Email' } })
  expect(await axe(container)).toHaveNoViolations()
})
```

Both the lint plugin and the axe test run in CI, so an input without a label or a button without an accessible name fails before merge rather than reaching a screen reader.

### Performance budgets enforced in CI

**The practice.** Bundle size and Core Web Vitals have hard budgets, so a regression fails a pull request instead of shipping and being noticed in production weeks later. This makes the performance discussion from section 8 a guarantee rather than an aspiration.

**The design.** A route-split application where the initial bundle has a fixed size budget and the key pages have Core Web Vitals targets.

**The enforcement.** size-limit guards the bundle, and Lighthouse CI asserts the vitals.

```json
// package.json
{
  "size-limit": [
    { "path": "dist/assets/index-*.js", "limit": "180 kB" }
  ]
}
```

```yaml
# CI pipeline (excerpt)
- run: npm run build
- run: npx size-limit          # fails if the bundle exceeds its budget
- run: npx lhci autorun        # fails if LCP, INP, or CLS breach their thresholds
```

A change that pushes the bundle over budget or regresses a vital fails the check, so performance is defended continuously rather than rescued in a panic later.

### The through-line

Every example ends the same way: the mechanism is a required status check, so a violation blocks the merge. That is what converts a best practice from an intention into a guarantee, and it is the concrete answer when an interviewer asks how you made a standard stick. You did not ask people to follow it; you made the build refuse anything else, and you can point to the check, the config, and the fall in violations as evidence. Notice too that each enforcement maps back to an earlier design decision (tokens to the design system, the data-layer rule to the state architecture, the budgets to performance), which is the difference between a pattern you named and a pattern you operationalized.

---

## 14. How to answer well in a combined 45-minute round

Budget the time. Spend two or three minutes clarifying requirements, about five on the high-level architecture and the rendering decision, and the rest on one or two deep dives the interviewer cares about. Do not attempt to cover everything; depth on what he asks beats shallow breadth.

Drive the conversation. Structure your answer out loud, sketch the boxes and arrows, decide with explicit tradeoffs, and check in with the interviewer, for example "I can go deeper on the caching strategy or the rendering choice, which is more useful to you." Because the round combines coding and design, connect the two: let the design grow from the code you wrote, or note how you would implement a piece you just designed.

The staff-level signal across all of it is the same one from the other guides: explain the mechanism, name the tradeoff, and connect a decision to the failure mode it prevents. A candidate who says "I will cache the results" is junior. One who says "I will cache by query key with stale-while-revalidate, accepting that prices may be briefly stale, and revalidate on window focus to bound that staleness" is the one who proceeds to the next level.
