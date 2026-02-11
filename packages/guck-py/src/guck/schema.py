from __future__ import annotations

from typing import Any, Dict, Literal, TypedDict

GuckLevel = Literal["trace", "debug", "info", "warn", "error", "fatal"]

GuckSourceKind = Literal["sdk", "stdout", "stderr", "mcp"]


class GuckSource(TypedDict, total=False):
    kind: GuckSourceKind
    file: str
    line: int


class GuckEvent(TypedDict, total=False):
    id: str
    ts: str
    level: GuckLevel
    type: str
    service: str
    run_id: str
    session_id: str
    message: str
    data: Dict[str, Any]
    tags: Dict[str, str]
    trace_id: str
    span_id: str
    source: GuckSource


class GuckRedactionConfig(TypedDict):
    enabled: bool
    keys: list[str]
    patterns: list[str]


class GuckMcpConfig(TypedDict):
    max_results: int
    default_lookback_ms: int
    max_output_chars: int
    max_message_chars: int
    http: "GuckMcpHttpConfig"


class GuckMcpHttpConfig(TypedDict, total=False):
    port: int
    host: str
    path: str
    max_body_bytes: int


class GuckSdkConfig(TypedDict):
    enabled: bool
    capture_stdout: bool
    capture_stderr: bool


class GuckConfig(TypedDict):
    version: int
    enabled: bool
    store_dir: str
    default_service: str
    sdk: GuckSdkConfig
    redaction: GuckRedactionConfig
    mcp: GuckMcpConfig
