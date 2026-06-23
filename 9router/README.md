# pi-9router

9Router AI model provider extension for pi coding agent. [9Router](https://github.com/decolua/9router) is a local/remote AI gateway that exposes an OpenAI-compatible REST API. The extension dynamically fetches the live model list from the gateway at startup and registers chat-capable models with pi.

## Installation

```bash
pi install npm:@neilurk12/pi-9router
```

## Prerequisites

Start 9Router locally before launching pi. See the [9Router setup guide](https://github.com/decolua/9router) for installation. By default, the extension expects 9Router at `http://localhost:20128`.

Verify 9Router is reachable:

```bash
curl http://localhost:20128/api/health
# {"ok":true}
```

## Setup

The gateway URL and API key are both optional — local 9Router installs typically run with auth disabled and on the default port.

### Environment variables (recommended)

```bash
export NINEROUTER_URL="http://localhost:20128"   # default; override for VPS/tunnel
export NINEROUTER_KEY="sk-..."                  # only if your 9router requires auth
```

### Config file

Create `~/.pi/9router.json`:

```json
{
  "baseUrl": "https://9router.example.com",
  "apiKey": "sk-..."
}
```

If both env vars and the config file are set, environment variables take precedence.

## Models

Models are fetched from `${NINEROUTER_URL}/v1/models` at every pi startup — no hardcoded list. Whatever you configure in 9Router shows up in pi's `/model` picker.

Entries with non-chat `kind` values (e.g. `webSearch`, `embedding`, `tts`, `stt`, `image`) are filtered out, so only chat-capable models appear in `/model`.

## Usage

Select a 9Router model in pi with the `/model` command.

## Troubleshooting

- **No 9router models in `/model`** — check that 9Router is running (`curl $NINEROUTER_URL/api/health`) and that `NINEROUTER_URL` points to it. The extension logs the exact fetch URL on failure.
- **401 Unauthorized** — set `NINEROUTER_KEY` or add `apiKey` to `~/.pi/9router.json`.
- **Wrong models listed** — reconfigure 9Router; the extension re-fetches on every startup.