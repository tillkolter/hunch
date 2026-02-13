import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { searchEvents } from "../dist/store/file-store.js";
import { getDefaultConfig } from "../dist/config.js";

const writeJsonl = async (filePath, events) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const content = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
  await fs.writeFile(filePath, content, "utf8");
};

test("searchEvents applies query to message only", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "guck-query-"));
  const filePath = path.join(tmpDir, "svc", "2026-02-09", "run.jsonl");
  const events = [
    {
      id: "1",
      ts: "2026-02-09T00:00:00.000Z",
      level: "info",
      type: "log",
      service: "svc",
      run_id: "run",
      session_id: "s1",
      message: "foo bar",
      data: { note: "zzz" },
    },
    {
      id: "2",
      ts: "2026-02-09T00:00:01.000Z",
      level: "info",
      type: "log",
      service: "svc",
      run_id: "run",
      session_id: "s2",
      message: "foo",
      data: { note: "bar" },
    },
    {
      id: "3",
      ts: "2026-02-09T00:00:02.000Z",
      level: "info",
      type: "log",
      service: "svc",
      run_id: "run",
      session_id: "s3",
      message: "bar",
      data: { note: "foo" },
    },
  ];
  await writeJsonl(filePath, events);

  const config = getDefaultConfig();

  const result = await searchEvents(tmpDir, config, {
    service: "svc",
    query: "bar",
  });
  const ids = result.events.map((event) => event.id);
  assert.deepEqual(ids, ["1", "3"], "query should match message only");

  const combined = await searchEvents(tmpDir, config, {
    service: "svc",
    query: "foo",
    contains: "bar",
  });
  const combinedIds = new Set(combined.events.map((event) => event.id));
  assert.ok(combinedIds.has("1"));
  assert.ok(combinedIds.has("2"));
  assert.ok(!combinedIds.has("3"), "query must also match");
});
