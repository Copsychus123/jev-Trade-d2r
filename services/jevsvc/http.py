"""HTTP glue: one request pipeline, served by WSGI (Vercel) and BaseHTTPRequestHandler (dev server)."""

import json
import os
import traceback
from datetime import datetime, timezone
from http import HTTPStatus

from .invites import InviteError
from .store import Store, StoreError

MAX_BODY = 262144
CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
}


def _send(handler, status, payload):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(data)))
    for name, value in CORS.items():
        handler.send_header(name, value)
    handler.end_headers()
    handler.wfile.write(data)


def respond_options(handler):
    handler.send_response(204)
    for name, value in CORS.items():
        handler.send_header(name, value)
    handler.send_header("Content-Length", "0")
    handler.end_headers()


def _client_ip(handler) -> str:
    forwarded = handler.headers.get("X-Forwarded-For", "")
    return forwarded.split(",")[0].strip() or handler.client_address[0]


def process(length, read_body, ip, route, store=None):
    """The request logic shared by every transport: returns (status, payload)."""
    try:
        if length > MAX_BODY:
            return 413, {"error": "請求太大"}
        try:
            body = json.loads(read_body(length) or b"{}")
        except ValueError:
            return 400, {"error": "請求格式錯誤"}
        secret = os.environ.get("RUN_TOKEN_SECRET", "")
        if len(secret) < 32:
            print("missing or short env: RUN_TOKEN_SECRET", flush=True)
            return 500, {"error": "伺服器設定不完整"}
        if store is None:
            url = os.environ.get("KV_REST_API_URL")
            token = os.environ.get("KV_REST_API_TOKEN")
            for name, value in (("KV_REST_API_URL", url), ("KV_REST_API_TOKEN", token)):
                if not value:
                    print(f"missing env: {name}", flush=True)
                    return 500, {"error": "伺服器設定不完整"}
            store = Store(url, token)
        return route(body, ip, store, secret, datetime.now(timezone.utc))
    except InviteError as exc:
        return exc.status, {"error": exc.message}
    except StoreError as exc:
        print(f"store error: {exc}", flush=True)
        return 503, {"error": "資料庫暫時無法連線"}
    except Exception:
        traceback.print_exc()
        return 500, {"error": "伺服器錯誤"}


def respond(handler, route, store=None):
    """BaseHTTPRequestHandler transport (dev server)."""
    status, payload = process(
        int(handler.headers.get("Content-Length") or 0), handler.rfile.read, _client_ip(handler), route, store
    )
    _send(handler, status, payload)


def wsgi(environ, start_response, routes, store=None):
    """WSGI transport (Vercel): POST and OPTIONS on the paths in `routes`."""
    path = environ.get("PATH_INFO", "").rstrip("/")
    headers = [*CORS.items(), ("Content-Type", "application/json; charset=utf-8")]

    def reply(status, payload=None):
        data = b"" if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        start_response(f"{status} {HTTPStatus(status).phrase}", [*headers, ("Content-Length", str(len(data)))])
        return [data]

    route = routes.get(path)
    if route is None:
        return reply(404, {"error": "找不到"})
    if environ["REQUEST_METHOD"] == "OPTIONS":
        return reply(204)
    if environ["REQUEST_METHOD"] != "POST":
        return reply(405, {"error": "只接受 POST"})
    forwarded = environ.get("HTTP_X_FORWARDED_FOR", "")
    ip = forwarded.split(",")[0].strip() or environ.get("REMOTE_ADDR", "")
    length = int(environ.get("CONTENT_LENGTH") or 0)
    status, payload = process(length, environ["wsgi.input"].read, ip, route, store)
    return reply(status, payload)
