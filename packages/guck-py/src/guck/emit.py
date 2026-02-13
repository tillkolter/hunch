from __future__ import annotations

import errno
import os
import sys
import uuid
from datetime import datetime, timezone
from typing import Any

from .config import load_config, resolve_store_dir
from .redact import redact_event
from .schema import GuckEvent, GuckLevel
from .store import append_event

_cached: dict[str, Any] | None = None
_write_disabled = False
_warned = False

_DEFAULT_RUN_ID = os.environ.get("GUCK_RUN_ID") or str(uuid.uuid4())
_DEFAULT_SESSION_ID = os.environ.get("GUCK_SESSION_ID")


def _now_iso() -> str:
    now = datetime.now(timezone.utc)
    return now.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _normalize_level(level: str | None) -> GuckLevel:
    if not level:
        return "info"
    lower = level.lower()
    if lower in {"trace", "debug", "info", "warn", "error", "fatal"}:
        return lower  # type: ignore[return-value]
    return "info"


def _coalesce(input_event: dict[str, Any], key: str, default: Any) -> Any:
    if key in input_event and input_event[key] is not None:
        return input_event[key]
    return default


def _to_event(input_event: dict[str, Any], defaults: dict[str, str]) -> GuckEvent:
    event: GuckEvent = {
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


def _get_cached() -> dict[str, Any]:
    global _cached
    if _cached is not None:
        return _cached
    loaded = load_config()
    store_dir = resolve_store_dir(loaded["config"], loaded["root_dir"])
    _cached = {"store_dir": store_dir, "config": loaded["config"]}
    return _cached


def emit(input_event: dict[str, Any]) -> None:
    global _write_disabled, _warned
    if _write_disabled:
        return
    cached = _get_cached()
    config = cached["config"]
    if not config["enabled"]:
        return
    event = _to_event(input_event, {"service": config["default_service"]})
    redacted = redact_event(config, event)
    try:
        append_event(cached["store_dir"], redacted)
    except OSError as exc:
        if os.environ.get("GUCK_STRICT_WRITE_ERRORS") == "1":
            raise
        if exc.errno in {errno.EACCES, errno.EPERM, errno.EROFS}:
            _write_disabled = True
            if not _warned:
                _warned = True
                sys.stderr.write(
                    "[guck] write disabled (permission error); set "
                    "GUCK_STRICT_WRITE_ERRORS=1 to fail hard\n"
                )
            return
        raise
