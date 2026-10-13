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
from jev_ultrafast.model import action_space
from jev_ultrafast.traderie import TRADERIE_D2R_URL, build_goal, clean_item_name, new_market, save_report, step
from jev_ultrafast.traderie.site import LOAD_MORE_LIMIT, VIEW_NAMES, phase_finish_rule, validate_load_more
from jev_ultrafast.usage import usage_summary

ROOT = Path(__file__).parent
PORT = Settings.demo_port  # replaced in main() once .env is loaded
ORIGIN = f"http://127.0.0.1:{PORT}"
PAGE_FIELDS = ("url", "title", "text", "actions", "node_indices", "scroll", "omitted_actions", "fingerprint", "w", "h")
TOKEN = secrets.token_urlsafe(32)
LOCK = threading.Lock()
AGENT = None
OUTPUT_DIR = TRADERIE_LATEST_DIR
RUN: dict = {}  # demo-owned fields; AGENT.state is only changed through AGENT.command


def _pick(source, keys):
    """Only the named keys the source actually has, in the order given."""
    return {key: source[key] for key in keys if key in source}


def _omit(source, keys):
    """A copy of the mapping without the named keys."""
    return {key: value for key, value in source.items() if key not in keys}


def _node_indices(actions):
    """Each observed node and the element index `model.action_space` gave it, for the overlay's labels.

    `action_space` numbers its elements with the same indices the choice list shows (it skips nodes after
    `MAX_SAME_NAME_ELEMENTS` repeats), so the overlay can label each box with the number Jev actually chose.
    A select's options carry the index before the `:`.
    """
    _elements, targets, _controls = action_space(actions)
    return {action["node"]: target.split(":")[0] for group in targets.values() for target, action in group.items()}


def _trim_decisions(decisions):
    """Copy for the browser: the last decision keeps its request, earlier ones only the ranking summary."""
    brief = ("operation", "choice", "probabilities", "usage", "latency_ms",
             "label", "probability", "target_probability", "reasked", "phase", "step", "alternatives")
    last_keys = (*brief, "request", "target", "target_probabilities", "operation_probabilities")
    return [
        _pick(d, last_keys if i == len(decisions) - 1 else brief)
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


def _page_for_browser(page):
    """The page as the browser sees it: only the fields the overlay uses, each observed node's element index, and a
    content-addressed id for the screenshot (the image itself is fetched from `/api/screenshot`)."""
    screenshot = page.get("screenshot")
    trimmed = _pick({**page, "node_indices": _node_indices(page.get("actions") or [])}, PAGE_FIELDS)
    trimmed["screenshot_id"] = format(hash(screenshot) & 0xFFFFFFFF, "x") if screenshot else None
    return trimmed


def _market_views(market):
    """A copy of the market with each stored view's raw text replaced by its length (the browser fetches that text
    from `/api/raw?view=` on demand); every other key, such as the verification result, passes through unchanged."""
    views = dict(market)
    for name in VIEW_NAMES:
        if name in views:
            view = views[name]
            views[name] = {**_omit(view, ("text",)), "text_length": len(view["text"])}
    return views


def response_state():
    state = AGENT.snapshot() if AGENT else {"page": None, "status": "idle", "history": [], "decision": None}
    usage = None
    if "decisions" in state:
        usage = usage_summary(state["decisions"], state["history"])
        state["decisions"] = _trim_decisions(state["decisions"])
    market = _market_views(RUN.get("market", {}))
    page = state.get("page")
    if page:
        state["page"] = _page_for_browser(page)
    run = _omit(RUN, ("report_md",))
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
        raise ValueError("裝備名稱要 1 到 200 個字")
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


def _require_agent():
    if AGENT is None:
        raise ValueError("請先按「開始查詢」")


def _tick_command(_body):
    """One demo step: the controller's own `step`, so the work that tick made due is done even when it raised, and
    leftover work from an earlier step is finished before the next tick (the CLI's loop uses the same function)."""
    _require_agent()
    step(AGENT, RUN["item_name"], RUN["market"])


def _report_command(_body):
    _require_agent()
    verification = RUN["market"]["verification"]
    if verification is None:
        raise ValueError("Agent 尚未完成兩段讀取，無法產生報告")
    RUN["report_md"] = save_report(RUN["item_name"], RUN["market"], OUTPUT_DIR)
    if RUN["report_md"] is None:
        raise ValueError("檢查未通過，不產生報告")


COMMANDS = {"reset": _reset_command, "tick": _tick_command, "report": _report_command}


def command(name, body):
    handler = COMMANDS.get(name)
    if handler is None:
        raise ValueError("未知的指令")
    handler(body)
    return response_state()


class Handler(BaseHTTPRequestHandler):
    def forbidden(self):
        """403 unless the request comes from the local demo page: the Host check every request needs."""
        return self.headers.get("Host") != f"127.0.0.1:{PORT}"

    def forbidden_post(self):
        """403 unless a POST also carries this run's token and comes from the demo page (no Origin is allowed)."""
        return self.headers.get("X-Demo-Token") != TOKEN or self.headers.get("Origin") not in (None, ORIGIN)

    def send(self, status, content, mime="application/json"):
        content = content if isinstance(content, bytes) else content.encode()
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(content)

    def _serve_static(self, path):
        """The demo page itself: index.html and its assets, with this run's token substituted in."""
        files = {
            "/": ("index.html", "text/html"),
            "/app.js": ("app.js", "text/javascript"),
            "/csv.js": ("csv.js", "text/javascript"),
            "/style.css": ("style.css", "text/css"),
        }
        if path not in files:
            return self.send(404, "找不到", "text/plain")
        name, mime = files[path]
        content = (ROOT / "static" / name).read_text(encoding="utf-8").replace("__TOKEN__", TOKEN)
        self.send(200, content, mime + "; charset=utf-8")

    def _send_locked(self, getter, mime, missing):
        with LOCK:
            value = getter()
        if value:
            return self.send(200, value, mime)
        return self.send(404, json.dumps({"error": missing}))

    def do_GET(self):
        if self.forbidden():
            return self.send(403, "只接受本機的示範頁面", "text/plain")
        path = urlparse(self.path).path
        if path == "/api/state":
            with LOCK:
                return self.send(200, json.dumps(response_state()))
        if path == "/api/screenshot":
            return self._send_locked(
                lambda: base64.b64decode((AGENT.state["page"] or {}).get("screenshot") or "") if AGENT else None,
                "image/jpeg",
                "尚無畫面",
            )
        if path == "/api/raw":
            view = parse_qs(urlparse(self.path).query).get("view", [""])[0]
            return self._send_locked(
                lambda: (RUN.get("market", {}).get(view) or {}).get("text") if view in VIEW_NAMES else None,
                "text/plain; charset=utf-8",
                "尚未讀取",
            )
        if path == "/api/report":
            return self._send_locked(lambda: RUN.get("report_md"), "text/markdown; charset=utf-8", "尚未產生報告")
        self._serve_static(path)

    def do_POST(self):
        if self.forbidden() or self.forbidden_post():
            return self.send(403, json.dumps({"error": "只接受本機示範頁面的請求"}))
        if not LOCK.acquire(blocking=False):
            return self.send(409, json.dumps({"error": "已經有一個步驟在執行中，請等它結束"}))
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length < 8192:
                raise ValueError("請求大小不正確")
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise ValueError("請求內容必須是 JSON 物件")
            result = command(self.path.removeprefix("/api/"), body)
            self.send(200, json.dumps(result))
        except (ValueError, RuntimeError, TimeoutError) as error:
            self.send(400, json.dumps({"error": str(error)}))
        except Exception:
            traceback.print_exc()
            self.send(500, json.dumps({"error": "示範發生錯誤，不會自動重試；請重新整理這一頁，再按「開始查詢」。"}))
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
