import type { Plugin, ViteDevServer } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Buffer } from "node:buffer";
import {
  appendEvent,
  buildEvent,
  GuckEvent,
  loadConfig,
  redactEvent,
  resolveStoreDir,
} from "@guckdev/core";

export type GuckVitePluginOptions = {
  configPath?: string;
  path?: string;
  enabled?: boolean;
};

const DEFAULT_PATH = "/guck/emit";
const DEFAULT_MAX_BODY_BYTES = 512000;

const applyCors = (res: ServerResponse): void => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
};

const writeJson = (res: ServerResponse, status: number, payload: unknown): void => {
  applyCors(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
};

const readBody = async (
  req: IncomingMessage,
  maxBodyBytes: number,
): Promise<{ ok: true; data: string } | { ok: false; error: "too_large" | "aborted" }> => {
  return await new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    let settled = false;

    const finish = (result: { ok: true; data: string } | { ok: false; error: "too_large" | "aborted" }) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    req.on("data", (chunk) => {
      if (settled) {
        return;
      }
      size += chunk.length;
      if (size > maxBodyBytes) {
        tooLarge = true;
      }
      if (!tooLarge) {
        chunks.push(Buffer.from(chunk));
      }
    });

    req.on("aborted", () => finish({ ok: false, error: "aborted" }));
    req.on("error", () => finish({ ok: false, error: "aborted" }));
    req.on("end", () => {
      if (settled) {
        return;
      }
      if (tooLarge) {
        finish({ ok: false, error: "too_large" });
        return;
      }
      finish({ ok: true, data: Buffer.concat(chunks).toString("utf8") });
    });
  });
};

const coerceItems = (payload: unknown): Array<Partial<GuckEvent>> | null => {
  if (Array.isArray(payload)) {
    const items: Array<Partial<GuckEvent>> = [];
    for (const item of payload) {
      if (!item || typeof item !== "object") {
        return null;
      }
      items.push(item as Partial<GuckEvent>);
    }
    return items;
  }
  if (payload && typeof payload === "object") {
    return [payload as Partial<GuckEvent>];
  }
  return null;
};

export const guckVitePlugin = (options: GuckVitePluginOptions = {}): Plugin => {
  const configPath = options.configPath ?? process.cwd();
  const routePath = options.path ?? DEFAULT_PATH;
  const enabled = options.enabled ?? true;

  return {
    name: "guck-vite",
    apply: "serve",
    configureServer(server: ViteDevServer) {
      if (!enabled) {
        return;
      }
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? "", "http://localhost");
        if (url.pathname !== routePath) {
          next();
          return;
        }

        if (req.method === "OPTIONS") {
          applyCors(res);
          res.statusCode = 204;
          res.end();
          return;
        }

        if (req.method !== "POST") {
          applyCors(res);
          res.statusCode = 404;
          res.end();
          return;
        }

        const { config, rootDir } = loadConfig({ configPath });
        if (!config.enabled) {
          writeJson(res, 403, { ok: false, error: "Guck disabled" });
          return;
        }

        const body = await readBody(req, DEFAULT_MAX_BODY_BYTES);
        if (!body.ok) {
          if (body.error === "too_large") {
            writeJson(res, 413, { ok: false, error: "Payload too large" });
            return;
          }
          writeJson(res, 400, { ok: false, error: "Request aborted" });
          return;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(body.data);
        } catch {
          writeJson(res, 400, { ok: false, error: "Invalid JSON" });
          return;
        }

        const items = coerceItems(parsed);
        if (!items) {
          writeJson(res, 400, { ok: false, error: "Invalid event payload" });
          return;
        }

        const storeDir = resolveStoreDir(config, rootDir);
        try {
          for (const item of items) {
            const event = buildEvent(item, { service: config.default_service });
            const redacted = redactEvent(config, event);
            await appendEvent(storeDir, redacted);
          }
        } catch {
          writeJson(res, 500, { ok: false, error: "Failed to write event" });
          return;
        }

        writeJson(res, 200, { ok: true, count: items.length });
      });
    },
  };
};
