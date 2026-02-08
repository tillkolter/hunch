const DURATION_RE = /^(\d+)(ms|s|m|h|d)$/i;

export const parseTimeInput = (value?: string): number | undefined => {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const durationMatch = trimmed.match(DURATION_RE);
  if (durationMatch) {
    const amount = Number(durationMatch[1]);
    const unit = durationMatch[2]?.toLowerCase() ?? "";
    const unitMs =
      unit === "ms"
        ? 1
        : unit === "s"
          ? 1000
          : unit === "m"
            ? 60_000
            : unit === "h"
              ? 3_600_000
              : 86_400_000;
    return Date.now() - amount * unitMs;
  }

  const parsed = Date.parse(trimmed);
  if (!Number.isNaN(parsed)) {
    return parsed;
  }

  return undefined;
};

export const normalizeTimestamp = (value: unknown): number | undefined => {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
};

export const formatDateSegment = (date: Date): string => {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};
