type GuckLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

type GuckSource = {
  kind: "sdk";
  file?: string;
  line?: number;
};

type GuckEvent = {
  id: string;
  ts: string;
  level: GuckLevel;
  type: string;
  service: string;
  run_id: string;
  session_id?: string;
  message?: string;
  data?: Record<string, unknown>;
  tags?: Record<string, string>;
  trace_id?: string;
  span_id?: string;
  source?: GuckSource;
};

type BrowserClientOptions = {
  endpoint: string;
  service?: string;
  sessionId?: string;
  runId?: string;
  tags?: Record<string, string>;
  headers?: Record<string, string>;
  enabled?: boolean;
  keepalive?: boolean;
  fetch?: typeof fetch;
  onError?: (error: unknown) => void;
};

type AutoCaptureOptions = {
  captureConsole?: boolean;
  captureErrors?: boolean;
};

type BrowserClient = {
  emit: (event: Partial<GuckEvent>) => Promise<void>;
  installAutoCapture: (opts?: AutoCaptureOptions) => { stop: () => void };
};

type ConsoleMethod = "log" | "info" | "warn" | "error" | "debug" | "trace";

type ErrorPayload = {
  name?: string;
  message?: string;
  stack?: string;
};

const normalizeLevel = (level?: string): GuckLevel => {
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

const randomId = (): string => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `guck-${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
};

const serializeError = (value: unknown): ErrorPayload | undefined => {
  if (!value) {
    return undefined;
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return {
      name: typeof record.name === "string" ? record.name : undefined,
      message: typeof record.message === "string" ? record.message : undefined,
      stack: typeof record.stack === "string" ? record.stack : undefined,
    };
  }
  return { message: String(value) };
};

const toSerializable = (value: unknown, seen: WeakSet<object>): unknown => {
  if (value === null || value === undefined) {
    return value;
  }
  if (value instanceof Error) {
    return serializeError(value);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "function") {
    return `[Function${value.name ? ` ${value.name}` : ""}]`;
  }
  if (typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((entry) => toSerializable(entry, seen));
  }
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = toSerializable(entry, seen);
  }
  return output;
};

const formatArg = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Error) {
    return value.stack ?? value.message;
  }
  try {
    return JSON.stringify(toSerializable(value, new WeakSet<object>())) ?? "";
  } catch {
    return String(value);
  }
};

const formatArgs = (args: unknown[]): string => {
  if (!args.length) {
    return "";
  }
  return args.map((arg) => formatArg(arg)).join(" ");
};

const mapConsoleLevel = (method: ConsoleMethod): GuckLevel => {
  switch (method) {
    case "trace":
      return "trace";
    case "debug":
      return "debug";
    case "warn":
      return "warn";
    case "error":
      return "error";
    case "info":
    case "log":
    default:
      return "info";
  }
};

const isDevHost = (hostname?: string): boolean => {
  if (!hostname) {
    return false;
  }
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname.startsWith("local.") ||
    hostname.endsWith(".local")
  );
};

const isDevEndpoint = (endpoint: string): boolean => {
  try {
    const url = new URL(endpoint);
    return isDevHost(url.hostname);
  } catch {
    return false;
  }
};

const isProdBuild = (): boolean => {
  const globalProcess = (
    globalThis as { process?: { env?: Record<string, string | undefined> } }
  ).process;
  const nodeEnv = globalProcess?.env?.NODE_ENV;
  if (typeof nodeEnv === "string") {
    return nodeEnv === "production";
  }
  const meta =
    typeof import.meta !== "undefined"
      ? (import.meta as { env?: Record<string, unknown> }).env
      : undefined;
  if (meta && typeof meta.PROD === "boolean") {
    return meta.PROD;
  }
  if (meta && typeof meta.MODE === "string") {
    return meta.MODE === "production";
  }
  return false;
};

export const createBrowserClient = (options: BrowserClientOptions): BrowserClient => {
  if (!options?.endpoint) {
    throw new Error("[guck] endpoint is required");
  }
  if (isProdBuild()) {
    throw new Error("[guck] browser SDK is development-only");
  }
  const endpoint = options.endpoint;
  const service = options.service ?? "guck";
  const sessionId = options.sessionId;
  const runId = options.runId ?? randomId();
  const tags = options.tags;
  const headers = options.headers ?? {};
  const devHost = isDevEndpoint(endpoint);
  const enabled = devHost && (options.enabled ?? true);
  const keepalive = options.keepalive ?? true;
  const fetcher = options.fetch ?? fetch;
  const onError = options.onError;

  const emit = async (input: Partial<GuckEvent>): Promise<void> => {
    if (!enabled) {
      return;
    }
    const event: GuckEvent = {
      id: input.id ?? randomId(),
      ts: input.ts ?? new Date().toISOString(),
      level: normalizeLevel(input.level),
      type: input.type ?? "log",
      service: input.service ?? service,
      run_id: input.run_id ?? runId,
      session_id: input.session_id ?? sessionId,
      message: input.message,
      data: input.data,
      tags: input.tags ?? tags,
      trace_id: input.trace_id,
      span_id: input.span_id,
      source: input.source ?? { kind: "sdk" },
    };

    const requestHeaders: Record<string, string> = {
      "content-type": "application/json",
      ...headers,
    };

    const response = await fetcher(endpoint, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify(event),
      keepalive,
    });

    if (!response.ok) {
      throw new Error(`[guck] HTTP ${response.status} ${response.statusText}`);
    }
  };

  const installAutoCapture = (opts: AutoCaptureOptions = {}): { stop: () => void } => {
    const captureConsole = opts.captureConsole ?? true;
    const captureErrors = opts.captureErrors ?? true;
    const targetWindow = typeof window === "undefined" ? undefined : window;

    if (!captureConsole && !captureErrors) {
      return { stop: () => {} };
    }

    const originals: Partial<Record<ConsoleMethod, (...args: unknown[]) => void>> = {};
    const listeners: Array<() => void> = [];

    let suppressConsoleCapture = false;
    const safeEmit = (payload: Partial<GuckEvent>) => {
      void emit(payload).catch((error) => {
        if (onError) {
          suppressConsoleCapture = true;
          try {
            onError(error);
          } finally {
            suppressConsoleCapture = false;
          }
        }
      });
    };

    if (captureConsole) {
      const methods: ConsoleMethod[] = ["log", "info", "warn", "error", "debug", "trace"];
      for (const method of methods) {
        const original = console[method];
        originals[method] = original;
        console[method] = (...args: unknown[]) => {
          original.apply(console, args);
          if (suppressConsoleCapture) {
            return;
          }
          safeEmit({
            type: "console",
            level: mapConsoleLevel(method),
            message: formatArgs(args),
            data: { args: args.map((arg) => toSerializable(arg, new WeakSet<object>())) },
          });
        };
      }
    }

    if (captureErrors && targetWindow) {
      const errorListener = (event: ErrorEvent) => {
        const message = event.message || event.error?.message || "";
        const source: GuckSource = {
          kind: "sdk",
          file: event.filename || undefined,
          line: typeof event.lineno === "number" ? event.lineno : undefined,
        };
        safeEmit({
          type: "window.error",
          level: "error",
          message,
          source,
          data: {
            filename: event.filename || undefined,
            lineno: typeof event.lineno === "number" ? event.lineno : undefined,
            colno: typeof event.colno === "number" ? event.colno : undefined,
            error: serializeError(event.error),
          },
        });
      };
      targetWindow.addEventListener("error", errorListener);
      listeners.push(() => targetWindow.removeEventListener("error", errorListener));

      const rejectionListener = (event: PromiseRejectionEvent) => {
        const reason = event.reason;
        const message =
          typeof reason === "string"
            ? reason
            : reason instanceof Error
              ? reason.message
              : formatArg(reason);
        safeEmit({
          type: "unhandledrejection",
          level: "error",
          message,
          data: {
            reason: toSerializable(reason, new WeakSet<object>()),
          },
        });
      };
      targetWindow.addEventListener("unhandledrejection", rejectionListener);
      listeners.push(() => targetWindow.removeEventListener("unhandledrejection", rejectionListener));
    }

    const stop = () => {
      for (const method of Object.keys(originals) as ConsoleMethod[]) {
        const original = originals[method];
        if (original) {
          console[method] = original;
        }
      }
      for (const remove of listeners) {
        remove();
      }
    };

    return { stop };
  };

  return { emit, installAutoCapture };
};

export type { GuckEvent, GuckLevel, BrowserClientOptions, AutoCaptureOptions, BrowserClient };
