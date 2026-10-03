"""Tests for scripts/capture_traderie.py minimal and debug artifact behaviors."""

import json

from scripts import capture_traderie

TRADING_SAMPLE = """
Apply this search for all
Danpire
(10)
1 X Harlequin Crest
PC • Softcore • Ladder • Reign Of The Warlock
159 Defense
Ethereal
Trading For
1 X Pul Rune
High Rune Value: 0.04
36 seconds ago
"""

RECENT_SAMPLE = """
They Give
1 X Harlequin Crest
PC • Softcore • Ladder • Reign Of The Warlock
+126 Defense
I Give
1 X Mal Rune
High Rune Value: 0
17 分鐘前
"""


class FakeCaptureBrowser:
    def __init__(self, _url):
        self.closed = False
        self.navigated = []
        self.observe_calls = 0

    def navigate(self, url, *, timeout=15):  # noqa: ARG002
        self.navigated.append(url)

    def evaluate(self, expression, *, await_promise=False):  # noqa: ARG002
        if "querySelector" in expression:
            return False
        if "outerHTML" in expression:
            return "<html><body>full outer html</body></html>"
        if "innerText" in expression:
            last_url = self.navigated[-1] if self.navigated else "https://traderie.com/diablo2resurrected/product/shako"
            return RECENT_SAMPLE if last_url.endswith("/recent") else TRADING_SAMPLE
        if "scrollTo" in expression:
            return None
        return None

    def observe(self, screenshot=False):  # noqa: ARG002
        self.observe_calls += 1
        last_url = self.navigated[-1] if self.navigated else "https://traderie.com/diablo2resurrected/product/shako"
        is_recent = last_url.endswith("/recent")
        text = RECENT_SAMPLE if is_recent else TRADING_SAMPLE
        title = "Harlequin Crest - Diablo II: Resurrected (D2R) Trade | Traderie"
        return {
            "url": last_url,
            "title": title,
            "text": text,
            "screenshot": "AQID",
            "actions": [],
        }

    def close(self):
        self.closed = True


def test_capture_and_analyze_minimal_produces_only_json_and_md(tmp_path):
    out_dir = tmp_path / "minimal_out"
    capture_traderie.capture_and_analyze(
        "https://traderie.com/diablo2resurrected/product/shako",
        out=str(out_dir),
        debug_artifacts=False,
        browser_cls=FakeCaptureBrowser,
    )

    created_files = sorted(p.name for p in out_dir.iterdir())
    assert created_files == ["analysis.json", "analysis_report.md"]

    analysis = json.loads((out_dir / "analysis.json").read_text(encoding="utf-8"))
    assert analysis["report_mode"] == "【模式 A】"
    assert analysis["item_name"] == "Harlequin Crest"
    assert "observed_at" in analysis
    assert "sources" in analysis
    assert len(analysis["valid_listings"]) == 1
    assert "raw_text" not in analysis["valid_listings"][0]
    assert analysis["valid_listings"][0]["seller"] == "Danpire"
    assert analysis["recent_trades_status"]["mode"] == "A"
    assert len(analysis["recent_trades_status"]["trades"]) == 1
    assert analysis["recent_trades_status"]["trades"][0]["price"] == "1 X Mal Rune"


def test_capture_and_analyze_debug_artifacts_preserves_html_txt_jpg(tmp_path):
    out_dir = tmp_path / "debug_out"
    capture_traderie.capture_and_analyze(
        "https://traderie.com/diablo2resurrected/product/shako",
        out=str(out_dir),
        debug_artifacts=True,
        browser_cls=FakeCaptureBrowser,
    )

    names = {p.name for p in out_dir.iterdir()}
    # Contains analysis outputs
    assert "analysis.json" in names
    assert "analysis_report.md" in names
    # Contains debug evidence
    assert "captured_at.txt" in names
    assert "trading.html" in names
    assert "trading.txt" in names
    assert "trading.jpg" in names
    assert "trading.observe.json" in names
    assert "recent.html" in names
    assert "recent.jpg" in names
    assert "trading-bottom.jpg" in names
