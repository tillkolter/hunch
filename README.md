# Guck

Guck is a tiny, MCP-first telemetry store for AI debugging. It captures JSONL
telemetry events and exposes a minimal MCP toolset for fast, filtered queries.

Guck is designed to be:
- **Language-agnostic**: emit JSONL from any runtime
- **Filter-first**: no default tailing; MCP tools focus on targeted queries
- **Low-friction**: small optional SDK, simple `wrap` CLI for stdout/stderr

## Install

```sh
pnpm add -g @guckdev/cli
# or
npm install -g @guckdev/cli
# or
npx @guckdev/cli
```

Note: the `guck` command is provided by `@guckdev/cli`. If you already have the
unrelated npm `guck` installed globally, uninstall it first.
If you previously installed `guck-cli`, switch to `@guckdev/cli`.

## Quick start

1) Configure MCP (Codex/Claude/Copilot):

```json
{
  "mcpServers": {
    "guck": {
      "command": "guck",
      "args": ["mcp"],
      "env": {
        "GUCK_CONFIG_PATH": "/path/to/.guck.json"
      }
    }
  }
}
```

2) Drop‑in log capture (JS) — use auto‑capture, emit(), or both:

```ts
import "@guckdev/sdk/auto";
import { emit } from "@guckdev/sdk";

emit({ message: "hello from app" });
```

3) Run your app; the MCP client will spawn `guck mcp` and logs are queryable via
`guck.stats` / `guck.search`.

## Vite drop-in (dev)

Add the Vite plugin to handle `/guck/emit` during development:

```ts
import { defineConfig } from "vite";
import { guckVitePlugin } from "@guckdev/vite";

export default defineConfig({
  plugins: [guckVitePlugin()],
});
```

Then point the browser SDK at `/guck/emit`.
The plugin writes those events directly into the local log store.

## Monorepo layout

- `packages/guck-cli` — CLI (wrap/emit/checkpoint/mcp)
- `packages/guck-core` — shared config/types/store/redaction
- `packages/guck-js` — JS SDK
- `packages/guck-mcp` — MCP server
- `packages/guck-py` — Python SDK
- `packages/guck-vite` — Vite dev server plugin
- `specs` — shared contract fixtures for parity tests

## Python SDK (preview)

PyPI install:

```sh
pip install guck-sdk
```

Local dev install:

```sh
uv pip install -e packages/guck-py
```

Usage:

```py
from guck import emit

emit({"message": "hello from python"})
```

## Best practice (copy-paste)

1) Add local config (ignored by git):

`.guck.json`
```json
{
  "version": 1,
  "enabled": true,
  "default_service": "my-service"
}
```

2) Add one line to AGENTS.md:

```
When debugging, use Guck telemetry first (guck.stats → guck.search; tail only if asked).
```

3) Run:

```sh
guck wrap --service my-service --session dev-1 -- <your command>
guck mcp
```

## Session vs trace

Guck supports both `session_id` and `trace_id`, but they serve different purposes:

- `trace_id` is **request-scope** correlation (a single transaction across services).
- `session_id` is **run-scope** correlation (a dev run, test run, or local experiment).

`session_id` is useful even when you already have traces because many events are
not tied to a trace (startup, background jobs, cron tasks, etc.). It also gives
you a simple way to filter a whole dev run without wiring trace propagation.

Example:

```sh
export GUCK_SESSION_ID=dev-2026-02-10
guck wrap --service api --session dev-2026-02-10 -- pnpm run dev
```

## Config

Guck reads `.guck.json` from your repo root.

Guck is **enabled by default** using built-in defaults. Add a `.guck.json` or
set `GUCK_CONFIG_PATH` to override settings. You can also set `"enabled": false`
inside the config to turn it off explicitly.

The log directory is not configurable via `.guck.json`; set `GUCK_DIR` on the
server process (MCP/Vite) if you need a custom location.

For MCP usage across multiple repos, each tool accepts an optional
`config_path` parameter to point at a specific `.guck.json`.

### Multi-service or multi-repo tracing (shared store)

By default, Guck writes to a shared log store at `~/.guck/logs`, so multiple
local services and repos already land in the same place. Use a shared
`GUCK_SESSION_ID` to correlate a dev run and distinct `service` names to
separate sources.

If you need a custom location, set `GUCK_DIR` on the **server** process
(MCP or Vite dev server) so all writes land in the same absolute folder.

```json
{
  "version": 1,
  "enabled": true,
  "default_service": "my-service",
  "redaction": {
    "enabled": true,
    "keys": ["authorization","api_key","token","secret","password"],
    "patterns": ["sk-[A-Za-z0-9]{20,}","Bearer\\s+[A-Za-z0-9._-]+"]
  },
  "mcp": {
    "max_results": 200,
    "default_lookback_ms": 300000,
    "max_output_chars": 0,
    "max_message_chars": 0
  }
}
```

Remote backends (CloudWatch/K8s) require optional SDK installs; install only if you use them.

Kubernetes (EKS) backend example (SDK auth; no aws/kubectl exec):

```json
{
  "read": {
    "backend": "multi",
    "backends": [
      {
        "type": "k8s",
        "id": "k8s-api",
        "namespace": "avatars",
        "selector": "app.kubernetes.io/component=api,app.kubernetes.io/instance=avatars",
        "container": "avatars",
        "clusterName": "eks1-euc1-stg-bi",
        "region": "eu-central-1",
        "profile": "business-innovation-dev.admin"
      }
    ]
  }
}
```

If `clusterName` and `region` are set (or your kubeconfig user uses `aws eks get-token`),
Guck uses the AWS SDK to fetch tokens and ignores kubeconfig exec plugins.

### JS SDK auto-capture (stdout/stderr)

The JS SDK can patch `process.stdout` and `process.stderr` to emit Guck events.
Enable it early in your app startup:

```ts
import "@guckdev/sdk/auto";
// or
import { installAutoCapture } from "@guckdev/sdk";
installAutoCapture();
```

Config toggles:

```json
{ "sdk": { "enabled": true, "capture_stdout": true, "capture_stderr": true } }
```

If you're using `guck wrap`, the CLI sets `GUCK_WRAPPED=1` and the SDK
auto-capture intentionally skips to avoid double logging.

### Browser SDK (console + errors)

Use the Vite plugin to handle `/guck/emit` during development, then point the
browser SDK at that path.

Emit browser events:

```ts
import { createBrowserClient } from "@guckdev/browser";

const client = createBrowserClient({
  endpoint: "/guck/emit",
  service: "web-ui",
  sessionId: "dev-1",
});

await client.emit({ message: "hello from the browser" });
```

Auto-capture console output + unhandled errors:

```ts
const { stop } = client.installAutoCapture();

console.error("boom");

// call stop() to restore console and listeners (useful in component unmounts/tests)
stop();
```

Notes:
- `installAutoCapture()` should usually be called once at app startup; repeated calls will wrap console multiple times.
- If you install it inside a component or test, call `stop()` on cleanup to avoid duplicate logging.
- For SPAs, it's fine to call `installAutoCapture()` once in your app entry (e.g. `index.ts`) and never call `stop()`.
- There is no prebuilt UMD/IIFE bundle yet; for vanilla JS you should use a bundler or a native ESM import.

### Environment overrides
- `GUCK_CONFIG_PATH` — explicit config path
- `GUCK_DIR` — server-side store dir override (MCP/Vite)
- `GUCK_ENABLED` — true/false
- `GUCK_SERVICE` — service name
- `GUCK_SESSION_ID` — session override
- `GUCK_RUN_ID` — run id override

### Checkpoint

`guck checkpoint` writes a `.guck-checkpoint` file in the root of the log
store containing an epoch millisecond timestamp. When
MCP tools are called without `since`, Guck uses the checkpoint timestamp as
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

By default, Guck writes per-run JSONL files:

```
~/.guck/logs/<service>/<YYYY-MM-DD>/<run_id>.jsonl
```

## Minimal CLI

Guck’s CLI is intentionally minimal. It exists to **capture** and **serve**
telemetry; filtering is MCP-first.

- `guck init` — create `.guck.json`
- `guck checkpoint` — write `.guck-checkpoint` epoch timestamp
- `guck wrap --service <name> --session <id> -- <cmd...>` — capture stdout/stderr
- `guck emit --service <name> --session <id>` — append JSON events from stdin
- `guck mcp` — start MCP server

## MCP tools

Guck exposes these MCP tools (filter-first):

- `guck.mcp_version` — MCP package name + version
- `guck.search`
- `guck.stats`
- `guck.sessions`
- `guck.tail` (available, but not default in docs)

## Search and tail parameters

`guck.search` and `guck.tail` support additional output and query controls:

- `query` — boolean search over **message only** (case-insensitive). Supports `AND`, `OR`, `NOT`, parentheses, and quoted phrases.
- `contains` — substring search across message/type/session_id/data (unchanged).
- `format` — `json` (default) or `text`.
- `fields` — when `format: "json"`, project events to these top-level fields.
- `template` — when `format: "text"`, format each line using tokens like `{ts}|{service}|{message}`. Missing tokens become empty strings.
- `max_output_chars` — cap total response size in characters (set `max_message_chars` or use `fields/template` to shrink output).
- `max_message_chars` — truncate `event.message` before formatting/projection.

When `max_output_chars` is exceeded, responses include `warning` and set `truncated: true`. Set either value to `0` (or omit it) to disable the cap.

Examples:

```json
{ "query": "error AND (db OR timeout)" }
{ "format": "text", "template": "{ts}|{service}|{message}" }
{ "format": "json", "fields": ["ts", "level", "message"] }
```

Recommended minimal output for agents:

```json
{ "format": "text", "template": "{ts}|{service}|{message}" }
```

## AI usage guidance

Start with **stats**, then **search**, and only **tail** if needed:

1) `guck.stats` with a narrow time window
2) `guck.search` for relevant types/levels/messages
3) `guck.tail` only when live-streaming is required

This keeps prompts short and avoids flooding the model with irrelevant logs.

## Debugging strategy (recommended)

Use Guck as a tight loop to avoid log spam and wasted tokens:

1) **Scope** with `guck.stats` (short time window, service/session).
2) **Inspect** with `guck.search` for errors/warns or a specific boundary.
3) **Hypothesize** the failing stage or component.
4) **Instrument** only the boundary (entry/exit, inputs/outputs).
5) **Re-run** and re-query the same narrow window.

This keeps investigations focused while still enabling deep, iterative debugging.

## Redaction

Guck applies redaction on **write** and on **read** using configured key names
and regex patterns.

## Compatibility

Any language can emit Guck events by writing JSONL lines to the store.
The optional SDK simply adds conveniences like `run_id` and redaction.

## MCP server config example

```json
{
  "mcpServers": {
    "guck": {
      "command": "guck",
      "args": ["mcp"],
      "env": {
        "GUCK_CONFIG_PATH": "/path/to/.guck.json"
      }
    }
  }
}
```

## License

MIT
# guck
