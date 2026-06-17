// ================================================================
//  build-guides.js
//  Unified manifest-driven builder. Converts every guide's Markdown
//  source to a styled, syntax-highlighted HTML reference guide.
//
//  INSTALL  npm install markdown-it highlight.js
//  RUN      node .claude/build-guides.js
// ================================================================

const fs   = require('fs')
const path = require('path')
const MarkdownIt = require('markdown-it')
const hljs = require('highlight.js')

// ----------------------------------------------------------------
//  TIP TARGET — swap REPLACE_HANDLE for the real Ko-fi handle,
//  then rerun: node .claude/build-guides.js
// ----------------------------------------------------------------

const KOFI = {
  url: 'https://ko-fi.com/ingvord',
}

// ----------------------------------------------------------------
//  GUIDES MANIFEST
//  src and out are relative to the repository root.
// ----------------------------------------------------------------

const GUIDES = [

  // ---- Backend · Staff / Senior --------------------------------
  {
    src:      '.claude/backend-md/java-classic-prep.md',
    out:      'backend/java-classic-prep.html',
    kicker:   'Interview Preparation · Staff Backend',
    title:    'Java Classic: Jakarta EE & TomEE',
    subtitle: 'The application-server model at staff level: Servlets, CDI, JAX-RS, JPA, and TomEE packaging, with the bootstrap, caveats, and production metrics interviewers probe.',
    accent:   '#8a2436',  // burgundy
  },
  {
    src:      '.claude/backend-md/java-cloud-native-prep.md',
    out:      'backend/java-cloud-native-prep.html',
    kicker:   'Interview Preparation · Staff Backend',
    title:    'Java Cloud-Native: Quarkus & Micronaut',
    subtitle: 'Build-time DI, GraalVM native images, and reactive JVM services: where they win, where they bite, and the startup and memory numbers that justify them.',
    accent:   '#0a6b82',  // deep cyan
  },
  {
    src:      '.claude/backend-md/nodejs-backend-prep.md',
    out:      'backend/nodejs-backend-prep.html',
    kicker:   'Interview Preparation · Staff Backend',
    title:    'Node.js Backend: Express & NestJS',
    subtitle: 'The event loop as a throughput budget: middleware, dependency injection, graceful shutdown, and the latency metrics that separate senior from staff.',
    accent:   '#2d6a44',  // forest
  },
  {
    src:      '.claude/backend-md/python-backend-prep.md',
    out:      'backend/python-backend-prep.html',
    kicker:   'Interview Preparation · Staff Backend',
    title:    'Python Backend: FastAPI',
    subtitle: 'ASGI, Pydantic v2, async done right, and contract-first APIs, plus the GIL realities and worker-tuning numbers you defend in a system-design round.',
    accent:   '#2e5280',  // slate
  },
  {
    src:      '.claude/backend-md/scaling-foundations-prep.md',
    out:      'backend/scaling-foundations-prep.html',
    kicker:   'Interview Preparation · Staff Backend',
    title:    'Scaling Foundations',
    subtitle: 'Load balancing, real-time transport (polling, SSE, WebSockets), caching, security, and authentication: the shared reliability vocabulary (RPS, nines, percentiles) every backend round assumes.',
    accent:   '#7a5500',  // amber
  },

  // ---- Frontend · Staff ----------------------------------------
  {
    src:      '.claude/frontend-md/interview-question-bank.md',
    out:      'frontend/interview-question-bank.html',
    kicker:   'Interview Preparation &middot; Staff Frontend Engineer',
    title:    'Interview Question Bank',
    h1:       'Question Bank: Coding &amp; Frontend Knowledge',
    subtitle: 'Likely live-coding tasks with model solutions, plus knowledge questions across the browser, CSS, accessibility, performance, networking, security, Vue, testing, and architecture.',
    accent:   '#33408c',  // indigo
  },
  {
    src:      '.claude/frontend-md/js-interview-prep.md',
    out:      'frontend/js-interview-prep.html',
    kicker:   'Interview Preparation &middot; Staff Frontend Engineer',
    title:    'JavaScript Deep Dive (ES2025)',
    h1:       'JavaScript Deep Dive: Staff-Level Caveats',
    subtitle: 'The mechanisms behind the questions, assuming ES2025: this, closures, the event loop, memory leaks, prototypes, and what is newly relevant.',
    accent:   '#b0502f',  // terracotta
  },
  {
    src:      '.claude/frontend-md/vue-interview-prep.md',
    out:      'frontend/vue-interview-prep.html',
    kicker:   'Interview Preparation · Staff Frontend Engineer',
    title:    'From Webix, ExtJS &amp; Angular to Vue 3',
    subtitle: 'Mapping from Webix, ExtJS, and Angular to Vue 3, a runnable cookbook, a hooks-versus-composables comparison, four build toolchains, testing, and production deployment.',
    accent:   '#0f6e62',  // teal
  },
  {
    src:      '.claude/frontend-md/modules-build-guide.md',
    out:      'frontend/modules-build-guide.html',
    kicker:   'Interview Preparation · Staff Frontend Engineer',
    title:    'Modules, Bundlers, and npm Dependencies',
    subtitle: 'The module-and-build-ecosystem cluster from the live round: CommonJS versus ES Modules and tree-shaking, how Vite achieves its speed, and when to use runtime, dev, and peer dependencies.',
    accent:   '#7a5500',  // amber (also used by scaling-foundations — different section)
  },

  // ---- System Design -------------------------------------------
  {
    src:      '.claude/frontend-md/system-design-guide.md',
    out:      'system-design/frontend-system-design-guide.html',
    kicker:   'Interview Preparation · Staff Frontend Engineer',
    title:    'Frontend System Design',
    subtitle: 'Architecting the client application for a combined coding and system design round: a framework to drive the conversation, rendering and data strategy, scale, and two worked examples shaped like the real role.',
    accent:   '#2e5280',  // slate (also used by python-backend — different section)
  },
  {
    src:      '.claude/backend-md/system-design-backend-prep.md',
    out:      'system-design/backend-system-design-guide.html',
    kicker:   'Interview Preparation · Backend System Design',
    title:    'Backend System Design',
    subtitle: 'Driving the room, the 1K-to-1M-plus three-tier scaling ladder, the outbox/inbox patterns, availability mechanics, and the RAG and OLAP cases, with worked drives from real interviews.',
    accent:   '#1e5fa8',  // cobalt
  },

  // ---- DevOps --------------------------------------------------
  {
    src:      '.claude/devops-md/kubernetes-troubleshooting.md',
    out:      'devops/kubernetes-troubleshooting.html',
    kicker:   'Interview Preparation · DevOps · Kubernetes',
    title:    'Kubernetes: Diagnose It Live',
    subtitle: 'Symptom-first troubleshooting for the live round: eight real failure scenarios from Pending to RBAC Forbidden, each as symptom, ranked causes, commands, fix, and the catch.',
    accent:   '#0d5c8c',  // ocean
  },

  // ---- Level ---------------------------------------------------
  {
    src:      '.claude/level-md/staff-depth-guide.md',
    out:      'level/staff-depth-guide.html',
    kicker:   'Interview Preparation · Staff Level',
    title:    'Depth That Survives Probing',
    subtitle: 'The staff-level rejection pattern: claims that collapse under deeper questioning. How to back every architecture, leadership, and AI claim with the concrete technical mechanism that made it real.',
    accent:   '#8a2436',  // burgundy (also used by java-classic — different section)
  },
  {
    src:      '.claude/level-md/platform-engineer-prep.md',
    out:      'level/platform-engineer-prep.html',
    kicker:   'Interview Preparation · Senior Platform Engineer',
    title:    'The Senior Platform Engineer Interview',
    subtitle: 'What the loop actually tests: competency map, depth on IaC, observability, security, and data pipelines, plus six STAR story templates with quantified results and visible mechanisms.',
    accent:   '#5c6b1f',  // moss
  },

  // ---- Practice -----------------------------------------------
  {
    src:      '.claude/practice-md/coding-simulator-guide.md',
    out:      'practice/coding-simulator-guide.html',
    kicker:   'Interview Preparation · Practice Tooling',
    title:    'Run a Local Coding Interview Simulator with Claude Code',
    subtitle: 'Turn Claude Code into a strict proctor and autograder: timed one-at-a-time tasks, hidden test suites, PASS/FAIL scoring, and a session you drive entirely from chat commands.',
    accent:   '#5b3a8c',  // deep violet
  },

  // ---- Data & Messaging ----------------------------------------
  {
    src:      '.claude/data-md/relational-db-prep.md',
    out:      'db/relational-db-prep.html',
    kicker:   'Interview Preparation · Staff Backend',
    title:    'Relational Databases: PostgreSQL & MySQL/MariaDB',
    subtitle: 'Query planner mechanics, MVCC, WAL, VACUUM, locking, connection pooling, sharding, and the two slow-query diagnosis playbooks every senior engineer needs.',
    accent:   '#6b3585',  // plum
  },
  {
    src:      '.claude/data-md/redis-prep.md',
    out:      'db/redis-prep.html',
    kicker:   'Interview Preparation · Staff Backend',
    title:    'Redis',
    subtitle: 'The in-memory data-structure model: RDB vs AOF persistence, eviction policies and the noeviction default, Pub/Sub vs Streams, cluster sharding, stampede prevention, and rate-limiter implementation.',
    accent:   '#9d3658',  // rose
  },
  {
    src:      '.claude/data-md/kafka-prep.md',
    out:      'messaging/kafka-prep.html',
    kicker:   'Interview Preparation · Staff Backend',
    title:    'Apache Kafka',
    subtitle: 'The log abstraction: partitions, consumer groups, ISR, at-least-once vs exactly-once delivery, log compaction, consumer-lag diagnosis, and ordering guarantees.',
    accent:   '#3f5566',  // steel
  },
]

// ----------------------------------------------------------------
//  EXCLUDED DRAFTS (unpublished, not yet in house ##-first format)
//  .claude/frontend-md/typescript-guide.md
//  .claude/level-md/ai-workflow-guide.md
// ----------------------------------------------------------------

// ----------------------------------------------------------------
//  ACCENT PALETTE
//  teal        #0f6e62   vue-interview-prep
//  terracotta  #b0502f   js-interview-prep
//  indigo      #33408c   interview-question-bank
//  burgundy    #8a2436   java-classic-prep, staff-depth-guide
//  deep cyan   #0a6b82   java-cloud-native-prep
//  forest      #2d6a44   nodejs-backend-prep
//  slate       #2e5280   python-backend-prep, frontend-system-design
//  amber       #7a5500   scaling-foundations-prep, modules-build-guide
//  plum        #6b3585   relational-db-prep
//  rose        #9d3658   redis-prep                   -- AA on white
//  steel       #3f5566   kafka-prep                   -- AA on white
//  deep violet #5b3a8c   coding-simulator-guide       -- AA on white
//  ocean       #0d5c8c   kubernetes-troubleshooting   -- AA on white (6.5:1)
//  moss        #5c6b1f   platform-engineer-prep       -- AA on white (5.3:1)
//  cobalt      #1e5fa8   system-design-backend-prep   -- AA on white (5.6:1)
// ----------------------------------------------------------------

// ================================================================
//  BUILD PIPELINE
// ================================================================

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
  const soft = accent + '14'  // 8% alpha as hex suffix
  return `
:root {
  --ink:          #1c1b19;
  --muted:        #5f5c55;
  --paper:        #ffffff;
  --accent:       ${accent};
  --accent-soft:  ${soft};
  --rule:         #e7e3da;
  --code-bg:      #f6f8fa;
  --code-border:  #e1e6ea;
  --code-tag:     #eef1f4;
}
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }

body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font-family: "Newsreader", Georgia, "Times New Roman", serif;
  font-size: 18px;
  line-height: 1.72;
  print-color-adjust: exact;
  -webkit-print-color-adjust: exact;
}

.wrap { max-width: 52rem; margin: 0 auto; padding: 3.5rem 1.6rem 6rem; }

/* ---------- header ---------- */
.doc-header {
  border-bottom: 3px solid var(--ink);
  padding-bottom: 1.4rem;
  margin-bottom: 2.6rem;
}
.kicker {
  font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: .7rem;
  letter-spacing: .2em;
  text-transform: uppercase;
  color: var(--accent);
}
h1 {
  font-family: "Fraunces", Georgia, serif;
  font-weight: 600;
  font-size: 2.7rem;
  line-height: 1.08;
  margin: .5rem 0 0;
  letter-spacing: -.015em;
}
.doc-header .sub {
  color: var(--muted);
  font-size: 1.02rem;
  margin-top: .85rem;
  line-height: 1.55;
}

/* ---------- tip: header chip ---------- */
.tip-chip {
  display: inline-block;
  margin-top: 1rem;
  font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: .66rem;
  letter-spacing: .08em;
  text-transform: uppercase;
  color: var(--accent);
  background: var(--accent-soft);
  border: 1px solid var(--accent-soft);
  border-radius: 999px;
  padding: .3em .8em;
  text-decoration: none;
}
.tip-chip:hover { background: var(--accent); color: #fff; }

/* ---------- tip: footer card ---------- */
.tip-jar {
  margin-top: 4rem;
  padding: 1.8rem 1.9rem;
  border: 1px solid var(--rule);
  border-left: 3px solid var(--accent);
  border-radius: 10px;
  background: var(--accent-soft);
}
.tip-jar-lead {
  font-family: "Fraunces", Georgia, serif;
  font-weight: 600;
  font-size: 1.3rem;
  margin: 0 0 .5rem;
}
.tip-jar-body { color: var(--muted); font-size: .96rem; margin: 0 0 1.1rem; }
.tip-jar-btn {
  display: inline-block;
  background: var(--accent);
  color: #fff;
  font-family: "JetBrains Mono", monospace;
  font-size: .8rem;
  letter-spacing: .04em;
  padding: .6em 1.1em;
  border-radius: 8px;
  border: none;
  text-decoration: none;
}
.tip-jar-btn:hover { filter: brightness(1.08); }
.tip-jar-fine { color: var(--muted); font-size: .8rem; margin: .9rem 0 0; }

/* ---------- headings ---------- */
h2 {
  font-family: "Fraunces", Georgia, serif;
  font-weight: 600;
  font-size: 1.72rem;
  margin: 3.2rem 0 1rem;
  padding-bottom: .42rem;
  border-bottom: 1px solid var(--rule);
  letter-spacing: -.01em;
}
h3 {
  font-family: "Fraunces", Georgia, serif;
  font-weight: 600;
  font-size: 1.22rem;
  margin: 2.1rem 0 .55rem;
}

/* ---------- body copy ---------- */
p  { margin: 0 0 1rem; }
a  { color: var(--accent); text-decoration: none; border-bottom: 1px solid var(--accent-soft); }
strong { font-weight: 650; color: #141312; }
ul, ol { margin: 0 0 1rem; padding-left: 1.3rem; }
li { margin: .25rem 0; }
hr { border: none; border-top: 1px solid var(--rule); margin: 2.6rem 0; }

/* ---------- inline code ---------- */
code {
  font-family: "JetBrains Mono", ui-monospace, "SFMono-Regular", monospace;
  font-size: .84em;
  background: var(--code-bg);
  border: 1px solid var(--code-border);
  border-radius: 4px;
  padding: .06em .34em;
  color: var(--ink);
}

/* ---------- code blocks ---------- */
pre {
  position: relative;
  margin: 1.1rem 0 1.5rem;
  background: var(--code-bg);
  border: 1px solid var(--code-border);
  border-left: 3px solid var(--accent);
  border-radius: 8px;
  padding: 1rem 1.15rem;
  overflow-x: auto;
}
pre code.hljs {
  background: transparent;
  border: none;
  padding: 0;
  color: #24292e;
  font-size: .8rem;
  line-height: 1.6;
  display: block;
}
pre code[data-lang]:not([data-lang=""])::before {
  content: attr(data-lang);
  position: absolute;
  top: 0; right: 0;
  font-family: "JetBrains Mono", monospace;
  font-size: .58rem;
  letter-spacing: .12em;
  text-transform: uppercase;
  color: var(--muted);
  background: var(--code-tag);
  border: 1px solid var(--code-border);
  border-top: none; border-right: none;
  border-bottom-left-radius: 6px;
  padding: .22em .6em;
}

/* ---------- tables ---------- */
table { border-collapse: collapse; width: 100%; margin: 1.3rem 0; font-size: .86rem; }
th, td {
  border: 1px solid var(--rule);
  padding: .5rem .68rem;
  text-align: left;
  vertical-align: top;
}
th {
  background: var(--accent);
  color: #fff;
  font-family: "JetBrains Mono", monospace;
  font-size: .66rem;
  letter-spacing: .04em;
  text-transform: uppercase;
  font-weight: 500;
}
tbody tr:nth-child(even) { background: #faf9f6; }
td code { font-size: .84em; }

/* ---------- print ---------- */
@page { margin: 16mm; }
@media print {
  body { font-size: 10.5pt; }
  .wrap { max-width: none; padding: 0; }
  * { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
  a { color: var(--ink); border: none; }
  /* wrap long lines so nothing clips at the page edge */
  pre code.hljs { white-space: pre-wrap; word-break: break-word; }
  pre, table { break-inside: auto; }
  tr { break-inside: avoid; }
  h1, h2, h3 { break-after: avoid; }
  .tip-chip, .tip-jar { display: none; }
}
`
}

// meta.h1 is optional: if set it is used for the <h1> element while meta.title
// is used only for the <title> tag. When absent, meta.title covers both.
function buildHtml(meta, cssBody, highlightTheme, bodyHtml) {
  const pageH1 = meta.h1 || meta.title
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
${highlightTheme}
${cssBody}
</style>
</head>
<body>
<div class="wrap">
  <header class="doc-header">
    <div class="kicker">${meta.kicker}</div>
    <h1>${pageH1}</h1>
    <div class="sub">${meta.subtitle}</div>
    <a class="tip-chip" href="${KOFI.url}" target="_blank" rel="noopener noreferrer">&#x2615; Useful? Tip the author</a>
  </header>
  <main>
${bodyHtml}
  </main>
  <footer class="tip-jar">
    <p class="tip-jar-lead">Found this useful?</p>
    <p class="tip-jar-body">These guides are written with Claude, and each one burns real API tokens to research, draft, and fact-check. There is no paywall and no signup. If this helped you walk into an interview better prepared, you can chip in toward the next guide. One-off tip, any amount, your call.</p>
    <a class="tip-jar-btn" href="${KOFI.url}" target="_blank" rel="noopener noreferrer">&#x2615; Tip on Ko-fi</a>
    <p class="tip-jar-fine">Thank you, and good luck in the room.</p>
  </footer>
</div>
</body>
</html>`
}

const ROOT = path.join(__dirname, '..')
const highlightCss = fs.readFileSync(
  path.join(ROOT, 'node_modules', 'highlight.js', 'styles', 'github.css'), 'utf8'
)

let built = 0
for (const g of GUIDES) {
  const srcPath = path.join(ROOT, g.src)
  const outPath = path.join(ROOT, g.out)
  // Ensure output directory exists
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  const markdownSrc = fs.readFileSync(srcPath, 'utf8')
  const bodyHtml    = md.render(markdownSrc)
  const css         = buildCss(g.accent)
  const html        = buildHtml(g, css, highlightCss, bodyHtml)
  fs.writeFileSync(outPath, html, 'utf8')
  console.log(`Written ${String(html.length).padStart(7)} bytes  ${g.out}`)
  built++
}
console.log(`\nDone. ${built} guide(s) built.`)
