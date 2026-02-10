# Guck (Browser SDK)

Browser SDK for emitting Guck telemetry to your dev server at `/guck/emit`.
This package is intended for **development only** and throws if used in production builds.

## Usage

1) Add the Vite plugin:

```ts
import { defineConfig } from "vite";
import { guckVitePlugin } from "@guckdev/vite";

export default defineConfig({
  plugins: [guckVitePlugin()],
});
```

2) Create a client and emit events:

```ts
import { createBrowserClient } from "@guckdev/browser";

const client = createBrowserClient({
  endpoint: "/guck/emit",
  service: "web-ui",
  sessionId: "dev-1",
});

await client.emit({ message: "hello from the browser" });
```

## Keep it out of production

Use a development-only import so the SDK never gets bundled for production:

```ts
if (import.meta.env.DEV) {
  const { createBrowserClient } = await import("@guckdev/browser");
  const client = createBrowserClient({
    endpoint: "/guck/emit",
    service: "playground",
    sessionId: "dev-1",
  });
  client.installAutoCapture();
}
```

## Auto-capture console + errors

```ts
const { stop } = client.installAutoCapture();

console.error("boom");

// call stop() to restore console and listeners (useful in component unmounts/tests)
stop();
```

Notes:
- The SDK only runs when the endpoint host is local (`localhost`, `127.0.0.1`, `local.*`, `*.local`).
- `installAutoCapture()` should usually be called once at app startup; repeated calls will wrap console multiple times.
- If you install it inside a component or test, call `stop()` on cleanup to avoid duplicate logging.
- For SPAs, it's fine to call `installAutoCapture()` once in your app entry (e.g. `index.ts`) and never call `stop()`.
- There is no prebuilt UMD/IIFE bundle yet; for vanilla JS you should use a bundler (Vite/Rollup/etc) or a native ESM import in a modern build.
