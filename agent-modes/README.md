# pi-modes

Three-mode extension for the pi coding agent: **YOLO**, **PLAN**, and **ORCHESTRATOR**.

## Installation

```bash
npm install pi-modes
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
ln -s $(npm root)/pi-modes/dist/index.js ~/.pi/agent/extensions/modes.js
```

Or load directly:

```bash
pi --extension node_modules/pi-modes/dist/index.js
```

### Switching modes

- `/mode` — interactive mode picker
- `/mode status` — show current active tools and config
- `/mode yolo|plan|orchestrator` — switch immediately
- `/modes` — alias for `/mode`
- `Ctrl+Shift+M` — cycle modes (yolo → plan → orchestrator)

### CLI flag

```bash
pi --mode plan          # start in plan mode
pi --mode orchestrator  # start in orchestrator mode
pi --mode yolo          # start in yolo mode (default)
```

## Modes

### YOLO (default)
Full unrestricted access. All tools available. No additional restrictions.

### PLAN (read-only)
Safe exploration mode. Only read-only tools enabled:
- Allowed tools: `read`, `bash`, `grep`, `find`, `ls`, `questionnaire`
- Bash is shell-filtered: destructive commands (rm, git push, npm install, etc.) are blocked by the extension.
- edit/write/apply_patch are disabled by the harness

Useful for exploring codebases, understanding structure, and planning changes without risk.

### ORCHESTRATOR
Coordination mode. Full tool access, but system prompt encourages:
- Breaking tasks into subtasks
- Delegating to subagents using the `subagent` tool
- Tracking progress and synthesizing results

Requires the subagent extension to be loaded for full delegation capability.

## State persistence

Mode selection persists across sessions. The current mode is stored in session history and restored on startup.

## Configuration and Customization
Modes are defined by markdown files in `modes/` with YAML frontmatter:
```yaml
mode: yolo|plan|orchestrator
enabled_tools: []   # empty = all tools; omitted = legacy fallback; non-empty = exact list
description: "Brief UI description"
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
```
This configuration is merged over the built-in markdown definitions.

### Dynamic Reload
- Run `/mode reload` to immediately reload the mode definitions and your overrides.
- The `modes/` directory and your `config.yaml` are auto-watched. Edits trigger an automatic hot-reload when your turn ends.

## Migration
v0.2.1 (current): markdown-driven config, tool-level + shell-filtered safety in PLAN.
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
