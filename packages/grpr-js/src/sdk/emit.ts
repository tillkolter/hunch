import { randomUUID } from "node:crypto";
import {
  appendEvent,
  GrprEvent,
  GrprLevel,
  loadConfig,
  redactEvent,
  resolveStoreDir,
} from "grpr-core";

let cached:
  | {
      storeDir: string;
      config: ReturnType<typeof loadConfig>["config"];
    }
  | undefined;

const defaultRunId = process.env.GRPR_RUN_ID ?? randomUUID();
const defaultSessionId = process.env.GRPR_SESSION_ID;

const normalizeLevel = (level?: string): GrprLevel => {
  if (!level) {
    return "info";
  }
  const lower = level.toLowerCase();
  if (
    lower === "trace" ||
    lower === "debug" ||
    lower === "info" ||
    lower === "warn" ||
    lower === "error" ||
    lower === "fatal"
  ) {
    return lower;
  }
  return "info";
};

const toEvent = (
  input: Partial<GrprEvent>,
  defaults: { service: string },
): GrprEvent => {
  return {
    id: input.id ?? randomUUID(),
    ts: input.ts ?? new Date().toISOString(),
    level: normalizeLevel(input.level),
    type: input.type ?? "log",
    service: input.service ?? defaults.service,
    run_id: input.run_id ?? defaultRunId,
    session_id: input.session_id ?? defaultSessionId,
    message: input.message,
    data: input.data,
    tags: input.tags,
    trace_id: input.trace_id,
    span_id: input.span_id,
    source: input.source ?? { kind: "sdk" },
  };
};

const getCached = () => {
  if (cached) {
    return cached;
  }
  const loaded = loadConfig();
  const storeDir = resolveStoreDir(loaded.config, loaded.rootDir);
  cached = { storeDir, config: loaded.config };
  return cached;
};

export const emit = async (input: Partial<GrprEvent>): Promise<void> => {
  const { storeDir, config } = getCached();
  if (!config.enabled) {
    return;
  }
  const event = toEvent(input, { service: config.default_service });
  const redacted = redactEvent(config, event);
  await appendEvent(storeDir, redacted);
};
