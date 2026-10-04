"""Local backend with an in-memory store: uv run python services/dev_server.py."""

import os
import secrets
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "core"))

from jev_ultrafast.config import load_dotenv  # noqa: E402
from jevsvc import app, invites  # noqa: E402
from jevsvc.http import respond, respond_options  # noqa: E402
from jevsvc.store import MemoryStore  # noqa: E402

HOST, PORT = "127.0.0.1", 8788


def main() -> None:
    load_dotenv()
    if len(os.environ.get("RUN_TOKEN_SECRET", "")) < 32:
        os.environ["RUN_TOKEN_SECRET"] = secrets.token_hex(32)
    store = MemoryStore()
    routes = {
        "/api/run/start": app.run_start,
        "/api/choose": app.choose_route,
        "/api/run/base": app.pick_base_route,
    }

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            route = routes.get(self.path.split("?")[0])
            if route is None:
                self.send_error(404)
            else:
                respond(self, route, store)

        def do_OPTIONS(self):
            respond_options(self)

        def log_message(self, format, *args):
            pass

    code = invites.add(store, "dev")
    print(f"開發用邀請碼：{code}", flush=True)
    print(f"Jev backend: http://{HOST}:{PORT}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
