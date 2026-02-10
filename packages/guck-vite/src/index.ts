import type { Plugin, ViteDevServer } from "vite";
import { Buffer } from "node:buffer";
import type { IncomingMessage, ServerResponse } from "node:http";

export type GuckVitePluginOptions = {
  ingestUrl?: string;
  configPath?: string;
  path?: string;
  enabled?: boolean;
};

const DEFAULT_INGEST_URL = "http://127.0.0.1:7331/guck/emit";
const DEFAULT_PATH = "/guck/emit";

const applyCors = (res: ServerResponse): void => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
};

const readBody = async (req: IncomingMessage): Promise<Buffer> => {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("aborted", () => reject(new Error("aborted")));
    req.on("error", reject);
  });
};

const readContentType = (req: IncomingMessage): string => {
  const header = req.headers["content-type"];
  if (Array.isArray(header)) {
    return header[0] ?? "application/json";
  }
  return header ?? "application/json";
};

const handleProxy = async (
  req: IncomingMessage,
  res: ServerResponse,
  ingestUrl: string,
  configPath: string,
): Promise<void> => {
  let body: Buffer;
  try {
    body = await readBody(req);
  } catch {
    applyCors(res);
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: "Request aborted" }));
    return;
  }

  try {
    const response = await fetch(ingestUrl, {
      method: "POST",
      headers: {
        "content-type": readContentType(req),
        "x-guck-config-path": configPath,
      },
      body,
    });

    applyCors(res);
    res.statusCode = response.status;
    const contentType = response.headers.get("content-type");
    if (contentType) {
      res.setHeader("Content-Type", contentType);
    }
    const payload = Buffer.from(await response.arrayBuffer());
    res.end(payload);
  } catch {
    applyCors(res);
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: "Upstream unreachable" }));
  }
};

export const guckVitePlugin = (options: GuckVitePluginOptions = {}): Plugin => {
  const ingestUrl = options.ingestUrl ?? DEFAULT_INGEST_URL;
  const configPath = options.configPath ?? process.cwd();
  const path = options.path ?? DEFAULT_PATH;
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
        if (url.pathname !== path) {
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

        await handleProxy(req, res, ingestUrl, configPath);
      });
    },
  };
};
