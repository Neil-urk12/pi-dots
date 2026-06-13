# pi-tokenrouter

TokenRouter AI model provider extension for pi coding agent.

## Installation

```bash
pi install npm:@neilurk12/pi-tokenrouter
```

## Setup

Get an API key from TokenRouter, then choose one of the following methods:

### Environment variable (recommended)

```bash
export TOKENROUTER_API_KEY="your-api-key"
```

### Config file

Create `~/.pi/tokenrouter.json`:

```json
{
  "apiKey": "your-api-key"
}
```

If both are set, the environment variable takes precedence.

## Custom Models

Override or extend the default model list in `~/.pi/tokenrouter.json`:

```json
{
  "models": [
    { "id": "MiniMax-M3", "name": "MiniMax M3" },
    { "id": "my-custom-model", "name": "Custom Model", "contextWindow": 256000 }
  ]
}
```

When `models` is provided, it replaces the defaults entirely.

## Default Models

| Model ID | Name |
|----------|------|
| MiniMax-M3 | MiniMax M3 |

## Usage

Select a TokenRouter model in pi with `/model` command.
