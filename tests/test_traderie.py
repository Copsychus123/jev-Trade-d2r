import pytest

from jev_ultrafast import browser as browser_module
from jev_ultrafast.traderie import (
    TRADERIE_D2R_URL,
    build_goal,
    collect_market_snapshot,
    extract_market_evidence,
    product_root_url,
    verify_market,
)

TRADING_TEXT = """
Reinforced Mace
Trading
Looking For
Recent Trades
Stats
Diamond
belobog0916
1 x Reinforced Mace
Ethereal • rare • PC • softcore • Non Ladder • Asia
Trading For
20 X Jah Rune
High Rune Value: 60
13 minutes ago
"""

RECENT_TEXT = """
Reinforced Mace
Recent Trades
Sold For
2 X Jah Rune
High Rune Value: 6
September 21, 2026
Sold For
3 X Bear Claw Small Charm
20 to Life
September 10, 2026
"""


def test_build_goal_requires_item_name():
    assert "Stormshield" in build_goal("Stormshield")
    with pytest.raises(ValueError, match="item name"):
        build_goal("   ")


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        (f"{TRADERIE_D2R_URL}/product/reinforced-mace", f"{TRADERIE_D2R_URL}/product/reinforced-mace"),
        (f"{TRADERIE_D2R_URL}/product/reinforced-mace/recent", f"{TRADERIE_D2R_URL}/product/reinforced-mace"),
        (f"{TRADERIE_D2R_URL}/product/2570792671/buying", f"{TRADERIE_D2R_URL}/product/2570792671"),
        ("https://example.com/product/reinforced-mace", None),
    ],
)
def test_product_root_url_normalizes_supported_traderie_routes(url, expected):
    assert product_root_url(url) == expected


def test_extract_market_evidence_skips_tab_chrome_and_keeps_trade_lines():
    trading = extract_market_evidence(TRADING_TEXT, "trading")
    recent = extract_market_evidence(RECENT_TEXT, "recent")
    assert trading[:4] == [
        "Diamond",
        "belobog0916",
        "1 x Reinforced Mace",
        "Ethereal • rare • PC • softcore • Non Ladder • Asia",
    ]
    assert "Trading For" in trading
    assert recent[:4] == ["Sold For", "2 X Jah Rune", "High Rune Value: 6", "September 21, 2026"]


def test_verify_market_requires_item_page_tabs_and_both_summaries():
    final_page = {
        "url": f"{TRADERIE_D2R_URL}/product/reinforced-mace",
        "title": "Reinforced Mace",
        "text": "Reinforced Mace Trading Looking For Recent Trades",
    }
    trading_page = {"url": f"{TRADERIE_D2R_URL}/product/reinforced-mace"}
    recent_page = {"url": f"{TRADERIE_D2R_URL}/product/reinforced-mace/recent"}
    result = verify_market("Reinforced Mace", final_page, trading_page, recent_page, TRADING_TEXT, RECENT_TEXT)
    assert result["passed"]
    assert result["trading"]["summary"].startswith("Diamond | belobog0916")
    assert result["recent_trades"]["summary"].startswith("Sold For | 2 X Jah Rune")

    failed = verify_market("Stormshield", final_page, trading_page, recent_page, TRADING_TEXT, "")
    assert not failed["passed"]
    assert failed["checks"]["item_match"] is False
    assert failed["checks"]["recent_summary"] is False


def test_collect_market_snapshot_navigates_trading_then_recent():
    base = f"{TRADERIE_D2R_URL}/product/reinforced-mace"

    class FakeBrowser:
        def __init__(self):
            self.urls = []
            self.page = None

        def navigate(self, url, *, timeout=15):  # noqa: ARG002
            self.urls.append(url)
            self.page = {"url": url, "title": "Reinforced Mace", "text": "Reinforced Mace Trading Recent Trades"}

        def observe(self, screenshot=False):  # noqa: ARG002
            return self.page

        def evaluate(self, expression):
            assert expression == "document.body.innerText"
            return TRADING_TEXT if self.page["url"] == base else RECENT_TEXT

    browser = FakeBrowser()
    final_page = {"url": base, "title": "Reinforced Mace", "text": "Reinforced Mace Trading Recent Trades"}
    result = collect_market_snapshot(browser, "Reinforced Mace", final_page)
    assert result["passed"]
    assert browser.urls == [base, base + "/recent"]


def test_browser_navigate_waits_until_document_complete(monkeypatch):
    browser = browser_module.Browser.__new__(browser_module.Browser)
    calls = []
    states = iter(["interactive", "complete"])

    def fake_call(method, **params):
        calls.append((method, params))
        return {}

    def fake_evaluate(_expression):
        return next(states)

    browser.call = fake_call
    browser.evaluate = fake_evaluate
    browser.navigate("https://example.test/path")
    assert calls == [("Page.navigate", {"url": "https://example.test/path"})]
