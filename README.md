# Hunch

Hunch is a tiny, MCP-first telemetry store for AI debugging. It captures JSONL
telemetry events and exposes a minimal MCP toolset for fast, filtered queries.

Hunch is designed to be:
- **Language-agnostic**: emit JSONL from any runtime
- **Filter-first**: no default tailing; MCP tools focus on targeted queries
- **Low-friction**: small optional SDK, simple `wrap` CLI for stdout/stderr

## Install

```sh
pnpm add -g hunch
# or
npx hunch mcp
```

## Quick start

```sh
hunch init
hunch wrap --service debate-room --session room-123 -- pnpm run dev
# in another terminal
hunch mcp
```

## Monorepo layout

- `packages/hunch-js` — JS SDK + CLI
- `packages/hunch-py` — Python SDK
- `specs` — shared contract fixtures for parity tests

## Python SDK (preview)

Local dev install:

```sh
uv pip install -e packages/hunch-py
```

Usage:

```py
from hunch import emit

emit({"message": "hello from python"})
```

## Best practice (copy-paste)

1) Add local config (ignored by git):

`.hunch.json`
```json
{
  "version": 1,
  "enabled": true,
  "store_dir": "logs/hunch",
  "default_service": "my-service"
}
```

2) Add one line to AGENTS.md:

```
When debugging, use Hunch telemetry first (hunch.stats → hunch.search; tail only if asked).
```

3) Run:

```sh
hunch wrap --service my-service --session dev-1 -- <your command>
hunch mcp
```

## Config

Hunch reads `.hunch.json` from your repo root.

Hunch is **enabled by default** using built-in defaults. Add a `.hunch.json` or
set `HUNCH_CONFIG` to override settings. You can also set `"enabled": false`
inside the config to turn it off explicitly.

For MCP usage across multiple repos, each tool accepts an optional
`config_path` parameter to point at a specific `.hunch.json`.

```json
{
  "version": 1,
  "enabled": true,
  "store_dir": "logs/hunch",
  "default_service": "ais-avatars",
  "redaction": {
    "enabled": true,
    "keys": ["authorization","api_key","token","secret","password"],
    "patterns": ["sk-[A-Za-z0-9]{20,}","Bearer\\s+[A-Za-z0-9._-]+"]
  },
  "mcp": { "max_results": 200, "default_lookback_ms": 300000 }
}
```

### Environment overrides
- `HUNCH_CONFIG` — explicit config path
- `HUNCH_DIR` — store dir override
- `HUNCH_ENABLED` — true/false
- `HUNCH_SERVICE` — service name
- `HUNCH_SESSION_ID` — session override
- `HUNCH_RUN_ID` — run id override

## Event schema (JSONL)

Each line in the log is a single JSON event:

```json
{
  "id": "uuid",
  "ts": "2026-02-08T18:40:00.123Z",
  "level": "info",
  "type": "log",
  "service": "debate-room",
  "run_id": "uuid",
  "session_id": "room-123",
  "message": "speaker started",
  "data": { "turnId": 3 },
  "tags": { "env": "local" },
  "trace_id": "...",
  "span_id": "...",
  "source": { "kind": "sdk" }
}
```

## Store layout

By default, Hunch writes per-run JSONL files:

```
logs/hunch/<service>/<YYYY-MM-DD>/<run_id>.jsonl
```

## Minimal CLI

Hunch’s CLI is intentionally minimal. It exists to **capture** and **serve**
telemetry; filtering is MCP-first.

- `hunch init` — create `.hunch.json`
- `hunch wrap --service <name> --session <id> -- <cmd...>` — capture stdout/stderr
- `hunch emit --service <name> --session <id>` — append JSON events from stdin
- `hunch mcp` — start MCP server

## MCP tools

Hunch exposes these MCP tools (filter-first):

- `hunch.search`
- `hunch.stats`
- `hunch.sessions`
- `hunch.tail` (available, but not default in docs)

## AI usage guidance

Start with **stats**, then **search**, and only **tail** if needed:

1) `hunch.stats` with a narrow time window
2) `hunch.search` for relevant types/levels/messages
3) `hunch.tail` only when live-streaming is required

This keeps prompts short and avoids flooding the model with irrelevant logs.

## Debugging strategy (recommended)

Use Hunch as a tight loop to avoid log spam and wasted tokens:

1) **Scope** with `hunch.stats` (short time window, service/session).
2) **Inspect** with `hunch.search` for errors/warns or a specific boundary.
3) **Hypothesize** the failing stage or component.
4) **Instrument** only the boundary (entry/exit, inputs/outputs).
5) **Re-run** and re-query the same narrow window.

This keeps investigations focused while still enabling deep, iterative debugging.

## Redaction

Hunch applies redaction on **write** and on **read** using configured key names
and regex patterns.

## Compatibility

Any language can emit Hunch events by writing JSONL lines to the store.
The optional SDK simply adds conveniences like `run_id` and redaction.

## MCP server config example

```json
{
  "mcpServers": {
    "hunch": {
      "command": "hunch",
      "args": ["mcp"],
      "env": {
        "HUNCH_CONFIG": "/path/to/.hunch.json"
      }
    }
  }
}
```

## License

MIT
# hunch
