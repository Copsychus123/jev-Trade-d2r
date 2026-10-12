"""Real-Chrome check of the demo page's result rendering: `uv run --group e2e python scripts/demo_e2e.py [--headed]`.

The core flow's most visible artefact is the local demo page showing the two tables, and that page is the one
player-facing surface with no automated check (the panel has `scan_e2e`, the readers have `ocr_e2e`). This script
needs no quota, no Traderie login and no extension: it serves the demo's own static files from a throwaway server
whose `/api/state` is the shape `demo.response_state()` really produces (called with a stubbed agent), then renders
it in the dedicated Chrome the demo itself uses and reads the result out of the DOM.

What it asserts (see `verdict`, which is pure and unit-tested offline in `tests/test_e2e_scripts.py`):
  1. the page switched itself to 查詢結果 once the market carried a verification, and the tab says 掛單 3，成交 2;
  2. the two tables are side by side in the wide layout and carry 7 and 5 columns;
  3. the environment column joins the parts that exist (`Playstation / Hardcore / Ladder`) and shows — when none do;
  4. a seller name containing `|` and a newline reaches the cell as text (`a|b c`), never as markup;
  5. the high-rune extra column is merged under the price in the wide layout (`.col-merge`);
  6. both tables offer their own 匯出 CSV button and both 網頁原文 blocks are there.

Writes artifacts/demo-e2e/report.json and artifacts/demo-e2e/demo-results.jpg. Exit 0 all good, 1 an assertion
failed, 2 environment. It drives the same dedicated Chrome (port 9355, `src/.tmp-jev-chrome`) the demo and the CLI
use, so it must not run while either of them is running, nor while another member of the Chrome e2e family is.
"""

import argparse
import base64
import json
import sys
import threading
import types
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

TEXT = "Trading For\n1 X Vex Rune\n3 days ago\n"
OUT = ROOT / "artifacts" / "demo-e2e"

# One run's market, with the shapes that make the page's rendering interesting: a seller name carrying `|` and a
# newline, a row whose environment parts are all empty, a row whose are all there, both `has_more` answers.
MARKET = {
    "item_name": "Harlequin Crest",
    "lookup": {"layer": "table"},
    "verification": {"passed": True, "failed_checks": [], "view_reasons": {}},
    "trading": {
        "status": "PASSED", "reason": None, "reason_code": None, "url": "https://traderie.com/x/product/1",
        "title": "Harlequin Crest", "observed_at": "2026-10-10T12:00:00", "has_more": True, "settled": True,
        "text": TEXT,
        "rows": [
            {"seller": "a|b\nc", "ask": "1 Vex Rune", "high_rune_value": "Vex", "posted_time": "3 days ago",
             "platform": "PC", "mode": "Softcore", "ladder": "Ladder", "defense": "141", "game_version": "D2R"},
            {"seller": "賣家二", "ask": "Ist", "high_rune_value": None, "posted_time": "2 days ago",
             "platform": "", "mode": "", "ladder": "", "defense": None, "game_version": "Classic (Base Game)"},
            {"seller": "Third", "ask": "Pul", "high_rune_value": "Pul", "posted_time": "1 day ago",
             "platform": "Playstation", "mode": "Hardcore", "ladder": "Ladder", "defense": "0", "game_version": "D2R"},
        ],
    },
    "recent_trades": {
        "status": "PASSED", "reason": None, "reason_code": None, "url": "https://traderie.com/x/product/1",
        "title": "Harlequin Crest", "observed_at": "2026-10-10T12:00:05", "has_more": False, "settled": True,
        "text": TEXT,
        "rows": [
            {"buyer_or_seller": "They Give", "price": "1 Um", "trade_time": "5 hours ago", "platform": "PC",
             "mode": "Softcore", "ladder": "Ladder", "game_version": "D2R"},
            {"buyer_or_seller": "I Give", "price": "1 Mal", "trade_time": "1 day ago", "platform": "Xbox",
             "mode": "Hardcore", "ladder": "Non Ladder", "game_version": "D2R"},
        ],
    },
}

STATE = {
    "browser": None, "goal": "Find Harlequin Crest", "page": {"url": "https://traderie.com/x", "title": "t",
    "text": "", "scroll": {"y": 0}, "actions": []},
    "decision": None, "history": [], "status": "done", "plan": ["Find Harlequin Crest"], "plan_index": 0,
    "phase": "recent_trades", "phase_start": 0, "rule_events": [], "decisions": [], "usage": {},
    "awaiting_handoff": False, "elapsed_ms": 42000, "started_at": 0, "attempts": 0, "stale_events": {},
    "scope_blocked_reason": None,
}

PROBE = """
(() => JSON.stringify({
  tab: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent.trim() ?? null,
  tabResults: document.getElementById('tab-results-label')?.textContent ?? null,
  tables: [...document.querySelectorAll('table')].map((t) => ({
    width: t.getBoundingClientRect().width,
    rows: [...t.querySelectorAll('tr')].map((r) => [...r.children].map((c) => c.textContent)),
  })),
  merged: [...document.querySelectorAll('.col-merge')].map((el) => el.textContent),
  csv: document.querySelectorAll('button[id$="-csv"], .csv').length,
  details: document.querySelectorAll('details').length,
  status: document.getElementById('status')?.textContent?.trim() ?? null,
}))()
"""


def scan_state() -> dict:
    """The `/api/state` body the page receives: the demo's own function, with a stubbed agent."""
    from jev_ultrafast import demo

    demo.AGENT = types.SimpleNamespace(
        state=STATE, snapshot=lambda: STATE, phase_names=["trading", "recent_trades"]
    )
    demo.RUN = {"item_name": "Harlequin Crest", "market": MARKET, "report_md": "# report\n"}
    body = demo.response_state()
    demo.AGENT = None
    demo.RUN.clear()
    return body


def serve(port: int = 0) -> tuple[ThreadingHTTPServer, int]:
    """The demo's static files plus the four endpoints the page asks for; nothing is authenticated."""
    static = {
        "/": ("index.html", "text/html"),
        "/style.css": ("style.css", "text/css"),
        "/app.js": ("app.js", "text/javascript"),
        "/csv.js": ("csv.js", "text/javascript"),
        "/tokens.css": ("tokens.css", "text/css"),
    }

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def _send(self, body: bytes, mime: str) -> None:
            self.send_response(200)
            self.send_header("Content-Type", mime + "; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):  # noqa: N802 - the base class's name
            path = self.path.split("?")[0]
            if path in static:
                name, mime = static[path]
                text = (ROOT / "src" / "jev_ultrafast" / "static" / name).read_text(encoding="utf-8")
                return self._send(text.replace("__TOKEN__", "demo-e2e").encode("utf-8"), mime)
            if path == "/api/state":
                return self._send(json.dumps(scan_state()).encode("utf-8"), "application/json")
            if path == "/api/report":
                body = json.dumps({"report": "# Harlequin Crest 市場資料\n\n| 賣家 |\n| --- |\n"})
                return self._send(body.encode("utf-8"), "application/json")
            if path == "/api/raw":
                return self._send(json.dumps({"text": TEXT}).encode("utf-8"), "application/json")
            self.send_error(404)

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, server.server_address[1]


def read_page(url: str) -> dict:
    """Render the page in the demo's own dedicated Chrome and read the result out of the DOM."""
    from jev_ultrafast.browser import Browser

    report: dict = {}
    browser = Browser(url, images=True)
    try:
        page = browser.observe(screenshot=True)
        shot = (page.get("screenshot") or "").split(",", 1)[-1]
        OUT.mkdir(parents=True, exist_ok=True)
        if shot:
            (OUT / "demo-results.jpg").write_bytes(base64.b64decode(shot))
        report.update(json.loads(browser.evaluate(PROBE)))
        report["title"] = page["title"]
    finally:
        browser.close()
    return report


def _two_table_failures(left: dict, right: dict) -> list[str]:
    """The layout, column and row assertions of the two side-by-side tables (掛單 left, 成交 right)."""
    failures = []
    if left["width"] < right["width"]:
        failures.append(f"寬版排版應該掛單在左且較寬：{left['width']} / {right['width']}")
    if len(left["rows"][0]) != 7 or len(right["rows"][0]) != 5:
        failures.append(f"欄數應為 7 與 5，實際 {len(left['rows'][0])} 與 {len(right['rows'][0])}")
    if len(left["rows"]) != 4 or len(right["rows"]) != 3:
        failures.append(f"列數應為 4（含標題）與 3，實際 {len(left['rows'])} 與 {len(right['rows'])}")
    head = left["rows"][0]
    # The narrow-layout rule keeps every column in the DOM: the price cell carries both names, and the row still
    # has seven cells (the extra one is hidden by CSS in the wide layout, and the CSV still exports it).
    if head[0] != "賣家" or "高符文價值" not in head[1] or len(left["rows"][1]) != 7:
        failures.append(f"掛單表的欄位不對：{head}")
    seller = left["rows"][1][0]
    if seller != "a|b\nc":  # the raw text, so markup and mangling would both show up here
        failures.append(f"賣家名的 | 與換行應以文字呈現，實際 {seller!r}")
    if left["rows"][2][4] != "—" or left["rows"][3][4] != "Playstation / Hardcore / Ladder":
        empty, joined = left["rows"][2][4], left["rows"][3][4]
        failures.append(f"環境欄應在沒有值時顯示 —、有值時以 / 連接：{empty!r} / {joined!r}")
    if right["rows"][1][3] != "PC / Softcore / Ladder" or right["rows"][2][3] != "Xbox / Hardcore / Non Ladder":
        failures.append(f"成交表的環境欄不對：{right['rows'][1][3]!r} / {right['rows'][2][3]!r}")
    return failures


def verdict(report: dict) -> list[str]:
    """The assertions above; returns one Traditional Chinese message per failed one. Pure: no Chrome needed."""
    failures = []
    tab = report.get("tab") or ""
    if "查詢結果" not in tab or "掛單 3" not in tab or "成交 2" not in tab:
        failures.append(f"畫面沒有自動切到查詢結果、或筆數不對：{report.get('tab')!r}")
    tables = report.get("tables") or []
    if len(tables) != 2:
        failures.append(f"應該有兩張表，實際 {len(tables)} 張")
    else:
        left, right = tables
        failures += _two_table_failures(left, right)
    if "通過檢查" not in (report.get("status") or ""):
        failures.append(f"上方狀態列應說明兩段都通過檢查，實際 {report.get('status')!r}")
    merged = report.get("merged") or []
    if not any("Vex" in entry for entry in merged):
        failures.append(f"寬版要把高符文價值以小字併在要價下，實際 {merged!r}")
    if (report.get("csv") or 0) < 2:
        failures.append(f"兩張表各自要有匯出 CSV 的按鈕，實際 {report.get('csv')!r} 個")
    if (report.get("details") or 0) < 2:
        failures.append(f"兩張表都要有網頁原文區塊，實際 {report.get('details')!r} 個")
    return failures


def main() -> int:
    parser = argparse.ArgumentParser(description="Real-Chrome check of the demo page's result rendering.")
    parser.add_argument("--headed", action="store_true", help="顯示 Chrome 視窗（預設無視窗）")
    args = parser.parse_args()
    if args.headed:
        # The package's Browser always runs the dedicated Chrome headless; note it and continue.
        print("（這個檢查固定用專用 Chrome；--headed 只在其他 e2e 有意義）", flush=True)

    server, port = serve()
    url = f"http://127.0.0.1:{port}/"
    print(f"demo-e2e: 以 {url} 渲染（專用 Chrome、零額度）", flush=True)
    try:
        report = read_page(url)
    except Exception as error:  # environment: the dedicated Chrome is busy, missing, or the page never loaded
        print(f"環境問題：{error}", file=sys.stderr)
        return 2
    finally:
        server.shutdown()
    failures = verdict(report)
    OUT.mkdir(parents=True, exist_ok=True)
    payload = json.dumps({**report, "failures": failures}, ensure_ascii=False, indent=2)
    (OUT / "report.json").write_text(payload, encoding="utf-8")
    if failures:
        for line in failures:
            print(f"✗ {line}", file=sys.stderr)
        return 1
    print(
        f"通過：查詢結果 {report.get('tab')}、兩張表 {len(report.get('tables') or [])} 張、"
        "截圖 artifacts/demo-e2e/demo-results.jpg"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
