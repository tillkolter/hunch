# Hunch Python SDK

Hunch is a tiny, MCP-first telemetry store for AI debugging. This package is the
Python SDK that mirrors the JS `emit` behavior.

## Install (local dev)

```sh
uv pip install -e .
```

## Usage

```py
from hunch import emit

emit({"message": "hello from python"})
```

## Config

The SDK reads `.hunch.json` in your repo root and honors the same environment
variables as the JS SDK:

- `HUNCH_CONFIG`
- `HUNCH_DIR`
- `HUNCH_ENABLED`
- `HUNCH_SERVICE`
- `HUNCH_SESSION_ID`
- `HUNCH_RUN_ID`
