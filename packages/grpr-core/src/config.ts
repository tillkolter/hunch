import fs from "node:fs";
import path from "node:path";
import { GrprConfig } from "./schema.js";

const DEFAULT_CONFIG: GrprConfig = {
  version: 1,
  enabled: true,
  store_dir: "logs/grpr",
  default_service: "grpr",
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
  },
};

export type LoadedConfig = {
  rootDir: string;
  configPath?: string;
  localConfigPath?: string;
  config: GrprConfig;
};

const readJsonFile = (filePath: string): unknown | null => {
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
  base: GrprConfig["sdk"],
  override?: Partial<GrprConfig["sdk"]>,
): GrprConfig["sdk"] => {
  return {
    ...base,
    ...(override ?? {}),
  };
};

const mergeConfig = (base: GrprConfig, override: Partial<GrprConfig>): GrprConfig => {
  return {
    ...base,
    ...override,
    sdk: mergeSdkConfig(base.sdk, override.sdk),
    read: {
      ...(base.read ?? { backend: "local" }),
      ...(override.read ?? {}),
      backends: override.read?.backends ?? base.read?.backends,
    },
    redaction: {
      ...base.redaction,
      ...(override.redaction ?? {}),
    },
    mcp: {
      ...base.mcp,
      ...(override.mcp ?? {}),
    },
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
    process.env.GRPR_CWD ??
    process.env.INIT_CWD ??
    process.cwd();
  const explicitConfig =
    options.configPath ?? process.env.GRPR_CONFIG ?? process.env.GRPR_CONFIG_PATH;
  let rootDir = findRepoRoot(cwd);
  let configPath = path.join(rootDir, ".grpr.json");

  if (explicitConfig) {
    const resolvedConfig = path.isAbsolute(explicitConfig)
      ? explicitConfig
      : path.resolve(cwd, explicitConfig);
    if (isDirectory(resolvedConfig)) {
      rootDir = resolvedConfig;
      configPath = path.join(rootDir, ".grpr.json");
    } else {
      rootDir = path.dirname(resolvedConfig);
      configPath = resolvedConfig;
    }
  }
  const configExists = isDirOrFile(configPath);
  const configJson = configExists ? readJsonFile(configPath) : null;

  let config = DEFAULT_CONFIG;

  if (configJson && typeof configJson === "object") {
    config = mergeConfig(config, configJson as Partial<GrprConfig>);
  }

  const envEnabled = parseBool(process.env.GRPR_ENABLED);
  if (envEnabled !== undefined) {
    config = { ...config, enabled: envEnabled };
  }

  if (process.env.GRPR_DIR) {
    config = { ...config, store_dir: process.env.GRPR_DIR };
  }

  if (process.env.GRPR_SERVICE) {
    config = { ...config, default_service: process.env.GRPR_SERVICE };
  }

  return {
    rootDir,
    configPath: configExists ? configPath : undefined,
    localConfigPath: undefined,
    config,
  };
};

export const resolveStoreDir = (config: GrprConfig, rootDir: string): string => {
  if (path.isAbsolute(config.store_dir)) {
    return config.store_dir;
  }
  return path.join(rootDir, config.store_dir);
};

export const resolveCheckpointPath = (storeDir: string): string => {
  return path.join(storeDir, ".grpr-checkpoint");
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

export const getDefaultConfig = (): GrprConfig => DEFAULT_CONFIG;
