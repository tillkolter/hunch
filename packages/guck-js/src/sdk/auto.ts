import { emit } from "./emit.js";
import { GuckEvent, loadConfig } from "@guckdev/core";

type StopHandle = { stop: () => void };

type WriteTarget = {
  stream: NodeJS.WriteStream;
  type: "stdout" | "stderr";
  level: GuckEvent["level"];
};

type WriteChunk = string | Uint8Array;
type WriteCallback = (error?: Error | null) => void;
type WriteEncoding = NodeJS.BufferEncoding | WriteCallback;
type WriteFn = (
  chunk: WriteChunk,
  encoding?: WriteEncoding,
  callback?: WriteCallback,
) => boolean;

type CaptureState = {
  stop: () => void;
};

let installed: CaptureState | null = null;

const shouldCapture = (): boolean => {
  if (process.env.GUCK_WRAPPED === "1") {
    return false;
  }
  const { config } = loadConfig();
  if (!config.enabled) {
    return false;
  }
  if (!config.sdk.enabled) {
    return false;
  }
  return config.sdk.capture_stdout || config.sdk.capture_stderr;
};

const flushLine = (target: WriteTarget, line: string): void => {
  if (!line.trim()) {
    return;
  }
  void emit({
    type: target.type,
    level: target.level,
    message: line,
    source: { kind: target.type },
  });
};

const installCaptureFor = (
  target: WriteTarget,
  bufferRef: { value: string },
): WriteFn => {
  const original = target.stream.write.bind(target.stream) as WriteFn;
  const patched: WriteFn = (chunk, encoding, callback) => {
    const resolvedCallback = typeof encoding === "function" ? encoding : callback;
    const resolvedEncoding = typeof encoding === "string" ? encoding : undefined;
    const result = original(chunk, resolvedEncoding, resolvedCallback);
    const textEncoding: NodeJS.BufferEncoding =
      typeof encoding === "string" ? encoding : "utf8";
    const text = Buffer.isBuffer(chunk)
      ? chunk.toString(textEncoding)
      : String(chunk);
    bufferRef.value += text;
    const lines = bufferRef.value.split(/\r?\n/);
    bufferRef.value = lines.pop() ?? "";
    for (const line of lines) {
      flushLine(target, line);
    }
    return result;
  };
  target.stream.write = patched as typeof target.stream.write;
  return original;
};

export const installAutoCapture = (): StopHandle => {
  if (installed) {
    return installed;
  }

  if (!shouldCapture()) {
    const noOp = { stop: () => {} };
    installed = noOp;
    return noOp;
  }

  const buffers = {
    stdout: { value: "" },
    stderr: { value: "" },
  };

  const originals: Partial<Record<"stdout" | "stderr", WriteFn>> = {};

  const { config } = loadConfig();

  if (config.sdk.capture_stdout) {
    originals.stdout = installCaptureFor(
      { stream: process.stdout, type: "stdout", level: "info" },
      buffers.stdout,
    );
  }
  if (config.sdk.capture_stderr) {
    originals.stderr = installCaptureFor(
      { stream: process.stderr, type: "stderr", level: "error" },
      buffers.stderr,
    );
  }

  const flush = () => {
    if (config.sdk.capture_stdout && buffers.stdout.value.trim()) {
      flushLine({ stream: process.stdout, type: "stdout", level: "info" }, buffers.stdout.value);
      buffers.stdout.value = "";
    }
    if (config.sdk.capture_stderr && buffers.stderr.value.trim()) {
      flushLine({ stream: process.stderr, type: "stderr", level: "error" }, buffers.stderr.value);
      buffers.stderr.value = "";
    }
  };

  const beforeExit = (): void => {
    flush();
  };

  process.on("beforeExit", beforeExit);
  process.on("exit", beforeExit);

  const stop = () => {
    flush();
    if (originals.stdout) {
      process.stdout.write = originals.stdout as typeof process.stdout.write;
    }
    if (originals.stderr) {
      process.stderr.write = originals.stderr as typeof process.stderr.write;
    }
    process.off("beforeExit", beforeExit);
    process.off("exit", beforeExit);
    installed = null;
  };

  const handle = { stop };
  installed = handle;
  return handle;
};
