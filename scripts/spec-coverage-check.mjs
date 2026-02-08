import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const specsDir = path.join(rootDir, "specs");

const fileIncludes = (filePath, needle) => {
  const content = fs.readFileSync(filePath, "utf8");
  return content.includes(needle);
};

const fail = (message) => {
  throw new Error(message);
};

if (!fs.existsSync(specsDir)) {
  fail(`specs directory missing: ${specsDir}`);
}

const entries = fs.readdirSync(specsDir, { withFileTypes: true });
const specFiles = entries
  .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
  .map((entry) => entry.name);

if (specFiles.length === 0) {
  fail("expected at least one spec file");
}

for (const specFile of specFiles) {
  const match = specFile.match(/^(.*)_cases\.json$/);
  if (!match) {
    fail(
      `spec file ${specFile} must follow '*_cases.json' naming (update this check if needed)`,
    );
  }
  const suite = match[1];

  const jsTestPath = path.join(
    rootDir,
    "packages",
    "grpr-js",
    "test",
    `${suite}.contract.test.js`,
  );
  const pyTestPath = path.join(
    rootDir,
    "packages",
    "grpr-py",
    "tests",
    `test_${suite}_contract.py`,
  );

  if (!fs.existsSync(jsTestPath)) {
    fail(`missing JS contract test for ${specFile}: ${jsTestPath}`);
  }
  if (!fs.existsSync(pyTestPath)) {
    fail(`missing Python contract test for ${specFile}: ${pyTestPath}`);
  }

  if (!fileIncludes(jsTestPath, specFile)) {
    fail(`JS test does not reference ${specFile}`);
  }
  if (!fileIncludes(pyTestPath, specFile)) {
    fail(`Python test does not reference ${specFile}`);
  }
}

console.log("Spec coverage check passed.");
