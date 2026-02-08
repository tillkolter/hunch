export type GrprLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export type GrprSourceKind = "sdk" | "stdout" | "stderr" | "mcp";

export type GrprSource = {
  kind: GrprSourceKind;
  file?: string;
  line?: number;
  backend?: string;
  backend_id?: string;
};

export type GrprSdkConfig = {
  enabled: boolean;
  capture_stdout: boolean;
  capture_stderr: boolean;
};

export type GrprEvent = {
  id: string;
  ts: string;
  level: GrprLevel;
  type: string;
  service: string;
  run_id: string;
  session_id?: string;
  message?: string;
  data?: Record<string, unknown>;
  tags?: Record<string, string>;
  trace_id?: string;
  span_id?: string;
  source?: GrprSource;
};

export type GrprConfig = {
  version: 1;
  enabled: boolean;
  store_dir: string;
  default_service: string;
  sdk: GrprSdkConfig;
  read?: GrprReadConfig;
  redaction: {
    enabled: boolean;
    keys: string[];
    patterns: string[];
  };
  mcp: {
    max_results: number;
    default_lookback_ms: number;
  };
};

export type GrprReadBackendType = "local" | "cloudwatch" | "k8s";

export type GrprLocalReadBackendConfig = {
  type: "local";
  id?: string;
  dir?: string;
};

export type GrprCloudWatchReadBackendConfig = {
  type: "cloudwatch";
  id?: string;
  logGroup: string;
  region: string;
  profile?: string;
  service?: string;
};

export type GrprK8sReadBackendConfig = {
  type: "k8s";
  id?: string;
  namespace: string;
  selector: string;
  context?: string;
  container?: string;
  service?: string;
};

export type GrprReadBackendConfig =
  | GrprLocalReadBackendConfig
  | GrprCloudWatchReadBackendConfig
  | GrprK8sReadBackendConfig;

export type GrprReadConfig = {
  backend: "local" | "multi";
  backends?: GrprReadBackendConfig[];
};

export type GrprSearchParams = {
  service?: string;
  session_id?: string;
  run_id?: string;
  types?: string[];
  levels?: GrprLevel[];
  contains?: string;
  since?: string;
  until?: string;
  limit?: number;
  backends?: string[];
  config_path?: string;
};

export type GrprStatsParams = {
  service?: string;
  session_id?: string;
  since?: string;
  until?: string;
  group_by: "type" | "level" | "stage";
  limit?: number;
  backends?: string[];
  config_path?: string;
};

export type GrprSessionsParams = {
  service?: string;
  since?: string;
  limit?: number;
  backends?: string[];
  config_path?: string;
};

export type GrprTailParams = {
  service?: string;
  session_id?: string;
  run_id?: string;
  limit?: number;
  backends?: string[];
  config_path?: string;
};
