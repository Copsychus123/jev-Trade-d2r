"""Local backend with an in-memory store: uv run python services/dev_server.py."""

import os
import secrets
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from jev_ultrafast.config import load_dotenv  # noqa: E402
from jevsvc import invites  # noqa: E402
from jevsvc.app import ROUTES  # noqa: E402
from jevsvc.http import serve  # noqa: E402
from jevsvc.store import MemoryStore  # noqa: E402

HOST, PORT = "127.0.0.1", 8788


def make_server(store, routes=None) -> ThreadingHTTPServer:
    """The same routes and request pipeline as Vercel, over a plain HTTP server.

    `routes` defaults to the real table; the stub backend in scripts/stub_backend.py passes its own, with a chooser
    injected behind /api/choose, so the handler below is the single place the request pipeline is built.
    """
    routes = ROUTES if routes is None else routes

    class Handler(BaseHTTPRequestHandler):
        def _serve(self):
            serve(self, routes, store)

        do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = _serve

        def log_message(self, format, *args):
            pass

    return ThreadingHTTPServer((HOST, PORT), Handler)


def ensure_run_secret() -> None:
    """Replace a missing or too-short RUN_TOKEN_SECRET with a fresh random one (local dev and the stub backend)."""
    if len(os.environ.get("RUN_TOKEN_SECRET", "")) < 32:
        os.environ["RUN_TOKEN_SECRET"] = secrets.token_hex(32)


def main() -> None:
    load_dotenv()
    ensure_run_secret()
    store = MemoryStore()
    code = invites.add(store, "dev")
    print(f"開發用邀請碼：{code}", flush=True)
    print(f"Jev backend: http://{HOST}:{PORT}", flush=True)
    make_server(store).serve_forever()


if __name__ == "__main__":
    main()
