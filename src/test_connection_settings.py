"""Exercise the real local HTTP/supervision path with a network-free connector."""
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from urllib.error import HTTPError
from urllib.request import ProxyHandler, Request, build_opener

import connection_settings


class ConnectionSettingsChecks(unittest.TestCase):
    def test_pause_survives_restart_and_local_page_can_resume(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / "runtime"
            root.mkdir(mode=0o700)
            source = Path(__file__).resolve().parent
            worker = base / "worker"
            worker.write_text(f"#!{sys.executable}\n"
                              "import json, os, pathlib, sys, time\n"
                              "assert not any(key in os.environ for key in ('FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_OWNER_OPEN_ID'))\n"
                              "health = pathlib.Path(sys.argv[sys.argv.index('--health-file') + 1])\n"
                              "health.write_text(json.dumps(dict(pid=os.getpid(), connected=True, ownerPaired=True, "
                              "heartbeatAtMs=int(time.time()*1000))))\n"
                              "while True: time.sleep(1)\n")
            worker.chmod(0o700)
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0))
                port = sock.getsockname()[1]
            config = root / "service.json"
            config.write_text(json.dumps({"sourceDirectory": str(source), "nodeBinary": str(worker),
                                          "codexBinary": str(worker), "controlThreadId": "mock-chat", "settingsPort": port}))
            config.chmod(0o600)
            origin = f"http://127.0.0.1:{port}"
            opener = build_opener(ProxyHandler({}))

            def request(path="/api/connection", **kwargs):
                return opener.open(Request(origin + path, **kwargs), timeout=2).read()

            def status(expected):
                until = time.monotonic() + 5
                last = None
                while time.monotonic() < until:
                    try:
                        last = json.loads(request())
                        if last["status"] == expected:
                            return last
                    except OSError:
                        pass
                    time.sleep(.05)
                self.fail(f"Expected {expected}, last response: {last}")

            def start():
                return subprocess.Popen([sys.executable, str(source / "service-launcher.py"), "--root", str(root)],
                                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                        env={**os.environ, "FEISHU_APP_ID": "fixture", "FEISHU_APP_SECRET": "fixture",
                                             "FEISHU_OWNER_OPEN_ID": "fixture"})

            def set_enabled(token, enabled, sender=origin):
                return request(data=json.dumps({"enabled": enabled}).encode(),
                               headers={"Origin": sender, "X-Connection-Token": token, "Content-Type": "application/json"})

            def token():
                return re.search(rb'<script nonce="([^"]+)"', request("/")).group(1).decode()

            process = start()
            try:
                status("connected")
                previous = json.loads((root / "health.json").read_text())["pid"]
                for spoof in [
                    lambda: set_enabled(token(), False, "https://example.com"),
                    lambda: set_enabled("bad-token", False),
                    lambda: request(headers={"Host": "example.com"}),
                ]:
                    with self.assertRaises(HTTPError) as rejected:
                        spoof()
                    self.assertEqual(rejected.exception.code, 403)
                set_enabled(token(), False)
                self.assertEqual(status("paused"), {"enabled": False, "status": "paused"})
                with self.assertRaises(ProcessLookupError):
                    os.kill(previous, 0)
                process.terminate()
                process.wait(timeout=5)
                process = start()
                status("paused")
                set_enabled(token(), True)
                status("connected")
                self.assertNotEqual(previous, json.loads((root / "health.json").read_text())["pid"])
                resumed = connection_settings.read_settings(root)["resumeAtMs"]
                self.assertGreater(resumed, 0)
            finally:
                process.terminate()
                process.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
