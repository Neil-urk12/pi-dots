# nano-team Context

The nano-team extension spawns isolated pi subprocesses (**Subagents**) from a YAML-defined **Team** and renders their state as an animated chip row above the editor. This file records domain terms that are *architecturally load-bearing inside this package* — distinct from the project-wide domain glossary in [`../UBIQUITOUS_LANGUAGE.md`](../UBIQUITOUS_LANGUAGE.md), which defines the same terms at the pi-dots level.

## Language

### Subagent module

**Subagent** (in this package):
A single deep module owning the entire lifecycle of one or more named pi subprocesses — spawn, state transitions, stream parsing, concurrency, abort, shutdown — behind one small interface (`spawn`, `kill`, `list`, `get`, `subscribe`, `shutdown`).
_Avoid_: Runner, pool, orchestrator, SubagentPool, lifecycle manager

The Subagent module is the *only* external seam callers cross. Internally it composes a run store, a handle store, a semaphore, a stream accumulator, and a pi invocation resolver — none of which appear in its interface. The `ProcessFactory` seam (production: `ChildProcessAdapter`; test: fake with `PassThrough` streams) is an *internal* seam of the Subagent module.

**Agent run** (`AgentRun`):
The terminal-shaped snapshot of one named subagent's execution: state, transcript, activity, lastError, startedAt/endedAt, pid. Readonly. Updated on every state transition; subscribers see the new snapshot via `list()` / `get()`.
_Avoid_: job, task result, execution record

**Agent state** (`AgentState`):
The five-state machine `idle → thinking → working → done|error`. Terminal states (`done`, `error`) are absorbing within a single spawn cycle. A subsequent `spawn` of the same name starts fresh from idle semantics.
_Avoid_: status, phase, lifecycle stage

### Team

**Team member** (`TeamMember`):
A YAML-defined configuration record (`name`, `role`, `model`, `instructions`, `task`, `sourceFile`) used as the input to `Subagent.spawn`. Data, not behavior.
_Avoid_: agent config, agent definition, profile

**Roster**:
The `Map<string, TeamMember>` produced by loading YAML files from the global (`~/.pi/agent/nano-team/team/`) and local (`.pi/nano-team/team/`) directories. Local overrides global by source-file order; duplicate names are reported as load errors, not silent merges.

### Rendering

**Chip**:
The visual unit rendered by the widget module: face (eyes + mouth animated per state) + name + role + activity line, wrapped in a bordered box. One chip per active AgentRun.
_Avoid_: widget, card, tile

**Widget flusher**:
The debounced render loop (`schedule` / `cancel` / `tick`) that subscribes to Subagent state transitions and pushes chip rows to the pi UI sink. Owns the animation frame interval for live states (`thinking`, `working`).
_Avoid_: renderer, update loop, view controller

## Relationships

- A **Team** is loaded once per session; the **Subagent** module is created with a `cwd` and resolves its own pi invocation.
- `Subagent.spawn(member, task, signal) → Promise<AgentRun>` is the primary call path from the tools module.
- The **widget flusher** subscribes to Subagent transitions (push) and reads `Subagent.list()` inside `tick()` (pull).
- **Chips** are a pure function of `(runs, team, terminalCols, theme, frameIndex)` — the widget module has no knowledge of Subagent internals.
