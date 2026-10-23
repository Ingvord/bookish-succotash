## Nobody asks for YAML at this level

You are in the loop for a Staff Platform Engineer role, and the interviewer has stopped asking how a Pod gets scheduled. They assume you know the tools. What they ask instead sounds like a meeting you would walk into on day one: "Our deploy takes 45 minutes and devs ship once a week. You have six months and two engineers. What is your plan?" "Three teams are fighting over who owns shared infrastructure. How do you resolve it without making all three mad?" "The cloud bill doubled in six months and nobody knows why. Walk me through your first week."

These are open on purpose. There is no correct configuration to recite. The interviewer is watching three things: whether you **prioritize** when everything looks urgent, whether you can **influence** people who do not report to you, and whether you can **translate** technical work into the language of money, risk, and time. A candidate who answers with a tool name ("we would adopt Argo CD") has skipped the part being graded.

This guide gives you one answer skeleton, then walks six scenarios through it: the three above plus three more that show up in the same loops. It does not repeat the story templates in "The Senior Platform Engineer Interview" (use those for your own past experience), the influence mechanics in "The Engineering Leadership Interview", or the probing patterns in "Depth That Survives Probing". Kubernetes specifics (requests and limits, tenancy, rollouts) are in "Kubernetes: Diagnose It, Operate It".

---

## The answer skeleton

Every scenario answer in this guide has the same five moves. The order matters, because each move earns the right to make the next one.

1. **Clarify and bound.** Ask two or three questions that change the answer, then state your assumptions out loud. "Is the 45 minutes build time or total time to production? I will assume total."
2. **Measure before deciding.** Name the data you would collect and how long it takes. A plan built on a guess is a guess with a timeline.
3. **Find the constraint.** Most problems have one or two causes that dominate. Say which you expect and what would prove you wrong.
4. **Sequence by leverage, and say what you will not do.** The ordering is the answer. Naming what you will refuse to start shows prioritization better than any list of what you will do.
5. **Land it with people, report it in business units.** Who has to agree, who is afraid of what, and how you will say the result in hours saved, dollars saved, or incidents avoided.

Here is the skeleton as a script you can keep in your head and say aloud.

```text
1. "Before I plan, three questions: ..."          (clarify, bound)
2. "In week one I would measure ..."              (data, not opinion)
3. "My hypothesis is the constraint is ..., and
    I would be wrong if ..."                      (falsifiable)
4. "In order: first ..., then ..., and I would
    deliberately not ... because ..."             (leverage, refusal)
5. "To make it stick I need X to agree, and I
    would report it as ... per week / month."     (people, business units)
```

The skeleton is a script for thinking, not for reciting. Interviewers interrupt. If they cut in at move 2 with "assume you have no data", that is a signal to describe how you would get it cheaply, not to skip it. The catch is the candidate who treats clarifying questions as a ritual and asks five of them. Two or three that visibly change your plan beat a long list that delays it.

---

## ★ Scenario 1: the 45-minute deploy

**The prompt.** "Our deploy takes 45 minutes. Devs deploy once a week because of it. You have six months and two engineers. What is your plan?"

**What they are really testing.** Whether you diagnose before prescribing, whether you can size a plan to two people, and whether you notice that the cadence is a human problem as much as a pipeline problem.

### Clarify and frame

Ask: "Is the 45 minutes pipeline time, or does it include approvals and waiting? Is it one service or many? What happens when a deploy fails today?" Then reframe the problem before touching it. Weekly deploys are a **batch size** problem. A slow deploy makes each one expensive, so teams batch changes. A bigger batch carries more risk, so failures are more painful and harder to debug, which makes everyone more afraid to deploy, which makes them batch more. The loop feeds itself, and shortening the pipeline alone does not break it.

Give the loop a vocabulary the business recognizes. DORA's software delivery metrics are the standard: five of them, in two groups. Throughput is change lead time, deployment frequency, and failed deployment recovery time. Instability is change fail rate and deployment rework rate (rework rate was added in 2024; older material still teaches four metrics). Say which two you would move first: lead time and deployment frequency, while holding change fail rate flat. That last clause is the one that shows judgment.

### Measure first

In week one, break the 45 minutes into stages with real timestamps from your CI system and rollout events: queue wait, build, tests, image push, rollout, and any manual gates. Expect the distribution to be lumpy. Two stages usually account for most of the time, and it is rarely the one the team blames.

### The usual culprits, with mechanism

| Stage | Typical cause | Symptom you will see |
|---|---|---|
| Build | No layer cache, or dependencies installed before source is copied | Every build re-downloads the world; build time does not shrink on small changes |
| Test | One serial suite, shared test database | Wall time equals the sum of all tests; flaky reruns double it |
| Push and pull | Large images, cold nodes | Rollout waits on image pulls of hundreds of MB per new node |
| Rollout | Slow readiness probe times the number of surge batches, plus a large `minReadySeconds` | Rollout time = batches x (startup + probe delay + min ready) |
| Orchestration | Services deployed one after another, each waiting for the last | Total time is additive across services that do not depend on each other |
| Process | Manual approval gate, change window | Pipeline idle while a human is asleep |

A concrete example of the rollout row. A Deployment with 20 replicas, `maxSurge: 25%` and `maxUnavailable: 25%` replaces about 5 pods per batch, so 4 batches. If each pod takes 60 seconds to pass readiness and `minReadySeconds` is 30, that is 4 x 90 = 6 minutes for rollout alone. Tuning the probe and surge is cheap and shows up immediately.

### The plan: six months, two engineers

```text
Month 1      Measure and quick wins
             - stage timing dashboard (the baseline everyone trusts)
             - layer cache, dependency cache, shrink the base image
             - kill idle waits (queue capacity, approval timeouts)
Months 2-3   Parallelize
             - split and shard the test suite, run independent services concurrently
             - tune probes, surge, and image pre-pull on the hot path
Months 4-6   Make small deploys safe
             - progressive delivery: canary with automatic rollback on SLO breach
             - feature flags so deploying is separate from releasing
             - retire the approval gate once rollback is proven
```

The ordering is by leverage and by trust. Month 1 produces a visible win in weeks, which buys patience for the rest. Progressive delivery comes last because it is what lets the team deploy ten times a day without fear, and it only earns trust once the pipeline is fast enough to use it.

Say what you would not do. You would not rewrite the CI system, migrate CI vendors, or adopt a new deployment platform in the first quarter. With two engineers that is the plan that eats the six months and ships nothing.

**The catch.** Speed without a safety net raises change fail rate. If you cut the deploy to 8 minutes and rollback is still manual, the first bad release teaches the whole company that fast deploys are dangerous, and you have made the fear worse. The fix is the order above: canary and automatic rollback are not a luxury at the end, they are the thing that makes frequency safe.

**In business terms.** "Lead time from merge to production goes from days to under an hour, so a bug fix or a customer-requested change reaches users the same day, and each release is small enough that a failure is cheap to undo."

**Follow-ups to expect.** "What if the 45 minutes is mostly tests owned by other teams?" (You cannot fix it alone: show the data to the owners, propose a shared test-time budget, and shard what you can.) "How do you know it worked?" (Lead time and deploy frequency up, change fail rate flat or down, measured from the same baseline.)

---

## ★ Scenario 2: three teams, one piece of shared infrastructure

**The prompt.** "Three teams are fighting over shared infra ownership. How do you resolve it without making all three mad?"

**What they are really testing.** Influence without authority. Whether you treat this as a people problem or a structural one, and whether you can end up with something durable instead of a truce.

### Clarify and diagnose

Ask: "What is actually being fought over: who pays, who gets paged, who can change it, or who can block someone else's change? Is there an incident behind this?" The answer is almost never "they dislike each other". Ambiguous ownership produces conflict because every outage has three plausible owners and every change has three plausible vetoes. The bug is in the structure, and the people are reacting rationally to it.

### The plan

Start with one-on-ones, not a meeting. In a group, each team defends a position. Alone, each tells you the underlying fear: one is afraid of being paged for someone else's change, one is afraid of being blocked, one is afraid of the bill. Positions conflict; fears usually do not, and a design can address all three.

Then build the structure in this order:

1. **Ownership map.** List the shared components (ingress, cluster add-ons, node pools, observability, certificates) and give each a single accountable owner, plus who is consulted and who is informed. A one-page table is enough.
2. **Separate the substrate from the tenants.** A common resolution: the platform team owns the shared substrate and its upgrade cadence, each product team owns its namespace and workloads, and the boundary is enforced with RBAC, ResourceQuota, and a CODEOWNERS file on the configuration repository. Tenancy options (namespaces versus virtual clusters) are in the Kubernetes guide.
3. **Give each shared component an SLO.** An owner without a target is a janitor. A target gives the consumers something to hold the owner to and gives the owner something to defend.
4. **Write it down as a decision.** An ADR with the options considered and why this one won. People accept a decision they can argue with on paper more readily than one made in a hallway.
5. **Set a trial and a review date.** "We try this for a quarter and revisit" turns a win-lose negotiation into an experiment, and it lets the least happy team accept the change.
6. **Agree how disputes escalate**, in writing, before the next one happens.

Notice what is missing: you did not pick a winner. The goal is that each team gets the thing it cares about most and gives up the thing it cares about least.

**The catch.** Two failure modes. The first is "give everyone their own": it ends the argument today and triples cost and upgrade toil, because you now run three of everything and each drifts. The second is the consensus that nobody owns, where the meeting ends warmly with no accountable name. If you cannot point to one owner per component at the end, you have not resolved anything.

**In business terms.** "Every shared system has one accountable owner and a target, so an outage has a clear first responder and a change has a clear approver. That cuts time-to-restore and removes the weeks lost to waiting for three teams to agree."

**Follow-ups to expect.** "What if one team still refuses?" (Escalate with a written proposal and the cost of the status quo, not a complaint.) "What if you are wrong about the owner?" (That is what the review date is for.) The mechanics of influence are in "The Engineering Leadership Interview".

---

## ★ Scenario 3: the cloud bill doubled

**The prompt.** "Cloud bill doubled in six months. Nobody knows why. Walk me through your first week."

**What they are really testing.** Whether you start from data, whether you know where cloud money actually leaks, and whether your goal is a one-time cleanup or a system that stops it recurring.

### Clarify and bound

Ask: "Do I have access to billing data, and is anything tagged? Did traffic or headcount also double? Is there a committed-spend contract?" If usage doubled with revenue, the story is different from usage flat and cost doubled. State that you will separate **growth** (expected) from **waste** (not).

### Week one, day by day

```text
Day 1   Get billing export access (cost and usage report / billing export).
        Group by service, account/project, region, and tag. Chart the 6 months.
Day 2   Find the top 3 line items by growth, not by size. Costs are usually
        concentrated: 3 items often explain most of the increase.
Day 3   Allocate to owners. In clusters, break cost down by namespace and
        label (OpenCost, a CNCF incubating project, or the provider's
        cost tool). Compare requested resources to actual usage.
Day 4   Check the usual suspects (below) against the top items.
Day 5   Write the one-pager: where the money went, three quick wins with
        estimated savings, and why "nobody knows" (the visibility gap).
```

The comparison in day 3 is the one with the most Kubernetes content. The scheduler reserves capacity by **requests**, and you pay for nodes, not for usage. If pods request 4 CPUs and use 0.5, the cluster autoscaler keeps adding nodes to satisfy requests that are mostly empty. A quick way to see the gap on a live cluster:

```bash
# Requested vs actual, per node (needs metrics-server)
kubectl top nodes
kubectl describe nodes | grep -A 8 "Allocated resources"

# Actual usage per pod, to compare against each pod's requests
kubectl top pods -A --sort-by=cpu
```

Those commands show the shape of the problem, not the answer. The aggregate view that persists is a cost tool such as OpenCost, which attributes spend to namespaces and workloads over time and can report the gap between requested and used. Read the output as: large requested-but-unused capacity means overprovisioning, which is the most common single cause in Kubernetes-heavy bills.

### The usual suspects, with mechanism

- **Data transfer.** Cross-zone traffic between chatty services, and traffic through a NAT gateway (charged per GB processed, so a service pulling large images or datasets through it can dominate a bill). Symptom: a networking line item growing faster than compute.
- **Orphans.** Unattached volumes, forgotten snapshots, idle load balancers left behind by deleted workloads. Symptom: storage and load balancer lines that never shrink.
- **Observability ingestion.** Logs and metrics are billed on volume. A debug log level left on, or a metric with an unbounded label (high cardinality), multiplies cost with no change in traffic.
- **Autoscaler floors.** A minimum replica or node count set high during an incident and never lowered.
- **Non-production running 24/7.** Dev and staging at full size overnight and on weekends, roughly 70% of the hours in a week they sit idle.
- **Idle accelerators.** GPU nodes are expensive per hour, so one reserved but unused node is a visible line.
- **Pricing mismatch.** Everything on on-demand when stable load could be committed, or the reverse.

### What the plan produces

By the end of the week: a one-page breakdown, three quick wins with estimated savings each, and the missing piece that explains the title question, which is almost always **no tagging or allocation, so cost has no owner**.

**The catch.** Three traps. Cutting requests blindly to save money causes OOMKills and CPU throttling (see the OOMKilled versus throttling scenario in the Kubernetes guide), so rightsizing needs usage data over a representative window, including peaks. Buying commitments (savings plans, reserved instances) before rightsizing locks in the waste for one to three years. And a one-time cleanup decays: the lasting fix is **showback** (each team sees its own spend, weekly) and budgets or alerts per owner, so the next doubling is noticed in a week instead of six months.

**In business terms.** "In a week I can tell you where the increase came from and recover roughly X% of spend with no user impact. The ongoing fix is that every team sees its own bill, so cost becomes a design input and not a surprise."

**Follow-ups to expect.** "What if the growth is legitimate?" (Then the metric is unit cost: cost per request or per customer, which is what finance should track.) "How do you get teams to care?" (Showback first; chargeback only once the numbers are trusted.)

---

## ★ Scenario 4: everything is P0

**The prompt.** "You run a four-person platform team. Five teams each tell you their request is critical and due this quarter. How do you decide?"

**What they are really testing.** Prioritization under pressure, and whether you will say no in a way that keeps relationships intact.

### The plan

Do not rank by who shouts loudest or by who is most senior. Make the requests comparable first. For each, capture: who is affected and how many, what happens if it slips a quarter (the **cost of delay**), how risky and how reversible it is, and how much of your capacity it takes. Requests that look equal in urgency are rarely equal in cost of delay: a compliance deadline with a date and a penalty is different from a feature wanted sooner.

Then sequence:

1. Anything with a hard external deadline or a real reliability risk goes first.
2. Next, work that unblocks the most other teams, since one unblock multiplies.
3. Cheap, high-value items are batched so they do not each interrupt a larger effort.
4. The rest is declined or deferred explicitly, with a date to revisit.

Reserve a fixed slice of capacity for reliability and toil reduction (a common split is something like 20 to 30%), written down as policy, so urgent feature requests cannot quietly consume it. Then show the result as **options**, not a verdict: "With four people we can do A, B and C this quarter, or A and D. Here is what each choice costs." Leadership chooses between visible trade-offs, and the decision becomes theirs, not yours.

**The catch.** Saying yes to everything is the failure that looks like helpfulness: five things are started, none finishes, and every team is unhappy on the same day. The related trap is quietly prioritizing by your own taste. Naming the criteria publicly is what makes a "no" fair.

**In business terms.** "We ship the three items with the highest cost of delay and say plainly what slips, so the trade-off is a decision leadership made, not a surprise they discover in March."

**Follow-ups to expect.** "What if a VP overrides you?" (Show them the trade-off and what drops; if they still override, you have a recorded decision, not a conflict.)

---

## ★ Scenario 5: nobody uses the golden path

**The prompt.** "You built a paved road for deploying services. A year later about 20% of teams use it. What do you do?"

**What they are really testing.** Whether you treat the platform as a product with customers, or as a mandate to enforce.

### The plan

Treat low adoption as a signal about the product. Start by talking to the teams that did not adopt it, especially two or three who are respected: what did they try, what stopped them? Then measure friction instead of guessing. A strong metric is **time to first production deploy** for a new service on the path versus off it. If the path is slower than doing it by hand, no mandate will fix it for long.

The usual findings, and the corresponding move:

| What teams say | The real issue | The move |
|---|---|---|
| "It does not fit my service" | Path covers only the common case | Add the two most-requested variants; document an escape hatch |
| "It is slower than what I have" | Friction in the path | Cut the steps; measure time to first deploy weekly |
| "I do not trust it" | Opaque, breaks without explanation | Make failures legible; give a named on-call for the path |
| "We did not know it existed" | Discovery | Templates in the service generator, defaults in new repos |

Make the path the **easiest** option, not the only one. Keep an escape hatch for teams with real needs, but require them to say what the path lacked, because that feedback is your roadmap.

**The catch.** A mandate gets compliance without adoption: teams do the minimum, route around it, and resent it. A path that exists but is not the easiest is a document. And "we can enforce it in CI" is a tool, not a strategy: enforce the guardrails that matter for safety (security, cost tags) and let the rest compete on merit.

**In business terms.** "Time from new service to first production deploy drops from X days to Y hours, and the share of services on the supported path rises, which means fewer one-off setups to secure, upgrade, and page for."

**Follow-ups to expect.** "How do you measure the platform's success?" (Adoption by choice, time to first deploy, and the number of support requests per team falling.)

---

## ★ Scenario 6: a platform change took production down

**The prompt.** "A platform change you shipped caused a production outage. Leadership asks what changes so it never happens again. What do you say?"

**What they are really testing.** Ownership without blame, systemic thinking, and whether you can resist the overcorrection that makes a platform team useless.

### The plan

Open by owning it and by being specific about impact: duration, who was affected, how it was detected. Then run a blameless review, which asks "what in our system let one change do this?" rather than "who made the change". Look for the layered causes: why was the change not caught in review or test, why did it reach all clusters at once, why did detection take as long as it did, why was rollback slow?

Propose durable, mechanical fixes, not reminders:

- **Smaller blast radius.** Roll platform changes out in rings (a test cluster, a low-risk tenant, then everyone), with automatic halt on SLO breach.
- **Faster detection and rollback.** An alert on the symptom, and a rollback that is one command and has been rehearsed.
- **Close the test gap** that let it through, with a test that would have failed.
- **Frame the investment in error budgets and money.** If the platform's own SLO was breached, that is the lever for prioritizing reliability work over new features, and the cost of the outage in revenue or engineer hours is the justification.

Every action item needs one named owner and a date. A list without owners is the review's most common failure.

**The catch.** The overcorrection: "freeze all changes" or "add an approval for everything". It feels responsible, but it slows every future change, raises batch sizes (back to Scenario 1), and makes the next failure larger. The better answer replaces the single big gate with guardrails that make small changes safe.

**In business terms.** "Outage cost was X. The changes cap the blast radius of any single platform release to a small slice and cut time to recover from N minutes to M, so a similar failure becomes a minor incident instead of an outage."

**Follow-ups to expect.** "Whose fault was it?" (The system's: the answer is to describe the gap that let a normal change cause an outage, without naming a person.)

---

## Practice: lightning prompts

Each of these is a shorter scenario. Answer aloud with the skeleton, then check against the sketch.

**Justify a platform team's headcount.** Do not argue from workload; argue from leverage. Count the engineers the platform serves, the hours it saves them per week (time to first deploy, toil removed), and the incidents or compliance work it prevents, then compare the product to the team's cost. The catch: if you cannot measure what the platform saves, the first budget cycle will cut it.

**Leadership wants multi-cloud.** Ask what problem it solves: outage risk, contract leverage, a regulatory requirement, or fashion. Multi-cloud costs real engineering (lowest-common-denominator services, doubled tooling and skills, cross-cloud egress charges), so it is justified by a specific risk. Often the better answer is multi-region on one cloud plus a tested exit plan for the pieces that matter.

**Build versus buy for a managed service.** Apply the differentiation rule: build what is specific to your company and gives an edge; buy undifferentiated infrastructure. Count total cost, including the on-call and upgrade burden you would own. The catch: "we can run it cheaper" usually leaves out the people-hours.

**On-call is burning the team out.** Measure first: pages per shift, share that are actionable, time to resolve. Fix the noisy alerts and the top recurring causes before adding people, and make the on-call load a tracked number with an agreed ceiling. The catch: adding people to a noisy rotation spreads the pain without removing it.

**A senior engineer refuses the standard.** Find out why before assuming obstruction; they may be right about a gap. If the standard is right, give them a role in improving it. If a safety guardrail is at stake, hold the line through the mechanism (a CI check), not through a confrontation.

**A hard migration deadline with too little time.** Separate must-move from can-wait, migrate the riskiest dependency first, keep a rollback for each step, and bring the trade-off to the deadline's owner early as options: reduce scope, extend the date, or add people, with what each costs.

---

## Question bank

| Question | What they are testing | Concise answer |
|---|---|---|
| Deploys take 45 minutes. First step? | Measure before fixing | Break the time into stages with real timestamps; two stages usually dominate. |
| Why do slow deploys mean infrequent deploys? | Systems thinking | Batch size grows, risk grows with it, fear grows, so batches grow more. |
| Which delivery metrics do you track? | Business language | DORA's five: change lead time, deployment frequency, failed deployment recovery time, change fail rate, deployment rework rate. |
| How do you make fast deploys safe? | The catch | Canary with automatic rollback on SLO breach, plus feature flags to separate deploy from release. |
| What would you refuse to do in a six-month, two-person plan? | Prioritization | Rewrite CI or switch platforms; the plan that eats the budget and ships nothing. |
| Three teams dispute ownership. First move? | Influence | One-on-ones to find each team's underlying fear before any group meeting. |
| What makes an ownership agreement stick? | Durability | One accountable owner and an SLO per component, written as a decision, with a review date. |
| Why not give each team its own cluster? | Trade-offs | It ends the argument and triples cost, drift, and upgrade work. |
| The bill doubled. What do you look at first? | Data over guesses | Billing export grouped by service and tag; find the top 3 items by growth. |
| Where does Kubernetes cost hide? | Domain depth | Requested-but-unused capacity, cross-zone and NAT data transfer, orphaned volumes, log ingestion, idle non-prod and GPU nodes. |
| Why not just cut resource requests? | The catch | Blind cuts cause OOMKills and throttling; rightsize from usage over a window that includes peaks. |
| Why not buy a savings plan on day one? | Sequencing | It locks in waste for one to three years; rightsize first. |
| How do you stop the next doubling? | Systemic fix | Showback per team, tagging policy, and budget alerts per owner. |
| Five teams say P0. How do you choose? | Prioritization | Compare by cost of delay, risk, and capacity; show leadership explicit options. |
| Golden path adoption is low. What do you do? | Product thinking | Treat it as a product: interview non-adopters, measure time to first deploy, make it the easiest path, keep an escape hatch. |
| After an outage, leadership wants a change freeze. | Overcorrection | Replace the blanket gate with smaller blast radius, faster rollback, and guardrails. |
| How do you justify the platform team's cost? | Business translation | Engineers served times hours saved, plus incidents and compliance work avoided, versus team cost. |

---

## In the room

The strongest Staff answers sound like a plan from someone who has done it before, and the structure is what carries that. Say your assumptions out loud: "I will assume the 45 minutes is end to end." Ask two or three clarifying questions, then commit; an interviewer cannot grade a plan you never gave. Use numbers, even rough ones, because "reduce lead time from days to under an hour" lands where "make it faster" does not.

Say what you would deprioritize. Anyone can list work; naming what you would not start, and why, is the clearest evidence of judgment. Close each answer in business units: hours returned to engineers, dollars saved, incidents avoided, or time to recover.

Keep a real story behind each scenario. These prompts are hypothetical, but the follow-up is nearly always "have you done this?", and an answer that moves from the plan to "at my last company, we saw this pattern, and here is what changed" is far stronger. The adaptable templates in "The Senior Platform Engineer Interview" give you the shape, and "Depth That Survives Probing" shows how to back each claim with the mechanism that made it real.

Finally, be honest about scope. If you have run the cost review but not the ownership negotiation, say so and describe what you would do and what you would check, rather than claiming experience you cannot defend for two more questions.
