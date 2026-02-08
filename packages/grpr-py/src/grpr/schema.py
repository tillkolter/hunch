from __future__ import annotations

from typing import Any, Dict, Literal, TypedDict

GrprLevel = Literal["trace", "debug", "info", "warn", "error", "fatal"]

GrprSourceKind = Literal["sdk", "stdout", "stderr", "mcp"]


class GrprSource(TypedDict, total=False):
    kind: GrprSourceKind
    file: str
    line: int


class GrprEvent(TypedDict, total=False):
    id: str
    ts: str
    level: GrprLevel
    type: str
    service: str
    run_id: str
    session_id: str
    message: str
    data: Dict[str, Any]
    tags: Dict[str, str]
    trace_id: str
    span_id: str
    source: GrprSource


class GrprRedactionConfig(TypedDict):
    enabled: bool
    keys: list[str]
    patterns: list[str]


class GrprMcpConfig(TypedDict):
    max_results: int
    default_lookback_ms: int


class GrprConfig(TypedDict):
    version: int
    enabled: bool
    store_dir: str
    default_service: str
    redaction: GrprRedactionConfig
    mcp: GrprMcpConfig
