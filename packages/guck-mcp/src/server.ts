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

const CONFIG_PATH_DESCRIPTION =
  "Path to .guck.json or a directory containing it. Relative paths resolve against the MCP server pwd; prefer absolute paths to avoid mismatch.";

const COMPACT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    s: { type: "string", description: "service" },
    sid: { type: "string", description: "session_id" },
    rid: { type: "string", description: "run_id" },
    ty: { type: "array", items: { type: "string" }, description: "types" },
    lv: { type: "array", items: { type: "string" }, description: "levels" },
    cn: { type: "string", description: "contains" },
    q: { type: "string", description: "query" },
    since: { type: "string", description: "since" },
    until: { type: "string", description: "until" },
    lim: { type: "number", description: "limit" },
    fmt: { type: "string", enum: ["json", "text"], description: "format" },
    flds: { type: "array", items: { type: "string" }, description: "fields" },
    tpl: { type: "string", description: "template" },
    b: { type: "array", items: { type: "string" }, description: "backends" },
    cfg: { type: "string", description: "config_path" },
  },
} as const;

const SEARCH_SCHEMA = {
  type: "object",
  description:
    "Search telemetry events. All filters are combined with AND; query is a message-only boolean expression applied after other filters. Output is capped by mcp.max_output_chars; if exceeded, a warning is returned unless force=true. Use max_message_chars to trim message per event; warnings include avg/max message length.",
  additionalProperties: false,
  properties: {
    compact: {
      ...COMPACT_SCHEMA,
      description:
        "Compact short-key input. Canonical fields override compact values. When compact is present, defaults to format=text and template={ts}|{service}|{message} unless overridden.",
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
    config_path: {
      type: "string",
      description: CONFIG_PATH_DESCRIPTION,
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
    compact: {
      ...COMPACT_SCHEMA,
      description:
        "Compact short-key input. Canonical fields override compact values. When compact is present, defaults to format=text and template={ts}|{service}|{message} unless overridden.",
    },
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
    common: {
      ...SEARCH_ITEM_SCHEMA,
      description:
        "Defaults applied to each search. Individual searches override common values.",
    },
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
      description: CONFIG_PATH_DESCRIPTION,
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
      description: CONFIG_PATH_DESCRIPTION,
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
      description: CONFIG_PATH_DESCRIPTION,
    },
  },
} as const;

const TAIL_SCHEMA = {
  type: "object",
  description:
    "Return recent events. Output is capped by mcp.max_output_chars; if exceeded, a warning is returned unless force=true. Use max_message_chars to trim message per event; warnings include avg/max message length.",
  additionalProperties: false,
  properties: {
    compact: {
      ...COMPACT_SCHEMA,
      description:
        "Compact short-key input. Canonical fields override compact values. When compact is present, defaults to format=text and template={ts}|{service}|{message} unless overridden.",
    },
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
      description: CONFIG_PATH_DESCRIPTION,
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
      return `${String(config.mcp.default_lookback_ms)}ms`;
    }
    return input;
  }
  if (checkpointMs !== undefined) {
    return new Date(checkpointMs).toISOString();
  }
  return `${String(config.mcp.default_lookback_ms)}ms`;
};

type CompactParams = {
  s?: string;
  sid?: string;
  rid?: string;
  ty?: string[];
  lv?: string[];
  cn?: string;
  q?: string;
  since?: string;
  until?: string;
  lim?: number;
  fmt?: "json" | "text";
  flds?: string[];
  tpl?: string;
  b?: string[];
  cfg?: string;
};

const DEFAULT_COMPACT_TEMPLATE = "{ts}|{service}|{message}";

const stripUndefined = <T extends Record<string, unknown>>(value: T): Partial<T> => {
  const entries = Object.entries(value).filter(([, entry]) => entry !== undefined);
  return Object.fromEntries(entries) as Partial<T>;
};

const mapCompactParams = (
  compact?: CompactParams,
): Partial<GuckSearchParams> & { config_path?: string } => {
  if (!compact) {
    return {};
  }
  return stripUndefined({
    service: compact.s,
    session_id: compact.sid,
    run_id: compact.rid,
    types: compact.ty,
    levels: compact.lv,
    contains: compact.cn,
    query: compact.q,
    since: compact.since,
    until: compact.until,
    limit: compact.lim,
    format: compact.fmt,
    fields: compact.flds,
    template: compact.tpl,
    backends: compact.b,
    config_path: compact.cfg,
  });
};

const expandCompactParams = <T extends Record<string, unknown>>(
  input: T & { compact?: CompactParams },
): {
  params: Omit<T, "compact"> & Partial<GuckSearchParams> & { config_path?: string };
  usedCompact: boolean;
} => {
  const { compact, ...rest } = input;
  const mapped = mapCompactParams(compact);
  return {
    params: { ...mapped, ...rest },
    usedCompact: compact !== undefined,
  };
};

const applyCompactDefaults = <T extends { format?: "json" | "text"; template?: string }>(
  params: T,
  usedCompact: boolean,
): T => {
  if (!usedCompact) {
    return params;
  }
  const withDefaults = { ...params };
  if (!withDefaults.format) {
    withDefaults.format = "text";
  }
  if (withDefaults.format === "text" && !withDefaults.template) {
    withDefaults.template = DEFAULT_COMPACT_TEMPLATE;
  }
  return withDefaults;
};

const readCompactConfigPath = (value: unknown): string | undefined => {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const cfg = (value as { cfg?: unknown }).cfg;
  return typeof cfg === "string" ? cfg : undefined;
};

const resolveConfigPath = (
  toolName: string,
  args: Record<string, unknown>,
): string | undefined => {
  if (typeof args.config_path === "string") {
    return args.config_path;
  }
  if (toolName === "guck.search" || toolName === "guck.tail") {
    return readCompactConfigPath(args.compact);
  }
  if (toolName === "guck.search_batch") {
    const common = args.common;
    if (common && typeof common === "object") {
      const compact = (common as { compact?: unknown }).compact;
      const fromCommon = readCompactConfigPath(compact);
      if (fromCommon) {
        return fromCommon;
      }
    }
  }
  return undefined;
};

type McpServerOptions = {
  configPath?: string;
};

export const startMcpServer = async (options: McpServerOptions = {}): Promise<void> => {
  if (options.configPath && !process.env.GUCK_CONFIG && !process.env.GUCK_CONFIG_PATH) {
    process.env.GUCK_CONFIG_PATH = options.configPath;
  }
  // eslint-disable-next-line @typescript-eslint/no-deprecated
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

  server.setRequestHandler(ListToolsRequestSchema, () => {
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
    const rawArgs = (request.params.arguments ?? {}) as Record<string, unknown>;
    const configPath = resolveConfigPath(request.params.name, rawArgs);
    const { config, rootDir } = loadConfig({ configPath });
    if (!config.enabled) {
      return buildText({
        error:
          "Guck is disabled. Create .guck.json or set GUCK_ENABLED=true/GUCK_CONFIG_PATH.",
      });
    }
    const storeDir = resolveStoreDir(config, rootDir);

    if (request.params.name === "guck.search") {
      const input = (request.params.arguments ?? {}) as GuckSearchParams & {
        compact?: CompactParams;
      };
      const { params, usedCompact } = expandCompactParams(input);
      const { config_path: _configPath, ...filters } = params;
      void _configPath;
      const withDefaults = applyCompactDefaults(
        {
          ...filters,
          since: resolveSince(filters.since, config, storeDir),
        },
        usedCompact,
      );
      try {
        const result = await readSearch(config, rootDir, withDefaults);
        const maxMessageChars = resolveMaxChars(
          withDefaults.max_message_chars,
          config.mcp.max_message_chars,
        );
        const maxOutputChars = resolveMaxChars(
          withDefaults.max_output_chars,
          config.mcp.max_output_chars,
        );
        const redacted = result.events.map((event) => redactEvent(config, event));
        const messageStats = computeMessageStats(redacted);
        const trimmed = trimEventsMessages(redacted, {
          maxChars: maxMessageChars,
          match: withDefaults.contains,
        });
        if (withDefaults.format === "text") {
          const lines = trimmed.map((event) =>
            formatEventText(event, withDefaults.template),
          );
          const payload = {
            format: "text",
            lines,
            truncated: result.truncated,
            errors: result.errors,
          };
          const guarded = guardPayload({
            payload,
            maxChars: maxOutputChars ?? Number.POSITIVE_INFINITY,
            force: withDefaults.force,
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
        if (withDefaults.fields && withDefaults.fields.length > 0) {
          const projected = trimmed.map((event) =>
            projectEventFields(event, withDefaults.fields ?? [], {
              flatten: withDefaults.flatten,
            }),
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
            force: withDefaults.force,
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
          force: withDefaults.force,
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
          return buildText({ error: error.message, query: withDefaults.query });
        }
        throw error;
      }
    }

    if (request.params.name === "guck.search_batch") {
      const input = (request.params.arguments ?? {}) as {
        searches?: Array<GuckSearchParams & { id?: string; compact?: CompactParams }>;
        common?: GuckSearchParams & { compact?: CompactParams };
        force?: boolean;
        config_path?: string;
      };
      const { params: commonParams, usedCompact: commonUsedCompact } = input.common
        ? expandCompactParams(input.common)
        : { params: {}, usedCompact: false };
      const { id: _commonId, config_path: _commonConfigPath, ...commonFilters } =
        commonParams as Partial<GuckSearchParams> & { id?: string; config_path?: string };
      void _commonId;
      void _commonConfigPath;
      const searches = input.searches ?? [];
      const results = await Promise.all(
        searches.map(async (search) => {
          const { params: searchParams, usedCompact: searchUsedCompact } =
            expandCompactParams(search);
          const { id, config_path: _configPath, force: _force, ...filters } =
            searchParams as GuckSearchParams & { id?: string; force?: boolean };
          void _configPath;
          void _force;
          const mergedFilters: GuckSearchParams = {
            ...commonFilters,
            ...filters,
          };
          const withDefaults = applyCompactDefaults(
            {
              ...mergedFilters,
              since: resolveSince(mergedFilters.since, config, storeDir),
            },
            commonUsedCompact || searchUsedCompact,
          );
          try {
            const result = await readSearch(config, rootDir, withDefaults);
            const maxMessageChars = resolveMaxChars(
              withDefaults.max_message_chars,
              config.mcp.max_message_chars,
            );
            const maxOutputChars = resolveMaxChars(
              withDefaults.max_output_chars,
              config.mcp.max_output_chars,
            );
            const redacted = result.events.map((event) => redactEvent(config, event));
            const messageStats = computeMessageStats(redacted);
            const trimmed = trimEventsMessages(redacted, {
              maxChars: maxMessageChars,
              match: withDefaults.contains,
            });
            if (withDefaults.format === "text") {
              const lines = trimmed.map((event) =>
                formatEventText(event, withDefaults.template),
              );
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
            if (withDefaults.fields && withDefaults.fields.length > 0) {
              const projected = trimmed.map((event) =>
                projectEventFields(event, withDefaults.fields ?? [], {
                  flatten: withDefaults.flatten,
                }),
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
              return { id, error: error.message, query: withDefaults.query };
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
      void _configPath;
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
      void _configPath;
      const withDefaults: GuckSessionsParams = {
        ...filters,
        since: resolveSince(filters.since, config, storeDir),
      };
      const result = await readSessions(config, rootDir, withDefaults);
      return buildText(result);
    }

    if (request.params.name === "guck.tail") {
      const input = (request.params.arguments ?? {}) as GuckTailParams & {
        compact?: CompactParams;
      };
      const { params, usedCompact } = expandCompactParams(input);
      const { config_path: _configPath, ...filters } = params;
      void _configPath;
      const withDefaults = applyCompactDefaults(filters, usedCompact);
      const limit = withDefaults.limit ?? Math.min(config.mcp.max_results, 50);
      const since = resolveSince(undefined, config, storeDir);
      let result;
      try {
        result = await readTail(config, rootDir, {
          service: withDefaults.service,
          session_id: withDefaults.session_id,
          run_id: withDefaults.run_id,
          query: withDefaults.query,
          limit,
          backends: withDefaults.backends,
          since,
        });
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("Invalid query:")) {
          return buildText({ error: error.message, query: withDefaults.query });
        }
        throw error;
      }
      const maxMessageChars = resolveMaxChars(
        withDefaults.max_message_chars,
        config.mcp.max_message_chars,
      );
      const maxOutputChars = resolveMaxChars(
        withDefaults.max_output_chars,
        config.mcp.max_output_chars,
      );
      const redacted = result.events.map((event) => redactEvent(config, event));
      const messageStats = computeMessageStats(redacted);
      const trimmed = trimEventsMessages(redacted, {
        maxChars: maxMessageChars,
      });
      if (withDefaults.format === "text") {
        const lines = trimmed.map((event) =>
          formatEventText(event, withDefaults.template),
        );
        const payload = {
          format: "text",
          lines,
          truncated: result.truncated,
          errors: result.errors,
        };
        const guarded = guardPayload({
          payload,
          maxChars: maxOutputChars ?? Number.POSITIVE_INFINITY,
          force: withDefaults.force,
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
      if (withDefaults.fields && withDefaults.fields.length > 0) {
        const projected = trimmed.map((event) =>
          projectEventFields(event, withDefaults.fields ?? [], {
            flatten: withDefaults.flatten,
          }),
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
          force: withDefaults.force,
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
        force: withDefaults.force,
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
