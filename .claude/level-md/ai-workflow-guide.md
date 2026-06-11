# AI-Assisted Development and Design-to-Code

This guide targets the AI section of the interview, where the evaluation noted
strong personal Claude usage and MCP experience, but flagged no design-to-code
(D2C) experience. D2C is a workflow, not a single tool. You can speak to it
credibly after understanding how it works and trying the primary tools once, which
takes an afternoon.

The interview evaluates three things: what AI tools you use and how, whether you
apply judgment (not just accept output), and whether you have touched the D2C
workflow specifically. This guide covers all three.

---

## 1. What "design-to-code" actually means

D2C converts a visual design, whether a Figma frame, a screenshot, or a mockup,
into working frontend code. Historically this was a manual process: a developer
reads the design, measures spacing, matches typography, and writes the component
by hand. AI-assisted D2C accelerates or replaces most of that translation.

The workflow has three entry points:
- **Screenshot or image to component**: paste a screenshot into Claude, Cursor, or
  GitHub Copilot and ask for a Vue/React component.
- **Figma plugin to component**: tools like Anima, Locofy, or Figma's own Dev Mode
  AI convert Figma layers directly, preserving exact values.
- **Prompt to component**: describe the UI in text and a tool generates it, with
  no design file required. This is what v0.dev and Bolt do.

The catch that separates a thoughtful answer from a naive one: generated output
is a starting point, not a finished component. Pixel accuracy does not equal
production quality. The review pass is where the engineer adds value.

---

## 2. The primary D2C tools (what to name in the interview)

**v0.dev (Vercel).** The most production-credible D2C tool as of 2026. Accepts
text prompts or screenshots, outputs React or Vue with Tailwind, and produces
components at a quality level close to what a senior engineer writes. Iterates
via follow-up prompts. Free tier available. One afternoon here gives you real
experience to discuss.

**Bolt.new.** Full-app generation from a prompt, not just components. Useful for
scaffolding a prototype quickly. Good for demonstrating end-to-end AI-assisted
development.

**lovable.dev.** Similar to Bolt, prompt-to-app with a visual editor. Targets
non-developers but used by engineers for rapid prototyping.

**Claude (Anthropic).** Screenshot or Figma export to component via the chat
interface or Claude Code. Strong at following an existing codebase's conventions
when you provide context (component examples, design token names).

**Cursor with screenshots.** Cursor's vision support lets you paste a design
screenshot directly into the chat and ask it to match the layout in your current
codebase. It reads your existing files for context, which v0.dev cannot.

**Figma Dev Mode.** Figma's built-in developer view shows exact values and
generates basic CSS and component scaffolds. Not AI in the strong sense, but the
starting point for any Figma-to-code workflow.

---

## 3. A practical D2C workflow

Even if you have not used these tools heavily, describing the workflow correctly
signals competence. Here is the end-to-end shape:

```text
1. Design input: Figma frame export, screenshot at 2x, or prompt
2. Context injection: framework (Vue), component library, design token names
3. First-pass generation: v0.dev, Claude, or Cursor produces a draft component
4. Review pass: semantics, accessibility, tokenization, props API, edge states
5. Iteration: fix spacing, extract sub-components, add loading/empty/error states
6. Integration: wire to real data, connect to the design system, write tests
```

The review pass is the staff-level contribution and the right thing to emphasise.
Generated components typically have four categories of issues:

**Semantic HTML.** A generated button may be a styled `div`, a generated list may
be `div`s instead of `ul/li`. Fix the semantics and the accessibility follows.

**Design token drift.** A generator may hardcode `#3B82F6` where your design
system expects `var(--color-primary-500)`. Replace literal values with tokens.

**Props API design.** Generated components often put every variant as a separate
boolean prop. Collapse them into a single `variant` union: `'primary' | 'secondary'
| 'ghost'`. A richer, leakier API is harder to maintain.

**Missing states.** The generator saw the happy path. Add loading, empty, error,
and disabled states. Add responsive behaviour.

---

## 4. Bridging your CMS experience to D2C

The evaluation noted a CMS application background with no D2C experience. These
are closer than they appear. A headless CMS feeds structured content into
components; D2C converts visual designs into those same components. If you have
built CMS-driven pages, you have done the "output" half of D2C. The gap is the
"input" half (consuming a design file).

Frame it this way in the interview: "My CMS work gave me strong opinions about
component API design, because every content model decision shows up in the
component's props. Applying that to a D2C workflow, I review generated components
the same way: does the props API match the content model, or is the generator
exposing implementation details the author should not care about?"

That answer takes existing experience and places it precisely in the D2C context,
which is more credible than claiming broad D2C experience you do not have.

---

## 5. AI-assisted development beyond D2C

The evaluation noted good Claude usage for personal tasks, some MCP experience,
and skills with prompts. Strengthen that into a coherent picture.

**Where AI adds the most leverage.** Be specific rather than saying "I use it for
everything."

- Scaffolding: generating a composable, a Pinia store, or a component with a
  specific API from a description. Fast, and the output teaches conventions.
- Test generation: given a component or function, asking for a Vitest test suite.
  The generated tests show you edge cases you might not have considered.
- Refactoring: paste a 200-line component and ask it to extract composables,
  identify responsibilities, or convert from Options to Composition API.
- Exploring unfamiliar APIs: "Show me how to use IntersectionObserver to lazy-load
  an image in a Vue component." Faster than docs trawling.
- Code review: asking the model to review a diff for issues before a pull request.

**The review discipline.** Treat every AI output as a draft from a fast,
fallible colleague. Accept it only when you understand it. The specific things to
verify: does it handle edge cases, does it follow the codebase's conventions, does
it have the right semantics and accessibility, and does it have tests or is it
testable. A staff engineer who delegates to AI and reviews the output is a force
multiplier. One who accepts it blindly introduces bugs at AI speed.

**Types and tests as guardrails.** TypeScript and tests constrain what AI output
can get away with. A generated component that does not compile is immediately
rejected. A generated function with a failing test is immediately visible. Enabling
both in a project means AI output is automatically graded, which is why they are
the most important guardrails in an AI-assisted workflow.

---

## 6. MCP servers: what to say

The evaluation noted "used some MCP." Being concrete converts "some" into a
credible data point.

MCP (Model Context Protocol) is an open protocol that lets an AI assistant call
external tools: read files, query databases, fetch URLs, run code, talk to APIs.
It removes the copy-paste loop and lets the model act on your actual environment.

In a frontend context, practical MCP servers you can name:
- **Filesystem**: Claude reads your project files directly, writes generated
  components, finds the right import paths.
- **Browser/Playwright**: Claude controls a real browser, screenshots the
  rendered page, identifies visual gaps against a design.
- **Figma**: Claude reads the Figma file structure directly, extracting exact
  spacing, typography, and colour values without manual inspection.
- **GitHub**: Claude reads open issues, recent commits, and pull request diffs
  to understand project context before generating or reviewing code.

The honest framing: "I have used filesystem and browser MCP servers with Claude
Code for agentic coding tasks. The biggest benefit was removing the round-trip
of pasting context; the model reads the actual files and its suggestions match
the codebase's conventions immediately."

---

## 7. Framing AI experience in the interview

The evaluation wants three things: evidence of real usage, evidence of judgment,
and evidence of team impact. Structure your answer around all three.

```text
Task:    what I delegated to AI
         (generating a component from a design screenshot,
          writing tests for a composable,
          extracting a reusable hook from a complex component)

Judgment: what I verified, corrected, or rejected
          (the generated button used a div instead of a button element,
           the prop API had five booleans where a variant union was cleaner,
           the generated test did not cover the error state)

Outcome: what shipped and what it enabled
         (component in the design system the same day,
          test coverage for a module that had none,
          a junior engineer onboarded to the codebase in hours using the
          generated documentation as a starting point)
```

Prepare one concrete story for each of: scaffolding or generation, testing, and
D2C or design-adjacent work. Three real stories cover every follow-up question
the interviewer can ask.

The closing signal for a staff candidate: "AI makes me faster at the parts that
have known shapes. My contribution is the judgment about which shape is right in
this context, which the model does not have."
