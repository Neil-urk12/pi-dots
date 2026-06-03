# Ubiquitous Language

## Extensions

| Term             | Definition                                           | Aliases to avoid        |
| ---------------- | ---------------------------------------------------- | ----------------------- |
| **Extension**    | A pi package that adds behavior, UI, or tooling to the agent | Plugin, module, addon |
| **Footer**       | A powerline-style status bar rendered at the bottom of the terminal | Status bar, bar |
| **Segment**      | One configurable component inside the footer (model, git, tokensFull, cost, etc.) | Field, panel, widget |
| **Layout**       | A named arrangement of footer segments for a given terminal width | Arrangement, row |
| **Width tier**   | A terminal-width threshold that selects a specific footer layout | Breakpoint, tier |

## Modes

| Term               | Definition                                              | Aliases to avoid        |
| ------------------ | ------------------------------------------------------- | ----------------------- |
| **Mode**           | A named operational profile that controls tool access and behavior | Profile, state, mode |
| **Mode definition**| A markdown file with YAML frontmatter declaring a mode | Config, rule, policy |
| **Prompt suffix**  | Text injected into the system prompt when a mode is active | Prefix, injection, prompt |
| **Bash policy**    | The rule set governing which bash commands a mode allows | Bash rule, shell policy |
| **One-shot bypass** | A single-use allowance for a tool or command blocked by mode policy | Skip, exception, waiver |
| **Mode switch**    | The act of changing from one mode to another | Transition, change |

## Subagents and teams

| Term              | Definition                                           | Aliases to avoid        |
| ----------------- | ---------------------------------------------------- | ----------------------- |
| **Subagent**      | An isolated pi process spawned to perform a delegated task | Worker, mini-agent, child agent |
| **Team**          | A named roster of subagents defined in YAML for repeated use | Agent pool, roster, nano-team |
| **Agent state**   | The current lifecycle phase of a subagent run (idle, thinking, working, done, error) | Status, phase |

## Configuration and providers

| Term               | Definition                                              | Aliases to avoid        |
| ------------------ | ------------------------------------------------------- | ----------------------- |
| **Preset**         | A bundled named configuration for the footer (default, minimal, compact, dense, focus, muted) | Template, theme, scheme |
| **Model alias**    | A short display name mapped to a full model identifier | Nickname, shorthand |
| **Provider**       | A backend that supplies models to pi, registered via config | Gateway, backend, source |
| **User config**    | A local configuration file layered over built-in defaults | Override, local config, user settings |
| **Permission action** | A per-tool access decision (allow, ask, deny) enforced by mode policy | Action, decision, rule |

## Relationships

- An **Extension** provides **Segments** arranged by **Layouts** selected by **Width tier**.
- An **Extension** may be configured via **Presets** and **User config**.
- A **Mode** is defined by one **Mode definition** and enforces a **Bash policy**.
- A **Mode** may inject a **Prompt suffix** and grant **Permission actions** per tool.
- A **Subagent** belongs to exactly one **Team** and progresses through **Agent states**.
- A **Mode switch** can trigger a **Mode switch confirmation** unless the mode sets `auto_mode_switch: true`.
- A **One-shot bypass** is consumed after a single blocked tool use and does not change the active **Mode**.

## Example dialogue

> **Dev:** "When I switch to PLAN mode, can I still run `bash`?"
>
> **Domain expert:** "Yes, but PLAN applies `strict_readonly`. If you need a write command, you either switch modes or use a **one-shot bypass** for that single call."
>
> **Dev:** "So the bypass doesn't change the active **Mode**?"
>
> **Domain expert:** "Correct. It just lets one blocked tool execute once, then it's consumed. The **Mode definition** stays the same."
>
> **Dev:** "And ORCHESTRATOR delegates to **Subagents** from the **Team** instead of doing the work inline?"
>
> **Domain expert:** "Exactly. Each **Subagent** has its own **Agent state**, and the orchestrator tracks progress with todos. It never edits code itself — it delegates to grind or recon to blitz."

## Flagged ambiguities

- "config" was used to mean both **Mode definition** and **User config** — a **Mode definition** is the markdown/YAML shipped with an extension, while **User config** is local override JSON/YAML layered on top.
- "mode" was used without qualification in earlier drafts here — the precise terms are **Mode** (an operational profile), **Mode definition** (its declaration), and **Mode switch** (the action of changing modes).
- "agent" was used for both the main pi **Agent** and runtime **Subagent** workers — in pi-dots these are distinct: the main agent delegates, while a **Subagent** runs as an isolated process with its own **Agent state**.
- "layout" was used to mean both a **Layout** arrangement and a **Width tier** selection rule — a **Layout** is the segment arrangement, selected by the highest **Width tier** less than or equal to the current terminal width.
