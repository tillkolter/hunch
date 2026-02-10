import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createServer as createViteServer } from "vite";
import { guckVitePlugin } from "../dist/index.js";

const createTempRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guck-vite-"));
  fs.writeFileSync(path.join(root, "index.html"), "<!doctype html>\n");
  return root;
};

const startUpstream = async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      requests.push({
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { server, port, requests };
};

const startVite = async (plugin) => {
  const root = createTempRoot();
  const server = await createViteServer({
    root,
    server: { port: 0, host: "127.0.0.1" },
    plugins: [plugin],
  });
  await server.listen();
  const address = server.httpServer.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { server, port };
};

test("forwards to ingest with config header", async (t) => {
  const upstream = await startUpstream();
  t.after(() => upstream.server.close());

  const configPath = "/tmp/project-config";
  const vite = await startVite(
    guckVitePlugin({
      ingestUrl: `http://127.0.0.1:${upstream.port}/guck/emit`,
      configPath,
      path: "/guck/emit",
    }),
  );
  t.after(() => vite.server.close());

  const response = await fetch(`http://127.0.0.1:${vite.port}/guck/emit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "hello" }),
  });

  assert.equal(response.status, 200);
  assert.equal(upstream.requests.length, 1);
  const request = upstream.requests[0];
  assert.equal(request.headers["x-guck-config-path"], configPath);
  assert.ok(request.body.includes("hello"));
});

test("handles CORS preflight", async (t) => {
  const upstream = await startUpstream();
  t.after(() => upstream.server.close());

  const vite = await startVite(
    guckVitePlugin({
      ingestUrl: `http://127.0.0.1:${upstream.port}/guck/emit`,
    }),
  );
  t.after(() => vite.server.close());

  const response = await fetch(`http://127.0.0.1:${vite.port}/guck/emit`, {
    method: "OPTIONS",
  });

  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
});

test("returns 502 when upstream is down", async (t) => {
  const vite = await startVite(
    guckVitePlugin({
      ingestUrl: "http://127.0.0.1:59999/guck/emit",
    }),
  );
  t.after(() => vite.server.close());

  const response = await fetch(`http://127.0.0.1:${vite.port}/guck/emit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "hello" }),
  });

  assert.equal(response.status, 502);
  const payload = await response.json();
  assert.equal(payload.error, "Upstream unreachable");
});
