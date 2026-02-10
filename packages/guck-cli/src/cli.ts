#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  loadConfig,
  resolveStoreDir,
  getDefaultConfig,
  findRepoRoot,
  resolveCheckpointPath,
  redactEvent,
  appendEvent,
} from "@guckdev/core";
import { GuckEvent, GuckLevel } from "@guckdev/core";
import { emit } from "@guckdev/sdk";
import { startMcpServer } from "@guckdev/mcp";

const printHelp = (): void => {
  console.log(
    `Guck - MCP-first telemetry\n\nCommands:\n  init                 Create .guck.json and .guck.local.json\n  checkpoint           Write a .guck-checkpoint epoch timestamp\n  wrap --service <s> --session <id> -- <cmd...>\n                       Capture stdout/stderr and write JSONL\n  emit --service <s> --session <id>\n                       Read JSON events from stdin and append\n  mcp                  Start MCP server\n  upgrade              Update the @guckdev/cli install\n\nOptions:\n  --version, -v        Print version\n`,
  );
};

const loadVersion = (): string | null => {
  try {
    const pkgUrl = new URL("../package.json", import.meta.url);
    const raw = fs.readFileSync(pkgUrl, "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.trim().length > 0
      ? parsed.version
      : null;
  } catch {
    return null;
  }
};

const printVersion = (): void => {
  const version = loadVersion();
  if (!version) {
    console.error("Failed to determine CLI version.");
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${version}\n`);
};

type PackageManagerName = "npm" | "pnpm" | "yarn" | "bun";

const detectPackageManager = (): PackageManagerName | null => {
  const userAgent = process.env.npm_config_user_agent;
  if (!userAgent) {
    return null;
  }
  const match = userAgent.match(/^(npm|pnpm|yarn|bun)\//);
  return match ? (match[1] as PackageManagerName) : null;
};

const getPackageManagerCandidates = (): PackageManagerName[] => {
  const preferred = detectPackageManager();
  const defaults: PackageManagerName[] = ["npm", "pnpm", "yarn", "bun"];
  if (!preferred) {
    return defaults;
  }
  return [preferred, ...defaults.filter((name) => name !== preferred)];
};

const buildUpgradeArgs = (manager: PackageManagerName): string[] => {
  switch (manager) {
    case "pnpm":
      return ["add", "-g", "@guckdev/cli"];
    case "yarn":
      return ["global", "add", "@guckdev/cli"];
    case "bun":
      return ["add", "-g", "@guckdev/cli"];
    case "npm":
    default:
      return ["install", "-g", "@guckdev/cli"];
  }
};

const runUpgrade = async (
  manager: PackageManagerName,
): Promise<{ status: "ok"; code: number } | { status: "missing" } | { status: "failed"; error: Error }> => {
  const args = buildUpgradeArgs(manager);
  return await new Promise((resolve) => {
    let settled = false;
    const child = spawn(manager, args, { stdio: "inherit" });
    const finish = (
      result: { status: "ok"; code: number } | { status: "missing" } | { status: "failed"; error: Error },
    ) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };
    child.on("error", (error) => {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        finish({ status: "missing" });
        return;
      }
      finish({ status: "failed", error });
    });
    child.on("exit", (code) => {
      finish({ status: "ok", code: code ?? 0 });
    });
  });
};

const parseArgs = (argv: string[]) => {
  const args = [...argv];
  const opts: Record<string, string> = {};
  const rest: string[] = [];
  while (args.length > 0) {
    const next = args.shift();
    if (!next) {
      break;
    }
    if (next === "--") {
      rest.push(...args);
      break;
    }
    if (next.startsWith("--")) {
      const key = next.slice(2);
      const value = args.shift();
      if (!value) {
        throw new Error(`Missing value for --${key}`);
      }
      opts[key] = value;
      continue;
    }
    rest.push(next);
  }
  return { opts, rest };
};

const writeInitFiles = (rootDir: string): void => {
  const configPath = path.join(rootDir, ".guck.json");
  const defaultConfig = getDefaultConfig();
  const repoName = path.basename(rootDir);
  const seededConfig = {
    ...defaultConfig,
    default_service: repoName || defaultConfig.default_service,
  };

  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify(seededConfig, null, 2));
    console.log(`Created ${configPath}`);
  } else {
    console.log(`Config already exists: ${configPath}`);
  }
};

const toLevel = (type: "stdout" | "stderr"): GuckLevel =>
  type === "stderr" ? "error" : "info";

const buildEvent = (
  type: "stdout" | "stderr",
  message: string,
  base: Pick<GuckEvent, "service" | "run_id" | "session_id">,
): GuckEvent => {
  return {
    id: randomUUID(),
    ts: new Date().toISOString(),
    level: toLevel(type),
    type,
    service: base.service,
    run_id: base.run_id,
    session_id: base.session_id,
    message,
    source: { kind: type },
  };
};

const captureStream = (
  stream: NodeJS.ReadableStream,
  type: "stdout" | "stderr",
  base: Pick<GuckEvent, "service" | "run_id" | "session_id">,
  storeDir: string,
  config: ReturnType<typeof loadConfig>["config"],
  forward: NodeJS.WriteStream,
) => {
  let buffer = "";
  stream.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    forward.write(chunk);
    buffer += text;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim().length === 0) {
        continue;
      }
      const event = buildEvent(type, line, base);
      const redacted = redactEvent(config, event);
      void appendEvent(storeDir, redacted);
    }
  });
  stream.on("end", () => {
    if (buffer.trim().length > 0) {
      const event = buildEvent(type, buffer, base);
      const redacted = redactEvent(config, event);
      void appendEvent(storeDir, redacted);
    }
  });
};

const handleWrap = async (argv: string[]): Promise<number> => {
  const { opts, rest } = parseArgs(argv);
  if (rest.length === 0 || !rest[0]) {
    console.error("wrap requires a command after --");
    return 1;
  }

  const { config, rootDir } = loadConfig();
  if (!config.enabled) {
    console.log("Guck disabled via config/env; running command without capture.");
    const child = spawn(rest[0], rest.slice(1), { stdio: "inherit" });
    return new Promise((resolve) => {
      child.on("exit", (code: number | null) => resolve(code ?? 0));
    });
  }

  const runId = process.env.GUCK_RUN_ID ?? randomUUID();
  const service = opts.service ?? config.default_service;
  const session = opts.session ?? process.env.GUCK_SESSION_ID;
  const storeDir = resolveStoreDir(config, rootDir);

  const child = spawn(rest[0], rest.slice(1), {
    stdio: ["inherit", "pipe", "pipe"],
    env: {
      ...process.env,
      GUCK_RUN_ID: runId,
      GUCK_SERVICE: service,
      GUCK_WRAPPED: "1",
      ...(session ? { GUCK_SESSION_ID: session } : {}),
    },
  });

  const base = { service, run_id: runId, session_id: session };
  if (child.stdout) {
    captureStream(child.stdout, "stdout", base, storeDir, config, process.stdout);
  }
  if (child.stderr) {
    captureStream(child.stderr, "stderr", base, storeDir, config, process.stderr);
  }

  return new Promise((resolve) => {
    child.on("exit", (code: number | null) => resolve(code ?? 0));
  });
};

const parseJsonInput = (input: string): unknown[] => {
  const trimmed = input.trim();
  if (!trimmed) {
    return [];
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    return [parsed];
  } catch {
    const lines = trimmed.split(/\r?\n/).filter(Boolean);
    const items: unknown[] = [];
    for (const line of lines) {
      items.push(JSON.parse(line));
    }
    return items;
  }
};

const handleEmit = async (argv: string[]): Promise<number> => {
  const { opts } = parseArgs(argv);
  const input = await new Promise<string>((resolve) => {
    let buffer = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      buffer += chunk;
    });
    process.stdin.on("end", () => resolve(buffer));
  });

  let items: unknown[] = [];
  try {
    items = parseJsonInput(input);
  } catch (error) {
    console.error("Failed to parse JSON input", error);
    return 1;
  }

  for (const item of items) {
    if (item && typeof item === "object") {
      const event = item as Partial<GuckEvent>;
      if (opts.service && !event.service) {
        event.service = opts.service;
      }
      if (opts.session && !event.session_id) {
        event.session_id = opts.session;
      }
      await emit(event);
    }
  }

  return 0;
};

const handleUpgrade = async (argv: string[]): Promise<number> => {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log("Usage: guck upgrade\nUpdates @guckdev/cli using a global install.");
    return 0;
  }

  for (const manager of getPackageManagerCandidates()) {
    const result = await runUpgrade(manager);
    if (result.status === "missing") {
      continue;
    }
    if (result.status === "failed") {
      console.error(`Failed to run ${manager}.`, result.error);
      return 1;
    }
    return result.code;
  }

  console.error("No supported package manager found (npm, pnpm, yarn, bun).");
  return 1;
};

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (command === "--version" || command === "-v") {
    printVersion();
    return;
  }

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "init") {
    const root = findRepoRoot(process.cwd());
    writeInitFiles(root);
    return;
  }

  if (command === "wrap") {
    const exitCode = await handleWrap(argv.slice(1));
    process.exitCode = exitCode;
    return;
  }

  if (command === "emit") {
    const exitCode = await handleEmit(argv.slice(1));
    process.exitCode = exitCode;
    return;
  }

  if (command === "checkpoint") {
    const { rootDir, config } = loadConfig();
    const storeDir = resolveStoreDir(config, rootDir);
    const checkpointPath = resolveCheckpointPath(storeDir);
    const value = Date.now();
    fs.writeFileSync(checkpointPath, `${value}\n`, "utf8");
    process.stdout.write(`${value}\n`);
    return;
  }

  if (command === "mcp") {
    await startMcpServer();
    return;
  }

  if (command === "upgrade") {
    const exitCode = await handleUpgrade(argv.slice(1));
    process.exitCode = exitCode;
    return;
  }

  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exitCode = 1;
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
