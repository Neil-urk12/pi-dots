# pi-agent-modes

Multi-mode extension for the pi coding agent: **YOLO**, **PLAN**, **CODE**, **ASK**, and **ORCHESTRATOR**.

## Installation

```bash
npm install @neilurk12/pi-agent-modes
```

Or link for local development:

```bash
npm link
```

## Usage

### As a pi extension

Place the extension in pi's extensions directory:

```bash
# After npm install, pi will auto-discover from node_modules
# Or symlink/copy to ~/.pi/agent/extensions/
ln -s $(npm root)/@neilurk12/pi-agent-modes/dist/index.js ~/.pi/agent/extensions/modes.js
```

Or load directly:

```bash
pi --extension node_modules/@neilurk12/pi-agent-modes/dist/index.js
```

### Switching modes

- `/mode` — interactive mode picker
- `/mode status` — show current active tools and config
- `/mode yolo|plan|code|ask|orchestrator` — switch immediately
- `/modes` — alias for `/mode`
- `Ctrl+Shift+M` — cycle modes (yolo → plan → code → ask → orchestrator)

### CLI flag

```bash
pi --mode plan          # start in plan mode
pi --mode orchestrator  # start in orchestrator mode
pi --mode yolo          # start in yolo mode (default)
pi --mode ask           # start in ask mode
pi --mode code          # start in code mode
```

## Modes

### YOLO (default)
Full unrestricted access. All tools available. No additional restrictions.

### PLAN (read-only)
Safe exploration mode. Only read-only tools enabled:
- Allowed tools: `read`, `bash`, `grep`, `find`, `ls`, `questionnaire`
- Bash policy: `strict_readonly` (read-only command safelist)
- edit/write/apply_patch are disabled by the harness

Useful for exploring codebases, understanding structure, and planning changes without risk.

### CODE
Full editing and development tools with non-destructive command protection. All tools available like YOLO, but bash commands are filtered:
- Bash policy: `non_destructive` (blocks rm -rf, git push, sudo, npm install, redirects, etc.)
- Differences from YOLO: bash protection, safety-focused prompt

Useful for active development with safety net against accidental data loss.

### ORCHESTRATOR
Coordination mode. Full tool access, but system prompt encourages:
- Breaking tasks into subtasks
- Delegating to subagents using the `subagent` tool
- Tracking progress and synthesizing results

Requires the subagent extension to be loaded for full delegation capability.

### ASK
Clarification-first mode. Enabled tools: `read`, `bash`, `grep`, `find`, `ls`, `questionnaire`. Bash policy is `strict_readonly`. Gather requirements before any implementation — no code changes.

## State persistence

Mode selection persists across sessions. The current mode is stored in session history and restored on startup.

## Configuration and Customization
Modes are defined by markdown files in `modes/` with YAML frontmatter:
```yaml
mode: yolo|plan|code|ask|orchestrator
enabled_tools: []   # empty = all tools; omitted/empty = baseline tools; non-empty = exact list
bash_policy: strict_readonly|non_destructive|off
border_label: " LABEL "
border_style: accent|warning|success|muted
prompt_suffix: |           # system prompt injected before each request
  [MODE: ...]
  instructions...
```

### User Overrides
You can override any mode configuration locally by creating a YAML file at `~/.pi/modes/config.yaml`:
```yaml
plan:
  border_label: " MY PLAN "
  enabled_tools:
    - read
    - bash
  bash_policy: strict_readonly
```
This configuration is merged over the built-in markdown definitions.

### Dynamic Reload
- Run `/mode reload` to immediately reload the mode definitions and your overrides.
- The `modes/` directory and your `config.yaml` are auto-watched. Edits trigger an automatic hot-reload when your turn ends.

v0.2.2 (current): markdown-driven config with mode-specific `bash_policy`, enforced via `mode-tool-policy`.
v0.2.1: markdown-driven config, initial shell-filtered safety in PLAN.
v0.1.x → v0.2.x: replace extension files; modes/*.md included; no config migration needed.
## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Watch mode
npm run watch
```

Then symlink/dist to `~/.pi/agent/extensions/` for testing.

## License

MIT
