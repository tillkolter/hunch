import { randomUUID } from "node:crypto";
import type { GuckEvent, GuckSource } from "./schema.js";
import { normalizeLevel } from "./store/filters.js";

type BuildEventDefaults = {
  service: string;
  source?: GuckSource;
};

const defaultRunId = process.env.GUCK_RUN_ID ?? randomUUID();
const defaultSessionId = process.env.GUCK_SESSION_ID;

export const buildEvent = (
  input: Partial<GuckEvent>,
  defaults: BuildEventDefaults,
): GuckEvent => {
  const normalized = normalizeLevel(input.level);
  const fallbackSource = defaults.source ?? { kind: "sdk" };
  const source = input.source
    ? { ...input.source, kind: input.source.kind ?? fallbackSource.kind ?? "sdk" }
    : { ...fallbackSource, kind: fallbackSource.kind ?? "sdk" };
  return {
    id: input.id ?? randomUUID(),
    ts: input.ts ?? new Date().toISOString(),
    level: normalized ?? "info",
    type: input.type ?? "log",
    service: input.service ?? defaults.service,
    run_id: input.run_id ?? defaultRunId,
    session_id: input.session_id ?? defaultSessionId,
    message: input.message,
    data: input.data,
    tags: input.tags,
    trace_id: input.trace_id,
    span_id: input.span_id,
    source,
  };
};

export type { BuildEventDefaults };
