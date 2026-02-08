from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .schema import GrprEvent


def _parse_timestamp(value: Any) -> datetime:
    if isinstance(value, str):
        candidate = value.strip()
        if candidate.endswith("Z"):
            candidate = candidate[:-1] + "+00:00"
        try:
            parsed = datetime.fromisoformat(candidate)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed.astimezone(timezone.utc)
        except ValueError:
            pass
    return datetime.now(timezone.utc)


def _format_date_segment(ts: datetime) -> str:
    return ts.strftime("%Y-%m-%d")


def append_event(store_dir: str, event: GrprEvent) -> str:
    ts = _parse_timestamp(event.get("ts"))
    date_segment = _format_date_segment(ts)
    file_dir = Path(store_dir) / event["service"] / date_segment
    file_dir.mkdir(parents=True, exist_ok=True)
    file_path = file_dir / f"{event['run_id']}.jsonl"
    with file_path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(event, ensure_ascii=False) + "\n")
    return str(file_path)
