import path from "node:path";
import { resolveStoreDir } from "../config.js";
import {
  GuckConfig,
  GuckEvent,
  GuckReadBackendConfig,
  GuckSearchParams,
  GuckSessionsParams,
  GuckStatsParams,
  GuckTailParams,
} from "../schema.js";
import { normalizeTimestamp } from "./time.js";
import { createCloudWatchBackend } from "./backends/cloudwatch.js";
import { createK8sBackend } from "./backends/k8s.js";
import { createLocalBackend } from "./backends/local.js";
import { ReadBackend } from "./backends/types.js";
import { compileQuery } from "./query.js";

type BackendEntry = {
  type: string;
  id?: string;
  backend: ReadBackend;
};

export type BackendError = { backend: string; backend_id?: string; message: string };

type ResolvedBackends = {
  backends: BackendEntry[];
  errors: BackendError[];
};

const resolveLocalDir = (rootDir: string, storeDir: string, dir?: string): string => {
  if (!dir) {
    return storeDir;
  }
  if (path.isAbsolute(dir)) {
    return dir;
  }
  return path.join(rootDir, dir);
};

const resolveBackends = (config: GuckConfig, rootDir: string): ResolvedBackends => {
  const errors: BackendError[] = [];
  const backends: BackendEntry[] = [];
  const storeDir = resolveStoreDir(config, rootDir);
  const readConfig = config.read ?? { backend: "local" };

  const addBackend = (backendConfig: GuckReadBackendConfig): void => {
    if (backendConfig.type === "local") {
      const dir = resolveLocalDir(rootDir, storeDir, backendConfig.dir);
      backends.push({
        type: "local",
        id: backendConfig.id,
        backend: createLocalBackend({ storeDir: dir, config, backendId: backendConfig.id }),
      });
      return;
    }

    if (backendConfig.type === "cloudwatch") {
      backends.push({
        type: "cloudwatch",
        id: backendConfig.id,
        backend: createCloudWatchBackend(backendConfig),
      });
      return;
    }

    if (backendConfig.type === "k8s") {
      backends.push({
        type: "k8s",
        id: backendConfig.id,
        backend: createK8sBackend(backendConfig),
      });
      return;
    }

    const unknown = backendConfig as { type: string; id?: string };
    errors.push({
      backend: unknown.type,
      backend_id: unknown.id,
      message: `Unknown backend type: ${unknown.type}`,
    });
  };

  if (readConfig.backend !== "multi") {
    addBackend({ type: "local" });
    return { backends, errors };
  }

  const configured = readConfig.backends ?? [];
  if (configured.length === 0) {
    addBackend({ type: "local" });
    return { backends, errors };
  }

  for (const backendConfig of configured) {
    addBackend(backendConfig);
  }

  return { backends, errors };
};

const filterBackends = (
  entries: BackendEntry[],
  filters?: string[],
): BackendEntry[] => {
  if (!filters || filters.length === 0) {
    return entries;
  }
  const filterSet = new Set(filters);
  return entries.filter((entry) => {
    if (entry.id && filterSet.has(entry.id)) {
      return true;
    }
    if (filterSet.has(entry.type)) {
      return true;
    }
    return false;
  });
};

const sortEventsDesc = (events: GuckEvent[]): GuckEvent[] => {
  return [...events].sort((a, b) => {
    const aTs = normalizeTimestamp(a.ts) ?? 0;
    const bTs = normalizeTimestamp(b.ts) ?? 0;
    return bTs - aTs;
  });
};

export const readSearch = async (
  config: GuckConfig,
  rootDir: string,
  params: GuckSearchParams,
): Promise<{ events: GuckEvent[]; truncated: boolean; errors?: BackendError[] }> => {
  let queryPredicate: ((message: string) => boolean) | undefined;
  if (params.query) {
    const compiled = compileQuery(params.query);
    if (!compiled.ok) {
      throw new Error(`Invalid query: ${compiled.error}`);
    }
    queryPredicate = compiled.predicate;
  }
  const { backends, errors: resolveErrors } = resolveBackends(config, rootDir);
  const selected = filterBackends(backends, params.backends);
  const errors: BackendError[] = [...resolveErrors];

  if (params.backends && params.backends.length > 0 && selected.length === 0) {
    errors.push({
      backend: "multi",
      message: `No backends matched filter: ${params.backends.join(", ")}`,
    });
  }

  const results = await Promise.all(
    selected.map(async (entry) => {
      try {
        const result = await entry.backend.search(params);
        return { entry, result };
      } catch (error) {
        errors.push({
          backend: entry.type,
          backend_id: entry.id,
          message: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    }),
  );

  const limit = params.limit ?? config.mcp.max_results;
  const events: GuckEvent[] = [];
  let truncated = false;

  for (const item of results) {
    if (!item) {
      continue;
    }
    events.push(...item.result.events);
    if (item.result.truncated) {
      truncated = true;
    }
  }

  const filtered = queryPredicate
    ? events.filter((event) => queryPredicate?.(event.message ?? ""))
    : events;
  const sorted = sortEventsDesc(filtered);
  const mergedCount = sorted.length;
  const sliced = sorted.slice(0, limit);
  if (mergedCount > limit) {
    truncated = true;
  }

  return {
    events: sliced,
    truncated,
    errors: errors.length > 0 ? errors : undefined,
  };
};

export const readStats = async (
  config: GuckConfig,
  rootDir: string,
  params: GuckStatsParams,
): Promise<{ buckets: Array<{ key: string; count: number }>; errors?: BackendError[] }> => {
  const { backends, errors: resolveErrors } = resolveBackends(config, rootDir);
  const selected = filterBackends(backends, params.backends);
  const errors: BackendError[] = [...resolveErrors];

  if (params.backends && params.backends.length > 0 && selected.length === 0) {
    errors.push({
      backend: "multi",
      message: `No backends matched filter: ${params.backends.join(", ")}`,
    });
  }

  const results = await Promise.all(
    selected.map(async (entry) => {
      try {
        const result = await entry.backend.stats(params);
        return { entry, result };
      } catch (error) {
        errors.push({
          backend: entry.type,
          backend_id: entry.id,
          message: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    }),
  );

  const buckets = new Map<string, number>();
  for (const item of results) {
    if (!item) {
      continue;
    }
    for (const bucket of item.result.buckets) {
      buckets.set(bucket.key, (buckets.get(bucket.key) ?? 0) + bucket.count);
    }
  }

  const limit = params.limit ?? config.mcp.max_results;
  const merged = [...buckets.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));

  return {
    buckets: merged,
    errors: errors.length > 0 ? errors : undefined,
  };
};

export const readSessions = async (
  config: GuckConfig,
  rootDir: string,
  params: GuckSessionsParams,
): Promise<{
  sessions: Array<{ session_id: string; last_ts: string; event_count: number; error_count: number }>;
  errors?: BackendError[];
}> => {
  const { backends, errors: resolveErrors } = resolveBackends(config, rootDir);
  const selected = filterBackends(backends, params.backends);
  const errors: BackendError[] = [...resolveErrors];

  if (params.backends && params.backends.length > 0 && selected.length === 0) {
    errors.push({
      backend: "multi",
      message: `No backends matched filter: ${params.backends.join(", ")}`,
    });
  }

  const results = await Promise.all(
    selected.map(async (entry) => {
      try {
        const result = await entry.backend.sessions(params);
        return { entry, result };
      } catch (error) {
        errors.push({
          backend: entry.type,
          backend_id: entry.id,
          message: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    }),
  );

  const sessions = new Map<
    string,
    { session_id: string; last_ts: string; event_count: number; error_count: number }
  >();
  for (const item of results) {
    if (!item) {
      continue;
    }
    for (const session of item.result.sessions) {
      const existing = sessions.get(session.session_id) ?? {
        session_id: session.session_id,
        last_ts: session.last_ts,
        event_count: 0,
        error_count: 0,
      };
      existing.event_count += session.event_count;
      existing.error_count += session.error_count;
      const existingTs = normalizeTimestamp(existing.last_ts) ?? 0;
      const sessionTs = normalizeTimestamp(session.last_ts) ?? 0;
      if (sessionTs > existingTs) {
        existing.last_ts = session.last_ts;
      }
      sessions.set(session.session_id, existing);
    }
  }

  const limit = params.limit ?? config.mcp.max_results;
  const merged = [...sessions.values()]
    .sort((a, b) => (normalizeTimestamp(b.last_ts) ?? 0) - (normalizeTimestamp(a.last_ts) ?? 0))
    .slice(0, limit);

  return {
    sessions: merged,
    errors: errors.length > 0 ? errors : undefined,
  };
};

export const readTail = async (
  config: GuckConfig,
  rootDir: string,
  params: GuckTailParams & { since?: string },
): Promise<{ events: GuckEvent[]; truncated: boolean; errors?: BackendError[] }> => {
  const limit = params.limit ?? Math.min(config.mcp.max_results, 50);
  const searchParams: GuckSearchParams = {
    service: params.service,
    session_id: params.session_id,
    run_id: params.run_id,
    query: params.query,
    since: params.since,
    limit: config.mcp.max_results,
    backends: params.backends,
  };

  const result = await readSearch(config, rootDir, searchParams);
  const sorted = sortEventsDesc(result.events);
  const sliced = sorted.slice(0, limit);
  const truncated = result.truncated || sorted.length > limit;

  return {
    events: sliced,
    truncated,
    errors: result.errors,
  };
};
