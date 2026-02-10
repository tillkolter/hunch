import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const distIndex = path.join(repoRoot, "dist", "index.js");

if (!fs.existsSync(distIndex)) {
  execSync("pnpm run build", { cwd: repoRoot, stdio: "inherit" });
}

const rootDir = path.resolve(__dirname, "..", "..", "..");
const casesPath = path.join(rootDir, "specs", "auto_capture_cases.json");
const cases = JSON.parse(fs.readFileSync(casesPath, "utf8"));
const workerPath = path.join(__dirname, "auto_capture.contract.worker.mjs");

const uuidRegex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

const formatDateSegment = (ts) => {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const assertEventMatches = (event, testCase) => {
  const expected = testCase.expect || {};
  for (const [key, value] of Object.entries(expected)) {
    assert.deepStrictEqual(event[key], value, `expected ${key} to match`);
  }

  const missing = testCase.expect_missing || [];
  for (const key of missing) {
    assert.ok(!(key in event), `expected ${key} to be absent`);
  }

  const regexChecks = testCase.expect_regex || {};
  for (const [key, rule] of Object.entries(regexChecks)) {
    const value = event[key];
    assert.ok(typeof value === "string", `expected ${key} to be a string`);
    if (rule === "uuid") {
      assert.ok(uuidRegex.test(value), `expected ${key} to be uuid`);
    } else if (rule === "iso") {
      assert.ok(!Number.isNaN(Date.parse(value)), `expected ${key} to be ISO`);
    }
  }
};

const findMatchingEvent = (events, expected) => {
  return events.find((event) => {
    for (const [key, value] of Object.entries(expected)) {
      if (!isDeepStrictEqual(event[key], value)) {
        return false;
      }
    }
    return true;
  });
};

for (const testCase of cases) {
  test(testCase.name, () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "guck-auto-case-"));
    const configPath = path.join(tempDir, ".guck.json");
    fs.writeFileSync(configPath, JSON.stringify(testCase.config, null, 2));
    const casePath = path.join(tempDir, "case.json");
    fs.writeFileSync(casePath, JSON.stringify(testCase, null, 2));

    const defaultStoreDir = path.join(tempDir, "store");
    const env = {
      ...process.env,
      GUCK_CONFIG_PATH: configPath,
      GUCK_CASE_PATH: casePath,
      GUCK_INDEX_PATH: distIndex,
      GUCK_DIR: defaultStoreDir,
      ...testCase.env,
    };

    const result = spawnSync(process.execPath, [workerPath], {
      env,
      stdio: "inherit",
    });

    assert.equal(result.status, 0, "worker should exit cleanly");

    const configuredStore =
      testCase.expect_store_dir || env.GUCK_DIR || path.join(os.homedir(), ".guck", "logs");
    const storeDir = path.isAbsolute(configuredStore)
      ? configuredStore
      : path.join(path.dirname(configPath), configuredStore);

    const files = collectJsonlFiles(storeDir);
    if (testCase.expect_no_write) {
      assert.equal(files.length, 0, "expected no JSONL files");
      return;
    }

    assert.equal(files.length, 1, "expected one JSONL file");
    const content = fs.readFileSync(files[0], "utf8").trim();
    const lines = content.split(/\r?\n/).filter(Boolean);
    assert.ok(lines.length > 0, "expected JSONL content");
    const events = lines.map((line) => JSON.parse(line));

    const expected = testCase.expect || {};
    const event = findMatchingEvent(events, expected) ?? events[0];
    assertEventMatches(event, testCase);

    if (testCase.env?.GUCK_RUN_ID) {
      assert.equal(event.run_id, testCase.env.GUCK_RUN_ID);
    }
    if (testCase.env?.GUCK_SESSION_ID) {
      assert.equal(event.session_id, testCase.env.GUCK_SESSION_ID);
    }

    assert.ok(uuidRegex.test(event.id), "expected id to be uuid");
    const dateSegment = formatDateSegment(event.ts);
    assert.ok(dateSegment, "expected valid timestamp");
    const expectedPath = path.join(storeDir, event.service, dateSegment, `${event.run_id}.jsonl`);
    assert.equal(files[0], expectedPath, "expected store path to match");
  });
}
