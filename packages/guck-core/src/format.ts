import { GuckEvent } from "./schema.js";

const ALLOWED_FIELDS = new Set([
  "id",
  "ts",
  "level",
  "type",
  "service",
  "run_id",
  "session_id",
  "message",
  "data",
  "tags",
  "trace_id",
  "span_id",
  "source",
]);

type ProjectionOptions = {
  flatten?: boolean;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const splitPath = (path: string): string[] | null => {
  if (!path) {
    return null;
  }
  const parts = path.split(".");
  if (parts.some((part) => part.length === 0)) {
    return null;
  }
  return parts;
};

const getValueAtPath = (value: unknown, path: string[]): unknown => {
  let current: unknown = value;
  for (const segment of path) {
    if (!isPlainObject(current)) {
      return undefined;
    }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
};

const setValueAtPath = (
  target: Record<string, unknown>,
  path: string[],
  value: unknown,
): void => {
  let current: Record<string, unknown> = target;
  for (let index = 0; index < path.length; index += 1) {
    const segment = path[index];
    if (!segment) {
      return;
    }
    const isLast = index === path.length - 1;
    if (isLast) {
      current[segment] = value;
      return;
    }
    const next = current[segment];
    if (!isPlainObject(next)) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
};

const stringifyValue = (value: unknown): string => {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    const serialized = JSON.stringify(value);
    return serialized ?? "";
  } catch {
    return "";
  }
};

const truncateString = (value: string, maxChars: number): string => {
  if (maxChars <= 0 || value.length <= maxChars) {
    return value;
  }
  const suffix = "...";
  if (maxChars <= suffix.length) {
    return value.slice(0, maxChars);
  }
  return value.slice(0, maxChars - suffix.length) + suffix;
};

export const truncateEventMessage = (
  event: GuckEvent,
  maxChars?: number,
): GuckEvent => {
  if (!maxChars || maxChars <= 0) {
    return event;
  }
  const message = event.message;
  if (!message || message.length <= maxChars) {
    return event;
  }
  return { ...event, message: truncateString(message, maxChars) };
};

export const projectEventFields = (
  event: GuckEvent,
  fields: string[],
  options: ProjectionOptions = {},
): Record<string, unknown> => {
  const projected: Record<string, unknown> = {};
  for (const field of fields) {
    const path = splitPath(field);
    if (!path || path.length === 0) {
      continue;
    }
    const [topLevel] = path;
    if (!topLevel || !ALLOWED_FIELDS.has(topLevel)) {
      continue;
    }
    const value = getValueAtPath(event as Record<string, unknown>, path);
    if (value === undefined) {
      continue;
    }
    if (options.flatten) {
      projected[field] = value;
      continue;
    }
    setValueAtPath(projected, path, value);
  }
  return projected;
};

const applyTemplate = (event: GuckEvent, template: string): string => {
  return template.replace(/\{([a-zA-Z0-9_.]+)\}/g, (_match, token) => {
    const path = splitPath(token);
    if (!path || path.length === 0) {
      return "";
    }
    const [topLevel] = path;
    if (!topLevel || !ALLOWED_FIELDS.has(topLevel)) {
      return "";
    }
    const value = getValueAtPath(event as Record<string, unknown>, path);
    return stringifyValue(value);
  });
};

export const formatEventText = (event: GuckEvent, template?: string): string => {
  if (template) {
    return applyTemplate(event, template).trimEnd();
  }
  const ts = event.ts ?? "";
  const level = event.level ?? "";
  const service = event.service ?? "";
  const type = event.type ?? "";
  const message = event.message ?? "";
  const sessionSuffix = event.session_id ? ` session=${event.session_id}` : "";
  return `${ts} ${level} ${service} ${type}${sessionSuffix} ${message}`.trimEnd();
};
