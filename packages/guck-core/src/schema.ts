export type GuckLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export type GuckSourceKind = "sdk" | "stdout" | "stderr" | "mcp";

export type GuckSource = {
  kind: GuckSourceKind;
  file?: string;
  line?: number;
  backend?: string;
  backend_id?: string;
};

export type GuckSdkConfig = {
  enabled: boolean;
  capture_stdout: boolean;
  capture_stderr: boolean;
};

export type GuckEvent = {
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

export type GuckConfig = {
  version: 1;
  enabled: boolean;
  default_service: string;
  sdk: GuckSdkConfig;
  read?: GuckReadConfig;
  redaction: {
    enabled: boolean;
    keys: string[];
    patterns: string[];
  };
  mcp: GuckMcpConfig;
};

export type GuckMcpConfig = {
  max_results: number;
  default_lookback_ms: number;
  max_output_chars?: number;
  max_message_chars?: number;
};

export type GuckReadBackendType = "local" | "cloudwatch" | "k8s";

export type GuckLocalReadBackendConfig = {
  type: "local";
  id?: string;
  dir?: string;
};

export type GuckCloudWatchReadBackendConfig = {
  type: "cloudwatch";
  id?: string;
  logGroup: string;
  region: string;
  profile?: string;
  service?: string;
};

export type GuckK8sAuthConfig = {
  type: "eks";
  cluster?: string;
  region?: string;
  profile?: string;
  role_arn?: string;
};

export type GuckK8sReadBackendConfig = {
  type: "k8s";
  id?: string;
  namespace: string;
  selector: string;
  context?: string;
  container?: string;
  service?: string;
  clusterName?: string;
  region?: string;
  profile?: string;
  auth?: GuckK8sAuthConfig;
};

export type GuckReadBackendConfig =
  | GuckLocalReadBackendConfig
  | GuckCloudWatchReadBackendConfig
  | GuckK8sReadBackendConfig;

export type GuckReadConfig = {
  backend: "local" | "multi";
  backends?: GuckReadBackendConfig[];
};

export type GuckSearchParams = {
  service?: string;
  session_id?: string;
  run_id?: string;
  types?: string[];
  levels?: GuckLevel[];
  contains?: string;
  query?: string;
  since?: string;
  until?: string;
  limit?: number;
  max_output_chars?: number;
  max_message_chars?: number;
  format?: "json" | "text";
  fields?: string[];
  template?: string;
  backends?: string[];
  config_path?: string;
};

export type GuckStatsParams = {
  service?: string;
  session_id?: string;
  since?: string;
  until?: string;
  group_by: "type" | "level" | "stage";
  limit?: number;
  backends?: string[];
  config_path?: string;
};

export type GuckSessionsParams = {
  service?: string;
  since?: string;
  limit?: number;
  backends?: string[];
  config_path?: string;
};

export type GuckTailParams = {
  service?: string;
  session_id?: string;
  run_id?: string;
  limit?: number;
  query?: string;
  max_output_chars?: number;
  max_message_chars?: number;
  format?: "json" | "text";
  fields?: string[];
  template?: string;
  backends?: string[];
  config_path?: string;
};
