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
The `Map<string, TeamMember>` produced by loading from three tiers, lowest priority first: built-in `agents/*.md` (shipped with the package), then global `~/.pi/agent/nano-team/team/*.yaml`, then local `<cwd>/.pi/nano-team/team/*.yaml`. Each tier processes its files in source order. Within a single tier, duplicate names are reported as load errors and the first-loaded entry wins. Across tiers, the higher-priority tier silently overrides the lower — so a user-defined `blitz.yaml` shadows the shipped `blitz.md` without erroring.

**Built-in agent**:
An agent definition shipped inside the `nano-team` package (`agents/*.md`), loaded as the lowest-priority overlay. May be shadowed by a same-name file in the global or local team directories. _Avoid_: default agent, stock agent, builtin.

### Rendering

**Chip**:
The visual unit rendered by the chip display: face (eyes + mouth animated per state) + name + role + activity line, wrapped in a bordered box. One chip per live `AgentRun` (live = `thinking` or `working`).
_Avoid_: widget, card, tile

**Chip row**:
The whole "animated chip row above editor" — a single deep module (`src/chip-display.ts`) that owns the debounced render loop, the animation interval for live states, and the pure chip rendering. Exposes a 3-method lifecycle (`schedule`, `cancel`, `dispose`); the pure `renderChips` is a named-export so tests can target the rendering without crossing the animation seam.
_Avoid_: widget flusher, renderer, update loop

## Relationships

- A **Team** is loaded once per session; the **Subagent** module is created with a `cwd` and resolves its own pi invocation.
- `Subagent.spawn(member, task, signal) → Promise<AgentRun>` is the primary call path from the tools module.
- The **chip row** subscribes to Subagent transitions (push) and reads `Subagent.list()` inside its animation tick (pull).
- **Chips** are a pure function of `(runs, team, terminalCols, theme, frameIndex)` — the chip-display module has no knowledge of Subagent internals.
