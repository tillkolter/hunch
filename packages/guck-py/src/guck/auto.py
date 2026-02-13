from __future__ import annotations

import atexit
import os
import sys
from contextlib import suppress

from .config import load_config
from .emit import emit


class StopHandle:
    def __init__(self, stop_fn):
        self._stop_fn = stop_fn

    def stop(self) -> None:
        self._stop_fn()


class _CapturedStream:
    def __init__(self, stream, kind: str, level: str, buffer_ref):
        self._stream = stream
        self._kind = kind
        self._level = level
        self._buffer_ref = buffer_ref

    def write(self, data):
        result = self._stream.write(data)
        if isinstance(data, (bytes, bytearray)):
            encoding = getattr(self._stream, "encoding", None) or "utf-8"
            text = data.decode(encoding, errors="replace")
        else:
            text = str(data)
        self._buffer_ref["value"] += text
        lines = self._buffer_ref["value"].splitlines()
        if self._buffer_ref["value"].endswith(("\n", "\r")):
            pending = ""
        else:
            pending = lines.pop() if lines else ""
        self._buffer_ref["value"] = pending
        for line in lines:
            _flush_line(self._kind, self._level, line)
        return result

    def writelines(self, lines):
        for line in lines:
            self.write(line)

    def flush(self):
        return self._stream.flush()

    def __getattr__(self, name):
        return getattr(self._stream, name)


_installed: StopHandle | None = None


def _should_capture() -> bool:
    if os.environ.get("GUCK_WRAPPED") == "1":
        return False
    loaded = load_config()
    config = loaded["config"]
    if not config["enabled"]:
        return False
    sdk = config.get("sdk")
    if not sdk or not sdk.get("enabled", True):
        return False
    return bool(sdk.get("capture_stdout") or sdk.get("capture_stderr"))


def _flush_line(kind: str, level: str, line: str) -> None:
    if not line.strip():
        return
    emit(
        {
            "type": kind,
            "level": level,
            "message": line,
            "source": {"kind": kind},
        }
    )


def install_auto_capture() -> StopHandle:
    global _installed
    if _installed is not None:
        return _installed

    if not _should_capture():
        handle = StopHandle(lambda: None)
        _installed = handle
        return handle

    loaded = load_config()
    config = loaded["config"]
    sdk = config["sdk"]

    buffers = {"stdout": {"value": ""}, "stderr": {"value": ""}}

    original_stdout = sys.stdout
    original_stderr = sys.stderr

    if sdk.get("capture_stdout"):
        sys.stdout = _CapturedStream(original_stdout, "stdout", "info", buffers["stdout"])
    if sdk.get("capture_stderr"):
        sys.stderr = _CapturedStream(original_stderr, "stderr", "error", buffers["stderr"])

    def flush() -> None:
        if sdk.get("capture_stdout") and buffers["stdout"]["value"].strip():
            _flush_line("stdout", "info", buffers["stdout"]["value"])
            buffers["stdout"]["value"] = ""
        if sdk.get("capture_stderr") and buffers["stderr"]["value"].strip():
            _flush_line("stderr", "error", buffers["stderr"]["value"])
            buffers["stderr"]["value"] = ""

    def stop() -> None:
        global _installed
        flush()
        if sdk.get("capture_stdout"):
            sys.stdout = original_stdout
        if sdk.get("capture_stderr"):
            sys.stderr = original_stderr
        with suppress(AttributeError):
            atexit.unregister(flush)
        _installed = None

    atexit.register(flush)

    handle = StopHandle(stop)
    _installed = handle
    return handle
