# Hunch (JS SDK + CLI)

Hunch is a tiny, MCP-first telemetry store for AI debugging. This package
includes the JS SDK and CLI.

For full docs, see the repo README.

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
