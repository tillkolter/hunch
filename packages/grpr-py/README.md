# Grpr Python SDK

Grpr is a tiny, MCP-first telemetry store for AI debugging. This package is the
Python SDK that mirrors the JS `emit` behavior.

## Install (local dev)

```sh
uv pip install -e .
```

## Usage

```py
from grpr import emit

emit({"message": "hello from python"})
```

## Config

The SDK reads `.grpr.json` in your repo root and honors the same environment
variables as the JS SDK:

- `GRPR_CONFIG_PATH`
- `GRPR_DIR`
- `GRPR_ENABLED`
- `GRPR_SERVICE`
- `GRPR_SESSION_ID`
- `GRPR_RUN_ID`
