---
name: nano-team
description: |
  Delegate work to focused subagents running in isolated pi subprocesses.
  Use for code review, codebase recon, implementation handoffs, and
  parallel audits. Built-in agents: blitz (scout), grind (worker),
  yen (deep reviewer), seeker (web researcher). Tools: nano_agent_spawn,
  nano_agent_kill, nano_agent_status, nano_agent_aggregate, nano_agent_chain.
---

# nano-team

`nano-team` lets you delegate work to focused subagents — each runs as its own pi subprocess, with its own tools, and returns a final output you can act on. Five tools, four built-in agents, no extra setup.

## When to delegate

Delegate when the work fits one of these shapes:

- **It would dominate your context** — investigating a large module, reading dozens of files, or running long searches.
- **It's parallelizable and non-conflicting** — e.g. four independent reviews on the same diff.
- **You want a fresh perspective** — a reviewer or auditor with no bias from having written the code.
- **It's a repeatable cycle** — implementation → review → fix → review. The subagent does one cycle.
- **It's primarily read-only** — recon, code search, doc lookup, web research.

If the work is short, sequential, and tightly coupled to your current reasoning, do it inline.

## Tools

- `nano_agent_spawn(name, task?, timeoutMs?)` — run a named agent. `task` overrides the agent's default `task`. Returns the final output.
- `nano_agent_kill(name)` — abort a running agent.
- `nano_agent_status(name?)` — inspect one agent's run, or list all.
- `nano_agent_aggregate(tasks, aggregator, timeoutMs?)` — run N agents in parallel; an `aggregator` then sees all their outputs via `{previous}`.
- `nano_agent_chain(steps, timeoutMs?)` — run agents sequentially, substituting each step's output for `{previous}` in the next step's `task`.

A `task` is a string. In `aggregate` and `chain`, reference prior outputs with the literal token `{previous}` inside the next agent's `task` field.

## Built-in agents

| Name    | Role            | Use for                                                              |
|---------|-----------------|----------------------------------------------------------------------|
| `blitz` | scout           | Read-only recon, code search, mapping a module with file:line citations |
| `grind` | worker          | End-to-end implementation: edit, run tests/build, report            |
| `yen`   | deep reviewer   | Review-only audit with severity-tiered findings and evidence         |
| `seeker`| web researcher  | Open-web research with citations and untrusted-source handling       |

You can pass a per-run `task` string that overrides the agent's default. Example: `nano_agent_spawn("blitz", "Where is the team loader and what does it do?")`.

## The review loop (recommended pattern)

The canonical pattern for "implement, then review":

1. `nano_agent_spawn("grind", "<task>")` — implementation
2. Read the diff grind reports
3. `nano_agent_spawn("yen", "Review the diff grind just produced.")` — review
4. Apply the `worth-fixing-now` findings yourself (or hand them back to grind with a new task)
5. Done

`yen` returns findings split by severity (`blocker` / `worth-fixing-now` / `optional` / `ignore`). The parent — you — decides which to act on. Do not auto-apply everything yen reports; treat `optional` as a question and `ignore` as already considered.

## Composition recipes

### Parallel research and recon (`nano_agent_aggregate`)

```
nano_agent_aggregate({
  tasks: [
    { name: "blitz", task: "Map the loader module in this repo." },
    { name: "seeker", task: "Find the upstream pi-subagents skill specification." },
  ],
  aggregator: { name: "blitz", task: "Synthesize the prior two outputs into a single briefing. Local recon: {previous[0]}. External research: {previous[1]}." },
})
```

The aggregator is itself a named agent. `{previous[0]}`, `{previous[1]}`, etc. index into the parallel results in declared order.

### Aggregator tasks: synthesize, don't verify

The wrapper has already substituted `{previous[N]}` into the aggregator's `task`. The aggregator should consume those outputs, not re-verify whether the upstream tasks ran. Asking it to call `nano_agent_status` to "confirm all three completed" wastes tokens — `nano_agent_status` returns a snapshot the LLM can misread, and the substituted text already tells the aggregator whether a run produced output.

Good — synthesis:

```
aggregator: { name: "blitz", task: "Synthesize these three reports into a single recommendation. {previous[0]} {previous[1]} {previous[2]}" }
```

Bad — invites failure verification:

```
aggregator: { name: "blitz", task: "Confirm all three completed and report any failures. {previous[0]} {previous[1]} {previous[2]}" }
```

### Sequential pipeline (`nano_agent_chain`)

```
nano_agent_chain({
  steps: [
    { name: "blitz", task: "Map the current auth flow." },
    { name: "grind", task: "Refactor the auth flow per this analysis: {previous}." },
    { name: "yen",   task: "Review the refactor. Report findings only." },
  ],
})
```

Each step receives the previous step's final output via `{previous}`.

## Hard boundary

**Do not pass `nano_agent_spawn` to a child.** Children get the tools they need for their task; they do not recursively delegate. If a child needs something, the parent handles it. This prevents recursive fanout and keeps the parent in control of work distribution.

If you need a child to talk back during a long run, surface that need in the task description — the child will write it into its final output, and you'll see it when the run completes. There is no synchronous backchannel in this extension.

## Modifying the roster

Add your own agents:

- **Local project**: `<project>/.pi/nano-team/team/<name>.yaml` — YAML only, full override
- **User home**: `~/.pi/agent/nano-team/team/<name>.yaml` — YAML only, applies to all projects
- **Built-in**: `agents/<name>.md` ships with the package; copy it to a local or global location to shadow it

Resolution order, highest priority first:

1. Local project
2. User home
3. Built-in (shipped with the package)

A file with the same `name` as a built-in shadows the built-in. Use this to customize `blitz` for your team's conventions without forking the package.

`/reload` after editing. Run `/subagents-doctor` to diagnose if anything fails to load.
