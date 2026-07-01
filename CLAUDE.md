# Project: Technical Interview Guide Builder

This project produces styled, syntax-highlighted HTML reference guides for technical interview preparation. Guides are written in Markdown and converted to print-ready HTML via a Node.js pipeline.

---

## Build Pipeline

Install once per working directory:

```bash
npm install markdown-it highlight.js
```

`.claude/build-guides.js` is a manifest-driven builder: it converts every guide's Markdown source to a styled, syntax-highlighted HTML file in one run. There is no per-file editing of placeholders.

To add or change a guide, edit the `GUIDES` array in `.claude/build-guides.js`. Each entry is one guide:

| Field | Description |
|---|---|
| `src` | Source Markdown filename (relative to repo root) |
| `out` | Output HTML filename (relative to repo root) |
| `kicker` | Short label, e.g. `'Interview Preparation · Python'` |
| `title` | Used for the `<title>` tag (and the `<h1>` when `h1` is absent) |
| `h1` | Optional: the `<h1>` heading when it differs from `title` |
| `subtitle` | One sentence shown under the title |
| `accent` | Hex accent colour from the palette below |

Metadata lives in the manifest entry, not in the Markdown (the Markdown still starts at the first `##`). Drafts not ready to ship stay out of the `GUIDES` array (see the `EXCLUDED DRAFTS` comment in the builder).

Run (rebuilds every guide in the manifest): `node .claude/build-guides.js`

### Accent Colour Palette

All colours pass WCAG AA contrast on white. The authoritative list is the palette comment in `.claude/build-guides.js`; keep this table in sync with it. Each guide in a set gets a distinct accent.

| Name | Hex | Used by |
|---|---|---|
| Teal | `#0f6e62` | vue-interview-prep |
| Terracotta | `#b0502f` | js-interview-prep |
| Indigo | `#33408c` | interview-question-bank |
| Burgundy | `#8a2436` | java-classic-prep, staff-depth-guide |
| Deep Cyan | `#0a6b82` | java-cloud-native-prep |
| Forest | `#2d6a44` | nodejs-backend-prep |
| Slate | `#2e5280` | python-backend-prep, frontend-system-design |
| Amber | `#7a5500` | scaling-foundations-prep, modules-build-guide |
| Plum | `#6b3585` | relational-db-prep |
| Rose | `#9d3658` | redis-prep |
| Steel | `#3f5566` | kafka-prep |
| Deep Violet | `#5b3a8c` | coding-simulator-guide |
| Ocean | `#0d5c8c` | kubernetes-troubleshooting |
| Moss | `#5c6b1f` | platform-engineer-prep |
| Cobalt | `#1e5fa8` | system-design-backend-prep |
| Wine | `#8a2c5a` | elasticsearch-prep |

### Sanity-check after build

```js
const h = require('fs').readFileSync('level/platform-engineer-prep.html', 'utf8')  // swap for the guide's `out` path
console.log('h2:', (h.match(/<h2/g)||[]).length,
            '| code:', (h.match(/<pre>/g)||[]).length,
            '| hljs:', (h.match(/hljs-keyword/g)||[]).length,
            '| clean:', h.trimEnd().endsWith('</html>'),
            '| em-dash:', h.includes('—'))
```

- `hljs: 0` — a code fence is missing its language tag (acceptable for prose/diagram-heavy guides)
- `em-dash: true` — forbidden; replace with comma, colon, or parenthesis

---

## Markdown Authoring Rules

- Start the file at the first `##` heading (H1 comes from META).
- Use `##` for major sections, `###` for sub-sections — never deeper.
- Separate major sections with `---`.
- Always tag fenced code blocks with a language (`js`, `ts`, `python`, `go`, `java`, `sql`, `yaml`, `json`, `bash`, `dockerfile`, `html`, `css`, `text`, `vue`, etc.).
- No em dashes anywhere — use commas, colons, or parentheses.
- Prose before and after every code block. A block with no surrounding prose fails the guide's purpose.
- For Q&A sections, bold the question lead-in (`**What is X?**`) then answer in prose; do not use H3 for every question.

---

## Content Method

Every guide serves someone about to sit a specific interview. Each guide should follow this arc (not all sections are required for every guide):

1. **Framing** — orient the reader to the moment of use
2. **Mental model** — the one reframe that makes it click
3. **Mapping** — connect new concepts to known ones
4. **Depth** — cookbook patterns and details; spend depth budget on load-bearing ideas
5. **Practice** — drills, predict-the-output, worked problems
6. **Meta** — how to apply it, how to frame it in the room

For every concept covered: state **what** it is, explain **why** it matters, name **the catch** (gotcha, tradeoff, where it bites in production). Surface content stops at "what" — always reach the catch.

Replace vague claims ("can cause performance issues") with the mechanism and the symptom. Use concrete numbers, name tradeoffs explicitly.

**Tone:** peer-to-peer, warm, direct, no fluff. Lead with the answer; caveats are short and come after the point.

---

## Building a Series

When given a domain or role (e.g. "Staff Backend Node", "Senior Python", "System Design"):

1. List the competency areas the interview tests for that role/level.
2. Map each major area to one guide — aim for 4 to 6 guides.
3. Always include a coding-and-knowledge question bank guide (shape: question / what they are testing / concise answer / example).
4. Give each guide a distinct accent.

If only a domain is named with no specific guide, propose the set first and build on confirmation. If a single guide is named, build it directly.

**Verify present-day facts** (versions, LTS, dominant framework, current best practices, cited metrics) before writing — do not seed from training-cutoff memory.

### Pre-flight checklist before presenting a guide

- Opens on the reader's moment of use
- Follows the arc
- Every concept reaches the catch
- Every example has teaching prose
- Vague claims replaced with mechanism + symptom
- Depth on load-bearing ideas; rest brief
- Honest scope; verified facts; faded vs. evergreen noted
- Leads with the answer
- No em dashes
- Distinct accent colour
