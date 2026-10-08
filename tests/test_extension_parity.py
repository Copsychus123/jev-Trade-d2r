"""The extension's parsers and URL rules must give exactly what the Python ones give (run through node)."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from jev_ultrafast.traderie.controller import read_view
from jev_ultrafast.traderie.parsing import TIME_REGEX, parse_recent_trades, parse_trading_txt
from jev_ultrafast.traderie.site import TRADERIE_D2R_URL, product_root_url, product_section, traderie_scope_reason

REPO = Path(__file__).resolve().parents[1]
FIXTURES = Path(__file__).parent / "fixtures"
TRADERIE_JS = (REPO / "extension" / "src" / "traderie").as_uri()
pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")

ITEM = "Harlequin Crest"

SCRIPT = f"""
import {{ parseTradingTxt, parseRecentTrades }} from "{TRADERIE_JS}/parsing.js";
import {{ productRootUrl, productSection, traderieScopeReason }} from "{TRADERIE_JS}/site.js";
import {{ readView }} from "{TRADERIE_JS}/controller.js";
import {{ readFileSync }} from "node:fs";
const input = JSON.parse(readFileSync(0, "utf8"));
class FakeTab {{
  constructor(c) {{ this.c = c; }}
  async readSettledPage() {{
    return {{ url: this.c.url, title: this.c.title, text: this.c.text, settled: this.c.settled }};
  }}
  async evaluate(expression) {{
    if (!expression.includes("load more")) return false;
    if (this.c.more === "raise") throw new Error("probe failed");
    return this.c.more;
  }}
}}
const views = [];
for (const c of input.cases) {{
  const r = await readView(new FakeTab(c), "{ITEM}", c.view);
  views.push({{ status: r.status, reason_code: r.reason_code, reason: r.reason, has_more: r.has_more,
    settled: r.settled, rows: r.rows }});
}}
console.log(JSON.stringify({{
  trading: input.texts.map((t) => parseTradingTxt(t, {{ itemName: "{ITEM}" }})),
  home: input.homes.map((t) => parseTradingTxt(t, {{ itemName: null }})),
  recent: input.texts.map((t) => parseRecentTrades(t)),
  roots: input.urls.map((u) => productRootUrl(u)),
  sections: input.urls.map((u) => productSection(u)),
  scope: input.urls.map((u) => traderieScopeReason(u) === null),
  views,
}}));
"""

INLINE_TEXTS = [
    "Please sign in to view offers",
    "\n".join(["Harlequin Crest", "They Give", "1 X Harlequin Crest", "I Give", "1 X Um Rune", "39 分鐘前"]),
    "\n".join(["Harlequin Crest", "They Give", "1 X Harlequin Crest", "I Give", "1 X Mal Rune"]),
    "\n".join(["Sold For", "1 X Um Rune", "3 days ago"]),
    "",
    "\n".join([
        "They Give", "1 X Shako", "Nintendo Switch • ", "Hardcore • ", "Non Ladder • ", "Lord Of Destruction",
        "I Give", "1 X Pul Rune", "PC • ", "1 天前",
        "They Give", "1 X Shako", "Xbox • ", "Resurrected", "I Give", "1 X Pul Rune", "2 days ago",
        "They Give", "1 X Shako", "Playstation •", "Ladder", "Reign Of The Warlock",
        "I Give", "1 X Pul Rune", "3 days ago",
    ]),
]

HOME_INLINE = "\n".join([
    "Marketplace", "Community", "Add Listing", "Stats", "Apply FiltersClear Filters",
    "Bsg2026", " (261)", "English", "1 X Caster Amulet",
    "Reign Of The Warlock • ", "Softcore • ", "PC • ", "Non Ladder",
    "+8% Faster Cast Rate", "+18 To Mana", "", "Trading For", "", "1 X Vex Rune", "High Rune Value: 0.5", "1 秒前",
    "Pro", "z_Diablo", " (12)", "1 X Ring", "PC •", "+10% Faster Cast Rate", "Make an Offer", "2 秒前",
    "no rating seller", "1 X Amulet", "Trading For", "1 X Um Rune", "3 days ago",
])


HOME_RATING_FIRST = "\n".join(["(5)", "1 X Ring", "PC •", "Make an Offer", "1 秒前"])
# The item line cannot be the seller: a card whose "N X name" line comes first (and the next line is its rating)
# is not a listing on either side, even though the backward scan from the item finds no seller.
HOME_ITEM_FIRST = "\n".join(["1 X Ring", "(5)", "PC •", "Make an Offer", "1 秒前"])
HOME_ITEM_FIRST_AFTER_BLANK = "\n".join(["", "1 X Um Rune", "(12)", "Seller", "PC •", "1 秒前"])


def _homes():
    """Home-page texts (no item name is known): a saved real page, a small page, nothing, and a page without cards."""
    return [
        _fixture("home_stats.txt"),
        HOME_INLINE,
        "",
        "Marketplace\nCommunity\nThere are no listings",
        HOME_ITEM_FIRST,
        HOME_ITEM_FIRST_AFTER_BLANK,
        HOME_RATING_FIRST,
    ]


RELATIVE_TIMES = [
    "a day ago", "an hour ago", "just now", "3 days ago", "2 週前", "3 周前", "4 個月前", "5 月前", "1 年前",
    "3 weeks ago", "about 3 days ago", "2 months ago", "1 year ago", "5m ago", "a minute ago", "剛剛", "6 小时前",
]
TIME_TEXTS = [
    "\n".join(f"Seller{i}\n{ITEM}\nTrading For\n1 X Um Rune\n{t}" for i, t in enumerate(RELATIVE_TIMES)),
    "\n".join(f"They Give\n1 X {ITEM}\nI Give\n1 X Um Rune\n{t}" for t in RELATIVE_TIMES),
]

URLS = [
    TRADERIE_D2R_URL,
    f"{TRADERIE_D2R_URL}/search?q=shako",
    f"{TRADERIE_D2R_URL}/product/harlequin-crest",
    f"{TRADERIE_D2R_URL}/product/harlequin-crest/",
    f"{TRADERIE_D2R_URL}/product/harlequin-crest/recent",
    f"{TRADERIE_D2R_URL}/product/harlequin-crest/recent/",
    f"{TRADERIE_D2R_URL}/product/harlequin-crest/buying",
    f"{TRADERIE_D2R_URL}/product/harlequin-crest/wiki",
    f"{TRADERIE_D2R_URL}/product/harlequin-crest/recent/extra",
    "https://WWW.Traderie.com/diablo2resurrected/product/harlequin-crest/recent",
    "https://www.traderie.com/login?redirect=%2Fx",
    "https://example.com/diablo2resurrected/product/x",
    f"{TRADERIE_D2R_URL}x/product/x",
    f"{TRADERIE_D2R_URL}/messages",
]

ROOT = f"{TRADERIE_D2R_URL}/product/harlequin-crest"
RECENT = f"{ROOT}/recent"


def _fixture_texts():
    paths = sorted(FIXTURES.glob("*.txt"))
    return [p.read_text(encoding="utf-8") for p in paths]


def _fixture(name):
    return (FIXTURES / name).read_text(encoding="utf-8")


def _case(view, url, text, *, title=ITEM, settled=True, more=False):
    return {"view": view, "url": url, "title": title, "text": text, "settled": settled, "more": more}


ONE_TRADE = "\n".join(["They Give", f"1 X {ITEM}", "I Give", "1 X Um Rune", "39 分鐘前"])
VIEW_CASES = {
    "trading ok": _case("trading", ROOT, _fixture("trading_harlequin_crest.txt"), more=True),
    "recent ok": _case("recent_trades", RECENT, _fixture("recent_harlequin_crest.txt")),
    "trading on recent": _case("trading", RECENT, ITEM),
    "trading on buying": _case("trading", f"{ROOT}/buying", ITEM),
    "trading on wiki": _case("trading", f"{ROOT}/wiki", ITEM),
    "recent on root": _case("recent_trades", ROOT, ITEM),
    "recent on wiki": _case("recent_trades", f"{ROOT}/wiki", ITEM),
    "wrong item": _case("recent_trades", RECENT, ONE_TRADE, title="Shako"),
    "item only in the text": _case("recent_trades", RECENT, f"{ITEM}\n{ONE_TRADE}", title="Traderie - Shako"),
    "never settled": _case("recent_trades", RECENT, ONE_TRADE, settled=False),
    "no anchors but a row": _case("trading", ROOT, f"{ITEM}\nSeller\n{ITEM}\nPC •\n3 days ago"),
    "fewer rows than markers": _case("trading", ROOT, _fixture("trading_harlequin_crest.txt") + "\nTrading For"),
    "recent rows differ": _case("recent_trades", RECENT, ONE_TRADE + "\nThey Give\n1 X Um Rune"),
    "empty trading": _case("trading", ROOT, f"{ITEM}\nThere are no listings"),
    "empty trading with cards": _case("trading", ROOT, "There are no listings\nTrading For\n" + ITEM),
    "empty recent": _case("recent_trades", RECENT, f"{ITEM}\nThere are no offers"),
    "nothing and not confirmed": _case("recent_trades", RECENT, ITEM),
    "long page without anchors": _case("trading", ROOT, ITEM + "\nfiller line\n" * 600),
    "login wall": _case("recent_trades", RECENT, f"{ITEM}\nPlease sign in to view offers\nThere are no offers"),
    "challenge page": _case("recent_trades", RECENT, "Please complete the CAPTCHA"),
    "probe fails": _case("recent_trades", RECENT, ONE_TRADE, more="raise"),
    "more on page": _case("recent_trades", RECENT, ONE_TRADE, more=True),
    "relative times": _case("recent_trades", RECENT, TIME_TEXTS[1]),
}


class _PageBrowser:
    def __init__(self, case):
        self.case = case

    def evaluate(self, expression, *, await_promise=False):
        c = self.case
        if await_promise:
            return {"url": c["url"], "title": c["title"], "text": c["text"], "settled": c["settled"]}
        if "load more" not in expression:
            return False
        if c["more"] == "raise":
            raise RuntimeError("probe failed")
        return c["more"]


def _python_view(case):
    r = read_view(_PageBrowser(case), ITEM, case["view"])
    return {k: r[k] for k in ("status", "reason_code", "reason", "has_more", "settled", "rows")}


def _run_node(texts, urls, cases):
    payload = json.dumps({"texts": texts, "homes": _homes(), "urls": urls, "cases": cases})
    result = subprocess.run(
        ["node", "--input-type=module", "-e", SCRIPT],
        input=payload, capture_output=True, text=True, encoding="utf-8", timeout=60,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def test_extension_parsers_and_url_rules_equal_python():
    texts = _fixture_texts() + INLINE_TEXTS + TIME_TEXTS
    got = _run_node(texts, URLS, list(VIEW_CASES.values()))

    for i, text in enumerate(texts):
        rows = json.loads(json.dumps([c.to_dict() for c in parse_trading_txt(text, item_name=ITEM)]))
        assert got["trading"][i] == rows, i
        assert got["recent"][i] == json.loads(json.dumps(parse_recent_trades(text))), i
    for i, text in enumerate(_homes()):
        rows = json.loads(json.dumps([c.to_dict() for c in parse_trading_txt(text, item_name=None)]))
        assert got["home"][i] == rows, i
    assert len(got["home"][0]) > 0 and len(got["home"][1]) == 2
    # A card whose rating line comes first has no seller (i == 0): not a listing on either side.
    assert got["home"][-1] == [] and parse_trading_txt(HOME_RATING_FIRST, item_name=None) == []
    assert got["home"][-2] == [] and parse_trading_txt(HOME_ITEM_FIRST_AFTER_BLANK, item_name=None) == []
    assert got["home"][-3] == [] and parse_trading_txt(HOME_ITEM_FIRST, item_name=None) == []
    assert got["roots"] == [product_root_url(u) for u in URLS]
    assert got["sections"] == [product_section(u) for u in URLS]
    assert got["scope"] == [traderie_scope_reason(u) is None for u in URLS]
    for (name, case), js in zip(VIEW_CASES.items(), got["views"], strict=True):
        assert js == json.loads(json.dumps(_python_view(case))), name


def test_read_views_have_the_expected_typed_outcomes():
    views = {name: _python_view(case) for name, case in VIEW_CASES.items()}
    outcome = {name: (v["status"], v["reason_code"]) for name, v in views.items()}
    assert outcome == {
        "trading ok": ("PASSED", None),
        "recent ok": ("PASSED", None),
        "trading on recent": ("FAILED", "wrong_view"),
        "trading on buying": ("FAILED", "wrong_view"),
        "trading on wiki": ("FAILED", "wrong_view"),
        "recent on root": ("FAILED", "wrong_view"),
        "recent on wiki": ("FAILED", "wrong_view"),
        "wrong item": ("FAILED", "wrong_item"),
        "item only in the text": ("FAILED", "wrong_item"),
        "never settled": ("FAILED", "unsettled"),
        "no anchors but a row": ("FAILED", "no_anchor"),
        "fewer rows than markers": ("FAILED", "row_mismatch"),
        "recent rows differ": ("FAILED", "row_mismatch"),
        "empty trading": ("PASSED", "empty"),
        "empty trading with cards": ("FAILED", "no_rows"),
        "empty recent": ("PASSED", "empty"),
        "nothing and not confirmed": ("FAILED", "no_rows"),
        "long page without anchors": ("FAILED", "no_rows"),
        "login wall": ("BLOCKED", "login_required"),
        "challenge page": ("BLOCKED", "guard"),
        "probe fails": ("PASSED", None),
        "more on page": ("PASSED", None),
        "relative times": ("PASSED", None),
    }
    assert _python_view(VIEW_CASES["trading ok"])["has_more"] is True
    assert _python_view(VIEW_CASES["recent ok"])["has_more"] is False
    assert _python_view(VIEW_CASES["probe fails"])["has_more"] is None
    assert _python_view(VIEW_CASES["empty recent"])["rows"] == []


def test_one_regex_ends_a_card_on_both_views_for_every_relative_time_form():
    for text in RELATIVE_TIMES:
        assert TIME_REGEX.match(text), text
    assert not TIME_REGEX.match("Ago the seller")
    assert not TIME_REGEX.match("1 X Um Rune")
    assert len(parse_trading_txt(TIME_TEXTS[0], item_name=ITEM)) == len(RELATIVE_TIMES)
    assert len(parse_recent_trades(TIME_TEXTS[1])["trades"]) == len(RELATIVE_TIMES)


def test_product_section_tells_the_trading_page_from_the_other_sections():
    assert product_section(ROOT) is None and product_section(f"{ROOT}/") is None
    assert product_section(RECENT) == "recent" and product_section(f"{RECENT}/") == "recent"
    assert product_section(f"{ROOT}/buying") == "buying" and product_section(f"{ROOT}/wiki") == "wiki"
    assert product_section(f"{RECENT}/extra") is None and product_root_url(f"{RECENT}/extra") is None
    assert product_section("https://example.com/diablo2resurrected/product/x/recent") is None


def test_fixtures_give_rows_to_compare():
    """Guards against the parity test passing on two empty results."""
    trading = (FIXTURES / "trading_harlequin_crest.txt").read_text(encoding="utf-8")
    recent = (FIXTURES / "recent_harlequin_crest.txt").read_text(encoding="utf-8")
    assert len(parse_trading_txt(trading, item_name=ITEM)) > 0
    assert len(parse_recent_trades(recent)["trades"]) > 0


def test_recent_trade_tags_are_read_from_the_they_give_side_only():
    recent = (FIXTURES / "recent_harlequin_crest.txt").read_text(encoding="utf-8")
    first = parse_recent_trades(recent)["trades"][0]
    assert (first["platform"], first["mode"], first["ladder"], first["game_version"]) == (
        "PC", "Softcore", "Ladder", "Reign of the Warlock",
    )
    assert first["buyer_or_seller"] == "1 X Harlequin Crest, 99Defense"
    trades = parse_recent_trades(INLINE_TEXTS[-1])["trades"]
    tags = [(t["platform"], t["mode"], t["ladder"], t["game_version"]) for t in trades]
    assert tags == [
        ("Switch", "Hardcore", "Non Ladder", "Lord of Destruction"),
        ("Xbox", None, None, None),
        ("Playstation", None, "Ladder", "Reign of the Warlock"),
    ]
    plain = parse_recent_trades(INLINE_TEXTS[1])["trades"][0]
    assert (plain["platform"], plain["mode"], plain["ladder"], plain["game_version"]) == (None,) * 4
    sold = parse_recent_trades(INLINE_TEXTS[3])["trades"][0]
    assert sold["platform"] is None and sold["game_version"] is None


def test_original_game_version_tag_is_read_in_trading_and_recent_rows():
    card = (
        "koreaPOP\n (84)\n1 X Harlequin Crest\nClassic (Base Game) \u2022\nSoftcore \u2022\nPC \u2022\nLadder\n"
        "+139 Defense\nTrading For\n1 X Ist Rune\nOR\n2 X Mal Rune\nHigh Rune Value: 0.16 or 0.2\n1 \u5c0f\u6642\u524d"
    )
    row = parse_trading_txt(card, item_name=ITEM)[0]
    assert (row.platform, row.mode, row.ladder, row.game_version) == ("PC", "Softcore", "Ladder", "Classic (Base Game)")
    recent = "They Give\n1 X Shako\nClassic (Base Game) \u2022 \nPC \u2022 \nI Give\n1 X Pul Rune\n1 \u5929\u524d"
    trade = parse_recent_trades(recent)["trades"][0]
    assert trade["game_version"] == "Classic (Base Game)" and trade["buyer_or_seller"] == "1 X Shako"
