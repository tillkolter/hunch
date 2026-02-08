import { HunchConfig, HunchEvent } from "./schema.js";

const REDACTED_VALUE = "[REDACTED]";

const normalizeKeySet = (keys: string[]): Set<string> => {
  return new Set(keys.map((key) => key.trim().toLowerCase()).filter(Boolean));
};

const compilePatterns = (patterns: string[]): RegExp[] => {
  return patterns
    .map((pattern) => {
      try {
        return new RegExp(pattern, "gi");
      } catch {
        return null;
      }
    })
    .filter((pattern): pattern is RegExp => Boolean(pattern));
};

const redactString = (value: string, patterns: RegExp[]): string => {
  let next = value;
  for (const pattern of patterns) {
    next = next.replace(pattern, REDACTED_VALUE);
  }
  return next;
};

const redactValue = (
  value: unknown,
  keySet: Set<string>,
  patterns: RegExp[],
): unknown => {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return redactString(value, patterns);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, keySet, patterns));
  }

  if (typeof value === "object") {
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (keySet.has(key.toLowerCase())) {
        next[key] = REDACTED_VALUE;
      } else {
        next[key] = redactValue(entry, keySet, patterns);
      }
    }
    return next;
  }

  return value;
};

export const redactEvent = (config: HunchConfig, event: HunchEvent): HunchEvent => {
  if (!config.redaction.enabled) {
    return event;
  }

  const keySet = normalizeKeySet(config.redaction.keys);
  const patterns = compilePatterns(config.redaction.patterns);

  return {
    ...event,
    message: event.message ? redactString(event.message, patterns) : event.message,
    data: event.data
      ? (redactValue(event.data, keySet, patterns) as Record<string, unknown>)
      : event.data,
    tags: event.tags
      ? (redactValue(event.tags, keySet, patterns) as Record<string, string>)
      : event.tags,
  };
};
