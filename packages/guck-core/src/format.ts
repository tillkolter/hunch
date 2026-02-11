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
): Record<string, unknown> => {
  const projected: Record<string, unknown> = {};
  for (const field of fields) {
    if (!ALLOWED_FIELDS.has(field)) {
      continue;
    }
    projected[field] = (event as Record<string, unknown>)[field];
  }
  return projected;
};

const applyTemplate = (event: GuckEvent, template: string): string => {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, token) => {
    if (!ALLOWED_FIELDS.has(token)) {
      return "";
    }
    const value = (event as Record<string, unknown>)[token];
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
