import { emit } from "./emit.js";
import { GrprEvent, loadConfig } from "grpr-core";

type StopHandle = { stop: () => void };

type WriteTarget = {
  stream: NodeJS.WriteStream;
  type: "stdout" | "stderr";
  level: GrprEvent["level"];
};

type WriteFn = typeof process.stdout.write;

type CaptureState = {
  stop: () => void;
};

let installed: CaptureState | null = null;

const shouldCapture = (): boolean => {
  if (process.env.GRPR_WRAPPED === "1") {
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
  const original = target.stream.write.bind(target.stream);
  const patched: WriteFn = (chunk: any, encoding?: any, cb?: any) => {
    const result = original(chunk, encoding as any, cb as any);
    const resolvedEncoding: BufferEncoding =
      typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8";
    const text = Buffer.isBuffer(chunk)
      ? chunk.toString(resolvedEncoding)
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

  const beforeExit = () => flush();

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
