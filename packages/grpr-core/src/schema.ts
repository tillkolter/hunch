export type GrprLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export type GrprSourceKind = "sdk" | "stdout" | "stderr" | "mcp";

export type GrprSource = {
  kind: GrprSourceKind;
  file?: string;
  line?: number;
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
  config_path?: string;
};

export type GrprStatsParams = {
  service?: string;
  session_id?: string;
  since?: string;
  until?: string;
  group_by: "type" | "level" | "stage";
  limit?: number;
  config_path?: string;
};

export type GrprSessionsParams = {
  service?: string;
  since?: string;
  limit?: number;
  config_path?: string;
};

export type GrprTailParams = {
  service?: string;
  session_id?: string;
  run_id?: string;
  limit?: number;
  config_path?: string;
};
