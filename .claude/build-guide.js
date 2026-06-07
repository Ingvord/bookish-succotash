// ================================================================
//  build-guide.js
//  Converts a Markdown file to a styled, syntax-highlighted HTML
//  reference guide.
//
//  INSTALL  npm install markdown-it highlight.js
//  RUN      node build-guide.js
// ================================================================

// ----------------------------------------------------------------
//  CONFIGURE  – edit these lines, leave everything else alone
// ----------------------------------------------------------------
const INPUT_MD    = 'my-guide.md'
const OUTPUT_HTML = 'my-guide.html'

const META = {
  // Small label above the title, e.g. 'Interview Preparation · Staff Frontend'
  kicker:   'Your Category Here',

  // Main h1 title of the document
  title:    'Your Guide Title',

  // One-sentence subtitle shown below the title
  subtitle: 'Brief description of what this guide covers.',

  // Accent colour for headings, borders, and the code-block rule.
  // Pick one from the ACCENT PALETTE below.
  accent:   '#0f6e62',
}

// ACCENT PALETTE
//
//   Each guide in the series should have a distinct accent so the
//   documents are easy to tell apart on screen and in print.
//
//   Already used
//     teal        #0f6e62   Vue guide
//     terracotta  #b0502f   JavaScript deep-dive
//     indigo      #33408c   Question bank
//     burgundy    #8a2436   Java Classic (Jakarta EE & TomEE)
//     deep cyan   #0a6b82   Java Cloud-Native (Quarkus & Micronaut)
//     forest      #2d6a44   Node.js (Express & NestJS)
//     slate       #2e5280   Python (FastAPI)
//     amber       #7a5500   Scaling Foundations
//
//   Available (all pass WCAG AA contrast on white at heading sizes)
//     plum        #6b3585
//
// ----------------------------------------------------------------


// ================================================================
//  BUILD PIPELINE  – nothing below needs editing
// ================================================================

const fs   = require('fs')
const path = require('path')
const MarkdownIt = require('markdown-it')
const hljs = require('highlight.js')

// markdown-it with syntax highlighting callback
const md = new MarkdownIt({
  html:     true,
  linkify:  true,
  highlight(str, lang) {
    // vue blocks: use xml grammar so template tags + embedded script/style highlight
    let language = lang === 'vue' ? 'xml' : lang === 'ts' ? 'typescript' : lang
    const label  = lang || ''
    try {
      if (language && hljs.getLanguage(language)) {
        const out = hljs.highlight(str, { language, ignoreIllegals: true }).value
        return `<pre><code class="hljs" data-lang="${label}">${out}</code></pre>`
      }
    } catch (_) {}
    return `<pre><code class="hljs" data-lang="${label}">${md.utils.escapeHtml(str)}</code></pre>`
  },
})

// CSS: receives the accent hex and returns the document stylesheet.
// Prefix with the highlight.js github theme read from node_modules.
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
}
`
}

// HTML frame for the document
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

// --- run ---
const markdownSrc  = fs.readFileSync(INPUT_MD,  'utf8')
const highlightCss = fs.readFileSync(
  path.join('node_modules', 'highlight.js', 'styles', 'github.css'), 'utf8'
)

const bodyHtml = md.render(markdownSrc)
const css      = buildCss(META.accent)
const html     = buildHtml(META, css, highlightCss, bodyHtml)

fs.writeFileSync(OUTPUT_HTML, html, 'utf8')
console.log(`Written ${html.length} bytes to ${OUTPUT_HTML}`)
