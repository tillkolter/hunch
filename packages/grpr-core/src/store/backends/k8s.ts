import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  GrprEvent,
  GrprSearchParams,
  GrprSessionsParams,
  GrprStatsParams,
  GrprK8sReadBackendConfig,
} from "../../schema.js";
import { eventMatches, normalizeLevel } from "../filters.js";
import { normalizeTimestamp, parseTimeInput } from "../time.js";
import { ReadBackend, SearchResult, SessionsResult, StatsResult } from "./types.js";

type K8sClient = {
  listNamespacedPod: (
    namespace: string,
    pretty?: string,
    allowWatchBookmarks?: boolean,
    _continue?: string,
    fieldSelector?: string,
    labelSelector?: string,
  ) => Promise<{ body: { items: Array<{ metadata?: { name?: string } }> } }>;
  readNamespacedPodLog: (
    name: string,
    namespace: string,
    container?: string,
    follow?: boolean,
    pretty?: string,
    previous?: boolean,
    sinceSeconds?: number,
    sinceTime?: string,
    timestamps?: boolean,
    tailLines?: number,
    limitBytes?: number,
  ) => Promise<{ body: string }>;
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

const deriveService = (selector: string): string | undefined => {
  const first = selector.split(",")[0]?.trim();
  if (!first) {
    return undefined;
  }
  const parts = first.split("=");
  if (parts.length === 2 && parts[1]) {
    return parts[1].trim();
  }
  return undefined;
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
  fallback: Record<string, unknown>,
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
    return fallback;
  }
  return extra;
};

const normalizeSource = (
  source: unknown,
  backendId?: string,
): { kind: "mcp"; backend: "k8s"; backend_id?: string } & Record<string, unknown> => {
  const base =
    source && typeof source === "object" ? (source as Record<string, unknown>) : {};
  return {
    ...base,
    kind: "mcp",
    backend: "k8s",
    backend_id: backendId ?? (base.backend_id as string | undefined),
  };
};

const toEvent = (
  config: GrprK8sReadBackendConfig,
  message: string,
  ts: string,
  pod: string,
  container?: string,
): GrprEvent => {
  const trimmed = message.trim();
  const service = config.service ?? deriveService(config.selector) ?? "k8s";
  const runId = pod;
  const fallbackData: Record<string, unknown> = { pod, container, raw_message: message };
  const fallback: GrprEvent = {
    id: randomUUID(),
    ts,
    level: inferLevel(message),
    type: "log",
    service,
    run_id: runId,
    message,
    data: fallbackData,
    source: normalizeSource(undefined, config.id),
  };

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

    const level = normalizeLevel(record.level as string | undefined) ?? inferLevel(message);
    const eventMessage = typeof record.message === "string" ? record.message : message;
    const source = normalizeSource(record.source, config.id);
    return {
      id: typeof record.id === "string" ? record.id : fallback.id,
      ts: typeof record.ts === "string" ? record.ts : ts,
      level,
      type: typeof record.type === "string" ? record.type : "log",
      service: typeof record.service === "string" ? record.service : service,
      run_id: typeof record.run_id === "string" ? record.run_id : runId,
      session_id: typeof record.session_id === "string" ? record.session_id : undefined,
      message: eventMessage,
      data: extractData(record, fallbackData),
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

const loadClient = (context?: string): K8sClient => {
  let module: {
    KubeConfig: new () => {
      loadFromDefault: () => void;
      setCurrentContext: (ctx: string) => void;
      makeApiClient: (api: unknown) => unknown;
    };
    CoreV1Api: new () => unknown;
  };
  try {
    module = requireModule("@kubernetes/client-node");
  } catch {
    throw new Error(
      "Kubernetes backend requires @kubernetes/client-node. Install it to enable this backend.",
    );
  }

  const { KubeConfig, CoreV1Api } = module;
  const kc = new KubeConfig();
  kc.loadFromDefault();
  if (context) {
    kc.setCurrentContext(context);
  }
  const client = kc.makeApiClient(CoreV1Api) as unknown as K8sClient;
  return client;
};

const parseLogLine = (line: string): { ts: string; message: string } => {
  const trimmed = line.trim();
  if (!trimmed) {
    return { ts: new Date().toISOString(), message: "" };
  }
  const space = trimmed.indexOf(" ");
  if (space > 0) {
    const possibleTs = trimmed.slice(0, space);
    const parsed = Date.parse(possibleTs);
    if (!Number.isNaN(parsed)) {
      return { ts: new Date(parsed).toISOString(), message: trimmed.slice(space + 1) };
    }
  }
  return { ts: new Date().toISOString(), message: trimmed };
};

export const createK8sBackend = (config: GrprK8sReadBackendConfig): ReadBackend => {
  let client: K8sClient | null = null;
  const getClient = (): K8sClient => {
    if (!client) {
      client = loadClient(config.context);
    }
    return client;
  };

  const fetchEvents = async (params: GrprSearchParams): Promise<SearchResult> => {
    const client = getClient();
    const sinceMs = params.since ? parseTimeInput(params.since) : undefined;
    const untilMs = params.until ? parseTimeInput(params.until) : undefined;
    const sinceSeconds =
      sinceMs && sinceMs < Date.now()
        ? Math.max(1, Math.floor((Date.now() - sinceMs) / 1000))
        : undefined;
    const limit = params.limit ?? 200;
    const events: GrprEvent[] = [];
    let truncated = false;

    const pods = await client.listNamespacedPod(
      config.namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      config.selector,
    );

    for (const pod of pods.body.items) {
      const podName = pod.metadata?.name;
      if (!podName) {
        continue;
      }
      const response = await client.readNamespacedPodLog(
        podName,
        config.namespace,
        config.container,
        false,
        undefined,
        undefined,
        sinceSeconds,
        undefined,
        true,
      );
      const lines = response.body.split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        const { ts, message } = parseLogLine(line);
        const event = toEvent(config, message, ts, podName, config.container);
        if (!eventMatches(event, params, sinceMs, untilMs)) {
          continue;
        }
        events.push(event);
        if (events.length >= limit) {
          truncated = true;
          break;
        }
      }
      if (truncated) {
        break;
      }
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
