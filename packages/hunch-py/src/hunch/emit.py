from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from .config import load_config, resolve_store_dir
from .redact import redact_event
from .schema import HunchEvent, HunchLevel
from .store import append_event

_cached: Optional[Dict[str, Any]] = None

_DEFAULT_RUN_ID = os.environ.get("HUNCH_RUN_ID") or str(uuid.uuid4())
_DEFAULT_SESSION_ID = os.environ.get("HUNCH_SESSION_ID")


def _now_iso() -> str:
    now = datetime.now(timezone.utc)
    return now.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _normalize_level(level: Optional[str]) -> HunchLevel:
    if not level:
        return "info"
    lower = level.lower()
    if lower in {"trace", "debug", "info", "warn", "error", "fatal"}:
        return lower  # type: ignore[return-value]
    return "info"


def _coalesce(input_event: Dict[str, Any], key: str, default: Any) -> Any:
    if key in input_event and input_event[key] is not None:
        return input_event[key]
    return default


def _to_event(input_event: Dict[str, Any], defaults: Dict[str, str]) -> HunchEvent:
    event: HunchEvent = {
        "id": _coalesce(input_event, "id", str(uuid.uuid4())),
        "ts": _coalesce(input_event, "ts", _now_iso()),
        "level": _normalize_level(input_event.get("level")),
        "type": _coalesce(input_event, "type", "log"),
        "service": _coalesce(input_event, "service", defaults["service"]),
        "run_id": _coalesce(input_event, "run_id", _DEFAULT_RUN_ID),
        "source": _coalesce(input_event, "source", {"kind": "sdk"}),
    }

    session_id = _coalesce(input_event, "session_id", _DEFAULT_SESSION_ID)
    if session_id is not None:
        event["session_id"] = session_id

    if "message" in input_event and input_event["message"] is not None:
        event["message"] = input_event["message"]
    if "data" in input_event and input_event["data"] is not None:
        event["data"] = input_event["data"]
    if "tags" in input_event and input_event["tags"] is not None:
        event["tags"] = input_event["tags"]
    if "trace_id" in input_event and input_event["trace_id"] is not None:
        event["trace_id"] = input_event["trace_id"]
    if "span_id" in input_event and input_event["span_id"] is not None:
        event["span_id"] = input_event["span_id"]

    return event


def _get_cached() -> Dict[str, Any]:
    global _cached
    if _cached is not None:
        return _cached
    loaded = load_config()
    store_dir = resolve_store_dir(loaded["config"], loaded["root_dir"])
    _cached = {"store_dir": store_dir, "config": loaded["config"]}
    return _cached


def emit(input_event: Dict[str, Any]) -> None:
    cached = _get_cached()
    config = cached["config"]
    if not config["enabled"]:
        return
    event = _to_event(input_event, {"service": config["default_service"]})
    redacted = redact_event(config, event)
    append_event(cached["store_dir"], redacted)
