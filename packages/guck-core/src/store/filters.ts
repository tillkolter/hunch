import { GuckEvent, GuckLevel, GuckSearchParams } from "../schema.js";
import { normalizeTimestamp } from "./time.js";

const matchesContains = (event: GuckEvent, needle: string): boolean => {
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

const getEventTimestamp = (event: GuckEvent): number | undefined => {
  return normalizeTimestamp(event.ts);
};

export const eventMatches = (
  event: GuckEvent,
  params: GuckSearchParams,
  sinceMs?: number,
  untilMs?: number,
): boolean => {
  const ts = getEventTimestamp(event);
  return !(
    (params.service && event.service !== params.service) ||
    (params.session_id && event.session_id !== params.session_id) ||
    (params.run_id && event.run_id !== params.run_id) ||
    (params.types && params.types.length > 0 && !params.types.includes(event.type)) ||
    (params.levels && params.levels.length > 0 && !params.levels.includes(event.level)) ||
    (params.contains && !matchesContains(event, params.contains)) ||
    (sinceMs !== undefined && ts !== undefined && ts < sinceMs) ||
    (untilMs !== undefined && ts !== undefined && ts > untilMs)
  );
};

export const normalizeLevel = (level?: string): GuckLevel | undefined => {
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
