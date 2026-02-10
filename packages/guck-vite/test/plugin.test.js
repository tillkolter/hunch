import assert from "node:assert/strict";
import fs from "node:fs";
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

const startVite = async (plugin, rootOverride) => {
  const root = rootOverride ?? createTempRoot();
  const server = await createViteServer({
    root,
    server: { port: 0, host: "127.0.0.1" },
    plugins: [plugin],
  });
  await server.listen();
  const address = server.httpServer.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { server, port, root };
};

const collectJsonlFiles = (dir) => {
  const results = [];
  if (!fs.existsSync(dir)) {
    return results;
  }
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        results.push(fullPath);
      }
    }
  }
  return results;
};

const withEnv = (vars, fn) => {
  const previous = {};
  for (const key of Object.keys(vars)) {
    previous[key] = process.env[key];
    process.env[key] = vars[key];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of Object.keys(vars)) {
        if (previous[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = previous[key];
        }
      }
    });
};

test("writes events to the store dir", async (t) => {
  const root = createTempRoot();
  const configPath = path.join(root, ".guck.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        enabled: true,
        default_service: "web-ui",
        sdk: { enabled: true, capture_stdout: true, capture_stderr: true },
      },
      null,
      2,
    ),
  );
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "guck-store-"));

  await withEnv({ GUCK_DIR: storeDir }, async () => {
    const vite = await startVite(guckVitePlugin({ configPath: root }), root);
    t.after(() => vite.server.close());

    const response = await fetch(`http://127.0.0.1:${vite.port}/guck/emit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });

    assert.equal(response.status, 200);

    const files = collectJsonlFiles(storeDir);
    assert.equal(files.length, 1, "expected one JSONL file");
    const content = fs.readFileSync(files[0], "utf8").trim();
    const event = JSON.parse(content.split(/\r?\n/)[0]);
    assert.equal(event.message, "hello");
    assert.equal(event.service, "web-ui");
    assert.equal(typeof event.run_id, "string");
  });
});

test("returns 400 for invalid JSON", async (t) => {
  const root = createTempRoot();
  fs.writeFileSync(path.join(root, ".guck.json"), JSON.stringify({ enabled: true }, null, 2));
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "guck-store-"));

  await withEnv({ GUCK_DIR: storeDir }, async () => {
    const vite = await startVite(guckVitePlugin({ configPath: root }), root);
    t.after(() => vite.server.close());

    const response = await fetch(`http://127.0.0.1:${vite.port}/guck/emit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json}",
    });

    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.equal(payload.error, "Invalid JSON");
  });
});

test("returns 403 when disabled", async (t) => {
  const root = createTempRoot();
  fs.writeFileSync(path.join(root, ".guck.json"), JSON.stringify({ enabled: false }, null, 2));
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "guck-store-"));

  await withEnv({ GUCK_DIR: storeDir }, async () => {
    const vite = await startVite(guckVitePlugin({ configPath: root }), root);
    t.after(() => vite.server.close());

    const response = await fetch(`http://127.0.0.1:${vite.port}/guck/emit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });

    assert.equal(response.status, 403);
    const payload = await response.json();
    assert.equal(payload.error, "Guck disabled");
  });
});
