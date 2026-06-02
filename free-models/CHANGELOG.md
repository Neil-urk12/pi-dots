# Changelog

## 1.0.0

Initial release.

### Features

- Kilo Gateway provider — 300+ models via OpenRouter-compatible API, free/paid filtering, OAuth device auth flow, status bar
- OpenCode provider — dual endpoints (`opencode` + `opencode-go`), per-request session/request ID generation, free/paid filtering
- Global free-only mode with `/toggle-free` command
- Per-provider toggles: `/toggle-kilo`, `/toggle-opencode`
- Provider stats via `/free-providers`
- Adaptive free model detection (cost-based Route A, name-based Route B)
- Config at `~/.pi/free-models.json` with env var overrides
- Hidden models support with provider-scoped or global filtering
- Structured logging with file rotation (5 MB, `~/.pi/free-models.log`)
- OAuth token refresh for Kilo
- Retry with backoff for model fetching
- Session-start model refresh when authenticated
