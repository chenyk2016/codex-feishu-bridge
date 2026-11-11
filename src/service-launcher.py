#!/usr/bin/env python3
"""Run one private Feishu connector under launchd, with local settings and bounded logs."""
from __future__ import annotations

import argparse
import fcntl
import json
import os
from pathlib import Path
import selectors
import signal
import stat
import subprocess
import sys
import time

from connection_settings import FILENAME, read_settings
from settings_server import PORT, make_server

FAILURE_LOG = None


def private_directory(path: Path) -> None:
    """Accept only an owned real directory; new runtime directories are private."""
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("unsafe_private_directory")


def private_bytes(path: Path) -> bytes:
    """Read a private regular file without following its final component."""
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
            raise ValueError("unsafe_private_file")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            return stream.read()
    finally:
        os.close(fd)


class RotatingLog:
    """Bound connector output to four private files of five MiB each."""
    def __init__(self, path: Path, limit: int = 5 * 1024 * 1024) -> None:
        self.path, self.limit = path, limit

    def write(self, data: bytes) -> None:
        """Rotate before appending; refuse redirected log targets."""
        if self.path.exists():
            info = self.path.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
                raise ValueError("unsafe_log_file")
        if self.path.exists() and self.path.stat().st_size + len(data) > self.limit:
            for index in range(3, 0, -1):
                source = self.path if index == 1 else Path(str(self.path) + "." + str(index - 1))
                target = Path(str(self.path) + "." + str(index))
                if source.exists():
                    source.replace(target)
        fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)


def main() -> int:
    """Hold an inherited process lock, forward termination, and let launchd supervise failures."""
    global FAILURE_LOG
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True, type=Path)
    args = parser.parse_args()
    root = args.root
    private_directory(root)
    private_directory(root / "logs")
    log = RotatingLog(root / "logs" / "connector.log")
    FAILURE_LOG = log
    lock_fd = os.open(root / "service.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    lock_info = os.fstat(lock_fd)
    if not stat.S_ISREG(lock_info.st_mode) or lock_info.st_uid != os.getuid() or stat.S_IMODE(lock_info.st_mode) != 0o600:
        raise ValueError("unsafe_service_lock")
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return 75
    config = json.loads(private_bytes(root / "service.json"))
    command = [config["nodeBinary"], str(Path(config["sourceDirectory"]) / "probe.mjs"), "listen", "--service",
               "--health-file", str(root / "health.json"), "--credentials", str(root / "app.credentials.json"),
               "--state", str(root / "probe.state.json"),
               "--turn-outbox", str(root / "turn-outbox"), "--codex-bin", config["codexBinary"],
               "--codex-thread", config["controlThreadId"], "--session-catalog", str(root / "session-catalog.json")]
    if config.get("chatManagementEnabled"):
        command += ["--chat-management-dir", str(root / "chat-management")]
    if config.get("chatMetadataDatabase"):
        command += ["--chat-metadata-db", config["chatMetadataDatabase"]]
    if config.get("allLocalReportsEnabled"):
        if not config.get("chatMetadataDatabase"):
            raise ValueError("global_reports_require_metadata_database")
        command += ["--report-policy", str(root / "report-policy.json")]
    if config.get("recentRepliesEnabled"):
        if not config.get("chatMetadataDatabase"):
            raise ValueError("recent_replies_require_metadata_database")
        command += ["--recent-replies-dir", str(root / "recent-replies")]
    if config.get("mediaEnabled"):
        command += ["--media-dir", str(root / "media")]
        for allowed_root in config.get("mediaAllowedRoots", []):
            command += ["--media-allowed-root", allowed_root]
    env = dict(os.environ)
    env.update({key: "" for key in ("http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY")})
    for key in ("FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_OWNER_OPEN_ID"):
        env.pop(key, None)
    env["CODEX_FEISHU_CONNECTION_SETTINGS"] = str(root / FILENAME)
    child = None
    child_epoch = None
    stopping_child_at = None
    exiting = False
    retry_at = 0

    def preference():
        try:
            return read_settings(root)
        except (OSError, ValueError):
            return {"enabled": None, "resumeAtMs": 0}

    def status():
        settings = preference()
        running = child is not None and child.poll() is None
        enabled = settings["enabled"]
        if enabled is None:
            return {"enabled": None, "status": "unavailable"}
        if not enabled:
            return {"enabled": False, "status": "stopping" if running else "paused"}
        result = {"enabled": True, "status": "starting"}
        if not running or settings["resumeAtMs"] != child_epoch:
            if settings["resumeAtMs"] == child_epoch and time.monotonic() < retry_at:
                result["status"] = "failed"
            return result
        try:
            health = json.loads(private_bytes(root / "health.json"))
            heartbeat = health["heartbeatAtMs"]
            if health["pid"] == child.pid and 0 <= time.time_ns() // 1_000_000 - heartbeat <= 35000:
                result["heartbeatAtMs"] = heartbeat
                if health["connected"] is True:
                    result["status"] = "connected" if health["ownerPaired"] is True else "unpaired"
                elif health.get("lastReadyAtMs"):
                    result["status"] = "reconnecting"
        except (OSError, ValueError, KeyError, TypeError):
            pass
        return result

    def stop(_signum, _frame):
        nonlocal exiting
        exiting = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    with make_server(root, status, port=config.get("settingsPort", PORT)) as server, selectors.DefaultSelector() as selector:
        selector.register(server, selectors.EVENT_READ)
        try:
            while not exiting or child is not None:
                settings = preference()
                enabled = settings["enabled"] and not exiting
                if child is not None:
                    if (not enabled or child_epoch != settings["resumeAtMs"]) and stopping_child_at is None:
                        stopping_child_at = time.monotonic()
                        if child.poll() is None:
                            child.terminate()
                    if stopping_child_at is not None and time.monotonic() - stopping_child_at > 10 and child.poll() is None:
                        child.kill()
                    if child.poll() is not None and len(selector.get_map()) == 1:
                        if stopping_child_at is None:
                            log.write((json.dumps({"event": "connector_exited", "exitCode": child.returncode}) + "\n").encode())
                            retry_at = time.monotonic() + 10
                        else:
                            retry_at = 0
                        child = None
                        stopping_child_at = None
                if enabled and child is None and (settings["resumeAtMs"] != child_epoch or time.monotonic() >= retry_at):
                    child_epoch = settings["resumeAtMs"]
                    child = subprocess.Popen(command, cwd=config["sourceDirectory"], env=env, stdin=subprocess.DEVNULL,
                                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, pass_fds=(lock_fd,))
                    selector.register(child.stdout, selectors.EVENT_READ)
                    selector.register(child.stderr, selectors.EVENT_READ)
                for key, _ in selector.select(timeout=0.25):
                    if key.fileobj is server:
                        if not exiting:
                            server.handle_request()
                        continue
                    chunk = os.read(key.fileobj.fileno(), 65536)
                    if chunk:
                        log.write(chunk)
                    else:
                        selector.unregister(key.fileobj)
                        key.fileobj.close()
        finally:
            if child is not None and child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=5)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        # Never put credentials, config bodies or a third-party error payload in the launchd log.
        if FAILURE_LOG is not None:
            try:
                FAILURE_LOG.write((json.dumps({'event': 'launcher_failed', 'errorType': type(error).__name__}) + '\n').encode())
            except Exception:
                pass
        sys.stderr.write("connector_launcher_failed:" + type(error).__name__ + "\n")
        sys.exit(1)
