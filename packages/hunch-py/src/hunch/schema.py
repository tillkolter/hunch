from __future__ import annotations

from typing import Any, Dict, Literal, TypedDict

HunchLevel = Literal["trace", "debug", "info", "warn", "error", "fatal"]

HunchSourceKind = Literal["sdk", "stdout", "stderr", "mcp"]


class HunchSource(TypedDict, total=False):
    kind: HunchSourceKind
    file: str
    line: int


class HunchEvent(TypedDict, total=False):
    id: str
    ts: str
    level: HunchLevel
    type: str
    service: str
    run_id: str
    session_id: str
    message: str
    data: Dict[str, Any]
    tags: Dict[str, str]
    trace_id: str
    span_id: str
    source: HunchSource


class HunchRedactionConfig(TypedDict):
    enabled: bool
    keys: list[str]
    patterns: list[str]


class HunchMcpConfig(TypedDict):
    max_results: int
    default_lookback_ms: int


class HunchConfig(TypedDict):
    version: int
    enabled: bool
    store_dir: str
    default_service: str
    redaction: HunchRedactionConfig
    mcp: HunchMcpConfig
