from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, Optional, TypedDict

from .schema import GrprConfig

DEFAULT_CONFIG: GrprConfig = {
    "version": 1,
    "enabled": True,
    "store_dir": "logs/grpr",
    "default_service": "grpr",
    "redaction": {
        "enabled": True,
        "keys": ["authorization", "api_key", "token", "secret", "password"],
        "patterns": ["sk-[A-Za-z0-9]{20,}", "Bearer\\s+[A-Za-z0-9._-]+"],
    },
    "mcp": {
        "max_results": 200,
        "default_lookback_ms": 300000,
    },
}


class LoadedConfig(TypedDict):
    root_dir: str
    config_path: Optional[str]
    local_config_path: Optional[str]
    config: GrprConfig


def _read_json_file(file_path: Path) -> Optional[Dict[str, Any]]:
    try:
        raw = file_path.read_text(encoding="utf-8")
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else None
    except Exception:
        return None


def _is_dir_or_file(file_path: Path) -> bool:
    try:
        file_path.stat()
        return True
    except OSError:
        return False


def find_repo_root(start_dir: str) -> str:
    current = Path(start_dir).resolve()
    while True:
        if _is_dir_or_file(current / ".git"):
            return str(current)
        parent = current.parent
        if parent == current:
            return start_dir
        current = parent


def _merge_config(base: GrprConfig, override: Dict[str, Any]) -> GrprConfig:
    merged: GrprConfig = {
        **base,
        **override,
        "redaction": {
            **base["redaction"],
            **(override.get("redaction") or {}),
        },
        "mcp": {
            **base["mcp"],
            **(override.get("mcp") or {}),
        },
    }
    return merged


def _parse_bool(value: Optional[str]) -> Optional[bool]:
    if value is None:
        return None
    normalized = value.strip().lower()
    if normalized == "true":
        return True
    if normalized == "false":
        return False
    return None


def load_config(*, cwd: Optional[str] = None, config_path: Optional[str] = None) -> LoadedConfig:
    working_dir = (
        cwd
        or os.environ.get("GRPR_CWD")
        or os.environ.get("INIT_CWD")
        or os.getcwd()
    )
    explicit_config = config_path or os.environ.get("GRPR_CONFIG") or os.environ.get(
        "GRPR_CONFIG_PATH"
    )
    if explicit_config:
        resolved_explicit = Path(explicit_config)
        if not resolved_explicit.is_absolute():
            resolved_explicit = Path(working_dir) / resolved_explicit
        resolved_explicit = resolved_explicit.resolve()
        if resolved_explicit.is_dir():
            root_dir = str(resolved_explicit)
            resolved_config_path = resolved_explicit / ".grpr.json"
        else:
            root_dir = str(resolved_explicit.parent)
            resolved_config_path = resolved_explicit
    else:
        root_dir = find_repo_root(working_dir)
        resolved_config_path = Path(root_dir) / ".grpr.json"
    config_exists = _is_dir_or_file(resolved_config_path)
    config_json = _read_json_file(resolved_config_path) if config_exists else None

    config: GrprConfig = DEFAULT_CONFIG
    if config_json:
        config = _merge_config(config, config_json)

    env_enabled = _parse_bool(os.environ.get("GRPR_ENABLED"))
    if env_enabled is not None:
        config = {**config, "enabled": env_enabled}

    if os.environ.get("GRPR_DIR"):
        config = {**config, "store_dir": os.environ["GRPR_DIR"]}

    if os.environ.get("GRPR_SERVICE"):
        config = {**config, "default_service": os.environ["GRPR_SERVICE"]}

    return {
        "root_dir": root_dir,
        "config_path": str(resolved_config_path) if config_exists else None,
        "local_config_path": None,
        "config": config,
    }


def resolve_store_dir(config: GrprConfig, root_dir: str) -> str:
    store_dir = config["store_dir"]
    if Path(store_dir).is_absolute():
        return store_dir
    return str(Path(root_dir) / store_dir)


def get_default_config() -> GrprConfig:
    return DEFAULT_CONFIG
