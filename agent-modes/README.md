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
- Bash commands blocked: destructive operations (rm, mv, cp, mkdir, git write operations, npm install, etc.)
- Cannot edit or write files

Useful for exploring codebases, understanding structure, and planning changes without risk.

### ORCHESTRATOR
Coordination mode. Full tool access, but system prompt encourages:
- Breaking tasks into subtasks
- Delegating to subagents using the `subagent` tool
- Tracking progress and synthesizing results

Requires the subagent extension to be loaded for full delegation capability.

## State persistence

Mode selection persists across sessions. The current mode is stored in session history and restored on startup.

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
