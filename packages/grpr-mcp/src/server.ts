import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  GrprConfig,
  GrprSearchParams,
  GrprSessionsParams,
  GrprStatsParams,
  GrprTailParams,
  loadConfig,
  readCheckpoint,
  redactEvent,
  resolveStoreDir,
  readSearch,
  readSessions,
  readStats,
  readTail,
} from "grpr-core";

const SEARCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    service: { type: "string" },
    session_id: { type: "string" },
    run_id: { type: "string" },
    types: { type: "array", items: { type: "string" } },
    levels: { type: "array", items: { type: "string" } },
    contains: { type: "string" },
    since: { type: "string" },
    until: { type: "string" },
    limit: { type: "number" },
    backends: { type: "array", items: { type: "string" } },
    config_path: { type: "string" },
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
  config: GrprConfig,
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
      name: "grpr",
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
          name: "grpr.search",
          description: "Search telemetry events with filters.",
          inputSchema: SEARCH_SCHEMA,
        },
        {
          name: "grpr.stats",
          description: "Aggregate telemetry counts by type/level/stage.",
          inputSchema: STATS_SCHEMA,
        },
        {
          name: "grpr.sessions",
          description: "List recent sessions and error counts.",
          inputSchema: SESSIONS_SCHEMA,
        },
        {
          name: "grpr.tail",
          description: "Return the most recent events (non-streaming).",
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
          "Grpr is disabled. Create .grpr.json or set GRPR_ENABLED=true/GRPR_CONFIG_PATH.",
      });
    }
    const storeDir = resolveStoreDir(config, rootDir);

    if (request.params.name === "grpr.search") {
      const input = (request.params.arguments ?? {}) as GrprSearchParams;
      const { config_path: _configPath, ...filters } = input;
      const withDefaults: GrprSearchParams = {
        ...filters,
        since: resolveSince(filters.since, config, storeDir),
      };
      const result = await readSearch(config, rootDir, withDefaults);
      const redacted = result.events.map((event) => redactEvent(config, event));
      return buildText({ ...result, events: redacted });
    }

    if (request.params.name === "grpr.stats") {
      const input = (request.params.arguments ?? {}) as GrprStatsParams;
      const { config_path: _configPath, ...filters } = input;
      const withDefaults: GrprStatsParams = {
        ...filters,
        since: resolveSince(filters.since, config, storeDir),
      };
      const result = await readStats(config, rootDir, withDefaults);
      return buildText(result);
    }

    if (request.params.name === "grpr.sessions") {
      const input = (request.params.arguments ?? {}) as GrprSessionsParams;
      const { config_path: _configPath, ...filters } = input;
      const withDefaults: GrprSessionsParams = {
        ...filters,
        since: resolveSince(filters.since, config, storeDir),
      };
      const result = await readSessions(config, rootDir, withDefaults);
      return buildText(result);
    }

    if (request.params.name === "grpr.tail") {
      const input = (request.params.arguments ?? {}) as GrprTailParams;
      const { config_path: _configPath, ...filters } = input;
      const limit = input.limit ?? Math.min(config.mcp.max_results, 50);
      const since = resolveSince(undefined, config, storeDir);
      const result = await readTail(config, rootDir, {
        service: filters.service,
        session_id: filters.session_id,
        run_id: filters.run_id,
        limit,
        backends: filters.backends,
        since,
      });
      const redacted = result.events.map((event) => redactEvent(config, event));
      return buildText({ ...result, events: redacted });
    }

    throw new Error(`Unknown tool: ${request.params.name}`);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
};
