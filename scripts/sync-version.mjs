import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const versionPath = path.join(root, "VERSION");
const version = fs.readFileSync(versionPath, "utf8").trim();

const updateJsonVersion = (filePath) => {
  const raw = fs.readFileSync(filePath, "utf8");
  const data = JSON.parse(raw);
  if (data.version !== version) {
    data.version = version;
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
  }
};

updateJsonVersion(path.join(root, "package.json"));
updateJsonVersion(path.join(root, "packages", "grpr-js", "package.json"));
updateJsonVersion(path.join(root, "packages", "grpr-cli", "package.json"));
updateJsonVersion(path.join(root, "packages", "grpr-core", "package.json"));
updateJsonVersion(path.join(root, "packages", "grpr-mcp", "package.json"));
