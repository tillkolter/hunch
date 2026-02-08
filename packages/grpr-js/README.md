# Grpr (JS SDK)

Grpr is a tiny, MCP-first telemetry store for AI debugging. This package
includes the JS SDK.

For full docs, see the repo README.

## Install

This package is intended to be used from the monorepo workspace.
For the CLI (`grpr ...`), use `grpr-cli`.

## Quick start

```sh
grpr init
grpr wrap --service debate-room --session room-123 -- pnpm run dev
# in another terminal
grpr mcp
```
