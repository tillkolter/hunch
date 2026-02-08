# Grpr

Grpr is a tiny, MCP-first telemetry store for AI debugging. It captures JSONL
telemetry events and exposes a minimal MCP toolset for fast, filtered queries.

Grpr is designed to be:
- **Language-agnostic**: emit JSONL from any runtime
- **Filter-first**: no default tailing; MCP tools focus on targeted queries
- **Low-friction**: small optional SDK, simple `wrap` CLI for stdout/stderr

## Install

```sh
pnpm add -g grpr-cli
# or
npx grpr-cli
```

Note: the `grpr` command is provided by `grpr-cli`. If you already have the
unrelated npm `grpr` installed globally, uninstall it first.

## Quick start

```sh
grpr init
grpr wrap --service debate-room --session room-123 -- pnpm run dev
# in another terminal
grpr mcp
```

## Monorepo layout

- `packages/grpr-cli` — CLI (wrap/emit/checkpoint/mcp)
- `packages/grpr-core` — shared config/types/store/redaction
- `packages/grpr-js` — JS SDK
- `packages/grpr-mcp` — MCP server
- `packages/grpr-py` — Python SDK
- `specs` — shared contract fixtures for parity tests

## Python SDK (preview)

Local dev install:

```sh
uv pip install -e packages/grpr-py
```

Usage:

```py
from grpr import emit

emit({"message": "hello from python"})
```

## Best practice (copy-paste)

1) Add local config (ignored by git):

`.grpr.json`
```json
{
  "version": 1,
  "enabled": true,
  "store_dir": "logs/grpr",
  "default_service": "my-service"
}
```

2) Add one line to AGENTS.md:

```
When debugging, use Grpr telemetry first (grpr.stats → grpr.search; tail only if asked).
```

3) Run:

```sh
grpr wrap --service my-service --session dev-1 -- <your command>
grpr mcp
```

## Config

Grpr reads `.grpr.json` from your repo root.

Grpr is **enabled by default** using built-in defaults. Add a `.grpr.json` or
set `GRPR_CONFIG_PATH` to override settings. You can also set `"enabled": false`
inside the config to turn it off explicitly.

For MCP usage across multiple repos, each tool accepts an optional
`config_path` parameter to point at a specific `.grpr.json`.

```json
{
  "version": 1,
  "enabled": true,
  "store_dir": "logs/grpr",
  "default_service": "ais-avatars",
  "redaction": {
    "enabled": true,
    "keys": ["authorization","api_key","token","secret","password"],
    "patterns": ["sk-[A-Za-z0-9]{20,}","Bearer\\s+[A-Za-z0-9._-]+"]
  },
  "mcp": { "max_results": 200, "default_lookback_ms": 300000 }
}
```

Remote backends (CloudWatch/K8s) require optional SDK installs; install only if you use them.

### Environment overrides
- `GRPR_CONFIG_PATH` — explicit config path
- `GRPR_DIR` — store dir override
- `GRPR_ENABLED` — true/false
- `GRPR_SERVICE` — service name
- `GRPR_SESSION_ID` — session override
- `GRPR_RUN_ID` — run id override

### Checkpoint

`grpr checkpoint` writes a `.grpr-checkpoint` file in the root of your
`store_dir` (the log folder) containing an epoch millisecond timestamp. When
MCP tools are called without `since`, Grpr uses the checkpoint timestamp as
the default time window. You
can also pass `since: "checkpoint"` to explicitly anchor a query to the
checkpoint.

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

By default, Grpr writes per-run JSONL files:

```
logs/grpr/<service>/<YYYY-MM-DD>/<run_id>.jsonl
```

## Minimal CLI

Grpr’s CLI is intentionally minimal. It exists to **capture** and **serve**
telemetry; filtering is MCP-first.

- `grpr init` — create `.grpr.json`
- `grpr checkpoint` — write `.grpr-checkpoint` epoch timestamp
- `grpr wrap --service <name> --session <id> -- <cmd...>` — capture stdout/stderr
- `grpr emit --service <name> --session <id>` — append JSON events from stdin
- `grpr mcp` — start MCP server

## MCP tools

Grpr exposes these MCP tools (filter-first):

- `grpr.search`
- `grpr.stats`
- `grpr.sessions`
- `grpr.tail` (available, but not default in docs)

## AI usage guidance

Start with **stats**, then **search**, and only **tail** if needed:

1) `grpr.stats` with a narrow time window
2) `grpr.search` for relevant types/levels/messages
3) `grpr.tail` only when live-streaming is required

This keeps prompts short and avoids flooding the model with irrelevant logs.

## Debugging strategy (recommended)

Use Grpr as a tight loop to avoid log spam and wasted tokens:

1) **Scope** with `grpr.stats` (short time window, service/session).
2) **Inspect** with `grpr.search` for errors/warns or a specific boundary.
3) **Hypothesize** the failing stage or component.
4) **Instrument** only the boundary (entry/exit, inputs/outputs).
5) **Re-run** and re-query the same narrow window.

This keeps investigations focused while still enabling deep, iterative debugging.

## Redaction

Grpr applies redaction on **write** and on **read** using configured key names
and regex patterns.

## Compatibility

Any language can emit Grpr events by writing JSONL lines to the store.
The optional SDK simply adds conveniences like `run_id` and redaction.

## MCP server config example

```json
{
  "mcpServers": {
    "grpr": {
      "command": "grpr",
      "args": ["mcp"],
      "env": {
        "GRPR_CONFIG_PATH": "/path/to/.grpr.json"
      }
    }
  }
}
```

## License

MIT
# grpr
