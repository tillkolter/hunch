import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  GuckEvent,
  GuckSearchParams,
  GuckSessionsParams,
  GuckStatsParams,
  GuckK8sReadBackendConfig,
} from "../../schema.js";
import { eventMatches, normalizeLevel } from "../filters.js";
import { normalizeTimestamp, parseTimeInput } from "../time.js";
import { buildEksToken, fetchEksClusterInfo } from "./eks-auth.js";
import { ReadBackend, SearchResult, SessionsResult, StatsResult } from "./types.js";

type K8sClient = {
  api?: unknown;
  listNamespacedPod: (...args: unknown[]) => Promise<{
    body: { items: Array<{ metadata?: { name?: string } }> };
  }>;
  readNamespacedPodLog: (...args: unknown[]) => Promise<{ body: string }>;
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

const isGuckLikeObject = (value: Record<string, unknown>): boolean => {
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

const hasStructuredKeys = (value: Record<string, unknown>): boolean => {
  const keys = [
    "ts",
    "timestamp",
    "time",
    "@timestamp",
    "level",
    "severity",
    "message",
    "msg",
    "log",
  ];
  return keys.some((key) => key in value);
};

const coerceTimestamp = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString();
    }
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      return new Date(numeric).toISOString();
    }
    return undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return undefined;
};

const coerceMessage = (value: Record<string, unknown>): string | undefined => {
  if (typeof value.message === "string") {
    return value.message;
  }
  if (typeof value.msg === "string") {
    return value.msg;
  }
  if (typeof value.log === "string") {
    return value.log;
  }
  return undefined;
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
  config: GuckK8sReadBackendConfig,
  message: string,
  ts: string,
  pod: string,
  container?: string,
): GuckEvent => {
  const trimmed = message.trim();
  const service = config.service ?? deriveService(config.selector) ?? "k8s";
  const runId = pod;
  const fallbackData: Record<string, unknown> = { pod, container, raw_message: message };
  const fallback: GuckEvent = {
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
    if (!isGuckLikeObject(record) && !hasStructuredKeys(record)) {
      return fallback;
    }

    const level =
      normalizeLevel(record.level as string | undefined) ??
      normalizeLevel(record.severity as string | undefined) ??
      inferLevel(message);
    const eventMessage = coerceMessage(record) ?? message;
    const recordTs =
      (typeof record.ts === "string" && record.ts.trim() ? record.ts : undefined) ??
      coerceTimestamp(record.ts) ??
      coerceTimestamp(record.timestamp) ??
      coerceTimestamp(record.time) ??
      coerceTimestamp(record["@timestamp"]) ??
      ts;
    const source = normalizeSource(record.source, config.id);
    const baseData = extractData(record, fallbackData);
    const data = baseData ? { ...fallbackData, ...baseData } : fallbackData;
    return {
      id: typeof record.id === "string" ? record.id : fallback.id,
      ts: recordTs,
      level,
      type: typeof record.type === "string" ? record.type : "log",
      service: typeof record.service === "string" ? record.service : service,
      run_id: typeof record.run_id === "string" ? record.run_id : runId,
      session_id: typeof record.session_id === "string" ? record.session_id : undefined,
      message: eventMessage,
      data,
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

type KubeConfigUserExec = {
  command?: string;
  args?: string[];
  env?: Array<{ name?: string; value?: string }>;
};

type KubeConfigUser = {
  name?: string;
  exec?: KubeConfigUserExec;
};

type KubeConfigContext = {
  name?: string;
  cluster?: string;
  user?: string;
  namespace?: string;
};

type KubeConfigCluster = {
  name?: string;
  server?: string;
  caData?: string;
  skipTLSVerify?: boolean;
};

type KubeConfigLike = {
  loadFromDefault: () => void;
  setCurrentContext: (ctx: string) => void;
  makeApiClient: (api: unknown) => unknown;
  loadFromOptions?: (opts: {
    clusters: KubeConfigCluster[];
    users: Array<{ name: string; token: string }>;
    contexts: KubeConfigContext[];
    currentContext: string;
  }) => void;
  getCurrentContext?: () => string;
  getCurrentCluster?: () => KubeConfigCluster | undefined;
  getCurrentUser?: () => KubeConfigUser | undefined;
  getContextObject?: (name: string) => KubeConfigContext | undefined;
  clusters?: KubeConfigCluster[];
  users?: KubeConfigUser[];
  contexts?: KubeConfigContext[];
  currentContext?: string;
};

const loadKubeModule = (): {
  KubeConfig: new () => KubeConfigLike;
  CoreV1Api: new () => unknown;
} => {
  let module: { KubeConfig: new () => KubeConfigLike; CoreV1Api: new () => unknown };
  try {
    module = requireModule("@kubernetes/client-node");
  } catch {
    throw new Error(
      "Kubernetes backend requires @kubernetes/client-node. Install it to enable this backend.",
    );
  }
  return module;
};

const loadKubeConfig = (context?: string): { kc: KubeConfigLike; CoreV1Api: new () => unknown } => {
  const { KubeConfig, CoreV1Api } = loadKubeModule();
  const kc = new KubeConfig();
  kc.loadFromDefault();
  if (context) {
    kc.setCurrentContext(context);
  }
  return { kc, CoreV1Api };
};

const getCurrentContextName = (kc: KubeConfigLike): string | undefined => {
  return kc.getCurrentContext?.() ?? kc.currentContext;
};

const getContextObject = (kc: KubeConfigLike, name?: string): KubeConfigContext | undefined => {
  if (!name) {
    return undefined;
  }
  const direct = kc.getContextObject?.(name);
  if (direct) {
    return direct;
  }
  const contexts = Array.isArray(kc.contexts) ? kc.contexts : [];
  return contexts.find((context) => context.name === name);
};

const getCurrentCluster = (kc: KubeConfigLike): KubeConfigCluster | undefined => {
  const direct = kc.getCurrentCluster?.();
  if (direct) {
    return direct;
  }
  const currentContext = getContextObject(kc, getCurrentContextName(kc));
  const clusterName = currentContext?.cluster;
  if (!clusterName) {
    return undefined;
  }
  const clusters = Array.isArray(kc.clusters) ? kc.clusters : [];
  return clusters.find((cluster) => cluster.name === clusterName);
};

const getCurrentUser = (kc: KubeConfigLike): KubeConfigUser | undefined => {
  const direct = kc.getCurrentUser?.();
  if (direct) {
    return direct;
  }
  const currentContext = getContextObject(kc, getCurrentContextName(kc));
  const userName = currentContext?.user;
  if (!userName) {
    return undefined;
  }
  const users = Array.isArray(kc.users) ? kc.users : [];
  return users.find((user) => user.name === userName);
};

const getEnvValue = (env: KubeConfigUserExec["env"], key: string): string | undefined => {
  if (!env) {
    return undefined;
  }
  for (const entry of env) {
    if (entry?.name === key && entry.value) {
      return entry.value;
    }
  }
  return undefined;
};

const findArgValue = (args: string[], name: string): string | undefined => {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg) {
      continue;
    }
    if (arg === name && args[i + 1]) {
      return args[i + 1];
    }
    const prefix = `${name}=`;
    if (arg.startsWith(prefix)) {
      return arg.slice(prefix.length);
    }
  }
  return undefined;
};

const parseAwsEksExec = (
  exec?: KubeConfigUserExec,
): { clusterName: string; region: string; profile?: string; roleArn?: string } | null => {
  if (!exec) {
    return null;
  }
  const command = exec.command ?? "";
  const commandName = command.split(/[\\/]/).pop() ?? command;
  const args = exec.args ?? [];
  const isAws = commandName === "aws";
  const hasEks = args.includes("eks");
  const hasGetToken = args.includes("get-token");
  if (!isAws || !hasEks || !hasGetToken) {
    return null;
  }

  const region = findArgValue(args, "--region");
  const clusterName = findArgValue(args, "--cluster-name");
  if (!region || !clusterName) {
    throw new Error(
      "Kubernetes backend found aws eks exec config but missing --region or --cluster-name.",
    );
  }
  const profile = findArgValue(args, "--profile") ?? getEnvValue(exec.env, "AWS_PROFILE");
  const roleArn = findArgValue(args, "--role-arn") ?? getEnvValue(exec.env, "AWS_ROLE_ARN");
  return { clusterName, region, profile, roleArn };
};

const buildKubeConfigWithToken = (input: {
  clusterName: string;
  server: string;
  caData?: string;
  skipTLSVerify?: boolean;
  namespace?: string;
  token: string;
}): KubeConfigLike => {
  const { KubeConfig } = loadKubeModule();
  const kc = new KubeConfig();
  if (!kc.loadFromOptions) {
    throw new Error("Kubernetes client does not support loadFromOptions.");
  }
  const userName = `${input.clusterName}-token-user`;
  const contextName = `${input.clusterName}-token-context`;
  kc.loadFromOptions({
    clusters: [
      {
        name: input.clusterName,
        server: input.server,
        caData: input.caData,
        skipTLSVerify: input.skipTLSVerify,
      },
    ],
    users: [{ name: userName, token: input.token }],
    contexts: [
      {
        name: contextName,
        cluster: input.clusterName,
        user: userName,
        namespace: input.namespace,
      },
    ],
    currentContext: contextName,
  });
  return kc;
};

const listNamespacedPod = async (
  client: K8sClient,
  params: { namespace: string; labelSelector?: string },
): Promise<{ body: { items: Array<{ metadata?: { name?: string } }> } }> => {
  const listFn = client.listNamespacedPod.bind(client);
  const useObjectParams = Boolean(client.api) || listFn.length <= 1;
  const response = useObjectParams
    ? await listFn({
      namespace: params.namespace,
      labelSelector: params.labelSelector,
    })
    : await listFn(
        params.namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        params.labelSelector,
      );

  if (response && typeof response === "object") {
    if ("body" in response && response.body && typeof response.body === "object") {
      return response as { body: { items: Array<{ metadata?: { name?: string } }> } };
    }
    if ("items" in response && Array.isArray((response as { items?: unknown }).items)) {
      return { body: { items: (response as { items: Array<{ metadata?: { name?: string } }> }).items } };
    }
  }

  throw new Error("Unexpected response from listNamespacedPod.");
};

const readNamespacedPodLog = async (
  client: K8sClient,
  params: {
    name: string;
    namespace: string;
    container?: string;
    follow?: boolean;
    sinceSeconds?: number;
    timestamps?: boolean;
  },
): Promise<{ body: string }> => {
  const readFn = client.readNamespacedPodLog.bind(client);
  const useObjectParams = Boolean(client.api) || readFn.length <= 1;
  const response = useObjectParams
    ? await readFn({
      name: params.name,
      namespace: params.namespace,
      container: params.container,
      follow: params.follow,
      sinceSeconds: params.sinceSeconds,
      timestamps: params.timestamps,
    })
    : await readFn(
        params.name,
        params.namespace,
        params.container,
        params.follow,
        undefined,
        undefined,
        params.sinceSeconds,
        undefined,
        params.timestamps,
      );

  if (typeof response === "string") {
    return { body: response };
  }
  if (response && typeof response === "object" && "body" in response) {
    return response as { body: string };
  }
  throw new Error("Unexpected response from readNamespacedPodLog.");
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

export const createK8sBackend = (config: GuckK8sReadBackendConfig): ReadBackend => {
  let client: K8sClient | null = null;
  let clientPromise: Promise<K8sClient> | null = null;
  let tokenExpiresAtMs: number | null = null;
  let cachedEksConfig:
    | { clusterName: string; region: string; profile?: string; roleArn?: string }
    | null
    | undefined;
  let cachedCluster:
    | { name: string; server: string; caData?: string; skipTLSVerify?: boolean; namespace?: string }
    | null = null;

  const resolveEksConfig = (kc: KubeConfigLike): { clusterName: string; region: string; profile?: string; roleArn?: string } | null => {
    if (cachedEksConfig !== undefined) {
      return cachedEksConfig;
    }
    const parsed = parseAwsEksExec(getCurrentUser(kc)?.exec);
    if (config.auth?.type === "eks") {
      const clusterName =
        config.auth.cluster ?? config.clusterName ?? parsed?.clusterName;
      const region = config.auth.region ?? config.region ?? parsed?.region;
      if (!clusterName || !region) {
        throw new Error(
          "Kubernetes EKS auth requires cluster name and region. Set read.backends[].auth.cluster/read.backends[].auth.region or configure aws eks exec args.",
        );
      }
      cachedEksConfig = {
        clusterName,
        region,
        profile: config.auth.profile ?? config.profile,
        roleArn: config.auth.role_arn ?? parsed?.roleArn,
      };
      return cachedEksConfig;
    }
    if (config.clusterName && config.region) {
      cachedEksConfig = {
        clusterName: config.clusterName,
        region: config.region,
        profile: config.profile,
        roleArn: parsed?.roleArn,
      };
      return cachedEksConfig;
    }
    if (!parsed) {
      cachedEksConfig = null;
      return cachedEksConfig;
    }
    cachedEksConfig = {
      clusterName: parsed.clusterName,
      region: parsed.region,
      profile: config.profile ?? parsed.profile,
      roleArn: parsed.roleArn,
    };
    return cachedEksConfig;
  };

  const resolveClusterInfo = async (
    kc: KubeConfigLike,
    eksConfig: { clusterName: string; region: string; profile?: string; roleArn?: string },
  ): Promise<{ name: string; server: string; caData?: string; skipTLSVerify?: boolean; namespace?: string }> => {
    if (cachedCluster) {
      return cachedCluster;
    }
    const currentCluster = getCurrentCluster(kc);
    const currentContext = getContextObject(kc, getCurrentContextName(kc));
    const namespace = currentContext?.namespace;
    let server = currentCluster?.server;
    let caData = currentCluster?.caData;
    const skipTLSVerify = currentCluster?.skipTLSVerify;

    if (!server || !caData) {
      const fetched = await fetchEksClusterInfo({
        clusterName: eksConfig.clusterName,
        region: eksConfig.region,
        profile: eksConfig.profile,
        roleArn: eksConfig.roleArn,
      });
      server = server ?? fetched.endpoint;
      caData = caData ?? fetched.certificateAuthorityData;
    }

    if (!server) {
      throw new Error(`EKS cluster ${eksConfig.clusterName} has no endpoint configured.`);
    }
    cachedCluster = {
      name: currentCluster?.name ?? eksConfig.clusterName,
      server,
      caData,
      skipTLSVerify,
      namespace,
    };
    return cachedCluster;
  };

  const getClient = async (): Promise<K8sClient> => {
    if (client && tokenExpiresAtMs === null) {
      return client;
    }
    const now = Date.now();
    if (client && tokenExpiresAtMs && tokenExpiresAtMs - 30_000 > now) {
      return client;
    }
    if (clientPromise) {
      return clientPromise;
    }
    clientPromise = (async () => {
      const { kc, CoreV1Api } = loadKubeConfig(config.context);
      const eksConfig = resolveEksConfig(kc);
      if (!eksConfig) {
        client = kc.makeApiClient(CoreV1Api) as unknown as K8sClient;
        tokenExpiresAtMs = null;
        return client;
      }
      const clusterInfo = await resolveClusterInfo(kc, eksConfig);
      const tokenResult = await buildEksToken({
        clusterName: eksConfig.clusterName,
        region: eksConfig.region,
        profile: eksConfig.profile,
        roleArn: eksConfig.roleArn,
      });
      const tokenConfig = buildKubeConfigWithToken({
        clusterName: clusterInfo.name,
        server: clusterInfo.server,
        caData: clusterInfo.caData,
        skipTLSVerify: clusterInfo.skipTLSVerify,
        namespace: clusterInfo.namespace,
        token: tokenResult.token,
      });
      client = tokenConfig.makeApiClient(CoreV1Api) as unknown as K8sClient;
      tokenExpiresAtMs = tokenResult.expiresAtMs;
      return client;
    })().finally(() => {
      clientPromise = null;
    });
    return clientPromise;
  };

  const fetchEvents = async (params: GuckSearchParams): Promise<SearchResult> => {
    const client = await getClient();
    const sinceMs = params.since ? parseTimeInput(params.since) : undefined;
    const untilMs = params.until ? parseTimeInput(params.until) : undefined;
    const sinceSeconds =
      sinceMs && sinceMs < Date.now()
        ? Math.max(1, Math.floor((Date.now() - sinceMs) / 1000))
        : undefined;
    const limit = params.limit ?? 200;
    const events: GuckEvent[] = [];
    let truncated = false;

    const pods = await listNamespacedPod(client, {
      namespace: config.namespace,
      labelSelector: config.selector,
    });

    for (const pod of pods.body.items) {
      const podName = pod.metadata?.name;
      if (!podName) {
        continue;
      }
      const response = await readNamespacedPodLog(client, {
        name: podName,
        namespace: config.namespace,
        container: config.container,
        follow: false,
        sinceSeconds,
        timestamps: true,
      });
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

  const stats = async (params: GuckStatsParams): Promise<StatsResult> => {
    const searchParams: GuckSearchParams = {
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

  const sessions = async (params: GuckSessionsParams): Promise<SessionsResult> => {
    const searchParams: GuckSearchParams = {
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

export const __test__ = {
  toEvent,
  hasStructuredKeys,
  coerceTimestamp,
  coerceMessage,
};
