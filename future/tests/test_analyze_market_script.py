"""Integration tests for scripts/analyze_market.py run_analysis."""

import json

from scripts import analyze_market

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

RECENT_OBSERVE_SAMPLE = {
    "url": "https://www.traderie.com/diablo2resurrected/product/harlequin-crest/recent",
    "text": RECENT_SAMPLE,
}


def _write(folder, name, content):
    path = folder / name
    if isinstance(content, str):
        path.write_text(content, encoding="utf-8")
    else:
        path.write_text(json.dumps(content), encoding="utf-8")
    return path


def test_run_analysis_prefers_trading_html(tmp_path, monkeypatch):
    folder = tmp_path
    _write(folder, "trading.html", TRADING_SAMPLE)
    _write(folder, "trading.txt", "unrelated txt fallback content")
    _write(folder, "recent.txt", RECENT_SAMPLE)
    calls = []
    monkeypatch.setattr(
        analyze_market, "parse_trading_txt",
        lambda *a, **k: calls.append("txt") or [],
    )
    monkeypatch.setattr(
        analyze_market, "parse_trading_html",
        lambda *a, **k: calls.append("html") or [],
    )

    analyze_market.run_analysis(folder)

    assert calls == ["html"]
    out_json = json.loads((folder / "analysis.json").read_text(encoding="utf-8"))
    report_md = (folder / "analysis_report.md").read_text(encoding="utf-8")
    assert isinstance(out_json, dict)
    assert out_json["report_mode"]
    assert report_md.strip() != ""


def test_run_analysis_falls_back_to_trading_txt(tmp_path, monkeypatch):
    folder = tmp_path
    _write(folder, "trading.txt", TRADING_SAMPLE)
    calls = []
    monkeypatch.setattr(
        analyze_market, "parse_trading_html",
        lambda *a, **k: calls.append("html") or [],
    )
    monkeypatch.setattr(
        analyze_market, "parse_trading_txt",
        lambda *a, **k: calls.append("txt") or [],
    )

    analyze_market.run_analysis(folder)

    assert calls == ["txt"]
    assert (folder / "analysis.json").exists()
    assert (folder / "analysis_report.md").exists()


def test_run_analysis_reads_recent_txt(tmp_path):
    folder = tmp_path
    _write(folder, "trading.txt", TRADING_SAMPLE)
    _write(folder, "recent.txt", RECENT_SAMPLE)

    analyze_market.run_analysis(folder)

    out = json.loads((folder / "analysis.json").read_text(encoding="utf-8"))
    status = out["recent_trades_status"]
    assert status.get("trades"), "expected recent.txt trades to be parsed"
    assert any("Mal Rune" in (t.get("price") or "") for t in status["trades"])


def test_run_analysis_reads_recent_observe_json(tmp_path):
    folder = tmp_path
    _write(folder, "trading.txt", TRADING_SAMPLE)
    _write(folder, "recent.observe.json", RECENT_OBSERVE_SAMPLE)

    analyze_market.run_analysis(folder)

    out = json.loads((folder / "analysis.json").read_text(encoding="utf-8"))
    status = out["recent_trades_status"]
    assert status.get("trades"), "expected recent.observe.json trades to be parsed"
    assert any("Mal Rune" in (t.get("price") or "") for t in status["trades"])


def test_run_analysis_writes_outputs_and_summary(tmp_path):
    folder = tmp_path
    _write(folder, "trading.txt", TRADING_SAMPLE)

    analyze_market.run_analysis(folder)

    out = json.loads((folder / "analysis.json").read_text(encoding="utf-8"))
    assert out["summary"]["valid_count"] >= 1
    md = (folder / "analysis_report.md").read_text(encoding="utf-8")
    assert "Harlequin Crest" in md or out["report_mode"]