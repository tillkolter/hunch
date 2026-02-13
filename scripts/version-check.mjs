import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const version = fs.readFileSync(path.join(root, "VERSION"), "utf8").trim();
const PACKAGE_JSON = "package.json";

const readPackage = (packagePath) => {
  return JSON.parse(
    fs.readFileSync(path.join(root, packagePath, PACKAGE_JSON), "utf8"),
  );
};

const assertPackageVersion = (packagePath) => {
  const pkg = readPackage(packagePath);
  if (pkg.version !== version) {
    throw new Error(
      `Version mismatch: VERSION=${version} ${packagePath}/${PACKAGE_JSON}=${pkg.version}`,
    );
  }
};

assertPackageVersion("packages/guck-js");
assertPackageVersion("packages/guck-cli");
assertPackageVersion("packages/guck-core");
assertPackageVersion("packages/guck-mcp");

const browserPkg = JSON.parse(
  fs.readFileSync(path.join(root, "packages", "guck-browser", "package.json"), "utf8"),
);

if (browserPkg.version !== version) {
  throw new Error(
    `Version mismatch: VERSION=${version} packages/guck-browser/package.json=${browserPkg.version}`,
  );
}

const pyproject = fs.readFileSync(
  path.join(root, "packages", "guck-py", "pyproject.toml"),
  "utf8",
);
if (!/dynamic\s*=\s*\[\s*"version"\s*\]/.test(pyproject)) {
  throw new Error("pyproject.toml must declare dynamic version");
}
if (!/tool\.hatch\.version[\s\S]*VERSION/.test(pyproject)) {
  throw new Error("pyproject.toml must reference VERSION for hatch versioning");
}
