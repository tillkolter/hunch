# @guckdev/vite

Vite dev server plugin that accepts `/guck/emit` and writes events directly to
Guck’s local log store.

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
  configPath: "/absolute/path/or/project/root", // defaults to process.cwd()
  path: "/guck/emit", // local Vite endpoint
  enabled: true, // auto-disabled for non-dev
});
```

Notes:
- This plugin only runs in Vite dev server mode (`apply: "serve"`).
- CORS preflight is handled for browser requests.
- The log directory is controlled by the server env (`GUCK_DIR`) or the default `~/.guck/logs`.
