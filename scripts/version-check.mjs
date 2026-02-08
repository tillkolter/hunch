import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const version = fs.readFileSync(path.join(root, "VERSION"), "utf8").trim();

const pkg = JSON.parse(
  fs.readFileSync(path.join(root, "packages", "grpr-js", "package.json"), "utf8"),
);

if (pkg.version !== version) {
  throw new Error(
    `Version mismatch: VERSION=${version} packages/grpr-js/package.json=${pkg.version}`,
  );
}

const cliPkg = JSON.parse(
  fs.readFileSync(path.join(root, "packages", "grpr-cli", "package.json"), "utf8"),
);

if (cliPkg.version !== version) {
  throw new Error(
    `Version mismatch: VERSION=${version} packages/grpr-cli/package.json=${cliPkg.version}`,
  );
}

const corePkg = JSON.parse(
  fs.readFileSync(path.join(root, "packages", "grpr-core", "package.json"), "utf8"),
);

if (corePkg.version !== version) {
  throw new Error(
    `Version mismatch: VERSION=${version} packages/grpr-core/package.json=${corePkg.version}`,
  );
}

const mcpPkg = JSON.parse(
  fs.readFileSync(path.join(root, "packages", "grpr-mcp", "package.json"), "utf8"),
);

if (mcpPkg.version !== version) {
  throw new Error(
    `Version mismatch: VERSION=${version} packages/grpr-mcp/package.json=${mcpPkg.version}`,
  );
}

const pyproject = fs.readFileSync(
  path.join(root, "packages", "grpr-py", "pyproject.toml"),
  "utf8",
);
if (!/dynamic\s*=\s*\[\s*"version"\s*\]/.test(pyproject)) {
  throw new Error("pyproject.toml must declare dynamic version");
}
if (!/tool\.hatch\.version[\s\S]*VERSION/.test(pyproject)) {
  throw new Error("pyproject.toml must reference VERSION for hatch versioning");
}
