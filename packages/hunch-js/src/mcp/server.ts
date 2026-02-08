import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, resolveStoreDir } from "../config.js";
import { redactEvent } from "../redact.js";
import {
  HunchSearchParams,
  HunchSessionsParams,
  HunchStatsParams,
  HunchTailParams,
} from "../schema.js";
import {
  listSessions,
  searchEvents,
  statsEvents,
} from "../store/file-store.js";

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

export const startMcpServer = async (): Promise<void> => {
  const server = new Server(
    {
      name: "hunch",
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
          name: "hunch.search",
          description: "Search telemetry events with filters.",
          inputSchema: SEARCH_SCHEMA,
        },
        {
          name: "hunch.stats",
          description: "Aggregate telemetry counts by type/level/stage.",
          inputSchema: STATS_SCHEMA,
        },
        {
          name: "hunch.sessions",
          description: "List recent sessions and error counts.",
          inputSchema: SESSIONS_SCHEMA,
        },
        {
          name: "hunch.tail",
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
          "Hunch is disabled. Create .hunch.json or set HUNCH_ENABLED=true/HUNCH_CONFIG.",
      });
    }
    const storeDir = resolveStoreDir(config, rootDir);

    if (request.params.name === "hunch.search") {
      const input = (request.params.arguments ?? {}) as HunchSearchParams;
      const { config_path: _configPath, ...filters } = input;
      const withDefaults: HunchSearchParams = {
        ...filters,
        since: filters.since ?? `${config.mcp.default_lookback_ms}ms`,
      };
      const result = await searchEvents(storeDir, config, withDefaults);
      const redacted = result.events.map((event) => redactEvent(config, event));
      return buildText({ ...result, events: redacted });
    }

    if (request.params.name === "hunch.stats") {
      const input = (request.params.arguments ?? {}) as HunchStatsParams;
      const { config_path: _configPath, ...filters } = input;
      const withDefaults: HunchStatsParams = {
        ...filters,
        since: filters.since ?? `${config.mcp.default_lookback_ms}ms`,
      };
      const result = await statsEvents(storeDir, config, withDefaults);
      return buildText(result);
    }

    if (request.params.name === "hunch.sessions") {
      const input = (request.params.arguments ?? {}) as HunchSessionsParams;
      const { config_path: _configPath, ...filters } = input;
      const withDefaults: HunchSessionsParams = {
        ...filters,
        since: filters.since ?? `${config.mcp.default_lookback_ms}ms`,
      };
      const result = await listSessions(storeDir, config, withDefaults);
      return buildText(result);
    }

    if (request.params.name === "hunch.tail") {
      const input = (request.params.arguments ?? {}) as HunchTailParams;
      const { config_path: _configPath, ...filters } = input;
      const limit = input.limit ?? Math.min(config.mcp.max_results, 50);
      const result = await searchEvents(storeDir, config, {
        service: filters.service,
        session_id: filters.session_id,
        run_id: filters.run_id,
        limit: config.mcp.max_results,
      });

      const sorted = result.events
        .map((event) => ({ event, ts: Date.parse(event.ts) }))
        .sort((a, b) => {
          const aTs = Number.isNaN(a.ts) ? 0 : a.ts;
          const bTs = Number.isNaN(b.ts) ? 0 : b.ts;
          return aTs - bTs;
        })
        .slice(-limit)
        .map(({ event }) => redactEvent(config, event));

      return buildText({ events: sorted, truncated: result.truncated });
    }

    throw new Error(`Unknown tool: ${request.params.name}`);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
};
