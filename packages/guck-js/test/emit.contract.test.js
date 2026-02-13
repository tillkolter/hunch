import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..", "..", "..");
const casesPath = path.join(rootDir, "specs", "emit_cases.json");
const cases = JSON.parse(fs.readFileSync(casesPath, "utf8"));
const workerPath = path.join(__dirname, "emit.contract.worker.mjs");

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

for (const testCase of cases) {
  test(testCase.name, () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "guck-case-"));
    const configPath = path.join(tempDir, ".guck.json");
    fs.writeFileSync(configPath, JSON.stringify(testCase.config, null, 2));
    const casePath = path.join(tempDir, "case.json");
    fs.writeFileSync(casePath, JSON.stringify(testCase, null, 2));

    const defaultStoreDir = path.join(tempDir, "store");
    const env = {
      ...process.env,
      GUCK_CONFIG_PATH: configPath,
      GUCK_CASE_PATH: casePath,
      GUCK_DIR: defaultStoreDir,
      ...testCase.env,
    };

    const configuredStore =
      testCase.expect_store_dir || env.GUCK_DIR || path.join(os.homedir(), ".guck", "logs");
    const storeDir = path.isAbsolute(configuredStore)
      ? configuredStore
      : path.join(path.dirname(configPath), configuredStore);
    const resolvedStoreDir = path.resolve(storeDir);
    const tempRoot = path.resolve(tempDir);
    const osTmp = path.resolve(os.tmpdir());
    const safeRoots = [tempRoot, osTmp];
    if (path.sep === "/") {
      safeRoots.push("/tmp", "/private/tmp", "/var/tmp");
    }
    const isSafe = safeRoots.some(
      (root) => resolvedStoreDir === root || resolvedStoreDir.startsWith(`${root}${path.sep}`),
    );
    if (isSafe) {
      fs.rmSync(resolvedStoreDir, { recursive: true, force: true });
    }

    const result = spawnSync(process.execPath, [workerPath], {
      env,
      stdio: "inherit",
    });

    assert.equal(result.status, 0, "worker should exit cleanly");

    if (testCase.expect_no_write) {
      const files = collectJsonlFiles(storeDir);
      assert.equal(files.length, 0, "expected no JSONL files");
      return;
    }

    const files = collectJsonlFiles(storeDir);
    assert.equal(files.length, 1, "expected one JSONL file");
    const content = fs.readFileSync(files[0], "utf8").trim();
    const line = content.split(/\r?\n/).find(Boolean);
    assert.ok(line, "expected JSONL content");
    const event = JSON.parse(line);

    assertEventMatches(event, testCase);

    const dateSegment = formatDateSegment(event.ts);
    assert.ok(dateSegment, "expected valid timestamp");
    const expectedPath = path.join(storeDir, event.service, dateSegment, `${event.run_id}.jsonl`);
    assert.equal(files[0], expectedPath, "expected store path to match");
  });
}
