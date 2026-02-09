import test from "node:test";
import assert from "node:assert/strict";
import { formatEventText, projectEventFields } from "../dist/format.js";

const baseEvent = {
  id: "1",
  ts: "2026-02-09T00:00:00.000Z",
  level: "info",
  type: "log",
  service: "svc",
  run_id: "run",
  session_id: "sess",
  message: "hello",
  data: { stage: "x" },
  tags: { env: "test" },
};

test("projectEventFields preserves order and ignores unknown", () => {
  const projected = projectEventFields(baseEvent, ["message", "ts", "unknown", "service"]);
  assert.deepEqual(Object.keys(projected), ["message", "ts", "service"]);
  assert.deepEqual(projected, {
    message: "hello",
    ts: "2026-02-09T00:00:00.000Z",
    service: "svc",
  });
});

test("projectEventFields empty fields", () => {
  const projected = projectEventFields(baseEvent, []);
  assert.deepEqual(projected, {});
});

test("formatEventText default", () => {
  const text = formatEventText(baseEvent);
  assert.equal(text, "2026-02-09T00:00:00.000Z info svc log session=sess hello");
});

test("formatEventText default without session", () => {
  const text = formatEventText({ ...baseEvent, session_id: undefined });
  assert.equal(text, "2026-02-09T00:00:00.000Z info svc log hello");
});

test("formatEventText template", () => {
  const text = formatEventText(baseEvent, "{ts}|{service}|{message}");
  assert.equal(text, "2026-02-09T00:00:00.000Z|svc|hello");
});

test("formatEventText template missing fields and json values", () => {
  const text = formatEventText(baseEvent, "{ts}|{missing}|{data}|{tags}");
  assert.equal(text, "2026-02-09T00:00:00.000Z||{\"stage\":\"x\"}|{\"env\":\"test\"}");
});
