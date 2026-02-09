from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .schema import GuckEvent


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


def _safe_chmod(path: Path, mode: int) -> None:
    try:
        os.chmod(path, mode)
    except OSError:
        # Best-effort only; ignore permission errors to avoid crashing.
        return


def append_event(store_dir: str, event: GuckEvent) -> str:
    ts = _parse_timestamp(event.get("ts"))
    date_segment = _format_date_segment(ts)
    store_root = Path(store_dir)
    service_dir = store_root / event["service"]
    file_dir = service_dir / date_segment
    file_dir.mkdir(parents=True, exist_ok=True)
    _safe_chmod(store_root, 0o777)
    _safe_chmod(service_dir, 0o777)
    _safe_chmod(file_dir, 0o777)
    file_path = file_dir / f"{event['run_id']}.jsonl"
    with file_path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(event, ensure_ascii=False) + "\n")
    _safe_chmod(file_path, 0o666)
    return str(file_path)
