import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const distAuto = path.join(repoRoot, "dist", "auto.js");
const distIndex = path.join(repoRoot, "dist", "index.js");

if (!fs.existsSync(distAuto) || !fs.existsSync(distIndex)) {
  execSync("pnpm run build", { cwd: repoRoot, stdio: "inherit" });
}

const runNode = (script, envOverrides = {}) => {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: repoRoot,
    env: { ...process.env, ...envOverrides },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
};

const readEvents = (storeDir, service, runId) => {
  const dateSegment = new Date().toISOString().slice(0, 10);
  const filePath = path.join(storeDir, service, dateSegment, `${runId}.jsonl`);
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) {
    return [];
  }
  return raw.split(/\r?\n/).map((line) => JSON.parse(line));
};

test("auto-captures stdout and stderr lines", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "grpr-auto-"));
  const storeDir = path.join(tempDir, "store");
  const service = "auto-capture";
  const runId = "run-stdout-stderr";

  runNode(
    `
      import { pathToFileURL } from "node:url";
      const autoUrl = pathToFileURL(process.env.GRPR_AUTO_PATH).href;
      await import(autoUrl);
      process.stdout.write("hello stdout\\n");
      process.stderr.write("oops stderr\\n");
      await new Promise((resolve) => setTimeout(resolve, 50));
    `,
    {
      GRPR_AUTO_PATH: distAuto,
      GRPR_DIR: storeDir,
      GRPR_SERVICE: service,
      GRPR_RUN_ID: runId,
    },
  );

  const events = readEvents(storeDir, service, runId);
  assert.ok(
    events.some(
      (event) =>
        event.message === "hello stdout" &&
        event.type === "stdout" &&
        event.level === "info" &&
        event.source?.kind === "stdout",
    ),
    "expected stdout event",
  );
  assert.ok(
    events.some(
      (event) =>
        event.message === "oops stderr" &&
        event.type === "stderr" &&
        event.level === "error" &&
        event.source?.kind === "stderr",
    ),
    "expected stderr event",
  );
});

test("respects sdk.enabled=false in config", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "grpr-auto-"));
  const storeDir = path.join(tempDir, "store");
  const service = "auto-disabled";
  const runId = "run-disabled";
  const configPath = path.join(tempDir, ".grpr.json");

  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        enabled: true,
        store_dir: storeDir,
        default_service: service,
        sdk: { enabled: false },
      },
      null,
      2,
    ),
  );

  runNode(
    `
      import { pathToFileURL } from "node:url";
      const autoUrl = pathToFileURL(process.env.GRPR_AUTO_PATH).href;
      await import(autoUrl);
      process.stdout.write("should-not-capture\\n");
      await new Promise((resolve) => setTimeout(resolve, 50));
    `,
    {
      GRPR_AUTO_PATH: distAuto,
      GRPR_CONFIG_PATH: configPath,
      GRPR_SERVICE: service,
      GRPR_RUN_ID: runId,
    },
  );

  const dateSegment = new Date().toISOString().slice(0, 10);
  const filePath = path.join(storeDir, service, dateSegment, `${runId}.jsonl`);
  assert.ok(!fs.existsSync(filePath), "expected no captured events");
});

test("flushes partial lines on stop()", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "grpr-auto-"));
  const storeDir = path.join(tempDir, "store");
  const service = "auto-flush";
  const runId = "run-partial";

  runNode(
    `
      import { pathToFileURL } from "node:url";
      const indexUrl = pathToFileURL(process.env.GRPR_INDEX_PATH).href;
      const { installAutoCapture } = await import(indexUrl);
      const handle = installAutoCapture();
      process.stdout.write("partial line");
      handle.stop();
      await new Promise((resolve) => setTimeout(resolve, 50));
    `,
    {
      GRPR_INDEX_PATH: distIndex,
      GRPR_DIR: storeDir,
      GRPR_SERVICE: service,
      GRPR_RUN_ID: runId,
    },
  );

  const events = readEvents(storeDir, service, runId);
  assert.ok(
    events.some((event) => event.message === "partial line" && event.type === "stdout"),
    "expected partial line to be flushed",
  );
});
