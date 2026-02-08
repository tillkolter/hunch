import fs from "node:fs";

import { emit } from "../dist/index.js";

const casePath = process.env.HUNCH_CASE_PATH;
if (!casePath) {
  throw new Error("Missing HUNCH_CASE_PATH");
}

const raw = fs.readFileSync(casePath, "utf8");
const testCase = JSON.parse(raw);

await emit(testCase.input || {});
