import test from "node:test";
import assert from "node:assert/strict";

const loadEventModule = async () => {
  const url = new URL("../dist/event.js", import.meta.url);
  url.searchParams.set("cacheBust", Date.now().toString());
  return await import(url.href);
};

test("buildEvent uses env defaults and stable run_id", async () => {
  const prevRun = process.env.GUCK_RUN_ID;
  const prevSession = process.env.GUCK_SESSION_ID;
  process.env.GUCK_RUN_ID = "run-core";
  process.env.GUCK_SESSION_ID = "sess-core";
  try {
    const { buildEvent } = await loadEventModule();
    const first = buildEvent({ message: "one" }, { service: "svc" });
    const second = buildEvent({ message: "two" }, { service: "svc" });
    assert.equal(first.run_id, "run-core");
    assert.equal(second.run_id, "run-core");
    assert.equal(first.session_id, "sess-core");
    assert.equal(first.level, "info");
    assert.equal(first.type, "log");
    assert.equal(first.service, "svc");
  } finally {
    if (prevRun === undefined) {
      delete process.env.GUCK_RUN_ID;
    } else {
      process.env.GUCK_RUN_ID = prevRun;
    }
    if (prevSession === undefined) {
      delete process.env.GUCK_SESSION_ID;
    } else {
      process.env.GUCK_SESSION_ID = prevSession;
    }
  }
});
