# pi-pioneer

Pioneer AI model provider extension for pi coding agent.

## Installation

```bash
pi install npm:@neilurk12/pi-pioneer
```

## Setup

Get an API key from Pioneer AI, then choose one of the following methods:

### Config file (recommended)

Create `~/.config/pi-pioneer/config.json`:

```json
{
  "apiKey": "your-api-key"
}
```

### Environment variable

```bash
export PIONEER_API_KEY="your-api-key"
```

If both are set, the environment variable takes precedence.

## Available Models

Models are fetched dynamically from the Pioneer AI API. Example models include:
- claude-opus-4.8
- moonshotai/Kimi-K2.6
- deepseek-ai/DeepSeek-V4-Flash
- deepseek-ai/DeepSeek-V4-Pro
- XiaomiMiMo/MiMo-V2.5-Pro
- MiniMaxAI/MiniMax-M3

## Usage

Select a Pioneer AI model in pi with `/model` command.
