# Prompt: Build a Technical Interview Guide Series (any domain)

Paste this entire file as your opening message in a fresh Claude conversation,
then add a line at the end naming the domain or role and which guide to build.
It is domain-agnostic: it works for any track (a language such as Node, Python,
Go, or Java; a discipline such as System Design, SRE, or Data Engineering; or a
single topic). It contains the visual build pipeline, the content method, and a
method for scoping the series to whatever domain you are given.

---

You are producing a series of deep, styled HTML reference guides for someone
preparing for a technical interview. Each guide is written as Markdown and
converted to print-ready HTML by a Node pipeline. Two things make these guides
good and you must honour both: the visual system (Steps 1 to 2) and the content
method (Step 3). Step 4 tells you how to adapt to the specific domain you are
given.

Work in the code-execution sandbox. Write files, run the build, validate, and
present the resulting HTML.

---

## Step 1: Set up the build pipeline

Run once in the working directory:

```
npm install markdown-it highlight.js
```

Create `build-guide.js` with exactly this content:

```js
// build-guide.js: Markdown to styled, syntax-highlighted HTML guide.
// INSTALL  npm install markdown-it highlight.js
// RUN      node build-guide.js

const fs   = require('fs')
const path = require('path')
const MarkdownIt = require('markdown-it')
const hljs = require('highlight.js')

// ---- CONFIGURE (set per guide) ----
const INPUT_MD    = 'REPLACE_INPUT'
const OUTPUT_HTML = 'REPLACE_OUTPUT'
const META = {
  kicker:   'REPLACE_KICKER',
  title:    'REPLACE_TITLE',
  subtitle: 'REPLACE_SUBTITLE',
  accent:   'REPLACE_ACCENT',
}
// -----------------------------------

const md = new MarkdownIt({
  html: true, linkify: true,
  highlight(str, lang) {
    let language = lang === 'vue' ? 'xml' : lang === 'ts' ? 'typescript' : lang
    const label = lang || ''
    try {
      if (language && hljs.getLanguage(language)) {
        const out = hljs.highlight(str, { language, ignoreIllegals: true }).value
        return `<pre><code class="hljs" data-lang="${label}">${out}</code></pre>`
      }
    } catch (_) {}
    return `<pre><code class="hljs" data-lang="${label}">${md.utils.escapeHtml(str)}</code></pre>`
  },
})

function buildCss(accent) {
  const soft = accent + '14'
  return `
:root {
  --ink: #1c1b19; --muted: #5f5c55; --paper: #ffffff;
  --accent: ${accent}; --accent-soft: ${soft};
  --rule: #e7e3da; --code-bg: #f6f8fa; --code-border: #e1e6ea; --code-tag: #eef1f4;
}
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--paper); color: var(--ink);
  font-family: "Newsreader", Georgia, "Times New Roman", serif;
  font-size: 18px; line-height: 1.72;
  print-color-adjust: exact; -webkit-print-color-adjust: exact; }
.wrap { max-width: 52rem; margin: 0 auto; padding: 3.5rem 1.6rem 6rem; }
.doc-header { border-bottom: 3px solid var(--ink); padding-bottom: 1.4rem; margin-bottom: 2.6rem; }
.kicker { font-family: "JetBrains Mono", ui-monospace, monospace; font-size: .7rem;
  letter-spacing: .2em; text-transform: uppercase; color: var(--accent); }
h1 { font-family: "Fraunces", Georgia, serif; font-weight: 600; font-size: 2.7rem;
  line-height: 1.08; margin: .5rem 0 0; letter-spacing: -.015em; }
.doc-header .sub { color: var(--muted); font-size: 1.02rem; margin-top: .85rem; line-height: 1.55; }
h2 { font-family: "Fraunces", Georgia, serif; font-weight: 600; font-size: 1.72rem;
  margin: 3.2rem 0 1rem; padding-bottom: .42rem; border-bottom: 1px solid var(--rule); letter-spacing: -.01em; }
h3 { font-family: "Fraunces", Georgia, serif; font-weight: 600; font-size: 1.22rem; margin: 2.1rem 0 .55rem; }
p { margin: 0 0 1rem; }
a { color: var(--accent); text-decoration: none; border-bottom: 1px solid var(--accent-soft); }
strong { font-weight: 650; color: #141312; }
ul, ol { margin: 0 0 1rem; padding-left: 1.3rem; }
li { margin: .25rem 0; }
hr { border: none; border-top: 1px solid var(--rule); margin: 2.6rem 0; }
code { font-family: "JetBrains Mono", ui-monospace, "SFMono-Regular", monospace;
  font-size: .84em; background: var(--code-bg); border: 1px solid var(--code-border);
  border-radius: 4px; padding: .06em .34em; color: var(--ink); }
pre { position: relative; margin: 1.1rem 0 1.5rem; background: var(--code-bg);
  border: 1px solid var(--code-border); border-left: 3px solid var(--accent);
  border-radius: 8px; padding: 1rem 1.15rem; overflow-x: auto; }
pre code.hljs { background: transparent; border: none; padding: 0; color: #24292e;
  font-size: .8rem; line-height: 1.6; display: block; }
pre code[data-lang]:not([data-lang=""])::before {
  content: attr(data-lang); position: absolute; top: 0; right: 0;
  font-family: "JetBrains Mono", monospace; font-size: .58rem; letter-spacing: .12em;
  text-transform: uppercase; color: var(--muted); background: var(--code-tag);
  border: 1px solid var(--code-border); border-top: none; border-right: none;
  border-bottom-left-radius: 6px; padding: .22em .6em; }
table { border-collapse: collapse; width: 100%; margin: 1.3rem 0; font-size: .86rem; }
th, td { border: 1px solid var(--rule); padding: .5rem .68rem; text-align: left; vertical-align: top; }
th { background: var(--accent); color: #fff; font-family: "JetBrains Mono", monospace;
  font-size: .66rem; letter-spacing: .04em; text-transform: uppercase; font-weight: 500; }
tbody tr:nth-child(even) { background: #faf9f6; }
td code { font-size: .84em; }
@page { margin: 16mm; }
@media print {
  body { font-size: 10.5pt; }
  .wrap { max-width: none; padding: 0; }
  * { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
  a { color: var(--ink); border: none; }
  pre code.hljs { white-space: pre-wrap; word-break: break-word; }
  pre, table { break-inside: auto; }
  tr { break-inside: avoid; }
  h1, h2, h3 { break-after: avoid; }
}
`
}

function buildHtml(meta, cssBody, hlTheme, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${meta.title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Newsreader:opsz,wght@6..72,400;6..72,500;6..72,600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
${hlTheme}
${cssBody}
</style>
</head>
<body>
<div class="wrap">
  <header class="doc-header">
    <div class="kicker">${meta.kicker}</div>
    <h1>${meta.title}</h1>
    <div class="sub">${meta.subtitle}</div>
  </header>
  <main>
${bodyHtml}
  </main>
</div>
</body>
</html>`
}

const src     = fs.readFileSync(INPUT_MD, 'utf8')
const hlTheme = fs.readFileSync(path.join('node_modules','highlight.js','styles','github.css'), 'utf8')
const html    = buildHtml(META, buildCss(META.accent), hlTheme, md.render(src))
fs.writeFileSync(OUTPUT_HTML, html, 'utf8')
console.log(`Written ${html.length} bytes to ${OUTPUT_HTML}`)
```

---

## Step 2: Per-guide config and accent palette

Replace the four REPLACE_ placeholders before each build.

| Placeholder | Value |
|---|---|
| REPLACE_INPUT | markdown filename, e.g. `'runtime.md'` |
| REPLACE_OUTPUT | html filename, e.g. `'runtime.html'` |
| REPLACE_KICKER | label, e.g. `'Interview Preparation · <your domain>'` |
| REPLACE_TITLE | the h1 title |
| REPLACE_SUBTITLE | one sentence under the title |
| REPLACE_ACCENT | a hex from the palette below |

Give each guide a distinct accent so the set is easy to tell apart. Available
colours (all pass AA contrast on white): teal `#0f6e62`, terracotta `#b0502f`,
indigo `#33408c`, deep cyan `#0a6b82`, plum `#6b3585`, forest `#2d6a44`,
burgundy `#8a2436`, slate `#2e5280`, amber `#7a5500`. Note which you use as you go.

---

## Step 3: The content method (this is what creates the depth)

These principles are domain-independent and matter more than the styling.

**Write to the moment of use.** Every guide serves a person about to sit a
specific interview. Organise around their situation, not the abstract topic.
Carry sections like "what they are really testing" and "how to frame it in the room."

**Use the section arc.** Order each guide: framing (orient the reader), mental
model (the one reframe that makes it click), mapping (connect new to known),
depth (the cookbook and details), practice (drills, predict-the-output, worked
problems), meta (how to apply it, how to frame it). Not every guide needs all
six. Use `##` for sections, `###` for sub-sections, never deeper. Separate
sections with `---`. Start the Markdown at the first `##`; the title comes from META.

**Reach the catch on every concept (what, why, catch).** For anything worth
covering, state plainly what it is, explain why it matters or how the mechanism
works, then name the catch: the gotcha, tradeoff, or where it bites in
production. Surface content stops at "what." Trusted content always reaches the
catch. If a paragraph only states what something is, keep going.

**Prose first, examples as proof.** Every code block or diagram earns surrounding
prose that would teach the point even if the example were deleted. Comments are
pointers, not explanation. Lead each paragraph with the answer, then the example.

**Concrete over abstract.** Replace "can cause performance issues" with the
mechanism and the symptom. Use runnable code or concrete numbers, name tradeoffs
explicitly, and run one example through a comparison so only the variable under
study changes. Use mapping tables to anchor the unfamiliar to the familiar.

**Calibrate depth.** Spend the depth budget on the few load-bearing ideas (the
ones that recur, that interviewers probe, that cause the worst bugs or outages).
Summarise the rest and cross-reference other guides instead of duplicating.

**Honesty is a feature.** State what is out of scope. Verify present-day facts
rather than asserting from memory (see Step 4). Distinguish faded from evergreen
where the field moved. A short honest caveat beats stale confidence.

**Tone.** Peer to peer, warm, direct, no fluff, no condescension. Lead with the
answer; keep caveats short and after the point. No em dashes anywhere; use
commas, colons, or parentheses. Active voice, plain words.

**Pre-flight check before presenting each guide:** opens on the reader's moment
of use; follows the arc; every concept reaches the catch; every example has
teaching prose; vague claims replaced with mechanism plus symptom; depth on the
load-bearing ideas, rest brief; honest scope and verified facts; faded versus
evergreen noted; leads with the answer; no em dashes; a distinct accent.

---

## Step 4: Adapt to the target domain

You will be given a domain or role. It might be a language and level (for example
Staff Backend Node, Senior Python, Staff Go), a discipline (System Design, SRE,
Data Engineering, Security, Mobile), or a single topic. Derive the right series
yourself; do not expect a detailed plan to be handed to you.

### Verify present-day facts first (every domain)

Versions, defaults, and anything described as "current" drift constantly. Before
writing version-specific or "what is standard now" content, search to confirm it:
the current language or runtime version and its LTS, the dominant framework and
tooling versions, current best practices, and any metric, limit, or threshold you
cite. Seed nothing from memory that could have changed since your training cutoff.

### How to scope a series for any track

1. List the competency areas the interview actually tests for this role and level.
   For an engineering language track these are usually: language and runtime
   fundamentals; the dominant framework or ecosystem; data and persistence; the
   concurrency or async model; system design and architecture; testing. For a
   discipline track (system design, SRE, data engineering) they are usually: the
   building blocks; the recurring patterns; a set of worked problems; and a
   process guide for driving the interview.
2. Map each major area to one guide. Aim for four to six.
3. Always include one coding-and-knowledge question bank guide, with live tasks
   plus knowledge questions in a "question, what they are testing, concise answer,
   example" shape.
4. Give each guide a distinct accent and note which you used.

If only a domain is named with no specific guide, propose the four-to-six guide
set first and build on confirmation. If a single guide is named, build it directly.

### Single-language deep-dive guides

When the request is a deep dive on one language (for example "a TypeScript guide",
"a Rust guide", "a Go guide"), follow the Language Deep-Dive Blueprint, which
defines the content categories such a guide covers and how each shifts by language
family. If that companion file is provided, use it in full. If it is not, apply its
categories from this condensed checklist, which is language-agnostic; allocate the
depth budget to the categories that are load-bearing for the language's family
(ownership for systems languages, the type system for gradually typed ones, the
concurrency model and GC for managed ones, and so on), and verify the current
version, edition, and toolchain by searching before writing anything version-specific:

```text
A  Execution and mental model      how the language actually runs (open here)
B  Type system                     static/dynamic, structural/nominal, inference, generics, nullability
C  Memory and resource management  GC vs ownership vs manual; value/reference; the cleanup idiom
D  Error handling                  exceptions vs result types vs error values; propagation ergonomics
E  Concurrency and async           primitives, the memory/visibility model, the classic bugs
F  Core language features          idiomatic features, each as a snippet plus what-why-catch
G  Patterns to implement           4 to 7 idiomatic ones (worker pool over a stream, retry, LRU,
                                    rate limiter, iterator pipeline, resource guard), each with its anti-pattern
H  Standard library and ecosystem  the batteries and the de-facto libraries, curated
I  Tooling lifecycle               deps, project structure, local dev, build model, testing, CI/CD, profiling
J  Performance and tradeoffs       the cost model and "when to choose this language, when not"
K  Security and safety pitfalls    the language-specific footguns plus supply chain
L  Interop and boundaries          FFI, embedding, WASM (include only where it is real)
M  Versioning and what is current  editions, recent changes, faded vs evergreen (verify by search)
N  Gotchas and predict-the-output  small programs that test the mechanism, with worked answers
O  Meta closer                     give the mechanism, name the tradeoff, connect to the failure mode
```

The flagship of category G is a bounded-concurrency worker pool over a stream or
cursor, because the same problem looks completely different and completely
idiomatic in each language, which exposes the concurrency model directly. Confirm
whether the guide is for interview preparation (the default) or learning, since
the same blueprint emphasizes different categories for each.

### Code fence language tags

Tag every fenced block with the language so it highlights; use whatever fits the
domain. Common tags: `js`, `ts`, `python`, `go`, `java`, `kotlin`, `rust`, `sql`,
`yaml`, `json`, `xml`, `properties`, `bash`, `dockerfile`, `groovy`, `html`,
`css`, `text`. The script maps `vue` to xml and `ts` to typescript; highlight.js
handles the rest by name. For diagrams or sample output with no language, use `text`.

### Illustrative guide sets (examples only, adapt to the real domain)

These show the shape. Do not copy one blindly; derive the set that fits the domain
you are actually given.

- Backend Node and TypeScript: the runtime (event loop, async and promises,
  modules, the type system); the framework (Nest, Fastify, or Express); data (SQL
  and an ORM, Redis); streams and performance; distributed systems and API design;
  coding and knowledge question bank.
- Backend Python: the language (data model and dunder methods, typing, generators,
  the GIL); the framework (FastAPI or Django); data (ORM and SQL); concurrency
  (asyncio, threads versus processes, the GIL in practice); distributed systems;
  coding and knowledge question bank.
- System design: fundamentals (estimation, latency numbers, scaling, CAP);
  building blocks (databases, caching, queues, load balancers, CDNs); patterns
  (sharding, replication, consistency, idempotency, the outbox); worked problems
  (design a URL shortener, a news feed, a rate limiter); a process guide for
  driving the room (requirements, API, data model, scale, tradeoffs).

---

## Step 5: Build, validate, present

For each guide: write the Markdown file, set the four REPLACE_ values in
`build-guide.js`, run `node build-guide.js`, then sanity-check the output:

```js
const h = require('fs').readFileSync('OUTPUT.html', 'utf8')
console.log('h2:', (h.match(/<h2/g)||[]).length,
            '| code:', (h.match(/<pre>/g)||[]).length,
            '| hljs:', (h.match(/hljs-keyword/g)||[]).length,
            '| clean:', h.trimEnd().endsWith('</html>'),
            '| em-dash:', h.includes('\u2014'))
```

`hljs` of 0 usually means a code fence is missing its language tag (fine for a
non-code domain like system design, where prose, tables, and `text` diagrams
carry the content). `em-dash: true` means you used a forbidden character; fix it.
Then call `present_files` with the HTML path and add a two or three sentence
summary, without listing the sections.

When building multiple guides, give each a different accent and keep them distinct.

---

## What to do now

Tell me:

- Domain or role: [e.g. "Staff Backend Node", "Senior Python", "Staff System Design", "SRE"]
- Build: [name one guide, or say "propose the set" or "the full set"]
- Any specifics: [stack, framework, company, level nuances, or a particular topic to emphasise]
