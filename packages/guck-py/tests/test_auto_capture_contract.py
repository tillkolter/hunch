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

CASES = json.loads((REPO_ROOT / "specs" / "auto_capture_cases.json").read_text(encoding="utf-8"))
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


@pytest.mark.parametrize("test_case", CASES, ids=[case["name"] for case in CASES])
def test_auto_capture_contract(test_case, tmp_path, monkeypatch):
    config_path = tmp_path / ".guck.json"
    config_path.write_text(json.dumps(test_case["config"], indent=2), encoding="utf-8")

    for key, value in test_case.get("env", {}).items():
        monkeypatch.setenv(key, value)
    monkeypatch.delenv("GUCK_WRAPPED", raising=False)
    monkeypatch.setenv("GUCK_CONFIG_PATH", str(config_path))
    if "GUCK_DIR" not in test_case.get("env", {}):
        monkeypatch.setenv("GUCK_DIR", str(tmp_path / "store"))

    emit_module = importlib.import_module("guck.emit")
    importlib.reload(emit_module)
    auto_module = importlib.import_module("guck.auto")
    importlib.reload(auto_module)
    handle = auto_module.install_auto_capture()

    for write in test_case.get("writes", []):
        stream = sys.stdout if write["stream"] == "stdout" else sys.stderr
        stream.write(write["text"])
        stream.flush()

    handle.stop()

    store_dir_value = os.environ.get("GUCK_DIR") or str(Path.home() / ".guck" / "logs")
    store_dir = Path(store_dir_value)

    files = _collect_jsonl_files(store_dir)

    if test_case.get("expect_no_write"):
        assert len(files) == 0, "expected no JSONL files"
        return

    assert len(files) == 1, "expected one JSONL file"
    content = files[0].read_text(encoding="utf-8").strip()
    line = next(entry for entry in content.splitlines() if entry)
    event = json.loads(line)

    expected = test_case.get("expect", {})
    assert event.get("type") == expected.get("type")
    assert event.get("level") == expected.get("level")
    assert event.get("message") == expected.get("message")
    if "source" in expected:
        assert event.get("source") == expected.get("source")

    assert UUID_RE.match(event.get("id", "")), "expected id to be uuid"
    assert _format_date_segment(event.get("ts", "")) is not None, "expected ts to be ISO"

    env = test_case.get("env", {})
    if env.get("GUCK_RUN_ID"):
        assert event.get("run_id") == env["GUCK_RUN_ID"]
    if env.get("GUCK_SESSION_ID"):
        assert event.get("session_id") == env["GUCK_SESSION_ID"]

    date_segment = _format_date_segment(event["ts"])
    expected_path = store_dir / event["service"] / date_segment / f"{event['run_id']}.jsonl"
    assert files[0] == expected_path
