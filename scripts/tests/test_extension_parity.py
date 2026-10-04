"""The extension's parsers and URL rules must give exactly what the Python ones give (run through node)."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from jev_ultrafast.traderie.parsing import parse_recent_trades, parse_trading_txt
from jev_ultrafast.traderie.site import TRADERIE_D2R_URL, product_root_url, traderie_scope_reason

ROOT = Path(__file__).resolve().parent.parent.parent
FIXTURES = Path(__file__).parent / "fixtures"
TRADERIE_JS = (ROOT / "extension" / "src" / "traderie").as_uri()
pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")

SCRIPT = f"""
import {{ parseTradingTxt, parseRecentTrades }} from "{TRADERIE_JS}/parsing.js";
import {{ productRootUrl, traderieScopeReason }} from "{TRADERIE_JS}/site.js";
import {{ readFileSync }} from "node:fs";
const input = JSON.parse(readFileSync(0, "utf8"));
console.log(JSON.stringify({{
  trading: input.texts.map((t) => parseTradingTxt(t)),
  recent: input.texts.map((t) => parseRecentTrades(t)),
  roots: input.urls.map((u) => productRootUrl(u)),
  scope: input.urls.map((u) => traderieScopeReason(u) === null),
}}));
"""

INLINE_TEXTS = [
    "Please sign in to view offers",
    "\n".join(["Harlequin Crest", "They Give", "1 X Harlequin Crest", "I Give", "1 X Um Rune", "39 分鐘前"]),
    "\n".join(["Harlequin Crest", "They Give", "1 X Harlequin Crest", "I Give", "1 X Mal Rune"]),
    "\n".join(["Sold For", "1 X Um Rune", "3 days ago"]),
    "",
]

URLS = [
    TRADERIE_D2R_URL,
    f"{TRADERIE_D2R_URL}/search?q=shako",
    f"{TRADERIE_D2R_URL}/product/harlequin-crest",
    f"{TRADERIE_D2R_URL}/product/harlequin-crest/recent",
    f"{TRADERIE_D2R_URL}/product/harlequin-crest/buying",
    "https://www.traderie.com/login?redirect=%2Fx",
    "https://example.com/diablo2resurrected/product/x",
    f"{TRADERIE_D2R_URL}/messages",
]


def _fixture_texts():
    paths = sorted(FIXTURES.glob("*.txt"))
    return [p.read_text(encoding="utf-8") for p in paths]


def test_extension_parsers_and_url_rules_equal_python():
    texts = _fixture_texts() + INLINE_TEXTS
    payload = json.dumps({"texts": texts, "urls": URLS})
    result = subprocess.run(
        ["node", "--input-type=module", "-e", SCRIPT],
        input=payload, capture_output=True, text=True, encoding="utf-8", timeout=60,
    )
    assert result.returncode == 0, result.stderr
    got = json.loads(result.stdout)

    for i, text in enumerate(texts):
        assert got["trading"][i] == json.loads(json.dumps([c.to_dict() for c in parse_trading_txt(text)])), i
        assert got["recent"][i] == json.loads(json.dumps(parse_recent_trades(text))), i
    assert got["roots"] == [product_root_url(u) for u in URLS]
    assert got["scope"] == [traderie_scope_reason(u) is None for u in URLS]


def test_fixtures_give_rows_to_compare():
    """Guards against the parity test passing on two empty results."""
    trading = (FIXTURES / "trading_harlequin_crest.txt").read_text(encoding="utf-8")
    recent = (FIXTURES / "recent_harlequin_crest.txt").read_text(encoding="utf-8")
    assert len(parse_trading_txt(trading)) > 0
    assert len(parse_recent_trades(recent)["trades"]) > 0
