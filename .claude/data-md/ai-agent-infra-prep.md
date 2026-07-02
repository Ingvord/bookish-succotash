## How to use this guide

This guide is a primer, not a deep-dive. It exists for the moment an interview turns to
"have you worked with agents" or a system-design round drops "how would you ground this
model in our data" and you need a correct, confident answer in under a minute, not a
recitation of a spec. It covers three pieces of plumbing that turn a stateless language
model into something that knows things, can act, and can work with other agents:

- **RAG** (Retrieval-Augmented Generation): gives the model *knowledge* it was not trained on.
- **MCP** (Model Context Protocol): gives the model *tools and data access* in a standard way.
- **A2A** (Agent2Agent): gives independent agents a way to *find and coordinate with each other*.

Each section states what the thing is, why it exists, and where it bites in practice. No
wire-format internals, no vector-math derivations, no SDK tutorials: enough to reason about
the tradeoffs and to not confuse the three with each other.

---

## The mental model: three fixes for one limitation

A language model, on its own, has two limits: its knowledge is frozen at training time, and
it cannot act on anything outside the conversation. Everything in this guide is a way of
loosening one of those limits.

```text
Stateless model
   |
   +-- RAG  -> knowledge from outside the training data (a document store)
   +-- MCP  -> tools and live data via a standard interface (a filesystem, a database, an API)
   +-- A2A  -> other agents to delegate to or collaborate with (a coworker, not a tool)
```

RAG answers "what does the model know." MCP answers "what can the model touch." A2A answers
"who else can the model work with." They are complementary, not competing: a single agent
commonly uses all three at once (retrieve context with RAG, call a tool over MCP, hand off a
sub-task to a specialist agent over A2A).

---

## RAG: giving the model knowledge

**The problem.** A model's knowledge is fixed at training time and is general-purpose: it
was not trained on your company's internal wiki, this morning's support tickets, or a
document that did not exist last year. Ask it a question that depends on that material and
it either says it does not know, or worse, hallucinates a plausible-sounding answer.

**The pipeline.** Retrieval-Augmented Generation fixes this by fetching relevant text at
query time and handing it to the model as context, instead of retraining the model on new
data.

```text
documents -> chunk -> embed -> store in a vector database
                                        |
user query -> embed  -----------------> similarity search -> top-k chunks
                                        |
                       top-k chunks + user query -> prompt -> model -> answer
```

Chunking splits documents into passages small enough to embed and retrieve individually
(a paragraph, not a whole PDF). Embedding converts each chunk, and the query, into a vector
that captures meaning rather than exact wording, so a query about "cancelling a subscription"
can retrieve a chunk titled "how to end your plan" even without a shared keyword. A vector
database stores those vectors and answers "which chunks are closest to this query" (nearest-
neighbour search) in milliseconds over millions of chunks. The retrieved chunks are then
stuffed into the prompt alongside the user's question, and the model answers grounded in
that text instead of its training data alone.

**The catch.** Retrieval quality is the whole game: if chunking splits a table or a
definition across two chunks, or the embedding model misses domain jargon, the model
confidently answers from irrelevant context. This is "garbage in, garbage out" one layer
removed: the generation step can only be as good as what retrieval handed it. RAG also does
not eliminate hallucination, it reduces the surface for it; the model can still misread or
over-generalize from the retrieved text. And it has a cost dimension: every new or changed
document needs re-chunking and re-embedding, and every retrieved chunk consumes context-
window budget that would otherwise go to conversation history or instructions.

---

## MCP: giving the model tools and data

**The problem it solves.** Before a shared standard, every AI application that wanted to
call a tool (search the web, query a database, read a file) wrote a one-off integration for
every tool, for every application: an M-times-N problem. The Model Context Protocol, an open
standard released by Anthropic in late 2024 and since adopted broadly across the industry
(including by other model providers), turns that into an M-plus-N problem: any MCP-speaking
application can use any MCP-speaking tool without custom glue. People describe it as "USB-C
for AI": one connector, many devices.

**The model.** MCP defines three roles. A **host** is the AI application the user interacts
with (an IDE, a chat client, an agent framework). The host embeds one or more **clients**,
each of which holds a 1:1 connection to one **server**, a lightweight process that exposes
capabilities. A server offers up to three kinds of capability: **tools** (functions the model
can invoke, like `create_issue` or `run_query`), **resources** (data the client can read or
attach to context, like a file or a database row), and **prompts** (reusable prompt templates
the server ships alongside its data). Servers talk to clients over one of two transports:
**stdio** for a server running as a local subprocess, or **Streamable HTTP** for a server
running remotely; you name the transport, you rarely need to reason about its framing.

```text
Host application (IDE, chat client, agent)
  |-- Client 1 --- Server A (stdio, local)   [tools, resources]
  |-- Client 2 --- Server B (HTTP, remote)   [tools, prompts]
```

**The catch.** MCP standardizes the interface, not the trust model: giving a model access to
a filesystem-write tool or a production-database tool is still handing it real capability,
and prompt injection from retrieved content can trick the model into invoking a tool it
should not. Connecting many servers at once also causes tool sprawl: the model has to choose
correctly among dozens of similarly-named tools, and choice quality degrades well before you
run out of context window. And the spec is still young and evolving quickly (multiple
breaking revisions in its first two years), so pin versions and expect client and server
support to lag the latest spec release.

---

## A2A: giving agents peers

**Why it exists.** MCP connects one agent to tools and data. It does not help two
independent agents, possibly built by different teams on different frameworks and different
model providers, discover each other and delegate work. Agent2Agent (A2A), originated by
Google in 2025 and now an open, vendor-neutral standard under the Linux Foundation with a
steering committee spanning AWS, Cisco, Google, IBM, Microsoft, Salesforce, SAP, and
ServiceNow, exists for that gap: a common protocol for agent-to-agent discovery and
collaboration across organizational and vendor boundaries.

**The model, at a glance.** An agent publishes an **Agent Card**, a small JSON document at a
well-known URL describing what it can do, how to reach it, and how to authenticate to it,
so other agents can discover its capabilities without a person wiring up the integration by
hand. One agent then opens a **task** with another: it sends a message describing the work,
the remote agent works on it (possibly asynchronously, possibly asking a clarifying question
back), and returns a result or a stream of updates. The exchange looks like a coworker
handing off a subtask, not a function call: the caller does not know or control how the
remote agent does the work internally.

```text
Agent A                          Agent B
  |-- discover Agent Card ------->|
  |-- open task, send message --->|
  |<-- status / clarification ----|
  |<-- result ---------------------|
```

**How it relates to MCP.** The two are commonly summarized as vertical versus horizontal:
MCP is agent-to-tool (a model reaching down into structured, well-defined capabilities), A2A
is agent-to-agent (a model reaching sideways to a peer that has its own reasoning and its own
tools underneath, possibly including MCP). A single system frequently uses both at once.

**The catch.** A2A is a young standard (v1.0 shipped in 2026) still hardening the parts
that matter most once it leaves a demo: verifying an Agent Card actually belongs to who it
claims (signed Agent Cards address this, but adoption is uneven), tracing a failure across
three or four hops of delegated agents, and deciding how much autonomy to hand a remote
agent before a human should be in the loop. Treat it, for now, as promising and moving fast
rather than fully settled.

---

## How they fit together

A concrete flow that uses all three: a support agent gets a billing question. It retrieves
relevant policy text with **RAG**, calls the billing system's `get_invoice` tool over
**MCP** to pull the customer's actual invoice, and, because the question turns out to need a
refund that only the finance team's agent is authorized to approve, opens a task with that
agent over **A2A** and relays its answer back to the customer.

| Question you're answering | Reach for |
|---|---|
| "Does the model know about this document / this fact?" | RAG |
| "Can the model read this data / call this API / use this tool?" | MCP |
| "Does this need a different agent's expertise or authority?" | A2A |

None of the three replaces fine-tuning or training a model from scratch; all three assume a
capable off-the-shelf model and add plumbing around it rather than changing what the model
knows innately.

---

## In the interview

Lead with the one-line framing for each, then the confusion the interviewer is actually
listening for.

**"What's RAG, and how is it different from fine-tuning?"** RAG injects relevant text into
the prompt at query time; fine-tuning changes the model's weights ahead of time. RAG is
cheap to update (re-index a document) and auditable (you can point at the retrieved chunk);
fine-tuning is expensive to update and opaque about which fact came from where. Use RAG for
knowledge that changes or must be traceable; use fine-tuning for changing behavior or style,
not for injecting facts.

**"What's MCP, and isn't that just function calling?"** Function calling is the model
choosing to invoke a function your application already wired up; MCP standardizes how that
function (and related data and prompts) is discovered and exposed in the first place, so the
same server works across many different host applications without custom glue per pairing.

**"What's A2A, and how is it different from MCP?"** MCP connects a model to tools it
controls directly; A2A connects a model to another autonomous agent it does not control, one
that may reason, use its own tools, and answer asynchronously. If you are calling something
that just returns data or performs an action, that is MCP; if you are handing off a task to
something with its own judgment, that is A2A.

A short glossary for the room: **embedding** (a vector representation of text capturing
meaning), **vector database** (a store optimized for nearest-neighbour search over
embeddings), **host / client / server** (MCP's three roles: the application, its connector,
the capability provider), **Agent Card** (A2A's discovery document describing an agent's
capabilities and how to reach it).
