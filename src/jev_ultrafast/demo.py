"""Loopback-only inspector for the Jev browser agent."""

import atexit
import base64
import json
import secrets
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from jev_ultrafast.agent import Agent
from jev_ultrafast.chrome import close_chrome, ensure_chrome
from jev_ultrafast.config import DEMO_HOST, MAX_STEPS, TRADERIE_LATEST_DIR, Settings, get_settings, load_dotenv
from jev_ultrafast.traderie import TRADERIE_D2R_URL, advance, build_goal, clean_item_name, new_market, save_report
from jev_ultrafast.traderie.site import LOAD_MORE_LIMIT, VIEW_NAMES, phase_finish_rule, validate_load_more
from jev_ultrafast.usage import usage_summary

ROOT = Path(__file__).parent
PORT = Settings.demo_port  # replaced in main() once .env is loaded
ORIGIN = f"http://127.0.0.1:{PORT}"
PAGE_FIELDS = ("url", "title", "text", "actions", "scroll", "omitted_actions", "fingerprint", "w", "h")
TOKEN = secrets.token_urlsafe(32)
LOCK = threading.Lock()
AGENT = None
OUTPUT_DIR = TRADERIE_LATEST_DIR
RUN: dict = {}  # demo-owned fields; AGENT.state is only changed through AGENT.command


def _trim_decisions(decisions):
    """Copy for the browser: the last decision keeps its request, earlier ones only the ranking summary."""
    brief = ("operation", "choice", "probabilities", "usage", "latency_ms",
             "label", "probability", "target_probability", "reasked", "phase", "step", "alternatives")
    last_keys = (*brief, "request", "target", "target_probabilities", "operation_probabilities")
    return [
        {k: d[k] for k in (last_keys if i == len(decisions) - 1 else brief) if k in d}
        for i, d in enumerate(decisions)
    ]


PHASE_LABELS = {"trading": "階段 1：目前掛單", "recent_trades": "階段 2：近期成交"}


def _phase_labels():
    """Short names for the plan boxes; the full goal text sits in a collapsible block on the page."""
    if not AGENT:
        return []
    names = AGENT.phase_names
    if all(name in PHASE_LABELS for name in names):
        return [PHASE_LABELS[name] for name in names]
    return [f"階段 {i + 1}：{goal[:30]}…" for i, goal in enumerate(AGENT.state["plan"])]


def response_state():
    state = AGENT.snapshot() if AGENT else {"page": None, "status": "idle", "history": [], "decision": None}
    usage = None
    if "decisions" in state:
        usage = usage_summary(state["decisions"], state["history"])
        state["decisions"] = _trim_decisions(state["decisions"])
    market = dict(RUN.get("market", {}))
    for key in VIEW_NAMES:
        if key in market:
            view = {k: v for k, v in market[key].items() if k != "text"}
            market[key] = {**view, "text_length": len(market[key]["text"])}
    page = state.get("page")
    if page:
        shot = page.get("screenshot")
        page = {k: page[k] for k in PAGE_FIELDS if k in page}
        page["screenshot_id"] = format(hash(shot) & 0xFFFFFFFF, "x") if shot else None
        state["page"] = page
    run = {k: v for k, v in RUN.items() if k != "report_md"}
    return {
        **state,
        **run,
        **({"market": market} if market else {}),
        "report_ready": bool(RUN.get("report_md")),
        "max_steps": MAX_STEPS,
        "usage": usage,
        "phase_labels": _phase_labels(),
    }


def close_browser():
    global AGENT
    try:
        if AGENT:
            AGENT.close()
    finally:
        AGENT = None
        RUN.clear()


def _reset_command(body):
    """A fresh run: a new Agent on the Traderie D2R URL and demo-owned fields for it."""
    global AGENT
    item = clean_item_name(body.get("goal", ""))
    if len(item) > 200:
        raise ValueError("Item name must be 1–200 characters")
    load_more = validate_load_more(body.get("load_more", LOAD_MORE_LIMIT))
    get_settings().require_typesafe_api_key()  # before Chrome starts, not on the first step
    close_browser()
    AGENT = Agent(
        TRADERIE_D2R_URL,
        build_goal(item, load_more),
        text=item,
        screenshots=True,
        finish_phase_after=phase_finish_rule(load_more),
    )
    RUN.update(item_name=item, market=new_market(), report_md=None)


def _tick_command(body):
    if AGENT is None:
        raise ValueError("Start a demo first")
    AGENT.command("tick", body)
    advance(AGENT, RUN["item_name"], RUN["market"])


def _report_command(_body):
    if AGENT is None:
        raise ValueError("Start a demo first")
    verification = RUN["market"]["verification"]
    if verification is None:
        raise ValueError("Agent 尚未完成兩段讀取，無法產生報告")
    RUN["report_md"] = save_report(RUN["item_name"], RUN["market"], OUTPUT_DIR)
    if RUN["report_md"] is None:
        raise ValueError("檢查未通過，不產生報告：" + ", ".join(verification["failed_checks"]))


COMMANDS = {"reset": _reset_command, "tick": _tick_command, "report": _report_command}


def command(name, body):
    handler = COMMANDS.get(name)
    if handler is None:
        raise ValueError("Unknown command")
    handler(body)
    return response_state()


class Handler(BaseHTTPRequestHandler):
    def forbidden(self):
        """403 unless the request comes from the local demo page: Host check here, token and Origin for POST."""
        return self.headers.get("Host") != f"127.0.0.1:{PORT}"

    def send(self, status, content, mime="application/json"):
        content = content if isinstance(content, bytes) else content.encode()
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(content)

    def do_GET(self):
        if self.forbidden():
            return self.send(403, "Forbidden", "text/plain")
        path = urlparse(self.path).path
        if path == "/api/state":
            with LOCK:
                return self.send(200, json.dumps(response_state()))
        if path == "/api/screenshot":
            with LOCK:
                shot = ((AGENT.state["page"] or {}).get("screenshot")) if AGENT else None
            if shot:
                return self.send(200, base64.b64decode(shot), "image/jpeg")
            return self.send(404, json.dumps({"error": "尚無畫面"}))
        if path == "/api/raw":
            view = parse_qs(urlparse(self.path).query).get("view", [""])[0]
            with LOCK:
                text = (RUN.get("market", {}).get(view) or {}).get("text") if view in VIEW_NAMES else None
            if text:
                return self.send(200, text, "text/plain; charset=utf-8")
            return self.send(404, json.dumps({"error": "尚未讀取"}))
        if path == "/api/report":
            with LOCK:
                report = RUN.get("report_md")
            if report:
                return self.send(200, report, "text/markdown; charset=utf-8")
            return self.send(404, json.dumps({"error": "尚未產生報告"}))
        files = {
            "/": ("index.html", "text/html"),
            "/app.js": ("app.js", "text/javascript"),
            "/csv.js": ("csv.js", "text/javascript"),
            "/style.css": ("style.css", "text/css"),
        }
        if path not in files:
            return self.send(404, "Not found", "text/plain")
        name, mime = files[path]
        content = (ROOT / "static" / name).read_text(encoding="utf-8").replace("__TOKEN__", TOKEN)
        self.send(200, content, mime + "; charset=utf-8")

    def do_POST(self):
        if (
            self.forbidden()
            or self.headers.get("X-Demo-Token") != TOKEN
            or self.headers.get("Origin") not in (None, ORIGIN)
        ):
            return self.send(403, json.dumps({"error": "Local demo requests only"}))
        if not LOCK.acquire(blocking=False):
            return self.send(409, json.dumps({"error": "A browser step is already running"}))
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length < 8192:
                raise ValueError("Invalid request size")
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise ValueError("The request body must be a JSON object")
            result = command(self.path.removeprefix("/api/"), body)
            self.send(200, json.dumps(result))
        except (ValueError, RuntimeError, TimeoutError) as error:
            self.send(400, json.dumps({"error": str(error)}))
        except Exception:
            traceback.print_exc()
            self.send(500, json.dumps({"error": "Local demo failed; no automatic retry. Reset to recover."}))
        finally:
            LOCK.release()

    def log_message(self, *_args):
        pass


def _prewarm_chrome():
    try:
        ensure_chrome()
    except Exception as exc:
        print(f"Chrome 預先啟動失敗（第一次查詢時會再試）：{exc}", flush=True)


def main():
    global PORT, ORIGIN
    load_dotenv()
    PORT = get_settings().demo_port
    ORIGIN = f"http://127.0.0.1:{PORT}"
    atexit.register(close_browser)
    server = ThreadingHTTPServer((DEMO_HOST, PORT), Handler)
    # Start Chrome now so the first 「開始查詢」 does not wait for it; a failure here is reported on the first run.
    threading.Thread(target=_prewarm_chrome, daemon=True).start()
    print(f"Jev Ultrafast: {ORIGIN}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        close_browser()
        close_chrome()


if __name__ == "__main__":
    main()
