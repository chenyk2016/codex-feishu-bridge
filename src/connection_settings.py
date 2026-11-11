"""Persist the local Feishu connection preference without exposing pairing data."""
import json
import os
import stat
import tempfile
import time
from pathlib import Path

FILENAME = "connection-settings.json"
PRIVATE_ROOT = Path.home() / "Library/Application Support/CodexFeishuBridge"
DEFAULT = {"enabled": True, "resumeAtMs": 0}


def read_settings(root):
    try:
        fd = os.open(root / FILENAME, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return DEFAULT.copy()
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
            raise ValueError("unsafe_connection_settings")
        data = json.loads(stream.read(1025))
    if (not isinstance(data, dict) or set(data) != set(DEFAULT) or type(data["enabled"]) is not bool
            or type(data["resumeAtMs"]) is not int or not 0 <= data["resumeAtMs"] <= 2**53 - 1):
        raise ValueError("invalid_connection_settings")
    return data


def set_enabled(root, enabled):
    current = read_settings(root)
    if current["enabled"] == enabled:
        return
    resumed_at = current["resumeAtMs"]
    if enabled:
        resumed_at = max(resumed_at + 1, time.time_ns() // 1_000_000)
    value = {"enabled": enabled, "resumeAtMs": resumed_at}
    fd, name = tempfile.mkstemp(prefix=".connection-settings-", dir=root)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, root / FILENAME)
    finally:
        Path(name).unlink(missing_ok=True)
