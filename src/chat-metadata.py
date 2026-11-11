"""Read one chat's display name, provenance and archive flag; never read messages."""

import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import sys


ERROR = "chat_metadata_unavailable"
SESSION_ID = re.compile(r"[_a-zA-Z0-9-]{1,128}", re.ASCII)
MAX_BYTES = 16 * 1024
MAIN_SOURCES = {"cli", "exec", "vscode"}
MAIN_THREAD_SOURCES = {"user", "chatgpt_handoff", "codex", "agent_created_thread"}


def metadata(database, session_id):
    """Open the existing index read-only, and fail closed on unknown provenance."""
    path = Path(database)
    if not path.is_absolute() or not SESSION_ID.fullmatch(session_id):
        raise ValueError(ERROR)
    before = path.lstat()
    if (not stat.S_ISREG(before.st_mode) or before.st_uid != os.geteuid()
            or before.st_mode & 0o022):
        raise ValueError(ERROR)

    connection = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=0.5)
    try:
        connection.execute("PRAGMA busy_timeout = 500")
        connection.execute("PRAGMA query_only = ON")
        # name is the renamed display label. The title column contains the first prompt.
        row = connection.execute(
            "SELECT id, name, cwd, source, thread_source, agent_path, archived "
            "FROM threads WHERE id = ? LIMIT 1", (session_id,)
        ).fetchone()
        after = path.lstat()
        if ((after.st_dev, after.st_ino) != (before.st_dev, before.st_ino)
                or not stat.S_ISREG(after.st_mode) or after.st_uid != os.geteuid()
                or after.st_mode & 0o022):
            raise ValueError(ERROR)
    finally:
        connection.close()

    if row is None:
        return None
    if len(row) != 7:
        raise ValueError(ERROR)
    identity, archived = row[:6], row[6]
    if (any(value is not None and not isinstance(value, str) for value in identity)
            or type(archived) is not int or archived not in (0, 1)):
        raise ValueError(ERROR)
    if sum(len(value.encode("utf-8")) for value in identity if value is not None) > MAX_BYTES:
        raise ValueError(ERROR)
    stored_id, name, cwd, source, thread_source, agent_path = identity
    if (stored_id != session_id or not isinstance(cwd, str) or not os.path.isabs(cwd)
            or len(cwd) > 1024 or any("\x00" in value for value in identity if value is not None)):
        raise ValueError(ERROR)

    # Only these currently observed scalar sources establish a main user chat.
    # JSON sources (including every subagent variant) and future values stay excluded.
    is_main = thread_source in MAIN_THREAD_SOURCES and not agent_path and source in MAIN_SOURCES
    title = (name or "").strip()[:160] or "聊天 " + session_id[-8:]
    return {"sessionId": session_id, "title": title, "cwd": cwd, "isMain": is_main,
            "titleReady": bool((name or "").strip()), "isArchived": archived == 1}


def main():
    """Emit only bounded metadata or a fixed error; SQLite diagnostics stay private."""
    try:
        if len(sys.argv) != 3:
            raise ValueError(ERROR)
        result = json.dumps(metadata(sys.argv[1], sys.argv[2]), ensure_ascii=False, separators=(",", ":"))
        if len(result.encode("utf-8")) > MAX_BYTES:
            raise ValueError(ERROR)
        sys.stdout.write(result)
        return 0
    except Exception:
        sys.stderr.write(ERROR + "\n")
        return 1


if __name__ == "__main__":
    sys.exit(main())
