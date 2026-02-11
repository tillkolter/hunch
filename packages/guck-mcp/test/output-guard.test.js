import assert from "node:assert/strict";
import { test } from "node:test";
import { guardPayload, trimMessage } from "../dist/output.js";

test("guardPayload allows small payload", () => {
  const payload = { format: "json", events: [{ message: "ok" }] };
  const result = guardPayload({
    payload,
    maxChars: 1000,
    format: "json",
    itemCount: 1,
    truncated: false,
  });
  assert.equal(result.kind, "ok");
  assert.ok(result.serialized.includes("\"events\""));
});

test("guardPayload blocks large payload", () => {
  const payload = { format: "json", events: [{ message: "x".repeat(200) }] };
  const result = guardPayload({
    payload,
    maxChars: 10,
    format: "json",
    itemCount: 1,
    truncated: false,
  });
  assert.equal(result.kind, "blocked");
  const warning = result.warningPayload.warning;
  assert.equal(warning.code, "guck.output_too_large");
  assert.equal(warning.blocked, true);
  assert.equal(warning.max_output_chars, 10);
  assert.ok(warning.estimated_output_chars > 10);
});

test("guardPayload includes message stats", () => {
  const payload = { format: "json", events: [{ message: "x".repeat(200) }] };
  const result = guardPayload({
    payload,
    maxChars: 10,
    format: "json",
    itemCount: 1,
    truncated: false,
    avgMessageChars: 123,
    maxMessageChars: 456,
  });
  assert.equal(result.kind, "blocked");
  const warning = result.warningPayload.warning;
  assert.equal(warning.avg_message_chars, 123);
  assert.equal(warning.max_message_chars, 456);
});

test("guardPayload allows force override", () => {
  const payload = { format: "json", events: [{ message: "x".repeat(200) }] };
  const result = guardPayload({
    payload,
    maxChars: 10,
    force: true,
    format: "json",
    itemCount: 1,
    truncated: false,
  });
  assert.equal(result.kind, "ok");
  assert.ok(result.serialized.includes("\"events\""));
});

test("trimMessage keeps match at start without leading ellipsis", () => {
  const message = "match-start-" + "x".repeat(50);
  const trimmed = trimMessage(message, { maxChars: 20, match: "match" });
  assert.ok(trimmed.startsWith("match"));
  assert.ok(trimmed.endsWith("..."));
  assert.ok(!trimmed.startsWith("..."));
});

test("trimMessage keeps match at end without trailing ellipsis", () => {
  const message = "x".repeat(50) + "-match";
  const trimmed = trimMessage(message, { maxChars: 20, match: "match" });
  assert.ok(trimmed.startsWith("..."));
  assert.ok(trimmed.endsWith("match"));
  assert.ok(!trimmed.endsWith("..."));
});

test("trimMessage keeps match in middle with both ellipses", () => {
  const message = "x".repeat(20) + "match" + "y".repeat(20);
  const trimmed = trimMessage(message, { maxChars: 20, match: "match" });
  assert.ok(trimmed.startsWith("..."));
  assert.ok(trimmed.endsWith("..."));
});

test("trimMessage falls back to head and tail when no match", () => {
  const message = "abcdefghijklmnopqrstuvwxyz";
  const trimmed = trimMessage(message, { maxChars: 10, match: "zzz" });
  assert.ok(trimmed.includes("..."));
  assert.ok(trimmed.startsWith("abc"));
  assert.ok(trimmed.endsWith("xyz"));
});
