# Prompt: Create a Technical Reference Guide

Paste this entire file as your opening message in a new Claude conversation,
then add one line at the end describing the guide you want.

---

You are producing a technical reference guide in an established house style.
The output is a styled, syntax-highlighted HTML file that prints cleanly to PDF.
A build pipeline (Node.js) converts Markdown to HTML. Follow the instructions
below exactly. Do not invent a different visual system.

---

## Step 1 — Set up the build pipeline

Run this once in the working directory before anything else:

```
npm install markdown-it highlight.js
```

Then create `build-guide.js` with the following content exactly:

```js
// ================================================================
//  build-guide.js
//  Converts a Markdown file to a styled, syntax-highlighted HTML
//  reference guide.
//
//  INSTALL  npm install markdown-it highlight.js
//  RUN      node build-guide.js
// ================================================================

const fs   = require('fs')
const path = require('path')
const MarkdownIt = require('markdown-it')
const hljs = require('highlight.js')

// ----------------------------------------------------------------
//  CONFIGURE  – these values come from the request
// ----------------------------------------------------------------
const INPUT_MD    = 'REPLACE_INPUT'
const OUTPUT_HTML = 'REPLACE_OUTPUT'
const META = {
  kicker:   'REPLACE_KICKER',
  title:    'REPLACE_TITLE',
  subtitle: 'REPLACE_SUBTITLE',
  accent:   'REPLACE_ACCENT',
}
// ----------------------------------------------------------------

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

const markdownSrc  = fs.readFileSync(INPUT_MD, 'utf8')
const highlightCss = fs.readFileSync(
  path.join('node_modules', 'highlight.js', 'styles', 'github.css'), 'utf8'
)
const bodyHtml = md.render(markdownSrc)
const css      = buildCss(META.accent)
const html     = buildHtml(META, css, highlightCss, bodyHtml)
fs.writeFileSync(OUTPUT_HTML, html, 'utf8')
console.log(`Written ${html.length} bytes to ${OUTPUT_HTML}`)
```

---

## Step 2 — Fill in the META values

When you create `build-guide.js`, replace the four REPLACE_ placeholders with
real values drawn from the request:

| Placeholder | What to put there |
|---|---|
| `REPLACE_INPUT` | markdown filename, e.g. `'css-guide.md'` |
| `REPLACE_OUTPUT` | html filename, e.g. `'css-guide.html'` |
| `REPLACE_KICKER` | short label, e.g. `'Interview Preparation · CSS'` |
| `REPLACE_TITLE` | h1 title of the guide |
| `REPLACE_SUBTITLE` | one sentence shown under the title |
| `REPLACE_ACCENT` | hex colour from the palette below |

### Accent colour palette

Pick an accent that is not already used for a guide in the same set.
All values pass WCAG AA contrast on white at heading sizes.

| Name | Hex | Status |
|---|---|---|
| Teal | `#0f6e62` | Used, Vue guide |
| Terracotta | `#b0502f` | Used, JavaScript deep-dive |
| Indigo | `#33408c` | Used, Question bank |
| Burgundy | `#8a2436` | Used, Java Classic (Jakarta EE & TomEE) |
| Deep cyan | `#0a6b82` | Used, Java Cloud-Native (Quarkus & Micronaut) |
| Forest | `#2d6a44` | Used, Node.js (Express & NestJS) |
| Slate | `#2e5280` | Used, Python (FastAPI) |
| Amber | `#7a5500` | Used, Scaling Foundations |
| Plum | `#6b3585` | Free |

Update this table's Status column when you use a colour, so future guides
in the same conversation stay distinct.

---

## Step 3 — Write the content as Markdown

Write the guide content as a Markdown file. Follow these rules:

**Structure.** Use `##` for major sections and `###` for sub-sections. Do not go
deeper than `###`. Separate major sections with a `---` rule. Start the file
directly with the first `##` heading — the `<h1>` comes from `META.title` in the
HTML header block, not from the Markdown.

**Prose first.** Write explanation paragraphs before and after code blocks.
A code block with no surrounding prose fails the purpose of a reference guide.
The explanation says what the pattern is, why it matters, and what the catch is.
The code demonstrates it concretely.

**Code fences.** Always tag fenced blocks with a language. Use these tags:

| Content | Tag |
|---|---|
| Vue SFC (`.vue`) | `vue` |
| JavaScript | `js` |
| TypeScript | `ts` |
| JSON | `json` |
| HTML | `html` |
| CSS | `css` |
| Nginx config | `nginx` |
| Dockerfile | `dockerfile` |
| Shell / bash | `bash` |

Vue SFC blocks are rendered as `xml` internally so the template, script,
and style regions all receive distinct token colours.

**Tables.** Use Markdown tables for concept comparisons, option lists, and palettes.
They render with the accent-coloured header row automatically.

**Question-and-answer format.** For question banks, use a bold phrase as the question
lead-in (`**What is X?**`), then answer in prose immediately below.
Do not use H3 for every question; H3 is for sub-topics within a section.

**No em dashes.** Use commas, colons, or parentheses instead. Never write `—`.

---

## Step 4 — Build and validate

After writing the Markdown file, run:

```
node build-guide.js
```

Then verify the output with a quick sanity check:

```js
// paste this snippet into a node REPL or run as a file
const h = require('fs').readFileSync('OUTPUT_FILE.html', 'utf8')
console.log('h2 sections:',   h.match(/<h2/g)?.length)
console.log('code blocks:',   h.match(/<pre>/g)?.length)
console.log('hljs-keyword:',  h.match(/hljs-keyword/g)?.length)
console.log('ends cleanly:',  h.trimEnd().endsWith('</html>'))
```

If `hljs-keyword` is 0, check that your fenced code blocks have language tags.
If `ends cleanly` is false, the HTML template has an unclosed expression.

---

## Step 5 — Present the file

Call `present_files` with the output HTML path. Add a short prose summary
covering what the guide contains. Do not list the sections — the user can open
the file. Keep the summary to two or three sentences.

---

## What to do now

Create a guide about: [DESCRIBE YOUR TOPIC HERE]

Use a kicker of: [e.g. "Interview Preparation · TypeScript"]
Use the accent: [pick one from the free list above]
