from __future__ import annotations

import re
from collections.abc import Iterable
from typing import Any

from .schema import GuckConfig, GuckEvent

_REDACTED_VALUE = "[REDACTED]"


def _normalize_key_set(keys: Iterable[str]) -> set[str]:
    return {key.strip().lower() for key in keys if key.strip()}


def _compile_pattern(pattern: str) -> re.Pattern[str] | None:
    try:
        return re.compile(pattern, re.IGNORECASE)
    except re.error:
        return None


def _compile_patterns(patterns: Iterable[str]) -> list[re.Pattern[str]]:
    compiled: list[re.Pattern[str]] = []
    for pattern in patterns:
        compiled_pattern = _compile_pattern(pattern)
        if compiled_pattern:
            compiled.append(compiled_pattern)
    return compiled


def _redact_string(value: str, patterns: Iterable[re.Pattern[str]]) -> str:
    next_value = value
    for pattern in patterns:
        next_value = pattern.sub(_REDACTED_VALUE, next_value)
    return next_value


def _redact_value(value: Any, key_set: set[str], patterns: list[re.Pattern[str]]) -> Any:
    if value is None:
        return value
    if isinstance(value, str):
        return _redact_string(value, patterns)
    if isinstance(value, (int, float, bool)):
        return value
    if isinstance(value, list):
        return [_redact_value(entry, key_set, patterns) for entry in value]
    if isinstance(value, dict):
        next_value: dict[str, Any] = {}
        for key, entry in value.items():
            if key.lower() in key_set:
                next_value[key] = _REDACTED_VALUE
            else:
                next_value[key] = _redact_value(entry, key_set, patterns)
        return next_value
    return value


def redact_event(config: GuckConfig, event: GuckEvent) -> GuckEvent:
    if not config["redaction"]["enabled"]:
        return event

    key_set = _normalize_key_set(config["redaction"]["keys"])
    patterns = _compile_patterns(config["redaction"]["patterns"])

    redacted: GuckEvent = dict(event)

    message = event.get("message")
    if isinstance(message, str):
        redacted["message"] = _redact_string(message, patterns)

    data = event.get("data")
    if data is not None:
        redacted["data"] = _redact_value(data, key_set, patterns)

    tags = event.get("tags")
    if tags is not None:
        redacted["tags"] = _redact_value(tags, key_set, patterns)

    return redacted
