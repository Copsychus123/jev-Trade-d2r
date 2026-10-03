"""Real end-to-end checks: real Chrome, TypeSafe and Traderie. Run with `pytest -m live`."""

import json
import os
import re
import subprocess
import sys
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path

import httpx
import pytest

from jev_ultrafast import demo
from jev_ultrafast.chrome import close_chrome
from jev_ultrafast.config import MAX_STEPS, load_dotenv

pytestmark = pytest.mark.live

load_dotenv()
if not os.environ.get("TYPESAFE_API_KEY"):
    pytest.skip("需要 .env 的 TYPESAFE_API_KEY", allow_module_level=True)

ITEM = "Harlequin Crest"
ROOT = Path(__file__).resolve().parent.parent.parent


@pytest.fixture(scope="module")
def journey(tmp_path_factory):
    mp = pytest.MonkeyPatch()
    out = tmp_path_factory.mktemp("latest")
    mp.setattr(demo, "OUTPUT_DIR", out)
    server = ThreadingHTTPServer(("127.0.0.1", 0), demo.Handler)
    port = server.server_address[1]
    mp.setattr(demo, "PORT", port)
    mp.setattr(demo, "ORIGIN", f"http://127.0.0.1:{port}")
    threading.Thread(target=server.serve_forever, daemon=True).start()
    client = httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=300)
    try:
        index = client.get("/")
        app_js = client.get("/app.js")
        token = re.search(r'name="demo-token" content="([^"]+)"', index.text).group(1)

        def post(name, body):
            return client.post(f"/api/{name}", json=body, headers={"X-Demo-Token": token})

        reset = post("reset", {"goal": ITEM})
        early_report = post("report", {})
        phases, last, error, trading_read_before_recent = [], None, None, False
        for _ in range(MAX_STEPS * 2):
            r = post("tick", {})
            if r.status_code != 200:
                error = f"{r.status_code} {r.text}"
                break
            last = r.json()
            phases.append(last["phase"])
            market = last["market"]
            if market["trading"]["status"] == "PASSED" and market["recent_trades"]["status"] == "NOT_RUN":
                trading_read_before_recent = True
            if last["status"] in {"done", "blocked"}:
                break
        report = post("report", {})
        download = client.get("/api/report")
        raw_recent = client.get("/api/raw?view=recent_trades")
        # The CLI test starts its own Agent; do not leave this tab (and Chrome) open next to it.
        with demo.LOCK:
            demo.close_browser()
        close_chrome()
        yield {
            "out": out,
            "index": index,
            "app_js": app_js,
            "reset": reset,
            "early_report": early_report,
            "phases": phases,
            "last": last,
            "error": error,
            "trading_read_before_recent": trading_read_before_recent,
            "report": report,
            "raw_recent": raw_recent,
            "download": download,
        }
    finally:
        server.shutdown()
        with demo.LOCK:
            demo.close_browser()
        client.close()
        mp.undo()


def test_inspector_page_loads(journey):
    index = journey["index"]
    assert index.status_code == 200
    assert '<meta name="demo-token"' in index.text
    assert "__TOKEN__" not in index.text
    assert journey["app_js"].status_code == 200


def test_reset_opens_traderie(journey):
    reset = journey["reset"]
    assert reset.status_code == 200, reset.text
    state = reset.json()
    assert state["page"]["url"].split("//", 1)[1].split("/", 1)[0] in {"traderie.com", "www.traderie.com"}
    assert state["page"]["url"].endswith("/diablo2resurrected")
    assert state["page"]["screenshot_id"]
    assert len(state["plan"]) == 2
    assert state["item_name"] == ITEM


def test_report_refused_before_both_views_are_read(journey):
    early = journey["early_report"]
    assert early.status_code == 400
    assert "尚未完成" in early.json()["error"]


def test_agent_clicked_recent_trades_and_read_trading_first(journey):
    last = journey["last"]
    assert last, f"no tick succeeded: {journey['error']}"
    history = last["history"][-1] if last["history"] else None
    assert last["status"] == "done", f"status={last['status']} last={history} error={journey['error']}"
    assert "trading" in journey["phases"] and "recent_trades" in journey["phases"]
    assert last["phase"] == "recent_trades"
    assert last["page"]["url"].split("?", 1)[0].rstrip("/").endswith("/recent")
    assert any(h["kind"] == "click" and "Recent Trades" in h["action"] for h in last["history"])
    assert journey["trading_read_before_recent"], "Trading was not shown before the Recent Trades step finished"


def test_views_read_verified_and_report_written(journey):
    report_resp, out, last = journey["report"], journey["out"], journey["last"]
    market = last["market"]
    usage = last["usage"]
    assert usage["steps"] == len(last["history"]) > 0
    assert 0 < usage["calls"] < usage["steps"]  # the loading cycle is run by rule, so not every step asked Jev
    assert usage["input_tokens"] > 0
    assert usage["cost_usd"] == pytest.approx(usage["input_tokens"] / 1e6 * 0.042 + usage["output_tokens"] / 1e6 * 0)
    assert last["phase_labels"] == ["階段 1：目前掛單", "階段 2：近期成交"]
    assert all(d["label"] and d["usage"] for d in last["decisions"])
    assert all(0 <= d["probability"] <= 1 for d in last["decisions"])
    # Load More was pressed: the first page holds 50 listings / 20 trades.
    assert len(market["trading"]["rows"]) > 50 and len(market["recent_trades"]["rows"]) > 20
    assert isinstance(market["trading"]["has_more"], bool)
    # A site that ships aria-label="[object Object]" must not leak that text as an element name.
    assert not any("[object" in a["label"] for a in last["page"]["actions"])
    for key in ("trading", "recent_trades"):
        assert market[key]["status"] == "PASSED", (key, market[key]["reason"])
        assert market[key]["rows"], key
    recent = market["recent_trades"]
    raw = journey["raw_recent"]
    assert raw.status_code == 200
    assert len(recent["rows"]) == sum(1 for line in raw.text.splitlines() if line.strip().lower() == "they give")
    v = market["verification"]
    assert v["passed"] is True, f"failed_checks={v.get('failed_checks')} reasons={v.get('view_reasons')}"
    assert report_resp.status_code == 200, report_resp.text
    for name in ("market_report.md", "market.json", "verification.json"):
        assert (out / name).exists(), name
    report = (out / "market_report.md").read_text(encoding="utf-8")
    assert report_resp.json()["report_ready"] is True
    assert journey["download"].text == report
    assert ITEM in report
    assert all(row["ask"] in report for row in market["trading"]["rows"][:3] if row["ask"])
    assert all(row["price"] in report for row in recent["rows"][:3])


def test_report_download_matches_file(journey):
    download = journey["download"]
    assert download.status_code == 200
    assert download.text == (journey["out"] / "market_report.md").read_text(encoding="utf-8")


def test_cli_example_writes_report(tmp_path):
    proc = subprocess.run(
        [sys.executable, "scripts/traderie.py", ITEM, "--output", str(tmp_path)],
        cwd=ROOT,
        env=os.environ.copy(),
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=1200,
    )
    assert proc.returncode == 0, (proc.stdout + proc.stderr)[-2000:]
    for name in ("market_report.md", "market.json", "verification.json", "state.json"):
        assert (tmp_path / name).exists(), name
    assert json.loads((tmp_path / "verification.json").read_text(encoding="utf-8"))["passed"] is True
    market = json.loads((tmp_path / "market.json").read_text(encoding="utf-8"))
    assert market["trading"]["rows"] and market["recent_trades"]["rows"]
