# pi-opengateway

pi extension that registers an [OpenGateway](https://opengateway.gitlawb.com) provider for the pi coding agent. Uses the OpenAI-compatible completions API.

## Install

```bash
pi install @neilurk12/pi-opengateway
```

For project-local install:

```bash
pi install -l @neilurk12/pi-opengateway
```

Or from local checkout (development):

```bash
pi install /absolute/path/to/pi-opengateway
```

## Configuration

Create a config file at one of these paths (first match wins):

1. **Global**: `~/.pi/agent/opengateway.json`
2. **Project**: `.pi/opengateway.json`

See [`config.example.json`](./config.example.json) for the required shape:

```json
{
  "baseUrl": "https://your-gateway.example.com/v1",
  "apiKey": "your-api-key-here",
  "models": [
    {
      "id": "model-id",
      "name": "Model Display Name",
      "reasoning": false,
      "input": ["text"],
      "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
      "contextWindow": 128000,
      "maxTokens": 4096
    }
  ]
}
```

### Fields

| Field | Required | Description |
|-------|----------|-------------|
| `baseUrl` | Yes | Gateway API endpoint (include `/v1` or equivalent) |
| `apiKey` | Yes | API key for authentication |
| `models[]` | Yes | Array of model definitions |
| `models[].id` | Yes | Model ID sent to the API |
| `models[].name` | Yes | Display name shown in pi |
| `models[].reasoning` | Yes | Whether the model supports extended thinking |
| `models[].input` | Yes | Supported input types: `["text"]` or `["text", "image"]` |
| `models[].cost` | Yes | Token costs (can be zeroes) |
| `models[].contextWindow` | Yes | Max context window in tokens |
| `models[].maxTokens` | Yes | Max output tokens |

## Usage

Once configured, the gateway models appear in pi's model picker under the "OpenGateway" provider. Select them like any other model.

## Development

```bash
npm install
npm run build
```

## Notes

- Extensions run with full system permissions. Review code before installing any pi package.
- Config is loaded at startup. Restart pi after changing config.
