import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GuckConfig } from "./schema.js";

const DEFAULT_CONFIG: GuckConfig = {
  version: 1,
  enabled: true,
  default_service: "guck",
  sdk: {
    enabled: true,
    capture_stdout: true,
    capture_stderr: true,
  },
  read: {
    backend: "local",
  },
  redaction: {
    enabled: true,
    keys: ["authorization", "api_key", "token", "secret", "password"],
    patterns: ["sk-[A-Za-z0-9]{20,}", "Bearer\\s+[A-Za-z0-9._-]+"],
  },
  mcp: {
    max_results: 200,
    default_lookback_ms: 300000,
    max_output_chars: 20000,
    max_message_chars: 0,
  },
};

const DEFAULT_STORE_DIR = path.join(os.homedir(), ".guck", "logs");

export type LoadedConfig = {
  rootDir: string;
  configPath?: string;
  localConfigPath?: string;
  config: GuckConfig;
};

const readJsonFile = (filePath: string): unknown => {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const isDirectory = (filePath: string): boolean => {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
};

const isDirOrFile = (filePath: string): boolean => {
  try {
    fs.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
};

export const findRepoRoot = (startDir: string): string => {
  let current = path.resolve(startDir);
  while (true) {
    if (isDirOrFile(path.join(current, ".git"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return startDir;
    }
    current = parent;
  }
};

const mergeSdkConfig = (
  base: GuckConfig["sdk"],
  override?: Partial<GuckConfig["sdk"]>,
): GuckConfig["sdk"] => {
  return {
    ...base,
    ...(override ?? {}),
  };
};

const mergeConfig = (base: GuckConfig, override: Partial<GuckConfig>): GuckConfig => {
  const overrideRest = {
    ...(override as Partial<GuckConfig> & { store_dir?: string }),
  };
  delete overrideRest.store_dir;
  const mergedMcp = {
    ...base.mcp,
    ...(overrideRest.mcp ?? {}),
  } as GuckConfig["mcp"] & { http?: unknown };
  if ("http" in mergedMcp) {
    delete mergedMcp.http;
  }
  return {
    ...base,
    ...overrideRest,
    sdk: mergeSdkConfig(base.sdk, override.sdk),
    read: {
      ...(base.read ?? { backend: "local" }),
      ...(overrideRest.read ?? {}),
      backends: overrideRest.read?.backends ?? base.read?.backends,
    },
    redaction: {
      ...base.redaction,
      ...(overrideRest.redaction ?? {}),
    },
    mcp: mergedMcp,
  };
};

const parseBool = (value: string | undefined): boolean | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  return undefined;
};

type LoadConfigOptions = {
  cwd?: string;
  configPath?: string;
};

export const loadConfig = (options: LoadConfigOptions = {}): LoadedConfig => {
  const cwd =
    options.cwd ??
    process.env.GUCK_CWD ??
    process.env.INIT_CWD ??
    process.cwd();
  const explicitConfig =
    options.configPath ?? process.env.GUCK_CONFIG ?? process.env.GUCK_CONFIG_PATH;
  let rootDir = findRepoRoot(cwd);
  let configPath = path.join(rootDir, ".guck.json");

  if (explicitConfig) {
    const resolvedConfig = path.isAbsolute(explicitConfig)
      ? explicitConfig
      : path.resolve(cwd, explicitConfig);
    if (isDirectory(resolvedConfig)) {
      rootDir = resolvedConfig;
      configPath = path.join(rootDir, ".guck.json");
    } else {
      rootDir = path.dirname(resolvedConfig);
      configPath = resolvedConfig;
    }
  }
  const configExists = isDirOrFile(configPath);
  const configJson = configExists ? readJsonFile(configPath) : null;

  let config = DEFAULT_CONFIG;

  if (configJson && typeof configJson === "object") {
    config = mergeConfig(config, configJson as Partial<GuckConfig>);
  }

  const envEnabled = parseBool(process.env.GUCK_ENABLED);
  if (envEnabled !== undefined) {
    config = { ...config, enabled: envEnabled };
  }

  if (process.env.GUCK_SERVICE) {
    config = { ...config, default_service: process.env.GUCK_SERVICE };
  }

  return {
    rootDir,
    configPath: configExists ? configPath : undefined,
    localConfigPath: undefined,
    config,
  };
};

export const resolveStoreDir = (_config?: GuckConfig, _rootDir?: string): string => {
  void _config;
  void _rootDir;
  return process.env.GUCK_DIR ?? DEFAULT_STORE_DIR;
};

export const resolveCheckpointPath = (storeDir: string): string => {
  return path.join(storeDir, ".guck-checkpoint");
};

export const readCheckpoint = (storeDir: string): number | undefined => {
  const checkpointPath = resolveCheckpointPath(storeDir);
  if (!isDirOrFile(checkpointPath)) {
    return undefined;
  }
  try {
    const raw = fs.readFileSync(checkpointPath, "utf8").trim();
    if (!raw) {
      return undefined;
    }
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
};

export const getDefaultConfig = (): GuckConfig => DEFAULT_CONFIG;
