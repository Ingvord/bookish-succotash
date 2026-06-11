## The pattern: they probe one level deeper than you expect

At the staff level the headline is not the test. Whatever you claim, the interviewer drills down one level, then another, and the claim either bottoms out in a concrete technical mechanism or it collapses into something weaker than it sounded. The most common staff rejection is not a wrong answer. It is a strong-sounding claim that turns out to have nothing underneath it: a redesign that was really a set of suggestions, leadership that was really meeting coordination, AI fluency that was really prompt-and-hope.

The principle that prevents this: every claim you make should have, one or two levels below it, a specific mechanism you can describe and ideally an outcome you can quantify. The headline draws the question; the depth wins or loses the round. Prepare the depth, not the headline.

This is the interview version of the rule that runs through good technical writing: do not stop at what something is, reach the mechanism and the evidence. In a conversation the interviewer forces that for you by asking "how," and a staff candidate has already been there.

---

## 1. Claims versus mechanisms

**What.** A claim is what you accomplished. A mechanism is how you made it real and how you know it worked. Under probing, only the mechanism survives.

**Why it matters.** Anyone can adopt a pattern or state an intention. What distinguishes a staff engineer is turning intention into something that holds without them: a tool, a check, a contract, a measurement. The interviewer is testing for that, so they keep asking "how" until they hit either a mechanism or the bottom of your knowledge.

**Catch.** The trap is that intentions sound like accomplishments. "I introduced best practices," "I established conventions," "I redesigned the architecture," all sound substantial and all collapse the moment someone asks how the practice was enforced, what made the convention stick, or what the redesign changed in concrete terms. If your answer to "how" is another intention, you have not reached the mechanism yet.

The preparation drill: for every project you plan to mention, write the one-line headline, then force yourself to write the three layers beneath it. The decision, the mechanism that implemented it, and the evidence it worked. If you cannot fill three layers, the interviewer will reach the bottom before you want them to, and the claim will reread as smaller than you meant.

```text
Headline:   "I improved consistency across our frontend teams."
Layer 1:    the decision  -> what specifically, and why that over alternatives
Layer 2:    the mechanism -> the tool, check, contract, or package that enforced it
Layer 3:    the evidence  -> the metric or signal that showed it worked
```

---

## 2. Technical leadership versus coordination

The distinction that decides a staff verdict. Coordination is aligning people: running the meetings, writing the document, getting agreement on a convention. It is real work and it matters, but it is not what the title tests. Technical leadership is building the technical means that make the right thing happen by default, so it holds when you are not in the room.

The sharpest way to hold the line in your own head: a best practice that depends on people remembering to follow it is coordination. The same practice encoded so it cannot be violated is technical leadership. The interviewer is listening for which one you actually did.

The technical means that turn a practice into something enforced, stated generally so it transfers to any architecture or standards effort:

- Automated enforcement: lint rules, type checks, continuous-integration gates, pre-commit hooks, custom static analysis that fail the build when the rule is broken.
- Contracts: typed interfaces, schema validation, API contracts, and contract tests that make a violation a compile or test failure rather than a runtime surprise.
- Shared primitives: a design system or utility library as a versioned package, shared configuration, and scaffolds or generators that make the correct structure the path of least resistance.
- Migration mechanisms: codemods and incremental adoption paths, so teams move without manual rewrites and the old pattern actually disappears.
- Governance encoded as code: ownership rules, dependency boundaries, architectural fitness functions, and performance or bundle budgets enforced in continuous integration.
- Evidence: dashboards and metrics that show adoption rose and the target outcome improved, so the impact is measured rather than asserted.

The reframe move in the room: when asked about a standards or architecture effort, lead with the mechanism and the evidence, not the pattern. Not "we adopted X," but "we made X the default by encoding it in Y, and the violations in CI dropped from many per week to near zero over the quarter." The pattern is the setup; the mechanism and the number are the answer.

---

## 3. A worked reframe: from pattern to enforcement

Take a generic claim and watch it move from collapsing to holding. The topic is consistency across teams, but the shape applies to any leadership claim.

The version that collapses under probing:

```text
"I led a redesign of our frontend architecture to improve consistency.
 I introduced shared patterns and best practices, documented our
 conventions, and the teams adopted them."
```

Press on it once and it reveals itself: patterns, a document, and getting agreement. That is coordination, and there is no evidence it stuck. This is exactly the read that ends a staff interview.

The version that holds:

```text
"Consistency was failing because the conventions lived in a wiki nobody
 read. I moved enforcement into the toolchain: a shared lint and TypeScript
 config so cross-team imports were type-checked, the design system as a
 versioned package so a token change shipped to every app in one release,
 and a CI gate that failed any build crossing a module boundary. I wrote
 codemods so teams adopted incrementally without manual rewrites. It was
 measurable: boundary violations in CI fell to near zero over a quarter,
 and the design-token drift we tracked fell with it."
```

What changed is exactly the method from section 1. The decision stayed the same; the answer added the mechanism that enforced it (lint, config, package, CI gate), the mechanism that migrated to it (codemods), and the evidence it worked (the CI metric and the drift tracking). Same project, an order of magnitude more convincing, and now it reads as technical leadership rather than coordination.

---

## 4. AI maturity versus enthusiasm

The second face of the same pattern. Enthusiasm is the headline: you are excited about AI, you built a demo, you use it daily. Maturity is the mechanism: you understand how to engineer with AI reliably, and you are aware of how the field has moved. Under probing, enthusiasm without maturity reads the same way coordination without leadership does, as motion without substance.

The distinction to internalize: vibe coding prompts a model, accepts what comes back, and ships it, trusting that it looked right. AI engineering treats the model as one component in a system that is fed the right inputs, given the right capabilities, constrained so wrong output is caught automatically, and measured so quality is known rather than hoped. The first is a starting point. The second is what a staff candidate is expected to articulate.

The honesty guard matters here as much as anywhere: if your practice really has been mostly experimental, say so and describe how you would put the engineering scaffolding around it, rather than inflating it into expertise the probe will deflate. A grounded "here is where I am and here is where I would take it" beats a claim that collapses.

---

## 5. The AI engineering harness

The generalizable framework behind that maturity, and a useful mental model regardless of this one interview. A harness is the scaffolding you build around a model so its output is reliable. It has four parts, and naming them is the difference between sounding current and sounding a year behind.

**Context: what the model can see.** The quality of output is mostly a function of the quality of the inputs. Curating the right files, examples, conventions, and current state into the model's window, rather than dumping everything or too little, is the lever that moves results most. The broad shift has been from crafting clever one-shot prompts toward engineering the context the model works from.

**Tools: what the model can do.** Giving a model the ability to read files, run code, query a database, or browse, through tool use and protocols like MCP, lets it act on the real environment instead of guessing from a frozen snapshot. An assistant that can read your actual code and run your actual tests produces grounded output; one that cannot is improvising.

**Constraints: what keeps the output correct.** This is the same idea as technical means from section 2, applied to AI. Types, tests, linters, and schemas automatically grade what the model produces, so a wrong answer is rejected by the system rather than caught by luck. Enabling strong typing and a real test suite is what makes AI output safe to accept at speed, because the guardrails do the checking.

**Evaluation: how you know it works.** Evals are systematic, repeatable measurement of output quality against a set of examples, the move from "this one result looked right" to "it passes the suite we measure against." Maturity is treating AI changes the way you treat code changes: measured, not eyeballed.

The signal this sends: you think about AI as an engineering system with inputs, capabilities, guardrails, and measurement, not as a box you prompt and trust. Keep your awareness of the field at the level of these concepts and the general direction of travel, toward agentic, tool-using, evaluated workflows, rather than memorizing product names that will be stale by the interview. Verify the current specifics close to the day.

---

## 6. How to prepare and how to answer under probing

The preparation is the three-layer drill from section 1, run against everything you might say. For each project, can you name the decision, the mechanism, and the evidence. For your AI practice, can you speak to context, tools, constraints, and evaluation, and describe how the field has moved. Where you cannot, either build the missing depth before the interview or scope the claim down to what you can defend.

In the room, the rule is simple: when the interviewer pushes deeper, move toward the concrete, not the abstract. "Tell me more" should make your answer more specific, the exact check, the exact contract, the exact number, not more adjectives. Every level of probing should reveal more substance, which is only possible if the substance is actually there. That is why this is a preparation problem more than a performance one. You cannot improvise depth you did not build; you can only reveal depth you did.

---

## 7. The pre-interview audit

Run every claim you intend to make through this before the day.

```text
For each project or accomplishment:
[ ] Can I state the decision and why I chose it over the alternatives?
[ ] Can I name the technical mechanism that enforced or implemented it?
[ ] Can I give a metric or concrete signal that it worked?
[ ] Does it read as technical leadership, or only as coordination?
[ ] If only coordination, have I scoped the claim honestly?

For AI experience:
[ ] Can I speak to context, tools, constraints, and evaluation?
[ ] Can I describe the general direction the field has moved?
[ ] Do I have a story that shows judgment and guardrails, not just a demo?
[ ] Am I claiming maturity I can defend, or scoping to what is real?

Across the board:
[ ] For every headline, can I go three layers deep before hitting bottom?
[ ] When pushed, does my answer get more concrete rather than more vague?
```

If a claim fails this audit, the probe will find the same crack the audit did. Fix it by building the depth or narrowing the claim, never by polishing the headline.
