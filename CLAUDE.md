# Project: Technical Interview Guide Builder

This project produces styled, syntax-highlighted HTML reference guides for technical interview preparation. Guides are written in Markdown and converted to print-ready HTML via a Node.js pipeline.

---

## Build Pipeline

Install once per working directory:

```bash
npm install markdown-it highlight.js
```

`build-guide.js` converts a Markdown file to HTML. Before each build, set four values at the top of the file:

| Placeholder | Description |
|---|---|
| `REPLACE_INPUT` | Source Markdown filename |
| `REPLACE_OUTPUT` | Output HTML filename |
| `REPLACE_KICKER` | Short label, e.g. `'Interview Preparation · Python'` |
| `REPLACE_TITLE` | H1 title (not in the Markdown — comes from META) |
| `REPLACE_SUBTITLE` | One sentence shown under the title |
| `REPLACE_ACCENT` | Hex accent colour from the palette below |

Run: `node build-guide.js`

### Accent Colour Palette

All colours pass WCAG AA contrast on white.

| Name | Hex | Status |
|---|---|---|
| Teal | `#0f6e62` | Used |
| Terracotta | `#b0502f` | Used |
| Indigo | `#33408c` | Used |
| Burgundy | `#8a2436` | Used |
| Deep Cyan | `#0a6b82` | Used |
| Forest | `#2d6a44` | Used |
| Slate | `#2e5280` | Used |
| Amber | `#7a5500` | Used |
| Plum | `#6b3585` | Free |

Update the Status column whenever a colour is used so each guide in a set has a distinct accent.

### Sanity-check after build

```js
const h = require('fs').readFileSync('OUTPUT.html', 'utf8')
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
