import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { loadConfig, resolveStoreDir } from "../../guck-core/dist/config.js";

const writeConfig = (configPath, config) => {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
};

test("loadConfig accepts a directory config_path", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "guck-config-dir-"));
  const configPath = path.join(tempDir, ".guck.json");
  writeConfig(configPath, {});

  const { rootDir, config } = loadConfig({ configPath: tempDir });
  assert.equal(rootDir, tempDir);
  assert.equal(resolveStoreDir(config, rootDir), path.join(os.homedir(), ".guck", "logs"));
});

test("loadConfig resolves relative config_path against cwd", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "guck-config-cwd-"));
  const configDir = path.join(tempDir, "config");
  fs.mkdirSync(configDir);
  const configPath = path.join(configDir, ".guck.json");
  writeConfig(configPath, {});

  const { rootDir, config } = loadConfig({
    cwd: tempDir,
    configPath: "config/.guck.json",
  });
  assert.equal(rootDir, configDir);
  assert.equal(resolveStoreDir(config, rootDir), path.join(os.homedir(), ".guck", "logs"));
});
