import fs from "node:fs";
import path from "node:path";
import { HunchConfig } from "./schema.js";

const DEFAULT_CONFIG: HunchConfig = {
  version: 1,
  enabled: true,
  store_dir: "logs/hunch",
  default_service: "hunch",
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
  config: HunchConfig;
};

const readJsonFile = (filePath: string): unknown | null => {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
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

const mergeConfig = (base: HunchConfig, override: Partial<HunchConfig>): HunchConfig => {
  return {
    ...base,
    ...override,
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
  const cwd = options.cwd ?? process.cwd();
  const explicitConfig = options.configPath ?? process.env.HUNCH_CONFIG;
  const rootDir = explicitConfig
    ? path.dirname(path.resolve(explicitConfig))
    : findRepoRoot(cwd);

  const configPath = explicitConfig ?? path.join(rootDir, ".hunch.json");
  const configExists = isDirOrFile(configPath);
  const configJson = configExists ? readJsonFile(configPath) : null;

  let config = DEFAULT_CONFIG;

  if (configJson && typeof configJson === "object") {
    config = mergeConfig(config, configJson as Partial<HunchConfig>);
  }


  const envEnabled = parseBool(process.env.HUNCH_ENABLED);
  if (envEnabled !== undefined) {
    config = { ...config, enabled: envEnabled };
  }

  if (process.env.HUNCH_DIR) {
    config = { ...config, store_dir: process.env.HUNCH_DIR };
  }

  if (process.env.HUNCH_SERVICE) {
    config = { ...config, default_service: process.env.HUNCH_SERVICE };
  }

  return {
    rootDir,
    configPath: configExists ? configPath : undefined,
    localConfigPath: undefined,
    config,
  };
};

export const resolveStoreDir = (config: HunchConfig, rootDir: string): string => {
  if (path.isAbsolute(config.store_dir)) {
    return config.store_dir;
  }
  return path.join(rootDir, config.store_dir);
};

export const getDefaultConfig = (): HunchConfig => DEFAULT_CONFIG;
