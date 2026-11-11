#!/usr/bin/env python3
"""Collect a bounded Codex Stop reply locally. The connector owns delivery."""

import argparse
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import time

from connection_settings import PRIVATE_ROOT, read_settings

IDENTIFIER = re.compile(r"[A-Za-z0-9_-]{1,128}")


def read_private_json(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > 262144):
            raise ValueError("private_json_required")
        value = json.loads(stream.read(262145))
        if not isinstance(value, dict):
            raise ValueError("object_required")
        return value


def queue_report(event, root, now_ms=None):
    if not isinstance(event, dict) or event.get("hook_event_name") != "Stop" or event.get("agent_id"):
        return
    session, turn, reply = (event.get(key) for key in ("session_id", "turn_id", "last_assistant_message"))
    if not all(isinstance(value, str) and IDENTIFIER.fullmatch(value) for value in (session, turn)):
        return
    if not isinstance(reply, str) or not reply.strip():
        return
    info = root.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        return
    now_ms = time.time_ns() // 1_000_000 if now_ms is None else now_ms
    settings = read_settings(root)
    if not settings["enabled"] or now_ms < settings["resumeAtMs"]:
        return
    catalog = read_private_json(root / "session-catalog.json")
    if catalog.get("version") != 1:
        return
    if not any(entry.get("sessionId") == session for entry in catalog.get("sessions", [])):
        try:
            policy = read_private_json(root / "report-policy.json")
        except FileNotFoundError:
            return
        if (policy.get("enabled") is not True or policy.get("version") != 1
                or policy.get("scope") != "all_local_main_chats"
                or type(policy.get("activatedAtMs")) is not int or not 0 < policy["activatedAtMs"] <= now_ms):
            return
        # The relay verifies that an unregistered ID belongs to a local main chat before sending.
    event_id = sha256(f"{session}\0{turn}\0{reply}".encode()).hexdigest()
    outbox = root / "turn-outbox"
    outbox.mkdir(mode=0o700, exist_ok=True)
    info = outbox.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        return
    fd, temporary = tempfile.mkstemp(prefix=".report-", dir=outbox)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump({"version": 1, "kind": "codex_turn_report", "eventId": event_id, "sessionId": session,
                       "turnId": turn, "createdAtMs": now_ms, "lastAssistantMessage": reply[:4000],
                       "truncated": len(reply) > 4000}, stream, ensure_ascii=False)
        try:
            os.link(temporary, outbox / (event_id + ".json"), follow_symlinks=False)
        except FileExistsError:
            pass
    finally:
        Path(temporary).unlink(missing_ok=True)
    return event_id


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=PRIVATE_ROOT)
    args = parser.parse_args()
    try:
        queue_report(json.load(sys.stdin), args.root)
    except (OSError, ValueError, TypeError, RecursionError, AttributeError):
        pass
    print("{}")


if __name__ == "__main__":
    main()
