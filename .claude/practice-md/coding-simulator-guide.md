## When you reach for this

You have an upcoming coding interview. You want timed, autograded reps on real task types: async JavaScript, REST aggregation, React components, Python data wrangling, SQL window functions. Paid platforms give you generic problems and a fixed timer. This setup gives you a Claude Code agent that acts as a strict proctor and autograder, driven entirely by a spec file you write once and reuse as many times as you like.

You type `done`, and the agent runs your code against hidden test suites, returns a `VERDICT`, a score out of ten, and a count of passed and failed cases. You control the pace; the agent controls the grading.

---

## The mental model

**What it is.** Two files do everything: a driver spec and a content bank. The driver is a Markdown document you load into a Claude Code context; it defines the agent's behaviour for an entire session. The content bank is a second Markdown file holding task statements, sample cases, and reference solutions. The agent reads the bank at startup, hides the solutions, and scaffolds one task at a time into a local `practice/` directory.

**Why it works.** Claude Code can execute shell commands, write files, and read test output. That is exactly what an autograder does. The driver spec turns those raw capabilities into a structured session: one active task, a waiting state, a deterministic validation trigger, and a scoring report.

**The catch.** The agent's behaviour is only as strict as the driver you write. A vague driver will give helpful hints unprompted, reveal solutions early, or pass sloppy code. The patterns in the sections below are deliberate: they name every rule the driver must enforce so you can copy or adapt them.

---

## Setting it up

**Prerequisites.** The simulator relies on standard local toolchains. Verify them once before the first session:

```bash
node --version          # need v18 or later for the built-in test runner
python3 --version       # need 3.9 or later
python3 -c "import sqlite3, sys; print('sqlite', sqlite3.sqlite_version)"
```

All three commands should succeed. If they do not, install the missing runtime first. The agent will run this same check silently at session start and tell you if anything is missing.

**React tasks only.** One task type needs npm packages (Vitest, jsdom, Testing Library). The agent installs them on demand inside the task's own directory. Nothing touches your global environment.

```bash
cd practice/task-4.1-react-search && npm install && npm test
```

If `npm install` fails in a locked environment, the agent falls back to a manual rubric: it reads your component against a checklist of five required behaviours and scores it without running a test runner.

**Repo layout.** Your project needs two directories:

```text
.claude/
  driver.md          ← the behaviour spec (see section below)
  tasks.md           ← task statements + reference solutions (hidden)
practice/            ← created at session start; never commit this
  PROGRESS.md        ← running scorecard, updated after each task
  task-1.1-slug/
    PROMPT.md        ← the task statement
    solution.mjs     ← your code goes here
    solution.test.mjs← hidden tests (written by the agent at scaffold time)
```

The `practice/` directory is ephemeral. Add it to `.gitignore`. The driver and task bank belong in `.claude/` alongside any other Claude Code configuration.

---

## The driver: what it enforces

The driver spec is a plain Markdown document that opens with an instruction like "You are a coding interview proctor." Everything below that line defines the agent's rules for the session. The rules that matter most:

**One task at a time.** The agent scaffolds exactly one task, then waits. It does not create the next task directory until you issue `proceed`. This mirrors the locked-down conditions of a real platform where you cannot jump ahead.

**Stub only, never solve.** When the agent creates `solution.mjs` (or `solution.py`, `solution.jsx`, etc.), it writes a stub with the required export signature and a `// TODO` comment. It does not write any implementation, even if you ask. The content bank's reference solutions are used for grading only, not shown.

**Wait for the trigger.** The agent does not run your code automatically when you edit the file. You type `done` or `validate` in the chat to trigger execution. This prevents the agent from grading partially finished code.

**Grade tough.** Passing the provided sample cases but failing an edge case is a FAIL. The hidden test suite always includes boundary conditions: empty input, a single element, a large input for time complexity, rejection handling for async tasks, concurrent access for queue tasks. If you would pass the sample but not the edges, you need to know that.

**Report format.** Every verdict follows the same structure, making it easy to scan a session's output:

```text
VERDICT: PASS
SCORE:   8/10
Tests:   6 passed, 0 failed
```

After the verdict the agent explains your approach, notes what you missed, and suggests one concrete improvement. It then waits for `proceed`.

---

## The command vocabulary

You drive the entire session from the chat input. The agent recognises these commands:

| Command | What it does |
|---|---|
| `done` / `validate` | Run the hidden tests against your current solution and report the verdict |
| `proceed` / `next` | Scaffold the next task and wait |
| `hint` | Give one targeted hint, no code. Can only be used once per task |
| `solution` | Reveal the reference solution. Marks the task as "reviewed, not solved" in PROGRESS.md |
| `skip` | Mark the task as skipped and scaffold the next one |
| `timer N` | Tell the agent the elapsed minutes. It flags tasks that exceed their budgeted time |
| `redo` / `reset task` | Wipe the task directory, re-scaffold a clean stub, and restart the clock |
| `harder` | After a PASS, add one additional edge-case test and re-validate |
| `status` | Print the current PROGRESS.md scorecard |
| `summary` | End the session: print totals, strengths, the one pattern to drill, and a readiness call |

The most useful command after a FAIL is `hint`, not `solution`. The point is to find the edge case yourself.

---

## How validation actually runs

Each task type uses a different runner. The agent picks the right one automatically based on the task.

**JavaScript / Node (most tasks).** Solutions are ES Modules that export named functions. Tests use the built-in Node test runner introduced in Node 18, so no test-framework install is needed:

```bash
node --test practice/task-1.1-promise-all/
```

The test file (`solution.test.mjs`) imports from `./solution.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promiseAll } from './solution.mjs';

test('preserves order', async () => {
  const result = await promiseAll([Promise.resolve(1), Promise.resolve(2)]);
  assert.deepEqual(result, [1, 2]);
});
```

**The catch for JS tasks.** Your function must match the exact export signature the test file expects. If you export `myPromiseAll` instead of `promiseAll`, every test fails with an import error, not an assertion error. The stub the agent creates always has the correct signature.

**Python stdin tasks.** Some tasks read from stdin and write to stdout, matching the classic competitive-programming format. The test file pipes fixture data and diffs the output:

```bash
python3 practice/task-5.1-distinct-counts/test_5_1.py
```

Inside that test file, each case calls `subprocess.run` with `input=fixture` and checks `stdout` against the expected string. The only import your `solution.py` needs is from the standard library.

**Python pandas tasks.** The agent checks for pandas first and installs it only if missing:

```bash
python3 -c "import pandas" 2>/dev/null || pip install pandas
python3 practice/task-5.2-top-organism/test_5_2.py
```

**The catch for pandas tasks.** The test calls your function with a specific DataFrame schema. If you change column names or return a Series instead of a DataFrame, you get a KeyError or an assertion on shape rather than values. The PROMPT always specifies the expected return shape.

**SQL tasks.** You write one `.sql` file containing a single `SELECT` query. The test runner creates an in-memory SQLite database, seeds it with fixture data, executes your query, and compares the result set:

```bash
python3 practice/task-6.1-sql-join/test_sql.py 6.1
```

**The catch for SQL tasks.** The local runner uses SQLite, but a real platform runs PostgreSQL or MySQL. Window functions like `ROW_NUMBER() OVER (...)` work in all three, but PostgreSQL-specific syntax (for example `FILTER (WHERE ...)` or certain date functions) will silently pass locally and fail on the platform. Write ANSI SQL unless the PROMPT says otherwise.

**React tasks.** These are the only tasks that need npm packages. The agent sets up a minimal Vitest + jsdom harness in the task directory:

```bash
cd practice/task-4.1-sample-search && npm install && npm test
```

The harness uses `@testing-library/react` and `@testing-library/user-event`. Your component must be a default export from `solution.jsx`. The test mounts it, fires user events, and asserts on DOM state.

**The catch for React tasks.** Race conditions involving stale async responses are always tested. If your component does not cancel a pending fetch before starting a new one (via `AbortController` or a request-ID ref), the test that fires two searches in quick succession will fail. This is intentional: it is the senior-level signal interviewers look for.

---

## A session, end to end

The GIF below shows a complete task cycle: the agent scaffolds a task, the user codes, types `done`, receives a PASS with score and test breakdown, then issues `proceed` to move on.

<iframe width="700" height="394" src="https://www.youtube.com/embed/m0CzZh_tIw4" title="Coding interview simulator: sample session" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen style="display:block;max-width:100%;border-radius:6px;"></iframe>

The full text flow for a single task looks like this:

```text
Agent:  Task 1.1: promiseAll
        Time budget: 12 minutes
        File ready: practice/task-1.1-promise-all/solution.mjs

[you edit solution.mjs]

You:    done

Agent:  Running: node --test practice/task-1.1-promise-all/

        VERDICT: PASS
        SCORE:   9/10
        Tests:   4 passed, 0 failed

        Your solution uses Promise.all internally (fine for this task).
        Note the hidden test for rejection: it expects the returned promise
        to reject with the first reason, which Promise.all handles correctly.
        You got all four cases. One mark off for not guarding the empty-array
        edge in your own logic (the built-in covers it, but the check shows
        you reasoned about it).

        Type "proceed" for the next task or "harder" to add an edge case.

You:    proceed
```

Each task directory stays on disk after you move on. You can revisit any solution after the session ends, or diff it against the reference after typing `solution`.

---

## Building your own task bank

A task bank is a Markdown file with two sections: task statements above a `## Reference Solutions` heading, and the solutions below it. The agent reads the whole file at startup, treats everything above the heading as the task catalogue, and uses everything below only for post-validation grading.

**Task structure.** Each task needs four things:

```text
### 1.1 Task slug (time budget)

[Two or three sentences: what the function signature is, what it does, the key constraint.]

**Sample:**

[Input and expected output, in plain text or a code block]
```

Keep the statement concise. The PROMPT.md the agent scaffolds comes directly from this text. If the statement is ambiguous, the agent will ask one clarifying question before scaffolding.

**Writing injectable tests.** For tasks that touch external state (network calls, timers, a database), the test must be able to inject a mock. The most reliable way is to add the dependency as a parameter:

```js
// Bad: the test cannot intercept globalThis.fetch
export async function getOrganismCounts() {
  const res = await fetch('/api/samples?page=1');
  // ...
}

// Good: the test passes in a mock; the real caller passes in fetch
export async function getOrganismCounts(fetchPage = fetch) {
  const res = await fetchPage('/api/samples?page=1');
  // ...
}
```

This pattern also makes it possible to test bounded-concurrency logic: the mock tracks how many calls are in flight simultaneously, and the test asserts that the number never exceeds the limit.

**Time budgets.** Assign each task a budget based on its cognitive load, not its line count. A twelve-line async pool implementation that requires reasoning about a shared cursor and a fill-loop deserves eighteen minutes. A ten-line SQL join deserves ten. When you issue `timer N` mid-task, the agent flags overruns in PROGRESS.md so your summary can call out where time leaked.

**Reference solutions.** Put them below the `## Reference Solutions` heading, labelled with the same task ID. The agent uses them for grading and can show them on `solution` command, but never before a validated attempt.

---

## How to get the most from it

**Simulate exam conditions.** Close your references before the session. Type `timer 0` when you open the first task so elapsed time is tracked from the start. The point is to surface the gap between "I know this concept" and "I can produce correct code under time pressure."

**Attempt before `solution`.** The reference solution is there as a calibration tool, not a shortcut. If you use `solution` before attempting, the task is marked "reviewed, not solved" in PROGRESS.md and does not count toward your score. That is an honest signal: you read it, not did it.

**Trust the `summary` command.** At the end of a session, `summary` prints the one pattern that caused the most time loss or the most failures. That single pattern is what you drill next. A session where you passed seven tasks but all three FAIL cases involved off-by-one errors in async concurrency control tells you exactly what to practice next time.

**Add tasks incrementally.** Start with five or six tasks covering your known weak spots. After the first session, `summary` will name one or two more. Add those to the bank and run again. The bank grows toward the actual interview, not away from it.
