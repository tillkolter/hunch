export type GuardPayloadOptions = {
  payload: unknown;
  maxChars: number;
  force?: boolean;
  format?: string;
  itemCount?: number;
  truncated?: boolean;
  avgMessageChars?: number;
  maxMessageChars?: number;
  errors?: Array<{ backend: string; backend_id?: string; message: string }>;
};

type GuardOk = { kind: "ok"; serialized: string };
type GuardBlocked = { kind: "blocked"; warningPayload: unknown };

type MessageStats = {
  avgMessageChars: number;
  maxMessageChars: number;
};

type TrimMessageOptions = {
  maxChars?: number;
  match?: string;
};

const ELLIPSIS = "...";

export const serializePayload = (payload: unknown): string => {
  return JSON.stringify(payload, null, 2);
};

export const computeMessageStats = (events: Array<{ message?: unknown }>): MessageStats => {
  let total = 0;
  let count = 0;
  let max = 0;

  for (const event of events) {
    if (typeof event.message !== "string") {
      continue;
    }
    const len = event.message.length;
    total += len;
    count += 1;
    if (len > max) {
      max = len;
    }
  }

  return {
    avgMessageChars: count === 0 ? 0 : Math.round(total / count),
    maxMessageChars: max,
  };
};

const buildWarningPayload = ({
  maxChars,
  estimatedChars,
  format,
  itemCount,
  truncated,
  avgMessageChars,
  maxMessageChars,
  errors,
}: {
  maxChars: number;
  estimatedChars: number;
  format?: string;
  itemCount?: number;
  truncated?: boolean;
  avgMessageChars?: number;
  maxMessageChars?: number;
  errors?: Array<{ backend: string; backend_id?: string; message: string }>;
}): unknown => {
  const warning: Record<string, unknown> = {
    code: "guck.output_too_large",
    blocked: true,
    message: `Output exceeds mcp.max_output_chars (${maxChars}). Refine your query or pass force=true to bypass the guard.`,
    max_output_chars: maxChars,
    estimated_output_chars: estimatedChars,
    format: format ?? "json",
    item_count: itemCount ?? 0,
    truncated: truncated ?? false,
  };

  if (avgMessageChars !== undefined) {
    warning.avg_message_chars = avgMessageChars;
  }
  if (maxMessageChars !== undefined) {
    warning.max_message_chars = maxMessageChars;
  }

  const suggestions = [
    { action: "limit", example: { limit: 50 } },
    { action: "fields", example: { fields: ["ts", "level", "message"] } },
    {
      action: "text",
      example: { format: "text", template: "{ts}|{service}|{message}" },
    },
    { action: "max_message_chars", example: { max_message_chars: 200 } },
    { action: "force", example: { force: true } },
  ];

  return {
    warning: {
      ...warning,
      suggestions,
    },
    ...(errors && errors.length > 0 ? { errors } : {}),
  };
};

export const guardPayload = ({
  payload,
  maxChars,
  force,
  format,
  itemCount,
  truncated,
  avgMessageChars,
  maxMessageChars,
  errors,
}: GuardPayloadOptions): GuardOk | GuardBlocked => {
  const serialized = serializePayload(payload);
  if (force || serialized.length <= maxChars) {
    return { kind: "ok", serialized };
  }
  return {
    kind: "blocked",
    warningPayload: buildWarningPayload({
      maxChars,
      estimatedChars: serialized.length,
      format,
      itemCount,
      truncated,
      avgMessageChars,
      maxMessageChars,
      errors,
    }),
  };
};

export const trimMessage = (message: string, options: TrimMessageOptions): string => {
  const { maxChars, match } = options;
  if (!maxChars || maxChars <= 0) {
    return message;
  }
  if (message.length <= maxChars) {
    return message;
  }
  if (maxChars <= ELLIPSIS.length) {
    return message.slice(0, maxChars);
  }

  const normalizedMatch = match?.toLowerCase();
  const matchIndex = normalizedMatch
    ? message.toLowerCase().indexOf(normalizedMatch)
    : -1;

  if (matchIndex < 0) {
    const available = maxChars - ELLIPSIS.length;
    const headLen = Math.ceil(available / 2);
    const tailLen = Math.floor(available / 2);
    const head = message.slice(0, headLen);
    const tail = tailLen > 0 ? message.slice(message.length - tailLen) : "";
    return `${head}${ELLIPSIS}${tail}`;
  }

  const matchLen = normalizedMatch ? normalizedMatch.length : 0;
  const matchCenter = matchIndex + Math.floor(matchLen / 2);

  const baseContentLen = Math.max(1, maxChars - 2 * ELLIPSIS.length);

  const buildWindow = (contentLen: number) => {
    const maxStart = Math.max(0, message.length - contentLen);
    let start = matchCenter - Math.floor(contentLen / 2);
    if (start < 0) {
      start = 0;
    }
    if (start > maxStart) {
      start = maxStart;
    }
    const end = Math.min(message.length, start + contentLen);
    const trimLeft = start > 0;
    const trimRight = end < message.length;
    return { start, end, trimLeft, trimRight };
  };

  let { start, end, trimLeft, trimRight } = buildWindow(baseContentLen);
  let extra = 0;
  if (!trimLeft) {
    extra += ELLIPSIS.length;
  }
  if (!trimRight) {
    extra += ELLIPSIS.length;
  }
  if (extra > 0) {
    const expandedContentLen = Math.min(message.length, baseContentLen + extra);
    ({ start, end, trimLeft, trimRight } = buildWindow(expandedContentLen));
  }

  const prefix = trimLeft ? ELLIPSIS : "";
  const suffix = trimRight ? ELLIPSIS : "";
  const slice = message.slice(start, end);
  const trimmed = `${prefix}${slice}${suffix}`;

  if (trimmed.length <= maxChars) {
    return trimmed;
  }

  return trimmed.slice(0, maxChars);
};

export const trimEventsMessages = <T extends { message?: unknown }>(
  events: T[],
  options: TrimMessageOptions,
): T[] => {
  const { maxChars } = options;
  if (!maxChars || maxChars <= 0) {
    return events;
  }
  return events.map((event) => {
    if (typeof event.message !== "string") {
      return event;
    }
    const trimmed = trimMessage(event.message, options);
    if (trimmed === event.message) {
      return event;
    }
    return { ...event, message: trimmed };
  });
};
