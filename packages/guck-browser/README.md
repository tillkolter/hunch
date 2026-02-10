# Guck (Browser SDK)

Browser SDK for emitting Guck telemetry to a local MCP HTTP ingest endpoint.

## Usage

Start the MCP server with HTTP ingest enabled:

```sh
guck mcp --http-port 7331
```

Create a client and emit events:

```ts
import { createBrowserClient } from "@guckdev/browser";

const client = createBrowserClient({
  endpoint: "http://localhost:7331/guck/emit",
  service: "web-ui",
  sessionId: "dev-1",
});

await client.emit({ message: "hello from the browser" });
```

## Auto-capture console + errors

```ts
const { stop } = client.installAutoCapture();

console.error("boom");

// call stop() to restore console and listeners (useful in component unmounts/tests)
stop();
```

Notes:
- The HTTP ingest endpoint is CORS-enabled by default.
- If your page is served over HTTPS, posting to an HTTP localhost endpoint may be blocked by mixed-content rules.
- `installAutoCapture()` should usually be called once at app startup; repeated calls will wrap console multiple times.
- If you install it inside a component or test, call `stop()` on cleanup to avoid duplicate logging.
- For SPAs, it's fine to call `installAutoCapture()` once in your app entry (e.g. `index.ts`) and never call `stop()`.
- There is no prebuilt UMD/IIFE bundle yet; for vanilla JS you should use a bundler (Vite/Rollup/etc) or a native ESM import in a modern build.

### Caddy (HTTPS dev) proxy example

If your frontend runs behind Caddy on HTTPS, proxy a path to the local ingest server
so the browser stays on HTTPS:

```caddyfile
:443 {
  # your existing site config...

  handle_path /guck/emit {
    reverse_proxy 127.0.0.1:7331
  }
}
```

Then point the client at `https://your-dev-host/guck/emit`.
