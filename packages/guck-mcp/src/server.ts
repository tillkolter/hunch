import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  GuckConfig,
  GuckSearchParams,
  GuckSessionsParams,
  GuckStatsParams,
  GuckTailParams,
  formatEventText,
  loadConfig,
  projectEventFields,
  readCheckpoint,
  readSearch,
  readSessions,
  readStats,
  readTail,
  redactEvent,
  resolveStoreDir,
  truncateEventMessage,
} from "@guckdev/core";
import { resolveHttpIngestConfig, startHttpIngest, type HttpIngestConfig } from "./ingest.js";
import { writeIngestRegistryEntry } from "./registry.js";
const SEARCH_SCHEMA = {
  type: "object",
  description:
    "Search telemetry events. All filters are combined with AND; query is a message-only boolean expression applied after other filters.",
  additionalProperties: false,
  properties: {
    service: {
      type: "string",
      description: "Exact match on event.service (use to scope to a single service).",
    },
    session_id: {
      type: "string",
      description: "Exact match on event.session_id.",
    },
    run_id: {
      type: "string",
      description: "Exact match on event.run_id.",
    },
    types: {
      type: "array",
      items: { type: "string" },
      description: "Only include events whose event.type is in this list.",
    },
    levels: {
      type: "array",
      items: { type: "string" },
      description:
        "Only include events whose event.level is in this list (trace, debug, info, warn, error, fatal).",
    },
    contains: {
      type: "string",
      description:
        "Case-insensitive substring match across event.message, event.type, event.session_id, and event.data JSON.",
    },
    query: {
      type: "string",
      description:
        "Boolean search applied to event.message only. Supports AND/OR/NOT, parentheses, quotes, and implicit AND (e.g. \"timeout AND retry\"). Case-insensitive.",
    },
    since: {
      type: "string",
      description:
        "Start time filter. Accepts ISO timestamps or relative durations like 15m/2h/1d. Also supports \"checkpoint\" to resume from the last saved checkpoint.",
    },
    until: {
      type: "string",
      description:
        "End time filter. Accepts ISO timestamps or relative durations like 15m/2h/1d.",
    },
    limit: {
      type: "number",
      description:
        "Maximum number of events to return (defaults to config.mcp.max_results).",
    },
    max_output_chars: {
      type: "number",
      description:
        "Maximum total characters to return in the response payload (uses config.mcp.max_output_chars when omitted).",
    },
    max_message_chars: {
      type: "number",
      description:
        "Truncate event.message to this length before formatting (uses config.mcp.max_message_chars when omitted).",
    },
    format: {
      type: "string",
      enum: ["json", "text"],
      description:
        "Output format: json returns events; text returns formatted lines (use template to customize).",
    },
    fields: {
      type: "array",
      items: { type: "string" },
      description:
        "JSON projection of event fields to return. Allowed fields: id, ts, level, type, service, run_id, session_id, message, data, tags, trace_id, span_id, source.",
    },
    template: {
      type: "string",
      description:
        "Text format template when format is \"text\". Tokens like {ts}, {level}, {service}, {message} are replaced; unknown tokens become empty. Example: \"{ts}|{service}|{message}\".",
    },
    backends: {
      type: "array",
      items: { type: "string" },
      description:
        "Restrict search to specific read backends by id or type (local, cloudwatch, k8s).",
    },
    config_path: {
      type: "string",
      description:
        "Path to .guck.json or a directory containing it; overrides default config resolution.",
    },
  },
} as const;

const STATS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    service: { type: "string" },
    session_id: { type: "string" },
    since: { type: "string" },
    until: { type: "string" },
    group_by: { type: "string", enum: ["type", "level", "stage"] },
    limit: { type: "number" },
    backends: { type: "array", items: { type: "string" } },
    config_path: { type: "string" },
  },
  required: ["group_by"],
} as const;

const SESSIONS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    service: { type: "string" },
    since: { type: "string" },
    limit: { type: "number" },
    backends: { type: "array", items: { type: "string" } },
    config_path: { type: "string" },
  },
} as const;

const TAIL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    service: { type: "string" },
    session_id: { type: "string" },
    run_id: { type: "string" },
    limit: { type: "number" },
    query: { type: "string" },
    max_output_chars: {
      type: "number",
      description:
        "Maximum total characters to return in the response payload (uses config.mcp.max_output_chars when omitted).",
    },
    max_message_chars: {
      type: "number",
      description:
        "Truncate event.message to this length before formatting (uses config.mcp.max_message_chars when omitted).",
    },
    format: { type: "string", enum: ["json", "text"] },
    fields: { type: "array", items: { type: "string" } },
    template: { type: "string" },
    backends: { type: "array", items: { type: "string" } },
    config_path: { type: "string" },
  },
} as const;

const buildText = (payload: unknown) => {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
};

const OUTPUT_LIMIT_WARNING =
  "Output truncated to fit max_output_chars. Consider using fields/template or max_message_chars to reduce size.";

const normalizeMaxChars = (value: number | undefined): number | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Number.isFinite(value)) {
    return undefined;
  }
  const normalized = Math.floor(value);
  if (normalized <= 0) {
    return undefined;
  }
  return normalized;
};

const resolveMaxChars = (
  value: number | undefined,
  fallback: number | undefined,
): number | undefined => {
  return normalizeMaxChars(value ?? fallback);
};

const payloadLength = (payload: unknown): number => {
  return JSON.stringify(payload, null, 2).length;
};

const limitPayloadItems = <T>(
  items: T[],
  maxOutputChars: number | undefined,
  buildPayload: (items: T[], truncated: boolean, warning?: string) => unknown,
  baseTruncated: boolean,
): { items: T[]; truncated: boolean; warning?: string } => {
  if (!maxOutputChars) {
    return { items, truncated: baseTruncated };
  }

  const limited: T[] = [];
  let truncated = baseTruncated;
  let warning: string | undefined;

  for (const item of items) {
    const candidate = [...limited, item];
    if (payloadLength(buildPayload(candidate, truncated, warning)) <= maxOutputChars) {
      limited.push(item);
      continue;
    }
    warning = OUTPUT_LIMIT_WARNING;
    truncated = true;
    if (payloadLength(buildPayload(limited, truncated, warning)) <= maxOutputChars) {
      return { items: limited, truncated, warning };
    }
    while (limited.length > 0) {
      limited.pop();
      if (payloadLength(buildPayload(limited, truncated, warning)) <= maxOutputChars) {
        return { items: limited, truncated, warning };
      }
    }
    return { items: [], truncated: true, warning };
  }

  if (payloadLength(buildPayload(limited, truncated, warning)) <= maxOutputChars) {
    return { items: limited, truncated, warning };
  }

  warning = OUTPUT_LIMIT_WARNING;
  truncated = true;
  while (limited.length > 0) {
    limited.pop();
    if (payloadLength(buildPayload(limited, truncated, warning)) <= maxOutputChars) {
      return { items: limited, truncated, warning };
    }
  }
  return { items: [], truncated: true, warning };
};

const resolveSince = (
  input: string | undefined,
  config: GuckConfig,
  storeDir: string,
): string => {
  const checkpointMs = readCheckpoint(storeDir);
  if (input) {
    if (input === "checkpoint") {
      if (checkpointMs !== undefined) {
        return new Date(checkpointMs).toISOString();
      }
      return `${config.mcp.default_lookback_ms}ms`;
    }
    return input;
  }
  if (checkpointMs !== undefined) {
    return new Date(checkpointMs).toISOString();
  }
  return `${config.mcp.default_lookback_ms}ms`;
};

type McpServerOptions = {
  http?: HttpIngestConfig;
  configPath?: string;
};

const parseNumber = (value: string | undefined, label: string): number | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`[guck] invalid ${label}: ${value}`);
  }
  return parsed;
};

const resolveHttpConfig = (
  config: GuckConfig,
  overrides?: HttpIngestConfig,
): { port?: number; host: string; path: string; maxBodyBytes: number } => {
  const envPort = parseNumber(process.env.GUCK_MCP_HTTP_PORT, "GUCK_MCP_HTTP_PORT");
  const envMax = parseNumber(
    process.env.GUCK_MCP_HTTP_MAX_BODY_BYTES,
    "GUCK_MCP_HTTP_MAX_BODY_BYTES",
  );
  const envHost = process.env.GUCK_MCP_HTTP_HOST;
  const envPath = process.env.GUCK_MCP_HTTP_PATH;

  const resolved = resolveHttpIngestConfig({
    port: overrides?.port ?? envPort ?? config.mcp.http?.port,
    host: overrides?.host ?? envHost ?? config.mcp.http?.host,
    path: overrides?.path ?? envPath ?? config.mcp.http?.path,
    max_body_bytes: overrides?.max_body_bytes ?? envMax ?? config.mcp.http?.max_body_bytes,
  });

  if (resolved.port !== undefined) {
    if (!Number.isInteger(resolved.port) || resolved.port < 0 || resolved.port > 65535) {
      throw new Error(`[guck] invalid HTTP port: ${resolved.port}`);
    }
  }
  if (!Number.isInteger(resolved.maxBodyBytes) || resolved.maxBodyBytes <= 0) {
    throw new Error(`[guck] invalid HTTP max_body_bytes: ${resolved.maxBodyBytes}`);
  }

  return resolved;
};

const isAddrInUse = (error: unknown): boolean => {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "EADDRINUSE"
  );
};

export const startMcpServer = async (options: McpServerOptions = {}): Promise<void> => {
  const server = new Server(
    {
      name: "guck",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "guck.search",
          description:
            "Search telemetry events with filters. Supports boolean message-only query (query), JSON field projection (fields), or text formatting with template (format: text + template).",
          inputSchema: SEARCH_SCHEMA,
        },
        {
          name: "guck.stats",
          description: "Aggregate telemetry counts by type/level/stage.",
          inputSchema: STATS_SCHEMA,
        },
        {
          name: "guck.sessions",
          description: "List recent sessions and error counts.",
          inputSchema: SESSIONS_SCHEMA,
        },
        {
          name: "guck.tail",
          description:
            "Return the most recent events (non-streaming). Supports message-only boolean query (query) and output formatting (format: json/text, fields, template).",
          inputSchema: TAIL_SCHEMA,
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as { config_path?: string };
    const { config_path: configPath } = args;
    const { config, rootDir } = loadConfig({ configPath });
    if (!config.enabled) {
      return buildText({
        error:
          "Guck is disabled. Create .guck.json or set GUCK_ENABLED=true/GUCK_CONFIG_PATH.",
      });
    }
    const storeDir = resolveStoreDir(config, rootDir);

    if (request.params.name === "guck.search") {
      const input = (request.params.arguments ?? {}) as GuckSearchParams;
      const { config_path: _configPath, ...filters } = input;
      const withDefaults: GuckSearchParams = {
        ...filters,
        since: resolveSince(filters.since, config, storeDir),
      };
      try {
        const result = await readSearch(config, rootDir, withDefaults);
        const maxMessageChars = resolveMaxChars(
          input.max_message_chars,
          config.mcp.max_message_chars,
        );
        const maxOutputChars = resolveMaxChars(
          input.max_output_chars,
          config.mcp.max_output_chars,
        );
        const redacted = result.events.map((event) => redactEvent(config, event));
        const trimmed = maxMessageChars
          ? redacted.map((event) => truncateEventMessage(event, maxMessageChars))
          : redacted;
        if (input.format === "text") {
          const lines = trimmed.map((event) => formatEventText(event, input.template));
          const limited = limitPayloadItems(
            lines,
            maxOutputChars,
            (items, truncated, warning) => ({
              format: "text",
              lines: items,
              truncated,
              errors: result.errors,
              warning,
            }),
            result.truncated,
          );
          return buildText({
            format: "text",
            lines: limited.items,
            truncated: limited.truncated,
            errors: result.errors,
            warning: limited.warning,
          });
        }
        if (input.fields && input.fields.length > 0) {
          const projected = trimmed.map((event) => projectEventFields(event, input.fields ?? []));
          const limited = limitPayloadItems(
            projected,
            maxOutputChars,
            (items, truncated, warning) => ({
              format: "json",
              events: items,
              truncated,
              errors: result.errors,
              warning,
            }),
            result.truncated,
          );
          return buildText({
            format: "json",
            events: limited.items,
            truncated: limited.truncated,
            errors: result.errors,
            warning: limited.warning,
          });
        }
        const limited = limitPayloadItems(
          trimmed,
          maxOutputChars,
          (items, truncated, warning) => ({
            format: "json",
            events: items,
            truncated,
            errors: result.errors,
            warning,
          }),
          result.truncated,
        );
        return buildText({
          format: "json",
          events: limited.items,
          truncated: limited.truncated,
          errors: result.errors,
          warning: limited.warning,
        });
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("Invalid query:")) {
          return buildText({ error: error.message, query: input.query });
        }
        throw error;
      }
    }

    if (request.params.name === "guck.stats") {
      const input = (request.params.arguments ?? {}) as GuckStatsParams;
      const { config_path: _configPath, ...filters } = input;
      const withDefaults: GuckStatsParams = {
        ...filters,
        since: resolveSince(filters.since, config, storeDir),
      };
      const result = await readStats(config, rootDir, withDefaults);
      return buildText(result);
    }

    if (request.params.name === "guck.sessions") {
      const input = (request.params.arguments ?? {}) as GuckSessionsParams;
      const { config_path: _configPath, ...filters } = input;
      const withDefaults: GuckSessionsParams = {
        ...filters,
        since: resolveSince(filters.since, config, storeDir),
      };
      const result = await readSessions(config, rootDir, withDefaults);
      return buildText(result);
    }

    if (request.params.name === "guck.tail") {
      const input = (request.params.arguments ?? {}) as GuckTailParams;
      const { config_path: _configPath, ...filters } = input;
      const limit = input.limit ?? Math.min(config.mcp.max_results, 50);
      const since = resolveSince(undefined, config, storeDir);
      let result;
      try {
        result = await readTail(config, rootDir, {
          service: filters.service,
          session_id: filters.session_id,
          run_id: filters.run_id,
          query: filters.query,
          limit,
          backends: filters.backends,
          since,
        });
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("Invalid query:")) {
          return buildText({ error: error.message, query: input.query });
        }
        throw error;
      }
      const maxMessageChars = resolveMaxChars(
        input.max_message_chars,
        config.mcp.max_message_chars,
      );
      const maxOutputChars = resolveMaxChars(
        input.max_output_chars,
        config.mcp.max_output_chars,
      );
      const redacted = result.events.map((event) => redactEvent(config, event));
      const trimmed = maxMessageChars
        ? redacted.map((event) => truncateEventMessage(event, maxMessageChars))
        : redacted;
      if (input.format === "text") {
        const lines = trimmed.map((event) => formatEventText(event, input.template));
        const limited = limitPayloadItems(
          lines,
          maxOutputChars,
          (items, truncated, warning) => ({
            format: "text",
            lines: items,
            truncated,
            errors: result.errors,
            warning,
          }),
          result.truncated,
        );
        return buildText({
          format: "text",
          lines: limited.items,
          truncated: limited.truncated,
          errors: result.errors,
          warning: limited.warning,
        });
      }
      if (input.fields && input.fields.length > 0) {
        const projected = trimmed.map((event) => projectEventFields(event, input.fields ?? []));
        const limited = limitPayloadItems(
          projected,
          maxOutputChars,
          (items, truncated, warning) => ({
            format: "json",
            events: items,
            truncated,
            errors: result.errors,
            warning,
          }),
          result.truncated,
        );
        return buildText({
          format: "json",
          events: limited.items,
          truncated: limited.truncated,
          errors: result.errors,
          warning: limited.warning,
        });
      }
      const limited = limitPayloadItems(
        trimmed,
        maxOutputChars,
        (items, truncated, warning) => ({
          format: "json",
          events: items,
          truncated,
          errors: result.errors,
          warning,
        }),
        result.truncated,
      );
      return buildText({
        format: "json",
        events: limited.items,
        truncated: limited.truncated,
        errors: result.errors,
        warning: limited.warning,
      });
    }

    throw new Error(`Unknown tool: ${request.params.name}`);
  });

  const transport = new StdioServerTransport();

  const {
    config: baseConfig,
    rootDir: baseRoot,
    configPath: baseConfigPath,
  } = loadConfig({ configPath: options.configPath });
  const httpConfig = resolveHttpConfig(baseConfig, options.http);
  if (httpConfig.port !== undefined) {
    const storeDir = resolveStoreDir(baseConfig, baseRoot);
    let ingestHandle;
    try {
      ingestHandle = await startHttpIngest({
        port: httpConfig.port,
        host: httpConfig.host,
        path: httpConfig.path,
        maxBodyBytes: httpConfig.maxBodyBytes,
        config: baseConfig,
        storeDir,
      });
    } catch (error) {
      if (isAddrInUse(error) && httpConfig.port > 0) {
        ingestHandle = await startHttpIngest({
          port: 0,
          host: httpConfig.host,
          path: httpConfig.path,
          maxBodyBytes: httpConfig.maxBodyBytes,
          config: baseConfig,
          storeDir,
        });
      } else {
        throw error;
      }
    }
    try {
      writeIngestRegistryEntry({
        rootDir: baseRoot,
        configPath: baseConfigPath,
        host: httpConfig.host,
        path: httpConfig.path,
        port: ingestHandle.port,
        sessionId: process.env.GUCK_SESSION_ID ?? process.env.CODEX_THREAD_ID,
      });
    } catch {
      // Registry is best-effort.
    }
  }

  await server.connect(transport);
};
