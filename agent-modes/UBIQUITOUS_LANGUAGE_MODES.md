# Ubiquitous Language - Agent Modes

## Mode Execution and Safekeeping

| Term | Definition | Aliases to avoid |
| ---- | ---------- | ---------------- |
| **Mode** | A named operational profile that restricts available tools and filters bash commands to enforce a specific safety level. | Profile, state, environment |
| **Mode definition** | A markdown file containing YAML frontmatter that declares a mode's configuration, tool safelist, bash policy, and prompt suffixes. | Config, policy markdown |
| **Bash policy** | The specific rule set (`strict_readonly`, `non_destructive`, or `off`) governing which terminal commands are permitted to run. | Command rules, shell filter |
| **One-shot bypass** | A prompt-driven single-use permission allowing a blocked tool or bash command to run once without altering the active mode. | Waiver, exception, skip |
| **Mode switch** | The process of transitioning the active execution environment from one mode to another. | Transition, profile swap |
| **Mode switch confirmation** | A confirmation dialog presented to the user before changing modes, unless bypassed by configuration. | Dialog, prompt switch |

## Delegation and Orchestration

| Term | Definition | Aliases to avoid |
| ---- | ---------- | ---------------- |
| **Orchestrator** | A coordination mode that delegates complex tasks to subagents instead of writing code directly. | Coordinator, dispatcher |
| **Subagent** | An isolated process spawned with a specific role and prompt instructions to perform a delegated task. | Worker, child agent |
| **Agent state** | The current execution phase of a running subagent (e.g., idle, thinking, working, done, error). | Roster phase, status |
| **Blitz** | A specialized orchestrator subagent optimized for fast codebase exploration and architectural mapping. | Recon, explorer |
| **Grind** | A specialized orchestrator subagent optimized for writing code, editing files, and running test suites. | Worker, builder |
| **Seeker** | A specialized orchestrator subagent optimized for searching the web and synthesizing findings. | Researcher, web scout |

## State and Configuration

| Term | Definition | Aliases to avoid |
| ---- | ---------- | ---------------- |
| **Session-scoped mode state** | A mechanism using UUID session IDs to persist the chosen mode across agent restarts within the same terminal session. | Persistent mode, session state |
| **Prompt suffix** | Mode-specific instructions appended to the system prompt to guide agent behavior. | System instruction, suffix |
| **User override** | A local configuration file (`~/.pi/modes/config.yaml`) that merges with and overrides built-in mode definitions. | Custom config, local settings |
| **Dynamic reload** | The hot-reloading of mode definitions and user overrides either manually via `/mode reload` or automatically upon file modifications. | Hot reload, refresh |

## Relationships

- A **Mode** is declared by a **Mode definition**, which configures a **Bash policy** and a **Prompt suffix**.
- A **Mode switch** transitions the agent's active **Mode**, which may trigger a **Mode switch confirmation**.
- An **Orchestrator** mode coordinates tasks by delegating to **Subagents** like **Blitz**, **Grind**, or **Seeker**.
- Each **Subagent** operates as an isolated process and transitions through different **Agent states**.
- A **One-shot bypass** permits a single execution of a blocked tool without triggering a **Mode switch**.
- **User overrides** modify the active configuration of a **Mode** without changing its original **Mode definition**.

## Example dialogue

> **Dev:** "I want to inspect this log file, but I'm currently in CODE mode. Do I need to perform a **mode switch** to PLAN?"
> 
> **Domain expert:** "No, you don't. CODE mode enables read-only tools by default. However, if you wanted to run a command restricted by CODE's **bash policy**, you could use a **one-shot bypass** to run it once."
> 
> **Dev:** "Ah, I see. What if I switch to **Orchestrator** mode? Can I edit the code directly?"
> 
> **Domain expert:** "The system prompt in **Orchestrator** mode discourages writing code directly. Instead, you should spawn a **Grind** **subagent** to handle the edits while you monitor its **agent state**."
> 
> **Dev:** "And if I want to customize how **Blitz** behaves locally, do I edit its **mode definition**?"
> 
> **Domain expert:** "No, you should define a **user override** in `config.yaml` to avoid modifying the shipped package files."

## Flagged ambiguities

- "State" was used ambiguously to refer to both the active **Mode** of the main session and the **Agent state** of a background subagent. These are distinct: the main session runs in a **Mode** (such as CODE or PLAN), whereas a spawned **Subagent** has an execution status tracking its lifecycle (**Agent state**).
- "Config" could refer to either the static **Mode definition** packaged with the extension or a **User override** written to `~/.pi/modes/config.yaml`.
- "Bypass" was occasionally used to mean a permanent rule change. In this domain, a **One-shot bypass** applies strictly to a single tool invocation and does not change the active **Mode or its baseline rules.
