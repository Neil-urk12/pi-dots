# @neilurk12/pi-header

Custom ASCII art header extension for [pi coding agent](https://github.com/earendil-works/pi).

```
  ____       _             _
 / ___|  ___(_)      _ __ (_)
 \___ \ / __| |_____| '_ \| |
  ___) | (__| |_____| |_) | |
 |____/ \___|_|     | .__/|_|
                    |_|

        v0.1.0 · main · my-project · claude-sonnet-4
```

## Install

```bash
pi install @neilurk12/pi-header
```

Or add to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["npm:@neilurk12/pi-header"]
}
```

## Commands

| Command | Description |
|---------|-------------|
| `/header` | Toggle header on/off |
| `/header refresh` | Force git branch refresh |
| `/header reload` | Reload config from disk |
| `/header config` | Show loaded config |

## Configuration

Create `~/.pi/agent/pi-header.json` (global) or `.pi/pi-header.json` (project):

```json
{
  "enabled": true,
  "name": "Sci-pi",
  "showGit": true,
  "showModel": true,
  "showDirectory": true,
  "colors": {
    "title": "accent",
    "subtitle": "muted",
    "separator": "dim"
  }
}
```

### Config Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable header |
| `name` | string | `"Sci-pi"` | ASCII art name (dynamic asciilib rendering for custom names) |
| `showGit` | boolean | `true` | Show git branch in subtitle |
| `showModel` | boolean | `true` | Show model ID in subtitle |
| `showDirectory` | boolean | `true` | Show directory in subtitle |
| `colors.title` | string | `"accent"` | Theme color for ASCII art |
| `colors.subtitle` | string | `"muted"` | Theme color for subtitle |
| `colors.separator` | string | `"dim"` | Theme color for separator |

### Color Values

Use theme color names: `accent`, `muted`, `dim`, `success`, `warning`, `error`, `border`, `text`, etc.

### Custom Names

Set `name` to any string. "Sci-pi" uses pre-rendered art; all other names generate dynamic asciilib output:

```json
{
  "name": "my-project"
}
```

Supported characters: A-Z, a-z, 0-9, space. Unknown characters render as spaces.

## Development

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Test
pnpm test

# Watch mode
pnpm dev
```

## License

MIT
