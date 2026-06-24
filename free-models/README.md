# @neilurk12/pi-free-models

Free model providers for [Pi](https://github.com/earendil-works/pi-coding-agent) — Kilo Gateway and OpenCode with automatic free/paid filtering.

## What it does

Registers two AI model providers into Pi and defaults to showing only free models:

| Provider     | Models                                        | Auth                      |
| ------------ | --------------------------------------------- | ------------------------- |
| **Kilo**     | 300+ via Kilo Gateway (OpenRouter-compatible) | Optional OAuth or API key |
| **OpenCode** | Models via OpenCode Zen gateway               | API key from `auth.json`  |

Free model detection uses adaptive heuristics — cost-based for providers that expose pricing, name-based for those that don't.

## Install

```bash
pi install npm:@neilurk12/pi-free-models
```

Requires Pi and Node ≥ 22.

## Configuration

Config lives at `~/.pi/free-models.json` (separate from Pi's built-in providers).

### Options

| Key                  | Type       | Default | Description                                               |
| -------------------- | ---------- | ------- | --------------------------------------------------------- |
| `free_only`          | `boolean`  | `true`  | Show only free models globally                            |
| `kilo_show_paid`     | `boolean`  | `false` | Show paid Kilo models                                     |
| `opencode_show_paid` | `boolean`  | `false` | Show paid OpenCode models                                 |
| `kilo_api_key`       | `string`   | —       | Kilo API key (env: `KILO_API_KEY`)                        |
| `opencode_api_key`   | `string`   | —       | OpenCode API key (env: `OPENCODE_API_KEY`)                |
| `hidden_models`      | `string[]` | `[]`    | Model IDs to hide (`"model-id"` or `"provider/model-id"`) |

Environment variables take priority over the config file.

## Commands

| Command            | Description                                       |
| ------------------ | ------------------------------------------------- |
| `/toggle-free`     | Toggle global free-only mode across all providers |
| `/toggle-kilo`     | Toggle Kilo between free and all models           |
| `/toggle-opencode` | Toggle OpenCode between free and all models       |
| `/free-providers`  | Show free/paid model counts by provider           |
| `/login kilo`      | OAuth login for Kilo (unlocks paid models)        |

## How free detection works

The extension uses two routes:

- **Route A** (pricing-exposed providers like Kilo): A model is free if `cost.input === 0 && cost.output === 0`, or its name contains "free". When pricing data is missing for a specific model, falls back to name-only.
- **Route B** (non-pricing providers like OpenCode): A model is free if its name contains "free" (case-insensitive).

## Logging

Logs go to `~/.pi/free-models.log` (5 MB rotation). Control with env vars:

| Variable                   | Default                 | Description                                          |
| -------------------------- | ----------------------- | ---------------------------------------------------- |
| `LOG_LEVEL`                | `error`                 | Console log level (`debug`, `info`, `warn`, `error`) |
| `PI_FREE_MODELS_LOG_LEVEL` | `debug`                 | File log level                                       |
| `PI_FREE_MODELS_LOG_PATH`  | `~/.pi/free-models.log` | Log file path                                        |
| `PI_FREE_MODELS_FILE_LOG`  | `true`                  | Set `false` to disable file logging                  |

## License

MIT
