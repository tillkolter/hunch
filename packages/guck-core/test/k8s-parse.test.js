import test from "node:test";
import assert from "node:assert/strict";
import { __test__ } from "../dist/store/backends/k8s.js";

const { toEvent } = __test__;

const baseConfig = {
  type: "k8s",
  namespace: "default",
  selector: "app=svc",
  service: "svc",
};

const baseTs = "2026-02-11T01:00:14.457Z";

test("k8s JSON maps timestamp, level, message", () => {
  const message = JSON.stringify({
    timestamp: "2026-02-11T01:00:14.456Z",
    level: "warn",
    message: "debater-a avatar session failed",
    pid: 47420,
    context: "debate-room",
  });
  const event = toEvent(baseConfig, message, baseTs, "pod-1", "container-1");
  assert.equal(event.ts, "2026-02-11T01:00:14.456Z");
  assert.equal(event.level, "warn");
  assert.equal(event.message, "debater-a avatar session failed");
  assert.equal(event.service, "svc");
  assert.equal(event.run_id, "pod-1");
  assert.equal(event.data?.pid, 47420);
  assert.equal(event.data?.context, "debate-room");
  assert.equal(event.data?.timestamp, "2026-02-11T01:00:14.456Z");
  assert.equal(event.data?.pod, "pod-1");
  assert.equal(event.data?.container, "container-1");
  assert.equal(event.data?.raw_message, message);
});

test("k8s JSON maps severity and msg", () => {
  const message = JSON.stringify({
    time: "2026-02-11T01:00:14.332Z",
    severity: "error",
    msg: "LiveAvatar API request failed",
    meta: ["detail"],
  });
  const event = toEvent(baseConfig, message, baseTs, "pod-2", "container-2");
  assert.equal(event.ts, "2026-02-11T01:00:14.332Z");
  assert.equal(event.level, "error");
  assert.equal(event.message, "LiveAvatar API request failed");
  assert.deepEqual(event.data?.meta, ["detail"]);
  assert.equal(event.data?.time, "2026-02-11T01:00:14.332Z");
  assert.equal(event.data?.pod, "pod-2");
  assert.equal(event.data?.container, "container-2");
  assert.equal(event.data?.raw_message, message);
});

test("k8s non-JSON message uses fallback", () => {
  const message = "warn: plain log";
  const event = toEvent(baseConfig, message, baseTs, "pod-3", "container-3");
  assert.equal(event.ts, baseTs);
  assert.equal(event.level, "warn");
  assert.equal(event.message, message);
  assert.equal(event.data?.pod, "pod-3");
  assert.equal(event.data?.container, "container-3");
  assert.equal(event.data?.raw_message, message);
});

test("k8s JSON data merges with metadata", () => {
  const message = JSON.stringify({
    timestamp: "2026-02-11T01:00:13.554Z",
    level: "info",
    message: "hello",
    data: { foo: "bar", pod: "from-json" },
  });
  const event = toEvent(baseConfig, message, baseTs, "pod-4", "container-4");
  assert.equal(event.ts, "2026-02-11T01:00:13.554Z");
  assert.equal(event.level, "info");
  assert.equal(event.message, "hello");
  assert.equal(event.data?.foo, "bar");
  assert.equal(event.data?.pod, "from-json");
  assert.equal(event.data?.container, "container-4");
  assert.equal(event.data?.raw_message, message);
});
