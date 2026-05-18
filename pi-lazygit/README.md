# pi-lazygit

Pi extension that opens [lazygit](https://github.com/jesseduffield/lazygit) in a popup terminal.

## Install

```bash
pi install pi-lazygit
```

Or add to your pi config manually:

```json
{
  "extensions": ["pi-lazygit"]
}
```

## Usage

| Method | Action |
|--------|--------|
| `/lazygit` | Command palette |
| `Ctrl+Shift+G` | Keyboard shortcut |

Opens lazygit fullscreen in the current repo. Returns to pi when you quit (`q`).

## Requirements

- [lazygit](https://github.com/jesseduffield/lazygit#installation) installed and on `PATH`
- Pi running in TUI mode

## How it works

Stops the TUI, spawns lazygit with inherited stdio (fullscreen takeover), then restarts the TUI on exit. Uses async `spawn` so the TUI event loop stays unblocked.
