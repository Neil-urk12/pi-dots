# pi-clean-footer

Clean, minimal, and lightweight powerline-style footer extension for [pi](https://pi.dev).

Shows a compact split footer:

![pi-clean-footer example](https://ik.imagekit.io/tqjjsoud1y/example.webp)

## Features

- Smart short model names, plus thinking effort (`low`, `med`, `high`, `xhigh`)
- Current directory basename only
- Git branch + dirty file count, including untracked files
- Event-driven git refresh after file-changing tools and user bash commands
- Context usage as `used/max`
- Cumulative active-branch token totals: input, output, total, cache read, cache write
- Adaptive width tiers for narrow terminals
- `/footer` toggle
- `/footer refresh` force refresh

## Install

From npm (recommended) | https://www.npmjs.com/package/@neilurk12/pi-clean-footer:

```bash
pi install @neilurk12/pi-clean-footer
```

For project-local install:

```bash
pi install -l @neilurk12/pi-clean-footer
```

Or from local checkout (development):

```bash
pi install /absolute/path/to/pi-clean-footer
```

## Usage

Toggle footer:

```text
/footer
```

Force git refresh:

```text
/footer refresh
```

Show active config paths and resolved config:

```text
/footer config
```

Reload config after editing JSON:

```text
/footer reload
```

## Configuration

Config is optional. Defaults match the built-in package behavior.

Load order:

1. Global: `~/.pi/agent/clean-footer.json`
2. Project: `.pi/clean-footer.json`

Project config overrides global config. Nested `modelAliases` and `colors` are merged.

Example:

```json
{
  "enabled": true,
  "showGit": true,
  "showTokens": true,
  "showCache": false,
  "showContext": true,
  "showDirectory": true,
  "showEffort": true,
  "gitRefreshDebounceMs": 500,
  "separator": " • ",
  "layouts": [
    {
      "minWidth": 100,
      "left": ["model", "directory", "git"],
      "right": ["context", "tokensFull"]
    },
    {
      "minWidth": 60,
      "left": ["model", "git"],
      "right": ["context", "tokensTotal"]
    },
    {
      "minWidth": 0,
      "left": ["model"],
      "right": ["context"]
    }
  ],
  "contextWarningPercent": 70,
  "contextDangerPercent": 85,
  "modelAliases": {
    "claude-sonnet-4-5-20250929": "sonnet-4.5",
    "gpt-5.5-codex": "gpt-5.5"
  },
  "colors": {
    "model": "accent",
    "directory": "dim",
    "git": "success",
    "gitDirty": "warning",
    "contextNormal": "success",
    "contextWarning": "warning",
    "contextDanger": "error",
    "tokens": "muted",
    "separator": "dim"
  }
}
```

Supported layout segment IDs:

- `model` - model name plus thinking effort when `showEffort` is enabled
- `directory` - current directory basename
- `git` - git branch and dirty count
- `context` - context usage
- `tokensFull` - input, output, total, cache read, and cache write tokens
- `tokensNoCache` - input, output, and total tokens
- `tokensTotal` - total tokens only

`layouts` are selected by the highest `minWidth` less than or equal to the terminal width. `showGit`, `showTokens`, `showContext`, `showDirectory`, and `showEffort` still act as global visibility controls. Unknown or duplicate layout segments are omitted and reported by `/footer config`.

Malformed JSON keeps defaults/last loaded behavior and reports an error through `/footer config` or at startup.

## Package manifest

This package declares its extension through `package.json`:

```json
{
  "pi": {
    "extensions": ["./dist/index.js"]
  }
}
```

## Development

Type-check extension:

```bash
npx tsc --noEmit --skipLibCheck --moduleResolution Node16 --module Node16 --target ES2022 --types node src/index.ts
```

## Notes

Extensions run with full system permissions. Review code before installing any pi package.
