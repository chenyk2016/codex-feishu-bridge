"""Loopback-only settings UI for the supervised Feishu connector."""
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import secrets

from connection_settings import set_enabled

PAGE = Path(__file__).with_name("settings.html")
PORT = 59431


def make_server(root, get_status, port=PORT):
    token = secrets.token_urlsafe(32)

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.0"

        def log_message(self, *_args):
            pass

        def setup(self):
            self.request.settimeout(1)
            super().setup()

        def reply(self, status, content, content_type="application/json; charset=utf-8"):
            body = content if isinstance(content, bytes) else json.dumps(content).encode()
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            policy = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
            if content_type.startswith("text/html"):
                policy += f"; connect-src 'self'; script-src 'nonce-{token}'; style-src 'nonce-{token}'"
            self.send_header("Content-Security-Policy", policy)
            self.end_headers()
            self.wfile.write(body)

        def trusted_host(self):
            return self.headers.get_all("Host") == [f"127.0.0.1:{self.server.server_port}"]

        def do_GET(self):
            if not self.trusted_host():
                return self.reply(403, {"error": "forbidden"})
            if self.path == "/":
                return self.reply(200, PAGE.read_bytes().replace(b"__LOCAL_TOKEN__", token.encode()), "text/html; charset=utf-8")
            if self.path == "/api/connection":
                return self.reply(200, get_status())
            self.reply(404, {"error": "not_found"})

        def do_POST(self):
            origin = f"http://127.0.0.1:{self.server.server_port}"
            if (not self.trusted_host() or self.headers.get_all("Origin") != [origin]
                    or self.headers.get("X-Connection-Token") != token):
                return self.reply(403, {"error": "forbidden"})
            if self.path != "/api/connection":
                return self.reply(404, {"error": "not_found"})
            try:
                lengths = self.headers.get_all("Content-Length") or []
                if (len(lengths) != 1 or not 0 < int(lengths[0]) <= 128 or self.headers.get("Transfer-Encoding")
                        or self.headers.get_content_type() != "application/json"):
                    raise ValueError
                data = json.loads(self.rfile.read(int(lengths[0])))
                if not isinstance(data, dict) or set(data) != {"enabled"} or type(data["enabled"]) is not bool:
                    raise ValueError
            except (ValueError, TimeoutError):
                return self.reply(400, {"error": "invalid_request"})
            try:
                set_enabled(root, data["enabled"])
            except (ValueError, OSError):
                return self.reply(500, {"error": "settings_unavailable"})
            self.reply(200, get_status())

    return HTTPServer(("127.0.0.1", port), Handler)
