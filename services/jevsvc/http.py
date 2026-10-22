"""HTTP glue: one request pipeline, served by WSGI (Vercel) and BaseHTTPRequestHandler (dev server)."""

import hashlib
import json
import os
import traceback
from dataclasses import dataclass
from datetime import datetime, timezone
from http import HTTPStatus
from typing import Callable

from . import invites, tokens
from .invites import InviteError
from .store import StoreError, shared_store

MAX_BODY = 262144
ALLOWED_METHODS = "POST"
# The two refusals this transport itself can produce, and the single home of their message and code: the routes import
# them (app.py) so the same failure cannot come back with two different texts.
BAD_REQUEST = {"error": "請求格式錯誤", "code": "bad_request"}
NOT_CONFIGURED = {"error": "伺服器設定不完整", "code": "not_configured"}
HEADERS = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
}
# No CORS headers on purpose: the only client is the extension side panel, which reaches this origin through its
# manifest host permission. A web page therefore cannot read the answers, and because a body must be application/json
# (which a cross-site page can only send after a preflight that is never granted) it cannot burn a visitor's
# wrong-guess throttle with a no-cors text/plain POST either.
UNSUPPORTED_MEDIA = {"error": "請求格式錯誤", "code": "unsupported_media_type"}


@dataclass(frozen=True)
class Request:
    """What a transport knows about one request; `header(name)` is case-insensitive and returns None when absent."""

    method: str
    path: str
    content_length: str | None
    header: Callable[[str], str | None]
    read: Callable[[int], bytes]
    remote: str


def normalize_path(path: str) -> str:
    """The route key for a request path: no query, no fragment, no trailing slash."""
    return path.split("?", 1)[0].split("#", 1)[0].rstrip("/")


def client_key(request: Request) -> str:
    """Who is asking, as a short hash (the address itself is never stored): the address Vercel saw, else the proxy
    headers, else the socket.

    The leftmost entry of a forwarding chain is taken on purpose, and `tests/test_services.py` pins that choice: the
    deployment's own header is read first, and the only consumer is the throttle in front of 128-bit invite codes,
    which is not protecting a guessable secret. A security pass (2026-10) raised taking the rightmost entry instead;
    the owner kept it as it is, because which hop to trust is a property of the deployment, not of this function.
    """
    forwarded = (
        request.header("X-Vercel-Forwarded-For")
        or request.header("X-Real-IP")
        or request.header("X-Forwarded-For")
        or ""
    )
    address = forwarded.split(",")[0].strip() or request.remote or ""
    return hashlib.sha256(address.encode("utf-8")).hexdigest()[:16]


def _store_from_env():
    """The shared Redis store the deployment is configured with, or None (after logging what is missing)."""
    url = os.environ.get("KV_REST_API_URL")
    token = os.environ.get("KV_REST_API_TOKEN")
    for name, value in (("KV_REST_API_URL", url), ("KV_REST_API_TOKEN", token)):
        if not value:
            print(f"missing env: {name}", flush=True)
            return None
    return shared_store(url, token)


def process(raw_length, read_body, caller, route, store=None):
    """The request logic shared by every transport: returns (status, payload).
    `raw_length` is the Content-Length header as sent (or None): it is client input and may be junk; `caller` is the
    hashed client key from `client_key`, passed on to the route as the throttle key."""
    try:
        try:
            length = int(raw_length or 0)
        except ValueError:
            length = -1  # not a number at all: refused by the same check as a negative length
        if length < 0:
            return 400, BAD_REQUEST
        if length > MAX_BODY:
            return 413, {"error": "請求太大", "code": "too_large"}
        try:
            body = json.loads(read_body(length) or b"{}")
        except (ValueError, RecursionError):  # deeply nested brackets raise RecursionError
            return 400, BAD_REQUEST
        secret = os.environ.get("RUN_TOKEN_SECRET", "")
        if len(secret) < 32:
            print("missing or short env: RUN_TOKEN_SECRET", flush=True)
            return 500, NOT_CONFIGURED
        now = datetime.now(timezone.utc)
        # A step of a run carries a signed token: a forged, expired or malformed one is refused here, on the HMAC alone,
        # so garbage traffic costs no store command (the store is the paid, rate-limited part of the deployment).
        if isinstance(body, dict) and "run_token" in body:  # anything else is the route's own 400
            tokens.verify(secret, body["run_token"], now.timestamp())
        if store is None:
            store = _store_from_env()
            if store is None:
                return 500, NOT_CONFIGURED
        if store.run("GET", invites.PAUSE_KEY):  # the kill switch: `invite.py pause`
            return 503, {"error": "服務暫時停用，請稍後再試", "code": "paused"}
        return route(body, caller, store, secret, now)
    except InviteError as exc:
        return exc.status, {"error": exc.message, **({"code": exc.code} if exc.code else {})}
    except StoreError as exc:
        print(f"store error: {exc}", flush=True)
        return 503, {"error": "資料庫暫時無法連線", "code": "store_unavailable"}
    except Exception:
        traceback.print_exc()
        return 500, {"error": "伺服器錯誤", "code": "server_error"}


def handle(request: Request, routes, store=None):
    """Route one request: returns (status, payload or None, extra headers). Every transport goes through here."""
    route = routes.get(normalize_path(request.path))
    if route is None:
        return 404, {"error": "找不到", "code": "not_found"}, {}
    if request.method != "POST":
        return 405, {"error": "只接受 POST", "code": "method_not_allowed"}, {"Allow": ALLOWED_METHODS}
    if not (request.header("Content-Type") or "").lower().startswith("application/json"):
        return 415, UNSUPPORTED_MEDIA, {}
    status, payload = process(request.content_length, request.read, client_key(request), route, store)
    return status, payload, {}


def render(status, payload, extra):
    """(status line, headers, body bytes) for a `handle` result."""
    data = b"" if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = [*HEADERS.items(), *extra.items(), ("Content-Length", str(len(data)))]
    return f"{status} {HTTPStatus(status).phrase}", headers, data


def serve(handler, routes, store=None):
    """BaseHTTPRequestHandler transport (dev server): the handler's do_* methods all call this."""
    request = Request(
        method=handler.command,
        path=handler.path,
        content_length=handler.headers.get("Content-Length"),
        header=handler.headers.get,
        read=handler.rfile.read,
        remote=handler.client_address[0],
    )
    status, payload, extra = handle(request, routes, store)
    _, headers, data = render(status, payload, extra)
    handler.send_response(status)
    for name, value in headers:
        handler.send_header(name, value)
    handler.end_headers()
    handler.wfile.write(data)


def _environ_key(name):
    """The WSGI environ key of a request header: Content-Type has no HTTP_ prefix, every other header has one."""
    key = name.upper().replace("-", "_")
    return key if key == "CONTENT_TYPE" else "HTTP_" + key


def wsgi(environ, start_response, routes, store=None):
    """WSGI transport (Vercel): POST on the paths in `routes`."""
    request = Request(
        method=environ["REQUEST_METHOD"],
        path=environ.get("PATH_INFO", ""),
        content_length=environ.get("CONTENT_LENGTH"),
        header=lambda name: environ.get(_environ_key(name)),
        read=environ["wsgi.input"].read,
        remote=environ.get("REMOTE_ADDR", ""),
    )
    status, headers, data = render(*handle(request, routes, store))
    start_response(status, headers)
    return [data]
