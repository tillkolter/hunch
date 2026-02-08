import { GrprEvent, GrprLevel, GrprSearchParams } from "../schema.js";
import { normalizeTimestamp } from "./time.js";

const matchesContains = (event: GrprEvent, needle: string): boolean => {
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

const getEventTimestamp = (event: GrprEvent): number | undefined => {
  return normalizeTimestamp(event.ts);
};

export const eventMatches = (
  event: GrprEvent,
  params: GrprSearchParams,
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

export const normalizeLevel = (level?: string): GrprLevel | undefined => {
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
