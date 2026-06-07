// ================================================================
//  build-backend-guides.js
//  Converts each backend Markdown guide to a styled, syntax-
//  highlighted HTML reference guide in the established house style.
//
//  INSTALL  npm install markdown-it highlight.js
//  RUN      node .claude/build-backend-guides.js
// ================================================================

const fs   = require('fs')
const path = require('path')
const MarkdownIt = require('markdown-it')
const hljs = require('highlight.js')

// ----------------------------------------------------------------
//  GUIDES  – one entry per output file
// ----------------------------------------------------------------
const SRC_DIR = path.join(__dirname, 'backend-md')
const OUT_DIR = path.join(__dirname, '..', 'backend')

const GUIDES = [
  {
    input:  'java-classic-prep.md',
    output: 'java-classic-prep.html',
    kicker:   'Interview Preparation · Staff Backend',
    title:    'Java Classic: Jakarta EE & TomEE',
    subtitle: 'The application-server model at staff level: Servlets, CDI, JAX-RS, JPA, and TomEE packaging, with the bootstrap, caveats, and production metrics interviewers probe.',
    accent:   '#8a2436',
  },
  {
    input:  'java-cloud-native-prep.md',
    output: 'java-cloud-native-prep.html',
    kicker:   'Interview Preparation · Staff Backend',
    title:    'Java Cloud-Native: Quarkus & Micronaut',
    subtitle: 'Build-time DI, GraalVM native images, and reactive JVM services: where they win, where they bite, and the startup and memory numbers that justify them.',
    accent:   '#0a6b82',
  },
  {
    input:  'nodejs-backend-prep.md',
    output: 'nodejs-backend-prep.html',
    kicker:   'Interview Preparation · Staff Backend',
    title:    'Node.js Backend: Express & NestJS',
    subtitle: 'The event loop as a throughput budget: middleware, dependency injection, graceful shutdown, and the latency metrics that separate senior from staff.',
    accent:   '#2d6a44',
  },
  {
    input:  'python-backend-prep.md',
    output: 'python-backend-prep.html',
    kicker:   'Interview Preparation · Staff Backend',
    title:    'Python Backend: FastAPI',
    subtitle: 'ASGI, Pydantic v2, async done right, and contract-first APIs, plus the GIL realities and worker-tuning numbers you defend in a system-design round.',
    accent:   '#2e5280',
  },
  {
    input:  'scaling-foundations-prep.md',
    output: 'scaling-foundations-prep.html',
    kicker:   'Interview Preparation · Staff Backend',
    title:    'Scaling Foundations',
    subtitle: 'Load balancing, caching, security, and authentication for distributed systems: the shared reliability vocabulary (RPS, nines, percentiles) every backend round assumes.',
    accent:   '#7a5500',
  },
]

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

function buildHtml(meta, cssBody, highlightTheme, bodyHtml) {
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

const highlightCss = fs.readFileSync(
  path.join(__dirname, '..', 'node_modules', 'highlight.js', 'styles', 'github.css'), 'utf8'
)

for (const g of GUIDES) {
  const markdownSrc = fs.readFileSync(path.join(SRC_DIR, g.input), 'utf8')
  const bodyHtml = md.render(markdownSrc)
  const css      = buildCss(g.accent)
  const html     = buildHtml(g, css, highlightCss, bodyHtml)
  const outPath  = path.join(OUT_DIR, g.output)
  fs.writeFileSync(outPath, html, 'utf8')
  console.log(`Written ${String(html.length).padStart(7)} bytes  ${g.output}`)
}
