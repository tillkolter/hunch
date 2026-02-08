#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { loadConfig, resolveStoreDir, getDefaultConfig, findRepoRoot } from "./config.js";
import { redactEvent } from "./redact.js";
import { appendEvent } from "./store/file-store.js";
import { HunchEvent, HunchLevel } from "./schema.js";
import { emit } from "./sdk/emit.js";
import { startMcpServer } from "./mcp/server.js";

const printHelp = (): void => {
  console.log(`Hunch - MCP-first telemetry\n\nCommands:\n  init                 Create .hunch.json and .hunch.local.json\n  wrap --service <s> --session <id> -- <cmd...>\n                       Capture stdout/stderr and write JSONL\n  emit --service <s> --session <id>\n                       Read JSON events from stdin and append\n  mcp                  Start MCP server\n`);
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
  const configPath = path.join(rootDir, ".hunch.json");
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

const toLevel = (type: "stdout" | "stderr"): HunchLevel =>
  type === "stderr" ? "error" : "info";

const buildEvent = (
  type: "stdout" | "stderr",
  message: string,
  base: Pick<HunchEvent, "service" | "run_id" | "session_id">,
): HunchEvent => {
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
  base: Pick<HunchEvent, "service" | "run_id" | "session_id">,
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
    console.log("Hunch disabled via config/env; running command without capture.");
    const child = spawn(rest[0], rest.slice(1), { stdio: "inherit" });
    return new Promise((resolve) => {
      child.on("exit", (code: number | null) => resolve(code ?? 0));
    });
  }

  const runId = process.env.HUNCH_RUN_ID ?? randomUUID();
  const service = opts.service ?? config.default_service;
  const session = opts.session ?? process.env.HUNCH_SESSION_ID;
  const storeDir = resolveStoreDir(config, rootDir);

  const child = spawn(rest[0], rest.slice(1), {
    stdio: ["inherit", "pipe", "pipe"],
    env: {
      ...process.env,
      HUNCH_RUN_ID: runId,
      HUNCH_SERVICE: service,
      ...(session ? { HUNCH_SESSION_ID: session } : {}),
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
      const event = item as Partial<HunchEvent>;
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

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2);
  const command = argv[0];

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

  if (command === "mcp") {
    await startMcpServer();
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
