import importlib
import json
import os
import re
import sys
from pathlib import Path
from typing import Optional

import pytest

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = PACKAGE_ROOT.parents[1]
SRC_ROOT = PACKAGE_ROOT / "src"
if str(SRC_ROOT) not in sys.path:
    sys.path.insert(0, str(SRC_ROOT))

CASES = json.loads((REPO_ROOT / "specs" / "emit_cases.json").read_text(encoding="utf-8"))
UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


def _collect_jsonl_files(root: Path) -> list[Path]:
    if not root.exists():
        return []
    return [path for path in root.rglob("*.jsonl") if path.is_file()]


def _format_date_segment(ts: str) -> Optional[str]:
    try:
        import datetime as dt

        candidate = ts.strip()
        if candidate.endswith("Z"):
            candidate = candidate[:-1] + "+00:00"
        parsed = dt.datetime.fromisoformat(candidate)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=dt.timezone.utc)
        parsed = parsed.astimezone(dt.timezone.utc)
        return parsed.strftime("%Y-%m-%d")
    except Exception:
        return None


def _assert_event_matches(event: dict, test_case: dict) -> None:
    expected = test_case.get("expect", {})
    for key, value in expected.items():
        assert event.get(key) == value, f"expected {key} to match"

    for key in test_case.get("expect_missing", []):
        assert key not in event, f"expected {key} to be absent"

    for key, rule in test_case.get("expect_regex", {}).items():
        value = event.get(key)
        assert isinstance(value, str), f"expected {key} to be a string"
        if rule == "uuid":
            assert UUID_RE.match(value), f"expected {key} to be uuid"
        elif rule == "iso":
            assert _format_date_segment(value) is not None, f"expected {key} to be ISO"


@pytest.mark.parametrize("test_case", CASES, ids=[case["name"] for case in CASES])
def test_emit_contract(test_case, tmp_path, monkeypatch):
    config_path = tmp_path / ".guck.json"
    config_path.write_text(json.dumps(test_case["config"], indent=2), encoding="utf-8")

    for key, value in test_case.get("env", {}).items():
        monkeypatch.setenv(key, value)
    monkeypatch.setenv("GUCK_CONFIG_PATH", str(config_path))
    if "GUCK_DIR" not in test_case.get("env", {}):
        monkeypatch.setenv("GUCK_DIR", str(tmp_path / "store"))

    emit_module = importlib.import_module("guck.emit")
    importlib.reload(emit_module)
    emit_module.emit(test_case.get("input", {}))

    store_dir_value = (
        test_case.get("expect_store_dir")
        or os.environ.get("GUCK_DIR")
        or str(Path.home() / ".guck" / "logs")
    )
    store_dir = Path(store_dir_value)

    if test_case.get("expect_no_write"):
        files = _collect_jsonl_files(store_dir)
        assert len(files) == 0, "expected no JSONL files"
        return

    files = _collect_jsonl_files(store_dir)
    assert len(files) == 1, "expected one JSONL file"

    content = files[0].read_text(encoding="utf-8").strip()
    line = next(entry for entry in content.splitlines() if entry)
    event = json.loads(line)

    _assert_event_matches(event, test_case)

    date_segment = _format_date_segment(event["ts"])
    assert date_segment is not None, "expected valid timestamp"
    expected_path = store_dir / event["service"] / date_segment / f"{event['run_id']}.jsonl"
    assert files[0] == expected_path
