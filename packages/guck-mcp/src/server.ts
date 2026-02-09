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
} from "@guckdev/core";
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

export const startMcpServer = async (): Promise<void> => {
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
        const redacted = result.events.map((event) => redactEvent(config, event));
        if (input.format === "text") {
          const lines = redacted.map((event) => formatEventText(event, input.template));
          return buildText({
            format: "text",
            lines,
            truncated: result.truncated,
            errors: result.errors,
          });
        }
        if (input.fields && input.fields.length > 0) {
          const projected = redacted.map((event) => projectEventFields(event, input.fields ?? []));
          return buildText({
            format: "json",
            events: projected,
            truncated: result.truncated,
            errors: result.errors,
          });
        }
        return buildText({ format: "json", ...result, events: redacted });
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
      const redacted = result.events.map((event) => redactEvent(config, event));
      if (input.format === "text") {
        const lines = redacted.map((event) => formatEventText(event, input.template));
        return buildText({
          format: "text",
          lines,
          truncated: result.truncated,
          errors: result.errors,
        });
      }
      if (input.fields && input.fields.length > 0) {
        const projected = redacted.map((event) => projectEventFields(event, input.fields ?? []));
        return buildText({
          format: "json",
          events: projected,
          truncated: result.truncated,
          errors: result.errors,
        });
      }
      return buildText({ format: "json", ...result, events: redacted });
    }

    throw new Error(`Unknown tool: ${request.params.name}`);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
};
