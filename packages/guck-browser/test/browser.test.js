import assert from "node:assert/strict";
import { test } from "node:test";
import { createBrowserClient } from "../dist/index.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const createFetchStub = (events) => async (url, init) => {
  events.push({ url, init });
  return { ok: true, status: 200, statusText: "OK" };
};

test("emit sends defaults", async () => {
  const events = [];
  const client = createBrowserClient({
    endpoint: "http://localhost/guck",
    service: "svc",
    sessionId: "session-001",
    fetch: createFetchStub(events),
  });

  await client.emit({ message: "hello" });

  assert.equal(events.length, 1);
  const request = events[0];
  assert.equal(request.url, "http://localhost/guck");
  const body = JSON.parse(request.init.body);
  assert.equal(body.service, "svc");
  assert.equal(body.session_id, "session-001");
  assert.equal(body.type, "log");
  assert.equal(body.level, "info");
  assert.equal(body.message, "hello");
  assert.equal(body.source.kind, "sdk");
  assert.ok(body.id);
  assert.ok(body.ts);
});

test("auto-capture console + unhandledrejection", async () => {
  const events = [];
  const originalWindow = globalThis.window;
  const listeners = {
    error: [],
    unhandledrejection: [],
  };
  globalThis.window = {
    addEventListener: (type, handler) => {
      listeners[type]?.push(handler);
    },
    removeEventListener: (type, handler) => {
      const list = listeners[type];
      if (!list) {
        return;
      }
      const index = list.indexOf(handler);
      if (index !== -1) {
        list.splice(index, 1);
      }
    },
  };

  const client = createBrowserClient({
    endpoint: "http://localhost/guck",
    fetch: createFetchStub(events),
  });

  const originalConsoleError = console.error;
  const handle = client.installAutoCapture();
  assert.notEqual(console.error, originalConsoleError);

  console.error("boom");
  await tick();

  const rejectionHandler = listeners.unhandledrejection[0];
  rejectionHandler?.({ reason: new Error("nope") });
  await tick();

  handle.stop();
  assert.equal(console.error, originalConsoleError);

  const payloads = events.map((event) => JSON.parse(event.init.body));
  const consoleEvent = payloads.find((event) => event.type === "console");
  const rejectionEvent = payloads.find((event) => event.type === "unhandledrejection");

  assert.ok(consoleEvent);
  assert.equal(consoleEvent.level, "error");
  assert.ok(consoleEvent.message.includes("boom"));
  assert.ok(rejectionEvent);
  assert.equal(rejectionEvent.level, "error");

  globalThis.window = originalWindow;
});
