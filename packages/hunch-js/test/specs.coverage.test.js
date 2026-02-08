import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..", "..", "..");
const specsDir = path.join(rootDir, "specs");

const fileIncludes = (filePath, needle) => {
  const content = fs.readFileSync(filePath, "utf8");
  return content.includes(needle);
};

test("spec coverage: each spec has JS + Python contract tests", () => {
  assert.ok(fs.existsSync(specsDir), `specs directory missing: ${specsDir}`);
  const entries = fs.readdirSync(specsDir, { withFileTypes: true });
  const specFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name);

  assert.ok(specFiles.length > 0, "expected at least one spec file");

  for (const specFile of specFiles) {
    const match = specFile.match(/^(.*)_cases\\.json$/);
    assert.ok(
      match,
      `spec file ${specFile} must follow '*_cases.json' naming (update this test if needed)`,
    );
    const suite = match[1];

    const jsTestPath = path.join(
      rootDir,
      "packages",
      "hunch-js",
      "test",
      `${suite}.contract.test.js`,
    );
    const pyTestPath = path.join(
      rootDir,
      "packages",
      "hunch-py",
      "tests",
      `test_${suite}_contract.py`,
    );

    assert.ok(
      fs.existsSync(jsTestPath),
      `missing JS contract test for ${specFile}: ${jsTestPath}`,
    );
    assert.ok(
      fs.existsSync(pyTestPath),
      `missing Python contract test for ${specFile}: ${pyTestPath}`,
    );

    assert.ok(
      fileIncludes(jsTestPath, specFile),
      `JS test does not reference ${specFile}`,
    );
    assert.ok(
      fileIncludes(pyTestPath, specFile),
      `Python test does not reference ${specFile}`,
    );
  }
});
