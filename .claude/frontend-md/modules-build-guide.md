## How this fits

These three topics came up together for a reason: they are the module-and-build-ecosystem cluster, and they connect in a chain. The module format you write (CommonJS or ES Modules) determines whether a bundler can tree-shake your code. The bundler (Vite, and the Rust engine inside it) is what does that shaking and turns your modules into what ships. And npm dependency types are the packaging side of the same story, deciding what travels with your code and what the host provides. Understanding the chain, not just the three facts, is what reads as senior.

A note on freshness: this is the fastest-moving corner of the frontend stack, and the bundler story in particular changed in early 2026. Verify the current state close to any interview, since the specifics here will keep shifting.

---

## 1. CommonJS versus ES Modules, and which one tree-shakes

**What they are.** CommonJS (CJS) is Node's original module system: `require()` to import, `module.exports` to export. ES Modules (ESM) is the standardized system built into the language and the browser: `import` and `export`. Both load code from other files; the difference is when and how.

**The mechanism, which is the whole answer.** CommonJS is dynamic and synchronous. `require()` is an ordinary function call that can sit inside an `if`, take a computed path, or run anywhere in the file, and the exported shape is decided at runtime. ES Modules are static and asynchronous. Imports and exports must be top-level and are fixed at parse time, so a tool can read the source and know exactly what each module imports and exports without running it. Dynamic `import()` exists for the cases where you genuinely need runtime loading, but the static form is the default.

```js
// CommonJS: dynamic, resolved at runtime
const { debounce } = require('lodash')
if (condition) { const x = require('./maybe') }   // legal: require is just a call
module.exports = { foo }

// ES Modules: static, analyzable before running
import { debounce } from 'lodash-es'
export { foo }
// import must be top-level; the shape is known at parse time
```

**Why this decides tree-shaking.** Tree-shaking is dead-code elimination: a bundler dropping exports nobody imports. It works only when the bundler can prove an export is unused, and that proof requires static structure. ESM provides it, so a bundler can see that you imported `used` and never `unused`, and remove the dead one. CommonJS defeats it, because `require` is dynamic and the exports object is assembled at runtime, so the bundler cannot safely prove any part is unreachable and generally keeps the whole module.

```js
// utils.js (ESM)
export function used() { /* ... */ }
export function unused() { /* large, imported nowhere */ }

// app.js
import { used } from './utils.js'
// A bundler can prove `unused` is dead and drop it from the output.
// The CommonJS equivalent (module.exports = { used, unused }) usually ships
// both, because require() is dynamic and the module's shape is a runtime value.
```

So the direct answer to "which is more efficient for tree-shaking" is ES Modules, decisively, because static imports allow static analysis and dead-code elimination, while CommonJS's dynamic nature does not. The practical levers that follow: prefer the ESM build of a library when one exists (`lodash-es` over `lodash`), use named imports rather than importing a whole namespace, and mark a package `"sideEffects": false` in `package.json` so the bundler knows it can drop unused modules without breaking implicit setup code.

**The catch worth knowing.** Two more differences come up. ESM has live bindings while CommonJS copies values. An imported ESM binding is a live read-only view of the exporter's variable, so if the exporter mutates it, importers see the new value; a destructured `require` captures a snapshot at import time and never updates.

```js
// counter.js (ESM)
export let count = 0
export function inc() { count++ }

// app.js
import { count, inc } from './counter.js'
inc()
console.log(count)   // 1, ESM bindings are live
// const { count, inc } = require('./counter') would log 0: a value snapshot
```

And interop has sharp edges: ESM can import a CommonJS module (as a default import), but CommonJS cannot statically `require` an ESM module and must use dynamic `import()`. Node selects the mode by file extension (`.mjs` is ESM, `.cjs` is CommonJS) or the `"type"` field in `package.json`. Top-level `await` and `import.meta.url` are ESM only; `__dirname` and `__filename` are CommonJS only.

---

## 2. How Vite works, and why it is fast

The precise answer separates two things people conflate: the development server feeling instant and the production build being fast are different mechanisms.

**Why the dev server is instant: it does not bundle.** Traditional bundlers build the entire module graph before they can serve anything, so startup time grows with the size of the app. Vite does the opposite in development. It serves your source files over native ES Modules and lets the browser request them, transforming each file (TypeScript, JSX, a Vue SFC) on demand only when the browser actually asks for it. There is no upfront bundle, so the dev server starts in roughly constant time no matter how large the project is, and hot module replacement is precise because only the edited module is invalidated rather than a chunk rebuilt.

**Dependency pre-bundling.** There is one thing Vite does bundle in development: your `node_modules` dependencies, once, cached on disk. This exists for two reasons. First, many packages still ship CommonJS or have hundreds of internal files, and the pre-bundle converts them to ESM and collapses them into a few files, so importing one library does not trigger hundreds of separate browser requests. Second, it is a one-time cost the dev server then reuses.

**Why builds are fast: a Rust-native bundler.** For production you do want bundling, because shipping hundreds of separate module requests to real users is slow, and you want tree-shaking, minification, and code-splitting. The speed of that build comes from the bundler being written in a native language rather than JavaScript. The current state, as of Vite 8 in March 2026, is a single Rust bundler called Rolldown (built by VoidZero, the team behind Vite and Vue, using the Oxc compiler) that handles both the dev transforms and the production build, reported at 10 to 30 times faster than the previous production bundler.

```text
Before Vite 8 (versions 2 to 7): two bundlers
  development  ->  esbuild   (native speed, dev transforms and pre-bundling)
  production   ->  Rollup    (JavaScript, mature, flexible, slower)

Vite 8 (March 2026): one unified Rust bundler
  development and production  ->  Rolldown (+ Oxc compiler)
  faster builds, and no more "works in dev, breaks in prod" from two pipelines
```

So the full answer to "why is Vite fast at building bundles" is two-part. In development it is fast because it does not build a bundle at all, serving native ES Modules and transforming on demand, with dependencies pre-bundled once by a native tool. In production it is fast because the bundling is done by a Rust-native engine rather than JavaScript. The staff-level version of this answer names that distinction rather than waving at "Vite is fast," and notes that the dual-to-single bundler shift in Vite 8 also removed a class of dev-versus-production inconsistency bugs. The exact engine has changed more than once, so confirm the current one before you cite it.

---

## 3. npm dependencies: runtime, dev, and peer

The three buckets answer one question each: who needs this package, and when.

**`dependencies`: needed at runtime.** Packages your shipped code actually imports and runs, such as `vue`, `pinia`, or `axios`. When someone installs your package, these install with it transitively, because the code does not work without them.

**`devDependencies`: needed only to build, test, or develop.** Tooling that never runs in production, such as `vite`, `vitest`, `typescript`, `eslint`, and the `@types/*` packages. These are skipped by a production install (`npm install --omit=dev`) and, importantly, are not installed for someone who consumes your package as a dependency, because they only need your built output, not your toolchain.

**`peerDependencies`: provided by the host.** A package you expect the consuming project to already have, so you use its single shared instance instead of bundling your own copy. This is for libraries and plugins: a Vue component library declares `vue` as a peer, a Vite plugin declares `vite` as a peer. The consumer supplies it.

**When to use which.** For an application, the rule is simple: anything the running app imports goes in `dependencies`, anything that only builds or tests it goes in `devDependencies`, and you rarely need peers at all.

```json
// an application's package.json
{
  "dependencies": { "vue": "^3.5.0", "pinia": "^2.2.0", "axios": "^1.7.0" },
  "devDependencies": { "vite": "^8.0.0", "vitest": "^2.0.0", "typescript": "^5.6.0", "eslint": "^9.0.0" }
}
```

For a library, the framework it plugs into goes in `peerDependencies`, usually paired with the same package in `devDependencies` so you can build and test against it locally, while small helpers it genuinely owns and ships go in `dependencies`.

```json
// a Vue component library's package.json
{
  "peerDependencies": { "vue": "^3.5.0" },
  "devDependencies": { "vue": "^3.5.0", "vite": "^8.0.0", "vitest": "^2.0.0" },
  "dependencies": { "@floating-ui/vue": "^1.0.0" }
}
```

**The catch, which is the staff-level and design-system-relevant part.** Putting the framework in a library's `dependencies` instead of `peerDependencies` is a classic bug. Each consumer can then end up with its own copy of Vue alongside the app's copy, and two Vue instances break everything that relies on a single shared runtime: reactivity across the boundary, `provide` and `inject`, and the active component instance. The symptom is baffling, the cause is the dependency type, and the fix is making the framework a peer so the library uses the application's instance. This is precisely the kind of mechanism-level answer that survives probing, and it maps directly to a multi-brand design system where one shared framework instance across many consuming apps is non-negotiable.

A practical aside on why the runtime-versus-dev split matters beyond tidiness: a smaller `dependencies` set means a smaller production install, a faster and more reproducible CI, and a smaller supply-chain attack surface, since every production dependency is code you ship and must trust.

---

## 4. How to answer these in the room

All three reward the same move: give the mechanism, not the label. For modules, do not stop at "ESM is newer," explain that its static structure is what enables tree-shaking and that CommonJS's dynamic `require` is what prevents it. For Vite, do not stop at "it is fast," separate the no-bundle dev server from the Rust-native production bundler and name the tradeoff each makes. For dependencies, do not stop at "dev versus runtime," reach the peer-dependency case and the duplicate-instance bug it prevents, because that is the answer that shows you have actually shipped a library, not just installed one.

Each of these also connects to a decision elsewhere in the stack: ESM is why your bundle is small, the Rust bundler is why your build budget holds, and peer dependencies are why a shared design system stays a single instance across apps. Drawing those connections is the difference between reciting three facts and showing you understand the system they belong to.
