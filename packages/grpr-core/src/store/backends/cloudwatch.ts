import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  GrprCloudWatchReadBackendConfig,
  GrprEvent,
  GrprSearchParams,
  GrprSessionsParams,
  GrprStatsParams,
} from "../../schema.js";
import { eventMatches, normalizeLevel } from "../filters.js";
import { normalizeTimestamp, parseTimeInput } from "../time.js";
import { ReadBackend, SearchResult, SessionsResult, StatsResult } from "./types.js";

type AwsClient = {
  send: (command: unknown) => Promise<{
    events?: Array<{
      eventId?: string;
      timestamp?: number;
      message?: string;
      logStreamName?: string;
    }>;
    nextToken?: string;
  }>;
};

const inferLevel = (message?: string): "fatal" | "error" | "warn" | "info" | "debug" | "trace" => {
  const text = message?.toLowerCase() ?? "";
  if (text.includes("fatal")) {
    return "fatal";
  }
  if (text.includes("error")) {
    return "error";
  }
  if (text.includes("warn")) {
    return "warn";
  }
  if (text.includes("debug")) {
    return "debug";
  }
  if (text.includes("trace")) {
    return "trace";
  }
  return "info";
};

const deriveService = (logGroup: string): string => {
  const trimmed = logGroup.trim();
  const parts = trimmed.split("/");
  const last = parts[parts.length - 1];
  return last && last.length > 0 ? last : trimmed;
};

const isGrprLikeObject = (value: Record<string, unknown>): boolean => {
  const keys = [
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
  ];
  return keys.some((key) => key in value);
};

const extractTags = (value: unknown): Record<string, string> | undefined => {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") {
      record[key] = entry;
    }
  }
  return Object.keys(record).length > 0 ? record : undefined;
};

const extractData = (
  value: Record<string, unknown>,
  fallbackMessage: string | undefined,
): Record<string, unknown> | undefined => {
  if (value.data && typeof value.data === "object" && value.data !== null) {
    return value.data as Record<string, unknown>;
  }
  const knownKeys = new Set([
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
  const extra: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!knownKeys.has(key)) {
      extra[key] = entry;
    }
  }
  if (Object.keys(extra).length === 0) {
    return fallbackMessage ? { raw_message: fallbackMessage } : undefined;
  }
  return extra;
};

const normalizeSource = (
  source: unknown,
  backendId?: string,
): { kind: "mcp"; backend: "cloudwatch"; backend_id?: string } & Record<string, unknown> => {
  const base =
    source && typeof source === "object" ? (source as Record<string, unknown>) : {};
  return {
    ...base,
    kind: "mcp",
    backend: "cloudwatch",
    backend_id: backendId ?? (base.backend_id as string | undefined),
  };
};

const toEvent = (
  config: GrprCloudWatchReadBackendConfig,
  logEvent: { eventId?: string; timestamp?: number; message?: string; logStreamName?: string },
): GrprEvent => {
  const rawMessage = logEvent.message ?? "";
  const trimmed = rawMessage.trim();
  const parsedTs = logEvent.timestamp ? new Date(logEvent.timestamp).toISOString() : new Date().toISOString();
  const id = logEvent.eventId ?? randomUUID();
  const service = config.service ?? deriveService(config.logGroup);
  const runId = logEvent.logStreamName ?? logEvent.eventId ?? id;
  const fallback = {
    id,
    ts: parsedTs,
    level: inferLevel(rawMessage),
    type: "log",
    service,
    run_id: runId,
    message: rawMessage,
    data: { logStreamName: logEvent.logStreamName, raw_message: rawMessage },
    source: normalizeSource(undefined, config.id),
  } satisfies GrprEvent;

  if (!trimmed.startsWith("{")) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object") {
      return fallback;
    }
    const record = parsed as Record<string, unknown>;
    if (!isGrprLikeObject(record)) {
      return fallback;
    }

    const level = normalizeLevel(record.level as string | undefined) ?? inferLevel(rawMessage);
    const message =
      typeof record.message === "string" ? record.message : rawMessage || undefined;
    const source = normalizeSource(record.source, config.id);

    return {
      id: typeof record.id === "string" ? record.id : id,
      ts: typeof record.ts === "string" ? record.ts : parsedTs,
      level,
      type: typeof record.type === "string" ? record.type : "log",
      service: typeof record.service === "string" ? record.service : service,
      run_id: typeof record.run_id === "string" ? record.run_id : runId,
      session_id: typeof record.session_id === "string" ? record.session_id : undefined,
      message,
      data: extractData(record, rawMessage),
      tags: extractTags(record.tags),
      trace_id: typeof record.trace_id === "string" ? record.trace_id : undefined,
      span_id: typeof record.span_id === "string" ? record.span_id : undefined,
      source,
    };
  } catch {
    return fallback;
  }
};

const requireModule = createRequire(import.meta.url);

const loadSdk = (): {
  CloudWatchLogsClient: new (config: { region: string; credentials?: unknown }) => AwsClient;
  FilterLogEventsCommand: new (input: {
    logGroupName: string;
    startTime?: number;
    endTime?: number;
    nextToken?: string;
    limit?: number;
  }) => unknown;
} => {
  try {
    return requireModule("@aws-sdk/client-cloudwatch-logs");
  } catch {
    throw new Error(
      "CloudWatch backend requires @aws-sdk/client-cloudwatch-logs. Install it to enable this backend.",
    );
  }
};

const loadCredentialProviders = (): { fromIni: (input: { profile: string }) => unknown } => {
  try {
    return requireModule("@aws-sdk/credential-providers");
  } catch {
    throw new Error(
      "CloudWatch backend requires @aws-sdk/credential-providers when using profile override.",
    );
  }
};

export const createCloudWatchBackend = (
  config: GrprCloudWatchReadBackendConfig,
): ReadBackend => {
  let client: AwsClient | null = null;
  let FilterLogEventsCommand: ReturnType<typeof loadSdk>["FilterLogEventsCommand"] | null = null;
  const getClient = (): { client: AwsClient; FilterLogEventsCommand: ReturnType<typeof loadSdk>["FilterLogEventsCommand"] } => {
    if (client && FilterLogEventsCommand) {
      return { client, FilterLogEventsCommand };
    }
    const sdk = loadSdk();
    FilterLogEventsCommand = sdk.FilterLogEventsCommand;
    const credentials = config.profile
      ? loadCredentialProviders().fromIni({ profile: config.profile })
      : undefined;
    const sdkClient = new sdk.CloudWatchLogsClient({
      region: config.region,
      credentials,
    });
    client = {
      send: (command) => sdkClient.send(command as unknown),
    };
    return { client, FilterLogEventsCommand };
  };

  const fetchEvents = async (
    params: GrprSearchParams,
  ): Promise<SearchResult> => {
    const { client, FilterLogEventsCommand } = getClient();
    const limit = params.limit ?? 200;
    const sinceMs = params.since ? parseTimeInput(params.since) : undefined;
    const untilMs = params.until ? parseTimeInput(params.until) : undefined;
    const events: GrprEvent[] = [];
    let truncated = false;
    let nextToken: string | undefined = undefined;

    do {
      const remaining = Math.max(limit - events.length, 1);
      const response = await client.send(
        new FilterLogEventsCommand({
          logGroupName: config.logGroup,
          startTime: sinceMs,
          endTime: untilMs,
          nextToken,
          limit: Math.min(remaining, 10000),
        }),
      );
      const batch = response.events ?? [];
      for (const logEvent of batch) {
        const event = toEvent(config, logEvent);
        if (!eventMatches(event, params, sinceMs, untilMs)) {
          continue;
        }
        events.push(event);
        if (events.length >= limit) {
          truncated = true;
          break;
        }
      }
      const receivedToken = response.nextToken;
      if (receivedToken && receivedToken === nextToken) {
        break;
      }
      nextToken = receivedToken;
    } while (nextToken && !truncated);

    if (nextToken) {
      truncated = true;
    }

    return { events, truncated };
  };

  const stats = async (params: GrprStatsParams): Promise<StatsResult> => {
    const searchParams: GrprSearchParams = {
      service: params.service,
      session_id: params.session_id,
      since: params.since,
      until: params.until,
      limit: params.limit ?? 1000,
    };
    const result = await fetchEvents(searchParams);
    const buckets = new Map<string, number>();
    for (const event of result.events) {
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
    }
    const limit = params.limit ?? 200;
    const sorted = [...buckets.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([key, count]) => ({ key, count }));
    return { buckets: sorted };
  };

  const sessions = async (params: GrprSessionsParams): Promise<SessionsResult> => {
    const searchParams: GrprSearchParams = {
      service: params.service,
      since: params.since,
      limit: params.limit ?? 1000,
    };
    const result = await fetchEvents(searchParams);
    const sessions = new Map<
      string,
      { session_id: string; last_ts: string; event_count: number; error_count: number }
    >();
    for (const event of result.events) {
      if (!event.session_id) {
        continue;
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
      const eventTs = normalizeTimestamp(event.ts) ?? 0;
      if (eventTs > existingTs) {
        existing.last_ts = event.ts;
      }
      sessions.set(event.session_id, existing);
    }

    const limit = params.limit ?? 200;
    const sorted = [...sessions.values()]
      .sort((a, b) => (normalizeTimestamp(b.last_ts) ?? 0) - (normalizeTimestamp(a.last_ts) ?? 0))
      .slice(0, limit);

    return { sessions: sorted };
  };

  return {
    search: fetchEvents,
    stats,
    sessions,
  };
};
