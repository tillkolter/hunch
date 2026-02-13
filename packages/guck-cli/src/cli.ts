#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
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

const CLI_PACKAGE = "@guckdev/cli";

const printHelp = (): void => {
  console.log(
    `Guck - MCP-first telemetry\n\nCommands:\n  init                 Create .guck.json and .guck.local.json\n  checkpoint           Write a .guck-checkpoint epoch timestamp\n  wrap --service <s> --session <id> -- <cmd...>\n                       Capture stdout/stderr and write JSONL\n  emit --service <s> --session <id>\n                       Read JSON events from stdin and append\n  mcp                  Start MCP server\n  upgrade [--manager <npm|pnpm|yarn|bun>]\n                       Update the @guckdev/cli install\n\nOptions:\n  --version, -v        Print version\n`,
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

type UpgradeManagerSource =
  | "flag"
  | "env"
  | "user agent"
  | "execpath"
  | "entry path";

const isPackageManager = (value: string): value is PackageManagerName =>
  value === "npm" || value === "pnpm" || value === "yarn" || value === "bun";

const parsePackageManager = (value: string | undefined | null): PackageManagerName | null => {
  if (!value) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return isPackageManager(normalized) ? normalized : null;
};

const detectPackageManager = (): PackageManagerName | null => {
  const userAgent = process.env.npm_config_user_agent;
  if (!userAgent) {
    return null;
  }
  const match = userAgent.match(/^(npm|pnpm|yarn|bun)\//);
  return match ? (match[1] as PackageManagerName) : null;
};

const detectPackageManagerFromExecPath = (execPath: string | undefined): PackageManagerName | null => {
  if (!execPath) {
    return null;
  }
  const lowered = execPath.toLowerCase();
  if (lowered.includes("pnpm")) {
    return "pnpm";
  }
  if (lowered.includes("yarn")) {
    return "yarn";
  }
  if (lowered.includes("npm")) {
    return "npm";
  }
  return null;
};

const detectPackageManagerFromEntryPath = (entryPath: string | null): PackageManagerName | null => {
  if (!entryPath) {
    return null;
  }
  const lowered = entryPath.toLowerCase();
  if (lowered.includes("/.pnpm/")) {
    return "pnpm";
  }
  if (lowered.includes("/.yarn/") || lowered.includes("/.config/yarn/")) {
    return "yarn";
  }
  if (lowered.includes("/.bun/")) {
    return "bun";
  }
  if (lowered.includes("/lib/node_modules/") || lowered.includes("/node_modules/@guckdev/cli/")) {
    return "npm";
  }
  return null;
};

const resolveUpgradeManager = (
  opts: Record<string, string>,
  env: NodeJS.ProcessEnv,
  entryPath: string | null,
): { manager: PackageManagerName; source: UpgradeManagerSource } | null => {
  const fromFlag = parsePackageManager(opts.manager);
  if (fromFlag) {
    return { manager: fromFlag, source: "flag" };
  }

  const fromEnv = parsePackageManager(env.GUCK_UPGRADE_MANAGER);
  if (fromEnv) {
    return { manager: fromEnv, source: "env" };
  }

  const fromUserAgent = detectPackageManager();
  if (fromUserAgent) {
    return { manager: fromUserAgent, source: "user agent" };
  }

  const fromExecPath = detectPackageManagerFromExecPath(env.npm_execpath);
  if (fromExecPath) {
    return { manager: fromExecPath, source: "execpath" };
  }

  const fromEntryPath = detectPackageManagerFromEntryPath(entryPath);
  if (fromEntryPath) {
    return { manager: fromEntryPath, source: "entry path" };
  }

  return null;
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
      return ["add", "-g", CLI_PACKAGE];
    case "yarn":
      return ["global", "add", CLI_PACKAGE];
    case "bun":
      return ["add", "-g", CLI_PACKAGE];
    case "npm":
    default:
      return ["install", "-g", CLI_PACKAGE];
  }
};

const canUseExecPath = (manager: PackageManagerName, execPath: string | undefined): boolean => {
  if (!execPath) {
    return false;
  }
  if (manager === "bun") {
    return false;
  }
  const lowered = execPath.toLowerCase();
  return lowered.includes(manager);
};

const spawnUpgradeProcess = (
  manager: PackageManagerName,
  args: string[],
  execPath: string | undefined,
): ReturnType<typeof spawn> => {
  if (canUseExecPath(manager, execPath)) {
    return spawn(process.execPath, [execPath as string, ...args], { stdio: "inherit" });
  }
  return spawn(manager, args, { stdio: "inherit" });
};

const runUpgrade = async (
  manager: PackageManagerName,
  execPath: string | undefined,
): Promise<{ status: "ok"; code: number } | { status: "missing" } | { status: "failed"; error: Error }> => {
  const args = buildUpgradeArgs(manager);
  return await new Promise((resolve) => {
    let settled = false;
    const child = spawnUpgradeProcess(manager, args, execPath);
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
      child.on("exit", (code: number | null) => {
        resolve(code ?? 0);
      });
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
    child.on("exit", (code: number | null) => {
      resolve(code ?? 0);
    });
  });
};

const parseJsonInput = (input: string): unknown[] => {
  const trimmed = input.trim();
  if (!trimmed) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
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
    process.stdin.on("end", () => {
      resolve(buffer);
    });
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
    console.log("Usage: guck upgrade [--manager <npm|pnpm|yarn|bun>]\nUpdates @guckdev/cli using a global install.");
    return 0;
  }

  const { opts } = parseArgs(argv);
  const beforeVersion = loadVersion();
  let entryPath: string | null = null;
  const argvPath = process.argv[1];
  if (argvPath) {
    try {
      entryPath = fs.realpathSync(argvPath);
    } catch {
      entryPath = argvPath;
    }
  }

  const explicitManager = opts.manager ? parsePackageManager(opts.manager) : null;
  if (opts.manager && !explicitManager) {
    console.error(`Invalid package manager: ${opts.manager}. Expected npm, pnpm, yarn, or bun.`);
    return 1;
  }

  const resolved = resolveUpgradeManager(opts, process.env, entryPath);
  const execPath = process.env.npm_execpath;

  const tryUpgrade = async (manager: PackageManagerName, source: UpgradeManagerSource | null) => {
    if (source) {
      console.log(`Using ${manager} (detected from ${source}).`);
    }
    const result = await runUpgrade(manager, execPath);
    if (result.status === "missing") {
      return { status: "missing" as const };
    }
    if (result.status === "failed") {
      console.error(`Failed to run ${manager}.`, result.error);
      return { status: "failed" as const, code: 1 };
    }
    return { status: "ok" as const, code: result.code };
  };

  const verifyUpgrade = (exitCode: number): number => {
    const after = spawnSync("guck", ["--version"], { encoding: "utf8" });
    const afterVersion = after.status === 0 ? after.stdout.trim() : null;
    if (!afterVersion || !beforeVersion) {
      console.warn("Upgrade completed, but could not verify the installed version.");
      if (after.status !== 0 && after.stderr) {
        console.warn(after.stderr.trim());
      }
      console.warn(`Current script path: ${process.argv[1] ?? "unknown"}`);
      return exitCode;
    }
    if (afterVersion === beforeVersion) {
      let resolvedPath = "";
      const whichCmd = process.platform === "win32" ? "where" : "which";
      const whichResult = spawnSync(whichCmd, ["guck"], { encoding: "utf8" });
      if (whichResult.status === 0) {
        resolvedPath = whichResult.stdout.trim();
      }
      console.warn("Upgrade finished, but the active guck version did not change.");
      console.warn(`Before: ${beforeVersion}`);
      console.warn(`After : ${afterVersion}`);
      console.warn(`Current script path: ${process.argv[1] ?? "unknown"}`);
      if (resolvedPath) {
        console.warn(`PATH-resolved guck: ${resolvedPath}`);
      }
      return exitCode;
    }

    console.log("Upgraded @guckdev/cli");
    console.log(`Before: ${beforeVersion}`);
    console.log(`After : ${afterVersion}`);
    return exitCode;
  };

  if (explicitManager) {
    const result = await tryUpgrade(explicitManager, "flag");
    if (result.status === "missing") {
      console.error(`No ${explicitManager} executable found on PATH.`);
      return 1;
    }
    if (result.status === "failed") {
      return result.code;
    }
    return verifyUpgrade(result.code);
  }

  const candidates: Array<{ manager: PackageManagerName; source: UpgradeManagerSource | null }> = [];
  if (resolved) {
    candidates.push({ manager: resolved.manager, source: resolved.source });
  }
  for (const manager of getPackageManagerCandidates()) {
    if (!candidates.some((candidate) => candidate.manager === manager)) {
      candidates.push({ manager, source: null });
    }
  }

  for (const candidate of candidates) {
    const result = await tryUpgrade(candidate.manager, candidate.source);
    if (result.status === "missing") {
      if (candidate.source) {
        console.warn(`${candidate.manager} not found. Falling back to other package managers.`);
      }
      continue;
    }
    if (result.status === "failed") {
      return result.code;
    }
    return verifyUpgrade(result.code);
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
    const valueText = `${String(value)}\n`;
    fs.writeFileSync(checkpointPath, valueText, "utf8");
    process.stdout.write(valueText);
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

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
