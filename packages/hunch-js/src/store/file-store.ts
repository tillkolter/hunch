import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import {
  HunchConfig,
  HunchEvent,
  HunchLevel,
  HunchSearchParams,
  HunchSessionsParams,
  HunchStatsParams,
} from "../schema.js";
import { parseTimeInput, normalizeTimestamp, formatDateSegment } from "./time.js";

const ensureDir = async (dir: string): Promise<void> => {
  await fs.promises.mkdir(dir, { recursive: true });
};

const getEventTimestamp = (event: HunchEvent): number | undefined => {
  return normalizeTimestamp(event.ts);
};

const matchesContains = (event: HunchEvent, needle: string): boolean => {
  const lower = needle.toLowerCase();
  const message = event.message?.toLowerCase() ?? "";
  if (message.includes(lower)) {
    return true;
  }
  if (event.type.toLowerCase().includes(lower)) {
    return true;
  }
  if (event.session_id?.toLowerCase().includes(lower)) {
    return true;
  }
  if (event.data) {
    try {
      const serialized = JSON.stringify(event.data).toLowerCase();
      if (serialized.includes(lower)) {
        return true;
      }
    } catch {
      return false;
    }
  }
  return false;
};

const eventMatches = (
  event: HunchEvent,
  params: HunchSearchParams,
  sinceMs?: number,
  untilMs?: number,
): boolean => {
  if (params.service && event.service !== params.service) {
    return false;
  }
  if (params.session_id && event.session_id !== params.session_id) {
    return false;
  }
  if (params.run_id && event.run_id !== params.run_id) {
    return false;
  }
  if (params.types && params.types.length > 0 && !params.types.includes(event.type)) {
    return false;
  }
  if (params.levels && params.levels.length > 0 && !params.levels.includes(event.level)) {
    return false;
  }
  if (params.contains && !matchesContains(event, params.contains)) {
    return false;
  }
  const ts = getEventTimestamp(event);
  if (sinceMs !== undefined && ts !== undefined && ts < sinceMs) {
    return false;
  }
  if (untilMs !== undefined && ts !== undefined && ts > untilMs) {
    return false;
  }
  return true;
};

const collectFiles = async (root: string, service?: string): Promise<string[]> => {
  const storeRoot = service ? path.join(root, service) : root;
  const result: string[] = [];
  if (!fs.existsSync(storeRoot)) {
    return result;
  }

  const stack: string[] = [storeRoot];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    const entries = await fs.promises.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        result.push(fullPath);
      }
    }
  }

  return result;
};

const readJsonLines = async (
  filePath: string,
  onEvent: (event: HunchEvent) => boolean | void,
): Promise<void> => {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as HunchEvent;
      const shouldContinue = onEvent(parsed);
      if (shouldContinue === false) {
        rl.close();
        break;
      }
    } catch {
      // ignore malformed line
    }
  }
};

export const appendEvent = async (
  storeDir: string,
  event: HunchEvent,
): Promise<string> => {
  const dateSegment = formatDateSegment(new Date(event.ts));
  const fileDir = path.join(storeDir, event.service, dateSegment);
  await ensureDir(fileDir);
  const filePath = path.join(fileDir, `${event.run_id}.jsonl`);
  await fs.promises.appendFile(filePath, `${JSON.stringify(event)}\n`, "utf8");
  return filePath;
};

export const searchEvents = async (
  storeDir: string,
  config: HunchConfig,
  params: HunchSearchParams,
): Promise<{ events: HunchEvent[]; truncated: boolean }> => {
  const limit = params.limit ?? config.mcp.max_results;
  const sinceMs = params.since ? parseTimeInput(params.since) : undefined;
  const untilMs = params.until ? parseTimeInput(params.until) : undefined;
  const events: HunchEvent[] = [];
  let truncated = false;

  const files = await collectFiles(storeDir, params.service);
  for (const filePath of files) {
    await readJsonLines(filePath, (event) => {
      if (!eventMatches(event, params, sinceMs, untilMs)) {
        return true;
      }
      events.push(event);
      if (events.length >= limit) {
        truncated = true;
        return false;
      }
      return true;
    });
    if (truncated) {
      break;
    }
  }

  return { events, truncated };
};

export const statsEvents = async (
  storeDir: string,
  config: HunchConfig,
  params: HunchStatsParams,
): Promise<{ buckets: Array<{ key: string; count: number }> }> => {
  const limit = params.limit ?? config.mcp.max_results;
  const sinceMs = params.since ? parseTimeInput(params.since) : undefined;
  const untilMs = params.until ? parseTimeInput(params.until) : undefined;
  const buckets = new Map<string, number>();

  const files = await collectFiles(storeDir, params.service);
  for (const filePath of files) {
    await readJsonLines(filePath, (event) => {
      const match = eventMatches(
        event,
        {
          service: params.service,
          session_id: params.session_id,
          types: undefined,
          levels: undefined,
        },
        sinceMs,
        untilMs,
      );
      if (!match) {
        return true;
      }
      let key = "unknown";
      if (params.group_by === "type") {
        key = event.type;
      } else if (params.group_by === "level") {
        key = event.level;
      } else if (params.group_by === "stage") {
        const stage = (event.data as Record<string, unknown> | undefined)?.stage;
        key = typeof stage === "string" ? stage : "unknown";
      }
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
      return true;
    });
  }

  const sorted = [...buckets.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));

  return { buckets: sorted };
};

export const listSessions = async (
  storeDir: string,
  config: HunchConfig,
  params: HunchSessionsParams,
): Promise<{
  sessions: Array<{ session_id: string; last_ts: string; event_count: number; error_count: number }>;
}> => {
  const limit = params.limit ?? config.mcp.max_results;
  const sinceMs = params.since ? parseTimeInput(params.since) : undefined;
  const sessions = new Map<
    string,
    { session_id: string; last_ts: string; event_count: number; error_count: number }
  >();

  const files = await collectFiles(storeDir, params.service);
  for (const filePath of files) {
    await readJsonLines(filePath, (event) => {
      if (params.service && event.service !== params.service) {
        return true;
      }
      if (!event.session_id) {
        return true;
      }
      const ts = getEventTimestamp(event);
      if (sinceMs !== undefined && ts !== undefined && ts < sinceMs) {
        return true;
      }
      const existing = sessions.get(event.session_id) ?? {
        session_id: event.session_id,
        last_ts: event.ts,
        event_count: 0,
        error_count: 0,
      };
      existing.event_count += 1;
      if (event.level === "error" || event.level === "fatal") {
        existing.error_count += 1;
      }
      const existingTs = normalizeTimestamp(existing.last_ts) ?? 0;
      if (ts !== undefined && ts > existingTs) {
        existing.last_ts = event.ts;
      }
      sessions.set(event.session_id, existing);
      return true;
    });
  }

  const sorted = [...sessions.values()]
    .sort((a, b) => (normalizeTimestamp(b.last_ts) ?? 0) - (normalizeTimestamp(a.last_ts) ?? 0))
    .slice(0, limit);

  return { sessions: sorted };
};

export const normalizeLevel = (level?: string): HunchLevel | undefined => {
  if (!level) {
    return undefined;
  }
  const value = level.toLowerCase();
  if (
    value === "trace" ||
    value === "debug" ||
    value === "info" ||
    value === "warn" ||
    value === "error" ||
    value === "fatal"
  ) {
    return value;
  }
  return undefined;
};
