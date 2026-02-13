from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, TypedDict

from .schema import GuckConfig

DEFAULT_CONFIG: GuckConfig = {
    "version": 1,
    "enabled": True,
    "default_service": "guck",
    "sdk": {
        "enabled": True,
        "capture_stdout": True,
        "capture_stderr": True,
    },
    "redaction": {
        "enabled": True,
        "keys": ["authorization", "api_key", "token", "secret", "password"],
        "patterns": ["sk-[A-Za-z0-9]{20,}", "Bearer\\s+[A-Za-z0-9._-]+"],
    },
    "mcp": {
        "max_results": 200,
        "default_lookback_ms": 300000,
        "max_output_chars": 0,
        "max_message_chars": 0,
    },
}

DEFAULT_STORE_DIR = str(Path.home() / ".guck" / "logs")


class LoadedConfig(TypedDict):
    root_dir: str
    config_path: str | None
    local_config_path: str | None
    config: GuckConfig


def _read_json_file(file_path: Path) -> dict[str, Any] | None:
    try:
        raw = file_path.read_text(encoding="utf-8")
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else None
    except Exception:
        return None


def _is_dir_or_file(file_path: Path) -> bool:
    try:
        file_path.stat()
    except OSError:
        return False
    else:
        return True


def find_repo_root(start_dir: str) -> str:
    current = Path(start_dir).resolve()
    while True:
        if _is_dir_or_file(current / ".git"):
            return str(current)
        parent = current.parent
        if parent == current:
            return start_dir
        current = parent


def _merge_config(base: GuckConfig, override: dict[str, Any]) -> GuckConfig:
    override = {k: v for k, v in override.items() if k != "store_dir"}
    mcp_override = dict(override.get("mcp") or {})
    mcp_override.pop("http", None)
    merged: GuckConfig = {
        **base,
        **override,
        "sdk": {
            **base["sdk"],
            **(override.get("sdk") or {}),
        },
        "redaction": {
            **base["redaction"],
            **(override.get("redaction") or {}),
        },
        "mcp": {
            **base["mcp"],
            **mcp_override,
        },
    }
    return merged


def _parse_bool(value: str | None) -> bool | None:
    if value is None:
        return None
    normalized = value.strip().lower()
    if normalized == "true":
        return True
    if normalized == "false":
        return False
    return None


def load_config(*, cwd: str | None = None, config_path: str | None = None) -> LoadedConfig:
    working_dir = (
        cwd
        or os.environ.get("GUCK_CWD")
        or os.environ.get("INIT_CWD")
        or os.getcwd()
    )
    explicit_config = config_path or os.environ.get("GUCK_CONFIG") or os.environ.get(
        "GUCK_CONFIG_PATH"
    )
    if explicit_config:
        resolved_explicit = Path(explicit_config)
        if not resolved_explicit.is_absolute():
            resolved_explicit = Path(working_dir) / resolved_explicit
        resolved_explicit = resolved_explicit.resolve()
        if resolved_explicit.is_dir():
            root_dir = str(resolved_explicit)
            resolved_config_path = resolved_explicit / ".guck.json"
        else:
            root_dir = str(resolved_explicit.parent)
            resolved_config_path = resolved_explicit
    else:
        root_dir = find_repo_root(working_dir)
        resolved_config_path = Path(root_dir) / ".guck.json"
    config_exists = _is_dir_or_file(resolved_config_path)
    config_json = _read_json_file(resolved_config_path) if config_exists else None

    config: GuckConfig = DEFAULT_CONFIG
    if config_json:
        config = _merge_config(config, config_json)

    env_enabled = _parse_bool(os.environ.get("GUCK_ENABLED"))
    if env_enabled is not None:
        config = {**config, "enabled": env_enabled}

    if os.environ.get("GUCK_SERVICE"):
        config = {**config, "default_service": os.environ["GUCK_SERVICE"]}

    return {
        "root_dir": root_dir,
        "config_path": str(resolved_config_path) if config_exists else None,
        "local_config_path": None,
        "config": config,
    }


def resolve_store_dir(_config: GuckConfig, _root_dir: str) -> str:
    return os.environ.get("GUCK_DIR") or DEFAULT_STORE_DIR


def get_default_config() -> GuckConfig:
    return DEFAULT_CONFIG
