import {
  appendEvent,
  buildEvent,
  GuckEvent,
  loadConfig,
  redactEvent,
  resolveStoreDir,
} from "@guckdev/core";

let cached:
  | {
      storeDir: string;
      config: ReturnType<typeof loadConfig>["config"];
    }
  | undefined;

let writeDisabled = false;
let warned = false;

const isWriteError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") {
    return false;
  }
  const code = (error as { code?: string }).code;
  return code === "EACCES" || code === "EPERM" || code === "EROFS";
};

const warnOnce = (message: string): void => {
  if (warned) {
    return;
  }
  warned = true;
  process.stderr.write(`${message}\n`);
};

const getCached = () => {
  if (cached) {
    return cached;
  }
  const loaded = loadConfig();
  const storeDir = resolveStoreDir(loaded.config, loaded.rootDir);
  cached = { storeDir, config: loaded.config };
  return cached;
};

export const emit = async (input: Partial<GuckEvent>): Promise<void> => {
  if (writeDisabled) {
    return;
  }
  const { storeDir, config } = getCached();
  if (!config.enabled) {
    return;
  }
  const event = buildEvent(input, { service: config.default_service });
  const redacted = redactEvent(config, event);
  try {
    await appendEvent(storeDir, redacted);
  } catch (error) {
    if (process.env.GUCK_STRICT_WRITE_ERRORS === "1") {
      throw error;
    }
    if (isWriteError(error)) {
      writeDisabled = true;
      warnOnce(
        "[guck] write disabled (permission error); set GUCK_STRICT_WRITE_ERRORS=1 to fail hard",
      );
      return;
    }
    throw error;
  }
};
