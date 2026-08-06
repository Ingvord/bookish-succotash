## The shape of the round

Rounds built around agent-skill design tend to follow the same two-part shape, whichever company runs them. The first part is a scoped, familiar design walkthrough: you are handed a concrete problem (a skill that helps engineers write better pull request descriptions is a common one) and asked to walk through the file layout, the file contents, and the core prompt, out loud, often in a shared editor with no code execution. That constraint matters more than it looks: with no working demo to fall back on, structure and precision carry the entire signal.

The first part is a fluency check. You either know the artifact cold or you do not, and at senior level and above that knowledge is assumed rather than nice to have. The second part changes the game: once the design walkthrough lands, the interviewer typically escalates, "now make it cloud native," then "now integrate it with a third party, MCP, A2A, greenfield." This is not a knowledge check anymore, it is an architecture-improvisation check, scored on how fast the right shape appears in your head rather than on whether you eventually get there after being walked to it.

The reason this shape of round exists at all is that "familiarity with AI coding assistants and experience extending them through custom plugins, skills, or hooks" has become a routine line in job descriptions at AI-native companies, and a line in a JD tends to produce a corresponding line in the loop. This guide covers exactly that surface: the artifact, the taxonomy around it, and the two escalations an interviewer is most likely to reach for once the artifact question is answered.

---

## The skill artifact

**What a skill is.** A skill is a directory containing, at minimum, a `SKILL.md` file with YAML frontmatter and a Markdown body. The frontmatter is machine-readable metadata; the body is the instructions the agent follows once the skill activates. Everything else in the directory is optional.

```text
pr-description/
├── SKILL.md          # required: frontmatter + instructions
├── scripts/           # optional: executable helpers
├── references/         # optional: docs the agent loads on demand
└── assets/             # optional: templates, static resources
```

**Where skills live, and why the location matters.** Three install locations exist, and they resolve in a fixed precedence order when names collide.

| Location | Path | Scope |
|---|---|---|
| Personal | `~/.claude/skills/<name>/SKILL.md` | Every project you work in |
| Project | `.claude/skills/<name>/SKILL.md` | This repository only |
| Plugin | `<plugin>/skills/<name>/SKILL.md` | Wherever the plugin is enabled |

When the same name exists at more than one level, personal overrides project, and a skill at any level overrides a bundled skill of the same name. Plugin skills are namespaced as `plugin-name:skill-name`, so they never collide with the other two. This is worth stating explicitly in an interview, because "where does it live" is really "who is this for": a personal skill is your own workflow shortcut, a project skill is a team convention checked into version control, and a plugin skill is a distributable capability with its own bundled agents, hooks, and MCP servers.

**When to add supporting files versus stay self-contained.** A skill that only produces a description from context that is already in front of the model, like drafting PR text from a diff the agent can read directly, has no reason to carry a `scripts/` directory: every dependency it needs is already available through the agent's normal tools. Reach for `scripts/` when the task involves a deterministic transformation that is cheaper and more reliable to run than to have the model reproduce token by token (parsing a binary format, hitting a rate-limited API with pagination, running a fixed compliance check). Reach for `references/` when the instructions need detail that most invocations will not touch (an edge-case table, a full API reference), because the whole point of progressive disclosure is that this material only enters context when the skill actually needs it, not on every activation. Keeping a skill dependency-free by default and only reaching for bundled code when the model genuinely cannot do the step reliably is a good default to state as a deliberate design principle.

**Discovery and progressive disclosure.** Skills load in three stages. At startup, the agent loads only `name` and `description` for every available skill, roughly a hundred tokens each, just enough to recognize when a skill might apply. When a task matches, the full `SKILL.md` body loads into context, capped by convention at under 5,000 tokens, with 500 lines as the practical ceiling before you should be splitting content into `references/`. Files inside `scripts/`, `references/`, and `assets/` load only when the instructions in the body point to them. This is why the description field is not throwaway metadata: it is the only thing standing between the agent and the decision to activate your skill at all, and a vague description is a skill that silently never fires.

---

## Frontmatter, field by field

Two frontmatter fields trip up more candidates than any other: `allowed-tools` and `argument-hint`. Most answers stop at `name` and `description` and never get further, which is a shame because the other two are exactly where the interesting judgment calls live. Here is the complete surface, split the way it actually splits.

**The portable six.** These are the only fields the open [Agent Skills](https://agentskills.io) specification defines, and they are the only fields that survive outside Claude Code: claude.ai skill uploads, the Skills API, and the `package_skill.py` packaging tool all validate against exactly this set.

| Field | Required | Constraint |
|---|---|---|
| `name` | Yes | Max 64 chars, lowercase letters/digits/hyphens only, no leading, trailing, or doubled hyphen, must match the parent directory name |
| `description` | Yes | Max 1,024 chars, non-empty, should state what the skill does and when to use it |
| `license` | No | License name, or a pointer to a bundled license file |
| `compatibility` | No | Max 500 chars, environment requirements (intended product, system packages, network access) |
| `metadata` | No | Free-form string-to-string map for your own tooling |
| `allowed-tools` | No | Space-separated list of tools pre-approved to run; marked experimental in the spec |

**`allowed-tools`, and the trap in how people describe it.**

<div class="callout callout-warning">
<span class="callout-label">The allowed-tools trap</span>
<p><code>allowed-tools</code> does not restrict a skill. It <strong>pre-approves</strong> the listed tools for the turn that invokes the skill, so Claude runs them without a permission prompt. Every other tool stays fully callable; the field removes nothing from the available pool. The grant also clears the moment you send your next message, so it is a single-turn convenience, not a standing policy.</p>
<p>Restriction is a different field: <code>disallowed-tools</code> removes tools from the pool while the skill is active. Saying "I scope the skill with <code>allowed-tools</code>" in the room is the wrong answer, and it is exactly the kind of nuance an interviewer who reads the docs weekly will catch on the follow-up.</p>
</div>

The correct framing is a permissions story with two halves: `allowed-tools` buys you a frictionless run for the specific commands a skill needs, and `disallowed-tools` (or ordinary deny rules in `settings.json` for anything session-wide) is where actual scoping happens. For a skill that touches version control and an issue tracker, the honest answer is that `allowed-tools` should list the narrow, specific commands the skill legitimately needs (`Bash(git log:*)`, `Bash(gh pr view:*)`), not a blanket grant, because a broad `allowed-tools` line is itself an over-permissioned skill, just one that looks tidy on the page.

**`argument-hint`, and why it is Claude Code-only.** `argument-hint` shows an autocomplete hint for expected arguments, e.g. `[issue-number]`. It is real and useful inside Claude Code, but it is not part of the portable spec. Package or upload a skill carrying it and the tool hard-errors:

```text
Unexpected key(s) in SKILL.md frontmatter: argument-hint.
Allowed properties are: allowed-tools, compatibility,
description, license, metadata, name
```

The practical takeaway, and a clean thing to say out loud in a greenfield-portability discussion: if a skill needs to survive outside Claude Code (an upload to claude.ai, distribution through the Skills API), keep its frontmatter to the portable six. If it only ever runs inside Claude Code, the extended fields below are fair game.

**The Claude Code superset.** Claude Code accepts every field above plus a set of platform-specific extensions. The ones worth knowing by name: `when_to_use` (extra invocation guidance, appended to `description`, both capped together at 1,536 characters in the skill listing), `arguments` (named positional arguments for `$name` substitution in the body), `disable-model-invocation` and `user-invocable` (invocation control, covered next section), `disallowed-tools` (the actual restriction mechanism), `model` and `effort` (override for the turn), `context: fork` with `agent` and `background` (run the skill in a subagent), `hooks` (lifecycle automation scoped to the skill, also covered next section), and `paths` (glob patterns that gate automatic activation to matching files). None of these validate outside Claude Code.

---

## The taxonomy

Interviewers use this distinction as a fluency check because candidates genuinely blur these together under pressure. Six mechanisms, one row each.

| Mechanism | What it is | Right tool when |
|---|---|---|
| Skill | A `SKILL.md` folder: metadata plus instructions, optionally with scripts and references | You are packaging a repeatable procedure or domain knowledge for an agent to load on demand |
| Slash command | As of the current Claude Code generation, merged into skills; `.claude/commands/x.md` and `.claude/skills/x/SKILL.md` both produce `/x` | Historical name for what a user-invocable skill does; new work should just be a skill |
| Subagent | A specialized agent, invoked via `context: fork` from a skill or spawned directly, with its own context window | The task needs isolated context or a different tool/model profile than the main conversation |
| Plugin | A bundle of skills, agents, hooks, and MCP servers, loaded by local path or marketplace, namespaced as `plugin:skill` | You are distributing a capability set as a unit rather than a single procedure |
| MCP server | An external process exposing tools, resources, and prompts over the Model Context Protocol | You are connecting the agent to a system that lives outside the agent's own process: a database, a SaaS API, a filesystem |
| Hook | A script bound to a lifecycle event (`PreToolUse`, `SessionStart`, and roughly thirty others), scoped globally or to a skill | Something must happen automatically on a system event, with no human or model decision in the loop |

One sentence to hold the whole table: skills package what the agent knows how to do, subagents and plugins package how much of it runs where, and MCP servers and hooks are the two ways the agent's own process reaches outside itself, one for data and tools, one for automatic reaction to events.

---

## Invocation control: who fires the skill, and how

This distinction is easy to skim past in a design walkthrough, but it matters more than it looks, because it is the direct conceptual setup for the cloud-native escalation that tends to follow it.

**Three invocation modes, not two.** A skill can be invoked by a human typing `/skill-name`, by the model deciding on its own that the skill's description matches the current task, or by a system event firing a hook with no decision step at all. The frontmatter controls which of the first two are open:

| Setting | Model can invoke | User can invoke | Effect |
|---|---|---|---|
| default | yes | yes | Description always in context; full skill loads when either triggers it |
| `disable-model-invocation: true` | no | yes | Description not in context at all; only a typed `/name` loads it |
| `user-invocable: false` | yes | no | Description always in context; hidden from the `/` menu, Claude-only |

Reach for `disable-model-invocation: true` on anything with a side effect you want to time yourself: `/commit`, `/deploy`, a skill that posts to Slack. You do not want the model deciding to deploy because the code looks ready. Reach for `user-invocable: false` on pure background knowledge that is not itself an action, a skill that just explains how a legacy subsystem works, where `/legacy-system-context` is not something a user would ever type.

**Hook-triggered is the third mode, and it is the bridge.** A skill's frontmatter can carry its own `hooks` block, scoped to that skill's lifecycle:

```yaml
---
name: secure-operations
description: Perform operations with security checks
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "./scripts/security-check.sh"
---
```

This runs `security-check.sh` before every Bash call the skill makes, automatically, with no human typing a command and no model deciding to check first. Claude Code exposes roughly thirty hook events beyond `PreToolUse`: `SessionStart`, `PostToolUse`, `UserPromptSubmit`, `FileChanged`, `SubagentStop`, and more, each firing when a specific system event occurs rather than when a person or the model chooses to act.

<div class="callout callout-insight">
<span class="callout-label">Why this is the bridge, not a side note</span>
<p>A hook is a trigger that is a system event, not a human command, running in the same process as the agent it's scoped to. A cloud-native agent triggered by a webhook is the identical shape at a different layer: the trigger is still a system event, not a human command, it has just moved outside the process boundary. If you can articulate hook-triggered invocation cleanly, you already have the first half of the "make it cloud native" answer before the interviewer asks for it.</p>
</div>

<div class="callout callout-script">
<span class="callout-label">Sample answer</span>
<p>"There are three ways a skill fires: I type `/name`, the model decides the description matches, or a hook fires it off a lifecycle event with nobody deciding in the moment at all. That third one is worth dwelling on, because it's structurally the same shape as an event-driven system outside Claude Code: a `PreToolUse` hook reacting to a tool call and a webhook reacting to a PR-opened event are both 'system event triggers action, no human in the loop at invocation time.' Everything about designing a hook-triggered skill, the idempotency, the scoping, the failure handling, carries over almost unchanged when that trigger becomes an external event instead of an internal one."</p>
</div>

---

## Writing the core prompt

The core prompt is the body of `SKILL.md` below the frontmatter: what you actually tell the model to do. Three things make one good.

**Structure first.** State the task in one sentence, then break the procedure into ordered steps, then state the output format explicitly and unambiguously. An agent following an unstructured wall of instructions will improvise where you needed determinism; an agent following numbered steps with a stated output contract will not.

**Constraints as guardrails, not suggestions.** If the skill must never touch certain files, must always ask before an irreversible action, or must produce output within a length bound, say so as an explicit constraint near the top of the body, not buried in step six. Ambiguous instructions are the most common failure mode in a skill that "mostly works": the model fills gaps with its best guess, and best guesses vary run to run.

**Output format as a contract.** If the consuming system is a PR template, an issue tracker field, or another agent downstream, the format needs to be specified precisely enough that a second party (human or agent) can rely on it without re-parsing prose. This is the same discipline as designing a wire format for an API: you would not ship an endpoint whose response shape depends on the phase of the moon, and you should not ship a skill whose output shape does either.

This discipline shows up anywhere LLM output feeds a downstream system, not just in skills. A multi-stage agent pipeline is a clean illustration: an early planning stage does not just ask an LLM to "figure out the integration," it constrains the output to a fixed schema the next stage can consume without further interpretation, and a later code-generation stage treats its own LLM output as untrusted until it clears a chain of deterministic gates, contract tests, then scenario tests, then a build step, before anything reaches production. That is prompt engineering discipline expressed as a pipeline: structure, constraint, and a verifiable output contract, the exact three properties a good `SKILL.md` body needs, just applied to a different artifact.

<div class="callout callout-script">
<span class="callout-label">Sample answer</span>
<p>"I write the core prompt the way I'd write any stage boundary in a pipeline: state the task in one line, give ordered steps, and then nail down the output format hard enough that whatever consumes it doesn't have to guess. For a PR-description skill specifically, that means the prompt tells the model to scan the branch's commits and diff, decide whether this is a short fix or a complex feature because that changes what 'good' looks like, estimate blast radius and review effort in developer hours so a reviewer can triage at a glance, and populate the issue tracker link if one exists in the branch name or commit trailers. Every one of those is a step with a defined output, not an open-ended 'write a good description.'"</p>
</div>

---

## Worked example: the PR-description skill, complete

A full, valid `SKILL.md` for this exact prompt shape, with accurate frontmatter and a body that follows the structure above.

```markdown
---
name: pr-description
description: Drafts a pull request description from the branch's commit history and diff against the base branch, sized to the scope of the change. Use when opening a PR or when the user asks for a PR description, summary, or write-up of pending changes.
allowed-tools: Bash(git log:*) Bash(git diff:*) Bash(gh pr view:*) Bash(gh issue view:*)
argument-hint: [issue-number]
---

## Task

Draft a pull request description for the current branch's changes against its
base branch. If an issue number is given as an argument, link it explicitly.

## Steps

1. Run `git log <base>..HEAD` and `git diff <base>..HEAD --stat` to see the
   full set of commits and the shape of the change.
2. Classify the change as a short fix (single concern, low blast radius) or a
   complex feature (multiple concerns, or touches a shared module). State
   which one and why in one sentence.
3. Estimate blast radius: list the modules or services touched, and flag any
   that are shared by more than one team.
4. Estimate review effort in developer hours, based on diff size and the
   blast-radius list, not diff size alone.
5. If `$ARGUMENTS` contains an issue number, fetch it with
   `gh issue view <number>` and link it under a "Closes" line.

## Output format

- Title: imperative mood, under 72 characters.
- Summary: two to four sentences, what changed and why, not how.
- Change classification: short fix or complex feature, with the one-sentence
  reason from step 2.
- Blast radius: bullet list of touched modules/services.
- Review effort estimate: a single number in developer hours, with the basis
  stated in parentheses.
- Closes line, if an issue number was resolved in step 5.

## Constraints

- Do not invent commit history or diff content; if `git log` or `git diff`
  return nothing, say so and stop rather than fabricating a description.
- Keep the summary in prose. Do not restate the diff stat as the summary.
```

This is deliberately dependency-free: no `scripts/`, no `references/`, because every input the skill needs (commit log, diff, issue metadata) is already reachable through the pre-approved `git` and `gh` commands, and the transformation from that data to prose is exactly what the model is good at without help. `allowed-tools` lists four narrow, read-only command patterns, not a blanket grant, which is the version of the permission story the earlier callout argues for.

---

## Cloud native: the three inversions

<div class="callout callout-warning">
<span class="callout-label">Why this trips people up</span>
<p>The mapping from a local, developer-invoked skill to a hosted, event-triggered agent often does not surface unprompted, even for candidates who know every individual piece. The fix is not more knowledge, it is retrieval speed: turn the mapping into a four-part reflex you can produce in the first few seconds after the prompt lands, before you start reasoning from scratch.</p>
</div>

**The mental model.** Taking a skill cloud native is not a rewrite, it is three inversions of the same shape, plus one concern that has to be added because it did not exist before.

1. **Trigger** inverts from a human typing a command to a system event: a webhook, a repo event, a schedule, a queue message.
2. **Runtime** inverts from the developer's own machine to hosted compute running the Agent SDK: a container, a serverless function, or a managed agent runtime.
3. **Identity** inverts from the developer's own credentials to a scoped service principal with least-privilege access, because nobody is sitting at a terminal to authorize each action anymore.
4. **Observability**, the concern that has to be added: a developer watching the terminal was your logging, tracing, and alerting all at once. None of that exists by default in a hosted deployment; it has to be built.

**The concrete shape.** Take the PR-description skill above and make it cloud native: a PR-opened webhook from the source host hits an endpoint, which triggers a hosted agent running the Agent SDK (in Python or TypeScript; other languages drive the CLI as a subprocess with `-p --output-format json`) with a scoped token that can read the diff and write a comment but nothing broader, and the agent writes the description back through the platform's API. Every piece of the local skill's logic, the steps, the output contract, the constraints, survives unchanged; only the four things above moved.

One distinction worth having precise, because it is the credible answer to "how would you host this": the Agent SDK is a library that runs the agent loop in your own process, in your own infrastructure. Managed Agents is a separate, hosted product where Anthropic runs the agent and the sandbox for you. Naming both, and being clear about which one you would reach for and why, reads as someone who has actually looked at the deployment surface rather than someone reciting "cloud native" as a phrase.

**The point worth landing.** This exact shape is not exotic; production systems implement it routinely. A webhook or scheduled event fires a containerized task (ECS Fargate, Cloud Run, a Lambda), secrets live in a parameter store or secrets manager rather than developer credentials, and failures propagate through a queue to a notification service rather than back to a terminal someone is watching. If you have built anything with this shape before, even for an unrelated purpose, that recognition is the actual skill being tested here: the gap is rarely capability, it is noticing that a familiar pattern is being asked for in a different costume.

<div class="callout callout-script">
<span class="callout-label">Sample answer</span>
<p>"Taking a skill cloud native is three inversions of the same shape. The trigger moves from a person typing a command to a system event, a webhook, a schedule, a queue message. The runtime moves from a developer's machine to hosted compute running the Agent SDK, a container or a serverless function. And identity moves from the developer's own credentials to a scoped service principal, because nobody's there to authorize each action anymore. You also have to add observability from scratch, because a developer watching their own terminal was doing that job implicitly before. Concretely for this skill: a PR-opened webhook triggers a hosted agent with a scoped token that can read the diff and post a comment and nothing else, and it writes the description back through the API. If you've built anything with this shape before, this is the moment to name it: an event trigger firing a containerized task, secrets in a parameter store instead of your own credentials, failures routed through a queue to a notifier instead of surfacing in a terminal you're watching. Swap in your own system's real nouns here, it's the fastest way to turn a generic answer into a credible one."</p>
</div>

**The drill.** Given any "make X cloud native" prompt, state the four in this fixed order before you say anything else. It costs four sentences and it puts you back at peer level instantly:

1. Trigger: what system event replaces the human command.
2. Runtime: what hosted compute replaces the developer machine.
3. Identity: what scoped credential replaces the developer's own.
4. Observability: what replaces the terminal you're no longer watching.

Then, and only then, get concrete about the specific service names for the platform in front of you.

---

## MCP, the agent-to-tool layer

MCP fundamentals (the host/client/server model, the M-times-N to M-plus-N framing, tools/resources/prompts, stdio versus Streamable HTTP transports) are covered in depth in the companion [AI Agent Infrastructure guide](../db/ai-agent-infra-prep.html). This section adds what that one does not: the tool-surface design judgment an interviewer is actually probing for when they ask "how would you expose this to an agent."

**Narrow tools beat one generic tool, and it is both an API decision and a security decision.** A `get_pr_diff` tool and a `post_pr_comment` tool, each with a tight input schema, is a better MCP surface than one `github_api` tool that accepts an arbitrary method and payload. The API-design argument is familiar: narrow tools are self-documenting, easier for the model to select correctly among, and easier to version. The security argument is the one worth stating unprompted, because it is the one an AI-native interviewer is listening for: a generic pass-through tool has the model's entire permission footprint riding on every single call, so a prompt-injected instruction that manipulates the model into calling it can do anything the underlying credential can do. A narrow tool bounds the blast radius of a single bad call to exactly what that tool does, nothing more.

**Where the design breaks down in practice.** Tool sprawl: connect enough MCP servers at once and the model has to choose correctly among dozens of similarly named tools, and selection quality degrades well before you exhaust the context window. Confused-deputy risk: a tool that legitimately needs broad access (a general-purpose database query tool, for instance) inherits the full trust of whoever granted it, so the narrow-tool principle sometimes runs into a genuine requirement for breadth, and the right answer there is scoping the credential behind the tool as tightly as the task allows, not widening the tool's own interface. And the spec itself is young: expect client and server support to lag the latest revision, and pin versions rather than assuming the newest spec feature is universally supported.

---

## A2A, the agent-to-agent layer

This is the section worth over-investing in relative to how briefly it tends to come up. A2A is the kind of topic candidates raise unprompted because they know it exists, and then underplay because they haven't gone past the one-sentence description, which reads worse in the room than not raising it at all. The goal here is a two-minute answer that can be delivered without hedging, plus an honest line about where direct experience stops.

**What it standardizes, and why it's a different problem than MCP.** MCP connects one agent to tools and data it does not have natively. A2A connects two independent agents, possibly built by different teams on different frameworks and different model providers, so they can discover each other and delegate work without a person wiring up custom integration code. The standard framing, worth repeating because it is the fastest way to place A2A relative to MCP in one sentence: MCP is vertical, agent reaching down into tools; A2A is horizontal, agent reaching sideways to a peer with its own reasoning underneath, possibly including its own MCP tools. A single system frequently uses both at once, and they are complementary layers, not competing standards.

**Capability discovery: the Agent Card.** An agent publishes an Agent Card, a JSON document describing its identity, capabilities, endpoints, and authentication requirements, conventionally at the well-known path `/.well-known/agent-card.json` under RFC 8615. Two other discovery mechanisms exist alongside the well-known-URL convention: curated registries, a centralized catalog that clients query by skill, tag, or provider, suited to enterprise and marketplace settings; and direct configuration, where the client is pre-wired with Agent Card details for a known, tightly coupled peer. The well-known-URL path is the one to lead with, because it is the one that makes A2A a discovery protocol rather than just a message format.

**Task lifecycle.** A2A models work between agents as a task with defined states, not a synchronous function call. The task states, precisely: `SUBMITTED`, `WORKING`, `COMPLETED`, `FAILED`, `CANCELED`, `INPUT_REQUIRED`, `REJECTED`, and `AUTH_REQUIRED`. The first four are terminal; `INPUT_REQUIRED` and `AUTH_REQUIRED` are interrupted states where the remote agent needs something back from the caller before it can continue, which is the protocol's built-in way of expressing "I can't finish this without more from you," structurally similar to a human coworker asking a clarifying question mid-task rather than failing silently.

**The RPC surface.** Core operations, defined consistently across all transport bindings: `SendMessage`, `SendStreamingMessage`, `GetTask`, `ListTasks`, `CancelTask`, `SubscribeToTask`, the four `TaskPushNotificationConfig` methods (`Create`, `Get`, `List`, `Delete`) for registering webhook callbacks on task state changes, and `GetExtendedAgentCard` for capabilities gated behind additional authentication. Three transport bindings carry these: JSON-RPC 2.0, gRPC, and HTTP+JSON/REST, chosen per integration rather than mandated. Streaming (`SendStreamingMessage`, `SubscribeToTask`) and push notifications are each gated behind a capability flag the Agent Card declares (`capabilities.streaming`, `capabilities.pushNotifications`), so a caller checks the card before assuming either is available.

**Message, Part, Artifact.** Communication between agents is a `Message` with a role (user or agent), built from one or more `Part`s, typed content containers holding text, bytes, a URL, or structured JSON. A task's output is an `Artifact`, also composed of `Part`s, kept distinct from `Message` specifically to separate the conversational exchange from the actual work product being delivered.

**Governance and maturity, stated plainly.** A2A originated at Google in 2025 and is now an open, vendor-neutral standard under the Linux Foundation, with a steering committee spanning AWS, Cisco, Google, IBM, Microsoft, Salesforce, SAP, and ServiceNow. Version 1.0 shipped in 2026. It is genuinely cross-vendor, which is the property that makes it different from a proprietary orchestration format, but it is young: verifying that an Agent Card actually belongs to who it claims (signed Agent Cards address this, adoption is uneven), tracing a failure across three or four hops of delegated agents, and deciding how much autonomy to hand a remote agent before a human needs to be in the loop are all still hardening. State that as fact, not apology, because a mature-sounding claim about a year-old standard is the bluff a security-minded interviewer is specifically listening for.

<div class="callout callout-script">
<span class="callout-label">Sample answer: honest limits</span>
<p>"I haven't run a production A2A integration. What I have built is the pattern A2A formalizes, by hand: a multi-stage pipeline where each stage is independently deployed with defined inputs, outputs, and failure states, coordinated through an orchestrator rather than through A2A's task-and-message model. If I were building this for real today, I'd expect the switch to be mostly conceptual, not architectural: the stages already have the shape of independent agents, I'd be trading a hand-rolled handoff for A2A's Agent Card discovery and its task lifecycle. What I don't have is hands-on experience with the trust and verification side, signed Agent Cards, cross-organization authentication, which is exactly the newest and least settled part of the standard anyway."</p>
</div>

---

## Multi-agent worked example

Extend the PR-description agent into a small multi-agent system: a security-review agent and a test-generation agent, each independently capable, composed around the same PR event.

One plausible shape: the PR-description agent, on receiving the webhook, opens A2A tasks with both peers in parallel rather than sequentially, since neither depends on the other's output. The security-review agent pulls the diff over its own MCP tool connection to a SAST scanner and returns findings as an `Artifact`; the test-generation agent inspects changed functions and proposes test cases, potentially entering `INPUT_REQUIRED` if it needs the PR author to confirm expected behavior for an ambiguous change. The PR-description agent waits on both tasks, then composes a single PR comment: description, security findings, suggested tests, one artifact instead of three separate bot comments competing for attention.

**Two contested design questions, worth naming as contested rather than settled, because the field has not converged on either.** Orchestrator-led versus peer-to-peer: should the PR-description agent explicitly coordinate the other two (an orchestrator pattern, easier to reason about, a single point of failure and a bottleneck), or should all three discover and negotiate independently (peer-to-peer, more resilient to any one agent's outage, harder to reason about and to debug)? And synchronous waiting versus fire-and-forget with a later reconciliation step: does the description agent block on both tasks before commenting, or post an initial description immediately and update the comment as each peer's task completes? Both are live design debates in multi-agent orchestration right now, not settled best practice, and saying so is more credible than picking one and presenting it as the obvious answer.

---

## Security of agent skills and agentic systems

**`allowed-tools` as a permission surface, done correctly.** The earlier callout already corrected the misconception; the constructive version is that a skill touching version control and an issue tracker deserves an `allowed-tools` list scoped to the exact commands it needs (`Bash(git log:*)`, not `Bash(git:*)`), because the field's actual function, pre-approving specific commands, is only a security improvement if the list is narrow. A broad `allowed-tools` grant is not scoping, it's just a permission prompt you've pre-answered "yes" to for everything.

**Prompt injection, and the honest answer about defenses.** There is no parameterization primitive for LLM inputs equivalent to a prepared statement for SQL. A prepared statement separates code from data at the interpreter level, so injected data physically cannot become executable instructions. An LLM has no equivalent boundary: instructions and data share the same channel, natural language, and content retrieved from an untrusted source (a webpage, a PR description, an issue comment) can contain text that reads as an instruction to the model. This is why defenses are containment strategies, not elimination: narrow tool surfaces, human approval gates on high-impact actions, and treating retrieved content as data to reason about rather than instructions to follow, stated explicitly in the skill's own prompt.

**Excessive agency, broken into its three root causes**, per [OWASP LLM06:2025](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/), with the mitigation matched to each:

- **Excessive functionality**: the agent has access to capabilities beyond what the task needs (a "GitHub API" tool when the task only ever needs to comment on a PR). Mitigate by minimizing the tool surface to exactly what's required, the same narrow-tools argument from the MCP section.
- **Excessive permissions**: the agent's credential can do more than its tools expose (a PR-comment tool riding on a token that also has repo-delete rights). Mitigate by scoping the underlying credential to the minimum access the tool actually needs, independent of what the tool's interface claims to expose.
- **Excessive autonomy**: the agent takes high-impact or irreversible actions without a checkpoint (auto-merging, auto-deploying, auto-deleting). Mitigate with human-in-the-loop gates on anything irreversible or high-blast-radius, which is a design decision made once per action type, not something to reconsider under time pressure mid-incident.

**The lethal trifecta, as a design constraint rather than a checklist item.** [Simon Willison's framing](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/), from mid-2025, names the combination that makes data exfiltration close to trivial: access to private data, exposure to untrusted content, and the ability to communicate externally. Any one or two of the three is manageable; all three together mean an attacker only needs to get malicious instructions into the untrusted-content leg (a webpage the agent summarizes, a PR description it reads) to have the agent retrieve private data and hand it to an attacker-controlled endpoint through the external-communication leg. The uncomfortable part is that removing any single leg breaks most useful agents, a PR-description skill needs to read repository content (private-ish data), read a diff that could contain adversarial text (untrusted content), and post a comment (external communication), all three, by design. The practical response is containment, not elimination: tighten what each leg can actually do (narrow tools, scoped credentials), and put a human or a deterministic check between the agent and anything irreversible.

**Human-in-the-loop gating, as a mechanism rather than a theory.** A workflow orchestrator (Step Functions, Temporal, Airflow) can define a wait-state or manual-approval gate at each stage boundary of a pipeline, left disabled by default and enabled selectively per stage. That is the lethal-trifecta response and the excessive-autonomy mitigation in one mechanism: the gate sits at the exact point where an action becomes hard to reverse, and it can be turned on tighter for a stage that pushes to production and looser for a stage that only produces a proposal a later stage will validate.

---

## Evaluation and testing

Three questions define whether a skill works, and none of them are "does it produce plausible-looking output."

**Invocation accuracy.** Does the skill fire when it should, and stay quiet when it shouldn't? A skill with a vague description either never activates on the tasks it was built for, or activates on unrelated tasks and pollutes context with irrelevant instructions. This is tested by running a set of prompts that should and should not trigger the skill, and checking the activation decision, not the output.

**Output quality.** Given the skill fires, does the output meet the contract stated in its own body? For the PR-description skill, that means checking the output actually contains a classification, a blast-radius list, and an effort estimate, not just prose that reads well.

**Regression when prompts change.** A skill's body is a prompt, and prompts are brittle to small edits in ways code is not: reordering two steps, or rewording a constraint, can change model behavior in ways that are not obvious from reading the diff. Treat prompt edits the way you'd treat a change to any other load-bearing artifact, with a fixed set of test invocations you re-run before and after, not just a read-through.

The throughline worth stating explicitly: LLM output is untrusted until it clears a deterministic gate. A production code-generation pipeline is a clean model for the posture: generated code is not trusted because it came from an LLM, it passes through contract tests, then scenario tests, then a build step, and only a clean pass at every stage reaches deployment. A skill's output deserves the same posture in miniature: the model's first draft is a proposal, not a result, until something deterministic (a schema check, a required-field check, a human review) confirms it.

---

## Delivery mechanics for a live design round

**Answer against the numbered prompt, visibly.** When the prompt is "walk us through (1) layout, (2) file contents, (3) core prompt," structure the answer as three labeled sections in that order, out loud. This sounds obvious and is exactly the thing that gets lost under interview pressure: the numbered structure is itself a signal the interviewer is scoring, independent of the content inside each number. Do this even when it feels redundant to say out loud: deliver the structure explicitly, get it implicitly accepted, then let the interviewer choose whether to escalate from there.

**Close the asked question before offering more.** Extension material, additional command families, ecosystem thinking beyond the literal ask, lands better as a deliberate offer than as an unlabeled continuation. One sentence does the whole job: "That covers what was asked. If it's useful, I can also sketch how I'd extend this into a small command family, want me to go there?" The content does not need to change; the framing turns a wandering answer into a demonstrated instinct for scope control, which is itself a signal at senior level and above.

**Handle a mid-round frame change as a resumed structure, not a restart.** "Make it cloud native" and "now add MCP and A2A" are not new questions, they are the same design conversation with the frame widened. Reuse the numbered-answer discipline from the opening walkthrough: state the frame explicitly ("so now the question is how this same skill runs without a developer invoking it"), give the reflex (the three inversions, or the MCP/A2A placement), then get concrete. Treating an escalation as a chance to restate structure, rather than a chance to panic into an unstructured answer, is the single highest-leverage habit across a round shaped like this, because it is the one move available at every frame change regardless of which specific fact gets asked next.

---

## Verify before you rely on this

Everything above traces to the sources fetched for this guide: the Claude Code skills docs, the agentskills.io specification, the Agent SDK overview, ADK's overview page, the current MCP specification, the current A2A specification, and OWASP's Excessive Agency entry. A few things could not be confirmed to the same standard and are flagged rather than asserted:

- **The current A2A well-known path** (`/.well-known/agent-card.json`) and the exact RPC method list were confirmed against the protocol's own site. Client-library specifics (which SDKs support which transport bindings today) move fast enough that they were not checked here; verify against the SDK you'd actually reach for if a specific one comes up.
- **OWASP's newer Top 10 for Agentic Applications (2026)** exists and covers categories including tool misuse, identity and privilege abuse, memory poisoning, and insecure inter-agent communication, released by the OWASP GenAI Security Project in December 2025. The full ranked list and exact category names were not independently verified for this guide; read it directly if the conversation leans security-heavy, since it is newer and more specific to multi-agent systems than LLM06:2025.
- **MCP client-side primitives beyond elicitation** (sampling, roots) were not covered in depth here; the guide focused on server primitives (tools, resources, prompts) since those are what a skill-design round is most likely to probe.
- **Managed Agents' exact deployment mechanics** (how a session is provisioned, what the sandbox looks like) were confirmed to exist as a distinct hosted product from the Agent SDK, but the operational detail was not fetched. If you're asked whether you'd use Managed Agents or run the SDK yourself, the categorical distinction above is solid; the specifics of setting one up are not something this guide can vouch for.
- **Version-specific Claude Code behavior** (exact version numbers gating features like `${CLAUDE_SKILL_DIR}` substitution in `allowed-tools`) changes release to release. The frontmatter fields and their semantics are current as of this guide's research date; a specific version number cited in the room is worth double-checking against the changelog rather than repeated from memory.
