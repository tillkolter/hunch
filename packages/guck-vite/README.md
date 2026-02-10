# @guckdev/vite

Vite dev server plugin that proxies `/guck/emit` to a shared Guck MCP ingest
endpoint and injects the project config server-side. The browser never sends
filesystem paths.

## Install

```sh
pnpm add -D @guckdev/vite
```

## Usage

```ts
import { defineConfig } from "vite";
import { guckVitePlugin } from "@guckdev/vite";

export default defineConfig({
  plugins: [guckVitePlugin()],
});
```

Then point the browser SDK at `/guck/emit`.

## Options

```ts
guckVitePlugin({
  ingestUrl: "http://127.0.0.1:7331/guck/emit", // shared MCP ingest
  configPath: "/absolute/path/or/project/root", // defaults to process.cwd()
  path: "/guck/emit", // local Vite endpoint
  enabled: true, // auto-disabled for non-dev
});
```

Notes:
- This plugin only runs in Vite dev server mode (`apply: "serve"`).
- The project config path is injected as a header on the server side.
- CORS preflight is handled for browser requests.
