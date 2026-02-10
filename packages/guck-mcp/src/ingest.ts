import http from "node:http";
import { randomUUID } from "node:crypto";
import { appendEvent, GuckConfig, GuckEvent, redactEvent } from "@guckdev/core";

type HttpIngestConfig = {
  port?: number;
  host?: string;
  path?: string;
  max_body_bytes?: number;
};

type HttpIngestRuntime = {
  port: number;
  host: string;
  path: string;
  maxBodyBytes: number;
  config: GuckConfig;
  storeDir: string;
};

type HttpIngestHandle = {
  close: () => Promise<void>;
};

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PATH = "/guck/emit";
const DEFAULT_MAX_BODY_BYTES = 512000;

const normalizeLevel = (level?: string): GuckEvent["level"] => {
  if (!level) {
    return "info";
  }
  const lower = level.toLowerCase();
  if (
    lower === "trace" ||
    lower === "debug" ||
    lower === "info" ||
    lower === "warn" ||
    lower === "error" ||
    lower === "fatal"
  ) {
    return lower;
  }
  return "info";
};

const defaultRunId = process.env.GUCK_RUN_ID ?? randomUUID();
const defaultSessionId = process.env.GUCK_SESSION_ID;

const toEvent = (input: Partial<GuckEvent>, defaults: { service: string }): GuckEvent => {
  const source = input.source
    ? { ...input.source, kind: input.source.kind ?? "sdk" }
    : { kind: "sdk" as const };
  return {
    id: input.id ?? randomUUID(),
    ts: input.ts ?? new Date().toISOString(),
    level: normalizeLevel(input.level),
    type: input.type ?? "log",
    service: input.service ?? defaults.service,
    run_id: input.run_id ?? defaultRunId,
    session_id: input.session_id ?? defaultSessionId,
    message: input.message,
    data: input.data,
    tags: input.tags,
    trace_id: input.trace_id,
    span_id: input.span_id,
    source,
  };
};

const applyCors = (res: http.ServerResponse) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
};

const writeJson = (res: http.ServerResponse, status: number, payload: unknown) => {
  applyCors(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
};

const readBody = async (
  req: http.IncomingMessage,
  maxBodyBytes: number,
): Promise<{ ok: true; data: string } | { ok: false; error: "too_large" } | { ok: false; error: "aborted" }> => {
  return await new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    let settled = false;

    const finish = (result: { ok: true; data: string } | { ok: false; error: "too_large" } | { ok: false; error: "aborted" }) => {
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

export const resolveHttpIngestConfig = (input?: HttpIngestConfig) => {
  return {
    port: input?.port,
    host: input?.host ?? DEFAULT_HOST,
    path: input?.path ?? DEFAULT_PATH,
    maxBodyBytes: input?.max_body_bytes ?? DEFAULT_MAX_BODY_BYTES,
  };
};

export const startHttpIngest = async (options: HttpIngestRuntime): Promise<HttpIngestHandle> => {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${options.host}`);

    if (req.method === "OPTIONS") {
      applyCors(res);
      res.statusCode = 204;
      res.end();
      return;
    }

    if (req.method !== "POST" || url.pathname !== options.path) {
      writeJson(res, 404, { ok: false, error: "Not found" });
      return;
    }

    if (!options.config.enabled) {
      writeJson(res, 403, { ok: false, error: "Guck disabled" });
      return;
    }

    const body = await readBody(req, options.maxBodyBytes);
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

    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of items) {
      if (!item || typeof item !== "object") {
        writeJson(res, 400, { ok: false, error: "Invalid event payload" });
        return;
      }
    }

    try {
      for (const item of items) {
        const event = toEvent(item as Partial<GuckEvent>, {
          service: options.config.default_service,
        });
        const redacted = redactEvent(options.config, event);
        await appendEvent(options.storeDir, redacted);
      }
    } catch (error) {
      writeJson(res, 500, { ok: false, error: "Failed to write event" });
      return;
    }

    writeJson(res, 200, { ok: true, count: items.length });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => resolve());
  });

  return {
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      }),
  };
};

export type { HttpIngestConfig, HttpIngestHandle };
