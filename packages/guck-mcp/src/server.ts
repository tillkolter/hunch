import fs from "node:fs";
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
import { computeMessageStats, guardPayload, trimEventsMessages } from "./output.js";

const SEARCH_SCHEMA = {
  type: "object",
  description:
    "Search telemetry events. All filters are combined with AND; query is a message-only boolean expression applied after other filters. Output is capped by mcp.max_output_chars; if exceeded, a warning is returned unless force=true. Use max_message_chars to trim message per event; warnings include avg/max message length.",
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
      description: "Per-message cap; trims the message field only.",
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
        "JSON projection of event fields to return. Allowed fields: id, ts, level, type, service, run_id, session_id, message, data, tags, trace_id, span_id, source. Dotted paths like data.rawPeak are supported (top-level segment must be allowed; arrays not supported).",
    },
    flatten: {
      type: "boolean",
      description:
        "When true, dotted field paths are emitted as top-level keys (e.g. \"data.rawPeak\": 43). Defaults to false.",
    },
    template: {
      type: "string",
      description:
        "Text format template when format is \"text\". Tokens like {ts}, {level}, {service}, {message} are replaced; dotted tokens like {data.rawPeak} are supported; unknown tokens become empty. Example: \"{ts}|{service}|{message}\".",
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
        "Path to .guck.json or a directory containing it. Relative paths resolve against the MCP server pwd; prefer absolute paths to avoid mismatch.",
    },
    force: {
      type: "boolean",
      description: "Bypass output-size guard and return the full payload.",
    },
  },
} as const;

const SEARCH_ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: {
      type: "string",
      description: "Optional identifier echoed back in results.",
    },
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
      description: "Per-message cap; trims the message field only.",
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
        "JSON projection of event fields to return. Allowed fields: id, ts, level, type, service, run_id, session_id, message, data, tags, trace_id, span_id, source. Dotted paths like data.rawPeak are supported (top-level segment must be allowed; arrays not supported).",
    },
    flatten: {
      type: "boolean",
      description:
        "When true, dotted field paths are emitted as top-level keys (e.g. \"data.rawPeak\": 43). Defaults to false.",
    },
    template: {
      type: "string",
      description:
        "Text format template when format is \"text\". Tokens like {ts}, {level}, {service}, {message} are replaced; dotted tokens like {data.rawPeak} are supported; unknown tokens become empty. Example: \"{ts}|{service}|{message}\".",
    },
    backends: {
      type: "array",
      items: { type: "string" },
      description:
        "Restrict search to specific read backends by id or type (local, cloudwatch, k8s).",
    },
  },
} as const;

const BATCH_SCHEMA = {
  type: "object",
  description:
    "Run multiple searches in parallel. Each search result is capped by mcp.max_output_chars; if exceeded, a warning is returned unless force=true. Each search can set max_message_chars for per-message trimming; warnings include avg/max message length.",
  additionalProperties: false,
  properties: {
    searches: {
      type: "array",
      items: SEARCH_ITEM_SCHEMA,
      description: "List of search parameter sets to execute in parallel.",
    },
    force: {
      type: "boolean",
      description: "Bypass output-size guard for all searches.",
    },
    config_path: {
      type: "string",
      description:
        "Path to .guck.json or a directory containing it. Relative paths resolve against the MCP server pwd; prefer absolute paths to avoid mismatch.",
    },
  },
  required: ["searches"],
} as const;

const VERSION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {},
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
    config_path: {
      type: "string",
      description:
        "Path to .guck.json or a directory containing it. Relative paths resolve against the MCP server pwd; prefer absolute paths to avoid mismatch.",
    },
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
    config_path: {
      type: "string",
      description:
        "Path to .guck.json or a directory containing it. Relative paths resolve against the MCP server pwd; prefer absolute paths to avoid mismatch.",
    },
  },
} as const;

const TAIL_SCHEMA = {
  type: "object",
  description:
    "Return recent events. Output is capped by mcp.max_output_chars; if exceeded, a warning is returned unless force=true. Use max_message_chars to trim message per event; warnings include avg/max message length.",
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
      description: "Per-message cap; trims the message field only.",
    },
    format: { type: "string", enum: ["json", "text"] },
    fields: { type: "array", items: { type: "string" } },
    flatten: {
      type: "boolean",
      description:
        "When true, dotted field paths are emitted as top-level keys (e.g. \"data.rawPeak\": 43). Defaults to false.",
    },
    template: { type: "string" },
    backends: { type: "array", items: { type: "string" } },
    config_path: {
      type: "string",
      description:
        "Path to .guck.json or a directory containing it. Relative paths resolve against the MCP server pwd; prefer absolute paths to avoid mismatch.",
    },
    force: {
      type: "boolean",
      description: "Bypass output-size guard and return the full payload.",
    },
  },
} as const;

const DEFAULT_MCP_NAME = "@guckdev/mcp";
const DEFAULT_MCP_VERSION = "unknown";

const loadMcpPackage = (): { name: string; version: string } => {
  try {
    const pkgUrl = new URL("../package.json", import.meta.url);
    const raw = fs.readFileSync(pkgUrl, "utf8");
    const parsed = JSON.parse(raw) as { name?: unknown; version?: unknown };
    const name =
      typeof parsed.name === "string" && parsed.name.trim().length > 0
        ? parsed.name
        : DEFAULT_MCP_NAME;
    const version =
      typeof parsed.version === "string" && parsed.version.trim().length > 0
        ? parsed.version
        : DEFAULT_MCP_VERSION;
    return { name, version };
  } catch {
    return { name: DEFAULT_MCP_NAME, version: DEFAULT_MCP_VERSION };
  }
};

const MCP_PACKAGE = loadMcpPackage();

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

const buildTextFromSerialized = (text: string) => {
  return {
    content: [
      {
        type: "text",
        text,
      },
    ],
  };
};

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
  configPath?: string;
};

export const startMcpServer = async (options: McpServerOptions = {}): Promise<void> => {
  if (options.configPath && !process.env.GUCK_CONFIG && !process.env.GUCK_CONFIG_PATH) {
    process.env.GUCK_CONFIG_PATH = options.configPath;
  }
  const server = new Server(
    {
      name: "guck",
      version: MCP_PACKAGE.version,
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
          name: "guck.mcp_version",
          description: "Return the MCP package name and version.",
          inputSchema: VERSION_SCHEMA,
        },
        {
          name: "guck.search",
          description:
            "Search telemetry events with filters. Supports boolean message-only query (query), JSON field projection (fields), or text formatting with template (format: text + template). Output is capped by mcp.max_output_chars; warning unless force=true. Use max_message_chars for per-message trimming; warnings include avg/max message length. Tip: Always pass config_path (absolute preferred). Relative paths resolve against the MCP server pwd, not the agent's PWD.",
          inputSchema: SEARCH_SCHEMA,
        },
        {
          name: "guck.search_batch",
          description:
            "Run multiple searches in parallel. Each search result is output-capped; use force=true to bypass per-search guard. Supports per-item max_message_chars trimming. Tip: Always pass config_path (absolute preferred). Relative paths resolve against the MCP server pwd, not the agent's PWD.",
          inputSchema: BATCH_SCHEMA,
        },
        {
          name: "guck.stats",
          description:
            "Aggregate telemetry counts by type/level/stage. Use this first to scope time windows and backends before running guck.search. Tip: Always pass config_path (absolute preferred). Relative paths resolve against the MCP server pwd, not the agent's PWD.",
          inputSchema: STATS_SCHEMA,
        },
        {
          name: "guck.sessions",
          description:
            "List recent sessions and error counts. Useful for finding a session_id to drill into with guck.search. Tip: Always pass config_path (absolute preferred). Relative paths resolve against the MCP server pwd, not the agent's PWD.",
          inputSchema: SESSIONS_SCHEMA,
        },
        {
          name: "guck.tail",
          description:
            "Return the most recent events (non-streaming). Supports message-only boolean query (query) and output formatting (format: json/text, fields, template). Output is capped by mcp.max_output_chars; warning unless force=true. Use max_message_chars for per-message trimming; warnings include avg/max message length. Tip: Always pass config_path (absolute preferred). Relative paths resolve against the MCP server pwd, not the agent's PWD.",
          inputSchema: TAIL_SCHEMA,
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === "guck.mcp_version") {
      return buildText({ name: MCP_PACKAGE.name, version: MCP_PACKAGE.version });
    }
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
        const messageStats = computeMessageStats(redacted);
        const trimmed = trimEventsMessages(redacted, {
          maxChars: maxMessageChars,
          match: input.contains,
        });
        if (input.format === "text") {
          const lines = trimmed.map((event) => formatEventText(event, input.template));
          const payload = {
            format: "text",
            lines,
            truncated: result.truncated,
            errors: result.errors,
          };
          const guarded = guardPayload({
            payload,
            maxChars: maxOutputChars ?? Number.POSITIVE_INFINITY,
            force: input.force,
            format: "text",
            itemCount: lines.length,
            truncated: result.truncated,
            avgMessageChars: messageStats.avgMessageChars,
            maxMessageChars: messageStats.maxMessageChars,
            errors: result.errors,
          });
          return guarded.kind === "ok"
            ? buildTextFromSerialized(guarded.serialized)
            : buildText(guarded.warningPayload);
        }
        if (input.fields && input.fields.length > 0) {
          const projected = trimmed.map((event) =>
            projectEventFields(event, input.fields ?? [], { flatten: input.flatten }),
          );
          const payload = {
            format: "json",
            events: projected,
            truncated: result.truncated,
            errors: result.errors,
          };
          const guarded = guardPayload({
            payload,
            maxChars: maxOutputChars ?? Number.POSITIVE_INFINITY,
            force: input.force,
            format: "json",
            itemCount: projected.length,
            truncated: result.truncated,
            avgMessageChars: messageStats.avgMessageChars,
            maxMessageChars: messageStats.maxMessageChars,
            errors: result.errors,
          });
          return guarded.kind === "ok"
            ? buildTextFromSerialized(guarded.serialized)
            : buildText(guarded.warningPayload);
        }
        const payload = { format: "json", ...result, events: trimmed };
        const guarded = guardPayload({
          payload,
          maxChars: maxOutputChars ?? Number.POSITIVE_INFINITY,
          force: input.force,
          format: "json",
          itemCount: trimmed.length,
          truncated: result.truncated,
          avgMessageChars: messageStats.avgMessageChars,
          maxMessageChars: messageStats.maxMessageChars,
          errors: result.errors,
        });
        return guarded.kind === "ok"
          ? buildTextFromSerialized(guarded.serialized)
          : buildText(guarded.warningPayload);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("Invalid query:")) {
          return buildText({ error: error.message, query: input.query });
        }
        throw error;
      }
    }

    if (request.params.name === "guck.search_batch") {
      const input = (request.params.arguments ?? {}) as {
        searches?: Array<GuckSearchParams & { id?: string }>;
        force?: boolean;
        config_path?: string;
      };
      const searches = input.searches ?? [];
      const results = await Promise.all(
        searches.map(async (search) => {
          const { id, config_path: _ignored, force: _ignoredForce, ...filters } = search;
          const withDefaults: GuckSearchParams = {
            ...filters,
            since: resolveSince(filters.since, config, storeDir),
          };
          try {
            const result = await readSearch(config, rootDir, withDefaults);
            const maxMessageChars = resolveMaxChars(
              search.max_message_chars,
              config.mcp.max_message_chars,
            );
            const maxOutputChars = resolveMaxChars(
              search.max_output_chars,
              config.mcp.max_output_chars,
            );
            const redacted = result.events.map((event) => redactEvent(config, event));
            const messageStats = computeMessageStats(redacted);
            const trimmed = trimEventsMessages(redacted, {
              maxChars: maxMessageChars,
              match: search.contains,
            });
            if (search.format === "text") {
              const lines = trimmed.map((event) => formatEventText(event, search.template));
              const payload = {
                format: "text",
                lines,
                truncated: result.truncated,
                errors: result.errors,
              };
              const guarded = guardPayload({
                payload,
                maxChars: maxOutputChars ?? Number.POSITIVE_INFINITY,
                force: input.force,
                format: "text",
                itemCount: lines.length,
                truncated: result.truncated,
                avgMessageChars: messageStats.avgMessageChars,
                maxMessageChars: messageStats.maxMessageChars,
                errors: result.errors,
              });
              if (guarded.kind === "ok") {
                return { id, ...payload };
              }
              return { id, ...(guarded.warningPayload as object) };
            }
            if (search.fields && search.fields.length > 0) {
              const projected = trimmed.map((event) =>
                projectEventFields(event, search.fields ?? [], { flatten: search.flatten }),
              );
              const payload = {
                format: "json",
                events: projected,
                truncated: result.truncated,
                errors: result.errors,
              };
              const guarded = guardPayload({
                payload,
                maxChars: maxOutputChars ?? Number.POSITIVE_INFINITY,
                force: input.force,
                format: "json",
                itemCount: projected.length,
                truncated: result.truncated,
                avgMessageChars: messageStats.avgMessageChars,
                maxMessageChars: messageStats.maxMessageChars,
                errors: result.errors,
              });
              if (guarded.kind === "ok") {
                return { id, ...payload };
              }
              return { id, ...(guarded.warningPayload as object) };
            }
            const payload = { format: "json", ...result, events: trimmed };
            const guarded = guardPayload({
              payload,
              maxChars: maxOutputChars ?? Number.POSITIVE_INFINITY,
              force: input.force,
              format: "json",
              itemCount: trimmed.length,
              truncated: result.truncated,
              avgMessageChars: messageStats.avgMessageChars,
              maxMessageChars: messageStats.maxMessageChars,
              errors: result.errors,
            });
            if (guarded.kind === "ok") {
              return { id, ...payload };
            }
            return { id, ...(guarded.warningPayload as object) };
          } catch (error) {
            if (error instanceof Error && error.message.startsWith("Invalid query:")) {
              return { id, error: error.message, query: search.query };
            }
            throw error;
          }
        }),
      );
      return buildText({ results });
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
      const messageStats = computeMessageStats(redacted);
      const trimmed = trimEventsMessages(redacted, {
        maxChars: maxMessageChars,
      });
      if (input.format === "text") {
        const lines = trimmed.map((event) => formatEventText(event, input.template));
        const payload = {
          format: "text",
          lines,
          truncated: result.truncated,
          errors: result.errors,
        };
        const guarded = guardPayload({
          payload,
          maxChars: maxOutputChars ?? Number.POSITIVE_INFINITY,
          force: input.force,
          format: "text",
          itemCount: lines.length,
          truncated: result.truncated,
          avgMessageChars: messageStats.avgMessageChars,
          maxMessageChars: messageStats.maxMessageChars,
          errors: result.errors,
        });
        return guarded.kind === "ok"
          ? buildTextFromSerialized(guarded.serialized)
          : buildText(guarded.warningPayload);
      }
      if (input.fields && input.fields.length > 0) {
        const projected = trimmed.map((event) =>
          projectEventFields(event, input.fields ?? [], { flatten: input.flatten }),
        );
        const payload = {
          format: "json",
          events: projected,
          truncated: result.truncated,
          errors: result.errors,
        };
        const guarded = guardPayload({
          payload,
          maxChars: maxOutputChars ?? Number.POSITIVE_INFINITY,
          force: input.force,
          format: "json",
          itemCount: projected.length,
          truncated: result.truncated,
          avgMessageChars: messageStats.avgMessageChars,
          maxMessageChars: messageStats.maxMessageChars,
          errors: result.errors,
        });
        return guarded.kind === "ok"
          ? buildTextFromSerialized(guarded.serialized)
          : buildText(guarded.warningPayload);
      }
      const payload = { format: "json", ...result, events: trimmed };
      const guarded = guardPayload({
        payload,
        maxChars: maxOutputChars ?? Number.POSITIVE_INFINITY,
        force: input.force,
        format: "json",
        itemCount: trimmed.length,
        truncated: result.truncated,
        avgMessageChars: messageStats.avgMessageChars,
        maxMessageChars: messageStats.maxMessageChars,
        errors: result.errors,
      });
      return guarded.kind === "ok"
        ? buildTextFromSerialized(guarded.serialized)
        : buildText(guarded.warningPayload);
    }

    throw new Error(`Unknown tool: ${request.params.name}`);
  });

  const transport = new StdioServerTransport();

  await server.connect(transport);
};
