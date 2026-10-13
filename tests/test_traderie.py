import re
import types

import pytest

from tests._harness_stub import install

install()  # before the package imports below: nothing here may start the Chrome daemon

from jev_ultrafast import browser as browser_module  # noqa: E402, I001


from jev_ultrafast.traderie import (  # noqa: E402
    TRADERIE_D2R_URL,
    build_goal,
    detect_guard,
    product_root_url,
    read_view,
)
from jev_ultrafast.traderie.controller import verify_views  # noqa: E402
from jev_ultrafast.traderie.parsing import parse_trading_txt  # noqa: E402
from jev_ultrafast.traderie.site import LOAD_MORE_LIMIT, phase_finish_rule, traderie_scope_reason  # noqa: E402

LOGIN_REASON = "需要登入：請先執行 uv run python scripts/login.py 登入一次"


class _GuardBrowser:
    """`detect_guard` only asks the browser one question: is a challenge frame on the page?"""

    def __init__(self, challenge_present=False):
        self.challenge_present = challenge_present

    def evaluate(self, _expr):
        return self.challenge_present


def _page(url, *, title="", text=""):
    """The page model `detect_guard` reads: it decides on the url, the title and the visible text."""
    return {"url": url, "title": title, "text": text}


def test_build_goal_requires_item_name():
    assert "Stormshield" in build_goal("Stormshield")


def test_goal_tells_jev_exactly_the_requested_number_of_presses_and_the_rule_matches():
    for presses in (1, 3, 5):
        assert re.findall(r"\b\d+\b", build_goal("Stormshield", presses)) == [str(presses)]
    assert re.findall(r"\b\d+\b", build_goal("Stormshield")) == [str(LOAD_MORE_LIMIT)]
    assert phase_finish_rule(3) == ("Load More", 3) and phase_finish_rule(0) is None


def test_goal_without_load_more_never_asks_for_a_press():
    goal = build_goal("Stormshield", 0)
    assert "do not press Load More" in goal and "Load More presses" not in goal and "action_counts" not in goal


@pytest.mark.parametrize("bad", [-1, 6, 2.5, "2", True, None])
def test_load_more_must_be_an_integer_from_zero_to_five(bad):
    with pytest.raises(ValueError, match="載入更多次數"):
        build_goal("Stormshield", bad)
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


@pytest.mark.parametrize(
    ("page", "expected_reason"),
    [
        (_page(f"{TRADERIE_D2R_URL}/product/shako", title="CLOUDFLARE | JUST A MOMENT..."), "防護頁/驗證碼"),
        (
            _page(f"{TRADERIE_D2R_URL}/product/shako", text="Please complete CAPTCHA before continuing"),
            "防護頁/驗證碼",
        ),
        (_page(f"{TRADERIE_D2R_URL}/signup?next=/diablo2resurrected/product/shako", title="Sign up"), LOGIN_REASON),
        (_page("https://accounts.traderie.com/login", title="Redirecting"), "離開 Traderie：accounts.traderie.com"),
    ],
)
def test_detect_guard_branches_cover_challenge_login_variants_and_offhost_redirect(page, expected_reason):
    assert detect_guard(page, _GuardBrowser()) == expected_reason

def test_detect_guard_checks_host_and_challenges():
    assert "離開 Traderie" in detect_guard(_page("https://google.com"), _GuardBrowser())
    d2r_url = "https://traderie.com/diablo2resurrected"
    assert detect_guard(_page(d2r_url, title="Just a moment..."), _GuardBrowser()) == "防護頁/驗證碼"
    assert detect_guard(_page(d2r_url, text="verify you are human"), _GuardBrowser()) == "防護頁/驗證碼"
    assert detect_guard(_page(d2r_url), _GuardBrowser(challenge_present=True)) == "防護頁/驗證碼"
    assert detect_guard(_page("https://traderie.com/login"), _GuardBrowser()) == LOGIN_REASON
    ok_page = _page(f"{d2r_url}/product/shako", title="Harlequin Crest", text="Trading")
    assert detect_guard(ok_page, _GuardBrowser()) is None


def test_detect_guard_ignores_the_word_captcha_on_a_long_normal_page():
    changelog = "Fixed captcha bugs when going between games"
    page = _page(f"{TRADERIE_D2R_URL}/product/shako", title="Shako", text="Trading For\n" * 600 + changelog)
    assert detect_guard(page, _GuardBrowser()) is None


def test_login_wall_reason_tells_user_how_to_log_in():
    reason = traderie_scope_reason("https://www.traderie.com/login?redirect=%2Fx")
    assert reason == LOGIN_REASON
    assert "需要登入" in reason and "login.py" in reason



def test_detect_guard_blocks_same_host_off_scope_path():
    page = _page("https://www.traderie.com/messages", title="Messages", text="Inbox")
    assert detect_guard(page, _GuardBrowser()) == "超出 Traderie D2R 範圍：/messages"

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


def _fake_browser_cdp(calls):
    def fake_cdp(method, session_id=None, **params):
        calls.append((method, session_id, params))
        if method == "Target.createTarget":
            return {"targetId": "target-1"}
        if method == "Target.attachToTarget":
            return {"sessionId": "session-1"}
        if method == "Runtime.evaluate":
            return {"result": {"value": "complete"}}
        return {"success": True}

    return fake_cdp


def _stub_chrome(monkeypatch, cdp):
    """Give `Browser.__init__` a fake CDP client: no Chrome is started and no daemon is asked for."""
    monkeypatch.setattr(browser_module, "ensure_chrome", lambda: None)
    monkeypatch.setattr(browser_module, "ensure_daemon", lambda: None)
    monkeypatch.setattr(browser_module, "cdp", cdp)


@pytest.mark.parametrize(
    ("env", "expected"),
    [
        ({}, []),
        ({"TRADERIE_COOKIE": "name=value; other=two"}, [("name", "value"), ("other", "two")]),
        ({"TRADERIE_SESSION_TOKEN": "abc"}, [("session", "abc")]),
        (
            {"TRADERIE_SESSION_TOKEN": "abc", "TRADERIE_SESSION_COOKIE_NAME": "auth"},
            [("auth", "abc")],
        ),
    ],
)
def test_browser_injects_traderie_auth_only_when_env_present(monkeypatch, env, expected):
    monkeypatch.delenv("TRADERIE_COOKIE", raising=False)
    monkeypatch.delenv("TRADERIE_SESSION_TOKEN", raising=False)
    monkeypatch.delenv("TRADERIE_SESSION_COOKIE_NAME", raising=False)
    for key, value in env.items():
        monkeypatch.setenv(key, value)

    calls = []
    _stub_chrome(monkeypatch, _fake_browser_cdp(calls))

    browser = browser_module.Browser("https://traderie.com/diablo2resurrected")
    assert browser.target == "target-1"
    set_cookie_calls = [params for method, _session_id, params in calls if method == "Network.setCookie"]
    assert [(call["name"], call["value"], call["url"]) for call in set_cookie_calls] == [
        (name, value, "https://www.traderie.com/") for name, value in expected
    ]
    navigate_index = next(i for i, (method, _session_id, _params) in enumerate(calls) if method == "Page.navigate")
    cookie_indices = [i for i, (method, _session_id, _params) in enumerate(calls) if method == "Network.setCookie"]
    if expected:
        assert max(cookie_indices) < navigate_index
    else:
        assert cookie_indices == []


def test_cookie_pairs_skip_the_attributes_a_set_cookie_string_carries():
    """A pasted line may be a `Set-Cookie` value, which carries attributes (`path`, `domain`, `secure`, ...); only
    name=value pairs are cookies. A value may itself contain `=` (a base64 session), so the split stops at the first."""
    from jev_ultrafast.traderie.auth import parse_cookie_pairs

    assert parse_cookie_pairs("session=abc; path=/; domain=.traderie.com; secure; SameSite=Lax") == [("session", "abc")]
    assert parse_cookie_pairs("token=a=b; HttpOnly") == [("token", "a=b")]
    assert parse_cookie_pairs("   ") == []
    with pytest.raises(ValueError, match="name=value"):
        parse_cookie_pairs("path=/; secure")


def test_cookie_pairs_split_trim_and_drop_what_is_not_a_pair():
    """`;` separates cookies and the whitespace a browser puts around a segment or a value is packaging, not data; an
    empty segment (or a trailing `;`) and a chunk without `=` are not cookies, and a blank name is skipped too."""
    from jev_ultrafast.traderie.auth import parse_cookie_pairs

    assert parse_cookie_pairs("  a=1 ; b=2 ") == [("a", "1"), ("b", "2")]
    assert parse_cookie_pairs("name = value") == [("name", "value")]  # space around `=` is trimmed off both halves
    assert parse_cookie_pairs("a=1;;b=2;") == [("a", "1"), ("b", "2")]
    assert parse_cookie_pairs("a=1; junk; b=2") == [("a", "1"), ("b", "2")]
    assert parse_cookie_pairs("=novalue; a=1") == [("a", "1")]
    assert parse_cookie_pairs("Path=/; a=1") == [("a", "1")]  # attribute names are matched case-insensitively


def test_cookie_pairs_keep_a_value_with_equals_and_every_duplicate_name():
    """The split stops at the first `=`, so a base64 session survives whole; a repeated name is not deduplicated - both
    cookies are handed to CDP in the order they were pasted."""
    from jev_ultrafast.traderie.auth import parse_cookie_pairs

    assert parse_cookie_pairs("token=a=b=c") == [("token", "a=b=c")]
    assert parse_cookie_pairs("dup=1; dup=2") == [("dup", "1"), ("dup", "2")]


@pytest.mark.parametrize(
    ("env", "expected"),
    [
        ({}, []),
        (
            {"TRADERIE_COOKIE": "name=value; other=two"},
            [
                {"url": "https://www.traderie.com/", "name": "name", "value": "value"},
                {"url": "https://www.traderie.com/", "name": "other", "value": "two"},
            ],
        ),
        (
            {"TRADERIE_SESSION_TOKEN": "token-value"},
            [{"url": "https://www.traderie.com/", "name": "session", "value": "token-value"}],
        ),
        (
            {"TRADERIE_SESSION_TOKEN": "token-value", "TRADERIE_SESSION_COOKIE_NAME": "authed"},
            [{"url": "https://www.traderie.com/", "name": "authed", "value": "token-value"}],
        ),
        (
            {
                "TRADERIE_COOKIE": "a=1",
                "TRADERIE_SESSION_TOKEN": "token-value",
                "TRADERIE_SESSION_COOKIE_NAME": "authed",
            },
            [
                {"url": "https://www.traderie.com/", "name": "a", "value": "1"},
                {"url": "https://www.traderie.com/", "name": "authed", "value": "token-value"},
            ],
        ),
    ],
)
def test_cookie_specs_inject_the_pasted_cookies_then_the_session_cookie_over_the_env(env, expected):
    """The exact `Network.setCookie` specs, built from the real env-var names: the pasted pairs first, then the session
    token appended under its configured name (default `session`) - and nothing at all when neither is set."""
    from jev_ultrafast.config import get_settings
    from jev_ultrafast.traderie.auth import cookie_specs

    assert cookie_specs(get_settings(env)) == expected


def test_cookie_specs_carry_only_url_name_value_for_the_traderie_origin():
    """Each spec is a `Network.setCookie` argument: pinned to Traderie's origin and carrying exactly `url`/`name`/
    `value` - no cookie attribute keys, which would silently inject a differently scoped cookie."""
    from jev_ultrafast.config import get_settings
    from jev_ultrafast.traderie.auth import COOKIE_ORIGIN, cookie_specs

    assert COOKIE_ORIGIN == "https://www.traderie.com/"
    # The pasted header carries cookie attributes (`domain=`, `path=`) next to a real pair. Those must be dropped -
    # never a spec key (which would scope the cookie elsewhere) and never a bogus cookie named after the attribute.
    specs = cookie_specs(
        get_settings({"TRADERIE_COOKIE": "domain=.x; path=/; name=value", "TRADERIE_SESSION_TOKEN": "token-value"})
    )
    assert specs
    assert all(set(spec) == {"url", "name", "value"} for spec in specs)
    assert all(spec["url"] == COOKIE_ORIGIN for spec in specs)
    assert [spec["name"] for spec in specs] == ["name", "session"]


def test_cookie_specs_falls_back_to_the_session_name_when_it_is_blank():
    """A `Settings` whose cookie name is blank still gets a name: the session cookie is never injected nameless."""
    from jev_ultrafast.config import Settings
    from jev_ultrafast.traderie.auth import COOKIE_ORIGIN, cookie_specs

    specs = cookie_specs(Settings(traderie_session_token="token-value", traderie_session_cookie_name=""))
    assert specs == [{"url": COOKIE_ORIGIN, "name": "session", "value": "token-value"}]


def test_settled_page_read_refuses_an_answer_that_is_not_a_page():
    """`read_settled_page` is the evidence that a view was read: an answer without a url has to fail here and now,
    not travel on as a settled page with nothing in it."""
    from jev_ultrafast.traderie import verification

    class SettleBrowser:
        def __init__(self, answer):
            self.answer = answer
            self.calls = []

        def evaluate(self, expression, *, await_promise=False):
            self.calls.append((expression, await_promise))
            return self.answer

    page = {"url": "u", "title": "t", "text": "x"}
    answered = SettleBrowser(page)
    assert verification.read_settled_page(answered) == page
    expression, awaited = answered.calls[0]
    assert awaited is True and "(500, 5000)" in expression

    for answer in (None, "text", {"title": "t"}):
        with pytest.raises(TimeoutError, match="url/title/text"):
            verification.read_settled_page(SettleBrowser(answer))

    custom = SettleBrowser(page)
    verification.read_settled_page(custom, quiet_ms=50, timeout_ms=80)
    assert "(50, 80)" in custom.calls[0][0]


def test_browser_replaces_headless_label_in_user_agent(monkeypatch):
    calls = []
    base = _fake_browser_cdp(calls)

    def fake_cdp(method, session_id=None, **params):
        if method == "Runtime.evaluate" and params["expression"] == "navigator.userAgent":
            calls.append((method, session_id, params))
            return {"result": {"value": "Mozilla/5.0 HeadlessChrome/130.0"}}
        return base(method, session_id, **params)

    _stub_chrome(monkeypatch, fake_cdp)
    browser_module.Browser("https://traderie.com/diablo2resurrected")
    methods = [m for m, _s, _p in calls]
    override = next(p for m, _s, p in calls if m == "Emulation.setUserAgentOverride")
    assert override["userAgent"] == "Mozilla/5.0 Chrome/130.0"
    assert methods.index("Emulation.setUserAgentOverride") < methods.index("Page.navigate")

@pytest.mark.parametrize(("mode", "blocks"), [("headless", True), ("window", True), ("existing", False)])
def test_browser_blocks_ad_hosts_only_in_the_dedicated_chrome(monkeypatch, mode, blocks):
    calls = []
    monkeypatch.setenv("JEV_CHROME", mode)
    _stub_chrome(monkeypatch, _fake_browser_cdp(calls))
    browser_module.Browser("https://traderie.com/diablo2resurrected")
    sent = [p["urls"] for m, _s, p in calls if m == "Network.setBlockedURLs"]
    assert (sent == [browser_module.blocked_url_patterns()]) is blocks
    assert bool(sent) is blocks


def test_only_ascii_digits_make_a_time_line_in_either_reader():
    """Python's `\\d` matches every Unicode digit while JavaScript's is ASCII, so a card whose time shows full-width
    digits parsed here and not in the JS reader -- which then dropped the whole card, turning into a failed read. Both
    patterns now say `[0-9]`; this is exactly the case that differed before."""
    def card(time):
        return "\n".join([
            "seller", " (11)", "1 X Axe", "Softcore -", "PC -", "Ladder", "Trading For", "1 X Pul Rune", time,
        ])

    assert parse_trading_txt(card("123 小時前"))[0].posted_time == "123 小時前"
    assert parse_trading_txt(card("１２３ 小時前")) == []


def test_a_seller_name_that_starts_with_help_does_not_end_the_listings():
    """The page's own end-of-listings line is exactly "HELP" (measured on a product page: one line, between "Load More"
    and "Getting Started"). Reading it as a prefix cut the list at a seller called "HELPfulTrader", so the rows then
    disagreed with the page's markers and every listing after it was lost."""
    def card(seller):
        return "\n".join([
            seller, " (11)", "1 X Harlequin Crest", "Softcore -", "PC -", "Ladder", "Trading For", "1 X Pul Rune",
            "High Rune Value: 0.5", "1 分鐘前",
        ])

    text = "\n".join([card("alpha"), card("HELPfulTrader"), card("gamma"), "HELP"])
    rows = parse_trading_txt(text)
    assert [row.seller for row in rows] == ["alpha", "HELPfulTrader", "gamma"]


@pytest.mark.parametrize(("price_line", "expected_ask", "expected_high_rune"), [
    ("NaN", "NaN", "High Rune Value: NaN"),
    ("Infinity", "Infinity", "High Rune Value: Infinity"),
    ("-Infinity", "-Infinity", "High Rune Value: -Infinity"),
    ("1.7976931348623157e+308", "1.7976931348623157e+308", "High Rune Value: 1.7976931348623157e+308"),
    ("abc", "abc", "High Rune Value: abc"),
    ("", "Unknown", "High Rune Value:"),        # an empty line is dropped; no wanted text is left
    ("   ", "Unknown", "High Rune Value:"),      # whitespace is stripped away too
])
def test_traderie_keeps_a_malformed_price_line_verbatim(price_line, expected_ask, expected_high_rune):
    """There is no numeric price parser: a listing's wanted line is kept as raw text, so a malformed price
    (NaN, Infinity, overflow, junk) survives verbatim as the row's `ask` and `high_rune_value` line."""
    text = "\n".join([
        "TestSeller", " (11)", "1 X Harlequin Crest", "Softcore -", "PC -", "Ladder",
        "Trading For", price_line, f"High Rune Value: {price_line}", "1 minute ago",
    ])
    rows = parse_trading_txt(text)
    assert len(rows) == 1
    assert (rows[0].ask, rows[0].high_rune_value) == (expected_ask, expected_high_rune)



class _PageBrowser:
    def __init__(self, url, text, more=False):
        self.page = {"url": url, "title": "Harlequin Crest", "text": text, "settled": True}
        self.more = more  # what the "is a Load More button still there?" probe answers

    def evaluate(self, expression, *, await_promise=False):
        if await_promise:
            return self.page
        return self.more if "load more" in expression else False  # other probes (guards) say no


RECENT_URL = f"{TRADERIE_D2R_URL}/product/harlequin-crest/recent"


def _recent_page_text(*offers):
    """A Recent Trades page as the tab shows it: the item heading, then one They Give/I Give block per offer; an
    offer is its `I Give` line and the timestamp that line normally ends with (some cards ship without one)."""
    lines = ["Harlequin Crest"]
    for offer in offers:
        lines += ["They Give", "1 X Harlequin Crest", "I Give", *offer]
    return "\n".join(lines)


def test_read_view_recent_rejects_table_that_misses_page_entries():
    text = _recent_page_text(("1 X Um Rune", "39 分鐘前"), ("1 X Mal Rune",))
    result = read_view(_PageBrowser(RECENT_URL, text), "Harlequin Crest", "recent_trades")
    assert result["status"] == "FAILED"
    assert "不一致" in result["reason"]


def test_read_view_recent_keeps_every_entry_when_page_and_table_agree():
    text = _recent_page_text(("1 X Um Rune", "39 分鐘前"), ("1 X Mal Rune", "44 分鐘前"))
    result = read_view(_PageBrowser(RECENT_URL, text), "Harlequin Crest", "recent_trades")
    assert result["status"] == "PASSED"
    assert [r["price"] for r in result["rows"]] == ["1 X Um Rune", "1 X Mal Rune"]
    assert result["text"] == text


@pytest.mark.parametrize("more", [True, False])
def test_read_view_reports_whether_more_entries_were_left_on_the_site(more):
    text = _recent_page_text(("1 X Um Rune", "39 分鐘前"))
    result = read_view(_PageBrowser(RECENT_URL, text, more=more), "Harlequin Crest", "recent_trades")
    assert result["status"] == "PASSED" and result["has_more"] is more


def test_read_view_trading_fails_when_agent_is_on_recent_page():
    result = read_view(_PageBrowser(RECENT_URL, "Harlequin Crest"), "Harlequin Crest", "trading")
    assert result["status"] == "FAILED"
    assert "不是掛單頁" in result["reason"]


def test_read_view_reports_blocked_when_site_shows_a_challenge():
    class ChallengeBrowser(_PageBrowser):
        def evaluate(self, _expression, *, await_promise=False):
            return self.page if await_promise else True

    result = read_view(ChallengeBrowser(RECENT_URL, "Harlequin Crest"), "Harlequin Crest", "recent_trades")
    assert result["status"] == "BLOCKED"
    assert "網站阻擋" in result["reason"]


def _view(status, url, *, title="Harlequin Crest", text="Harlequin Crest"):
    """A view in the shape `read_view` returns and `verify_views` and the controller consume."""
    return {"status": status, "reason": None, "url": url, "title": title, "text": text}


def _market(trading_url, recent_url, *, trading_status="PASSED", recent_status="PASSED", title="Harlequin Crest",
            text="Harlequin Crest"):
    return {
        "trading": _view(trading_status, trading_url, title=title, text=text),
        "recent_trades": _view(recent_status, recent_url, title=title, text=text),
    }


def test_verify_views_passes_when_both_views_read_the_same_product():
    market = _market(f"{TRADERIE_D2R_URL}/product/a", f"{TRADERIE_D2R_URL}/product/a/recent")
    result = verify_views("Harlequin Crest", market)
    assert result["passed"] is True
    assert result["failed_checks"] == []
    assert len(result["checks"]) == 8
    assert result["product_url"] == f"{TRADERIE_D2R_URL}/product/a"


def test_verify_views_flags_two_different_products():
    market = _market(f"{TRADERIE_D2R_URL}/product/a", f"{TRADERIE_D2R_URL}/product/b/recent")
    result = verify_views("Harlequin Crest", market)
    assert result["passed"] is False
    assert "same_product" in result["failed_checks"]


def test_verify_views_flags_a_blocked_recent_view():
    market = _market(
        f"{TRADERIE_D2R_URL}/product/a", f"{TRADERIE_D2R_URL}/product/a/recent", recent_status="BLOCKED"
    )
    result = verify_views("Harlequin Crest", market)
    assert "not_blocked" in result["failed_checks"]
    assert "recent_rows_ok" in result["failed_checks"]


PRODUCT = f"{TRADERIE_D2R_URL}/product/a"

# One market per check, each breaking only that check. Two of the eight (`item_match`, `trading_rows_ok`) could be
# replaced by `True` without any test noticing, and the checks are the product's promise: a DONE decision is not proof.
BROKEN = {
    "product_page": dict(trading_url=PRODUCT, recent_url=TRADERIE_D2R_URL),
    "item_match": dict(trading_url=PRODUCT, recent_url=f"{PRODUCT}/recent", title="Stormshield", text="Stormshield"),
    "same_product": dict(trading_url=PRODUCT, recent_url=f"{TRADERIE_D2R_URL}/product/b/recent"),
    "trading_view": dict(trading_url=f"{PRODUCT}/recent", recent_url=f"{PRODUCT}/recent"),
    "recent_view": dict(trading_url=PRODUCT, recent_url=PRODUCT),
    "trading_rows_ok": dict(trading_url=PRODUCT, recent_url=f"{PRODUCT}/recent", trading_status="FAILED"),
    "recent_rows_ok": dict(trading_url=PRODUCT, recent_url=f"{PRODUCT}/recent", recent_status="FAILED"),
    "not_blocked": dict(trading_url=PRODUCT, recent_url=f"{PRODUCT}/recent", recent_status="BLOCKED"),
}


@pytest.mark.parametrize("broken", sorted(BROKEN))
def test_every_verification_check_can_still_fail_on_its_own(broken):
    result = verify_views("Harlequin Crest", _market(**BROKEN[broken]))
    assert result["passed"] is False
    assert broken in result["failed_checks"]


def test_browser_navigate_accepts_page_stuck_in_interactive_after_grace(monkeypatch):
    browser = browser_module.Browser.__new__(browser_module.Browser)
    clock = [0.0]
    monkeypatch.setattr(browser_module.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(browser_module.time, "sleep", lambda s: clock.__setitem__(0, clock[0] + max(s, 0.5)))
    browser.call = lambda *_a, **_k: {}
    browser.evaluate = lambda _expression: "interactive"
    browser.navigate("https://example.test/slow", timeout_seconds=30, interactive_grace_seconds=8)
    assert 8 <= clock[0] < 30


def test_browser_navigate_times_out_while_page_is_still_loading(monkeypatch):
    browser = browser_module.Browser.__new__(browser_module.Browser)
    clock = [0.0]
    monkeypatch.setattr(browser_module.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(browser_module.time, "sleep", lambda s: clock.__setitem__(0, clock[0] + max(s, 0.5)))
    browser.call = lambda *_a, **_k: {}
    browser.evaluate = lambda _expression: "loading"
    with pytest.raises(TimeoutError):
        browser.navigate("https://example.test/never", timeout_seconds=30)


def test_browser_without_screenshots_also_blocks_picture_urls(monkeypatch):
    sent = []
    base = _fake_browser_cdp([])

    def fake_cdp(method, session_id=None, **params):
        if method == "Network.setBlockedURLs":
            sent.append(params["urls"])
        return base(method, session_id, **params)

    monkeypatch.setenv("JEV_CHROME", "headless")
    _stub_chrome(monkeypatch, fake_cdp)
    browser_module.Browser("https://traderie.com/diablo2resurrected", images=False)
    browser_module.Browser("https://traderie.com/diablo2resurrected")
    assert "*.png*" in sent[0] and "*.webp*" in sent[0]
    assert not any(p.startswith("*.") for p in sent[1])  # screenshots on: pictures stay


def test_browser_closes_its_tab_when_opening_the_page_fails(monkeypatch):
    calls = []
    base = _fake_browser_cdp(calls)

    def fake_cdp(method, session_id=None, **params):
        if method == "Page.navigate":
            raise RuntimeError("navigation failed")
        return base(method, session_id, **params)

    _stub_chrome(monkeypatch, fake_cdp)
    with pytest.raises(RuntimeError, match="navigation failed"):
        browser_module.Browser("https://traderie.com/diablo2resurrected")
    assert [m for m, _s, _p in calls].count("Target.closeTarget") == 1


def test_short_item_name_does_not_match_inside_other_words():
    from jev_ultrafast.traderie.verification import matches_item

    assert not matches_item("Um", "Ber Rune number of offers")
    assert not matches_item("Ist", "Soul Drainer - Traderie listing history")
    assert matches_item("Ist", "Ist Rune - Traderie")
    assert matches_item("Harlequin Crest", "Harlequin Crest (Shako) - Traderie")


def test_read_view_reports_a_page_that_changed_while_reading_instead_of_raising():
    class ChangingBrowser(_PageBrowser):
        def evaluate(self, _expression, *, await_promise=False):
            raise browser_module.StalePage("Document changed during evaluation")

    result = read_view(ChangingBrowser(RECENT_URL, "x"), "Harlequin Crest", "trading")
    assert result["status"] == "FAILED" and result["reason"]


def test_advance_explains_a_blocked_run_instead_of_leaving_no_verdict():
    from jev_ultrafast.traderie.controller import advance, new_market

    agent = types.SimpleNamespace(state={"awaiting_handoff": False, "status": "blocked"}, browser=None)
    market = new_market()
    advance(agent, "Harlequin Crest", market)
    assert market["verification"]["passed"] is False
    assert "recent_rows_ok" in market["verification"]["failed_checks"]


# --- the controller step: idempotent, shared, and complete before the last snapshot is handed out ---


class _FakeAgent:
    def __init__(self, state, tick):
        self.state = state
        self.browser = types.SimpleNamespace(evaluate=lambda *_a, **_k: None)
        self.calls = []
        self._tick = tick

    def command(self, name, *_a):
        self.calls.append(name)
        if name == "handoff":
            self.state.update(awaiting_handoff=False, status="ready")
        elif name == "tick":
            return self._tick(self)

    def snapshot(self):
        return dict(self.state)


def _read_stub(monkeypatch):
    from jev_ultrafast.traderie import controller

    seen = []

    def fake(_browser, _item, view):
        seen.append(view)
        return _view("PASSED", f"{TRADERIE_D2R_URL}/product/a", title="x", text="x")

    monkeypatch.setattr(controller, "read_view", fake)
    return seen


def test_a_tick_that_raised_during_a_handoff_does_not_strand_the_run(monkeypatch):
    from jev_ultrafast.traderie.controller import new_market, step

    seen = _read_stub(monkeypatch)

    def tick(agent):
        raise ValueError("Controller handoff required before continuing this run.")

    agent = _FakeAgent({"awaiting_handoff": True, "status": "handoff"}, tick)
    market = new_market()
    with pytest.raises(ValueError, match="handoff required"):
        step(agent, "Harlequin Crest", market)
    assert seen == ["trading"] and agent.calls[0] == "handoff"  # the Trading read and the handoff came first
    assert agent.state["awaiting_handoff"] is False


def test_a_failed_handoff_read_is_repeated_by_the_next_step_before_anything_else(monkeypatch):
    from jev_ultrafast.traderie import controller

    reads = []

    def flaky(_browser, _item, view):
        reads.append(view)
        if len(reads) == 1:
            raise RuntimeError("browser hiccup")
        return _view("PASSED", "u", title="t", text="t")

    monkeypatch.setattr(controller, "read_view", flaky)
    agent = _FakeAgent({"awaiting_handoff": True, "status": "handoff"}, lambda a: None)
    market = controller.new_market()
    with pytest.raises(RuntimeError, match="hiccup"):
        controller.step(agent, "Harlequin Crest", market)
    assert agent.calls == []  # nothing ran on a half-done handoff
    controller.step(agent, "Harlequin Crest", market)
    assert reads == ["trading", "trading"] and agent.calls == ["handoff", "tick"]


def test_run_agent_has_read_recent_trades_and_verified_before_it_yields_the_done_snapshot(monkeypatch):
    from jev_ultrafast.traderie import controller

    _read_stub(monkeypatch)
    monkeypatch.setattr(controller, "verify_views", lambda *_a: {"passed": True})

    def tick(agent):
        agent.state["status"] = "done"

    agent = _FakeAgent({"awaiting_handoff": False, "status": "ready"}, tick)
    market = controller.new_market()
    for snapshot in controller.run_agent(agent, "Harlequin Crest", market):
        if snapshot["status"] == "done":
            break  # a consumer that stops at the first done snapshot
    assert market["recent_trades"]["status"] == "PASSED" and market["verification"] == {"passed": True}


def test_verify_views_does_not_take_the_buying_or_wiki_page_for_trading_or_recent():
    root = f"{TRADERIE_D2R_URL}/product/a"
    for section in ("buying", "wiki"):
        wrong_trading = verify_views("Harlequin Crest", _market(f"{root}/{section}", f"{root}/recent"))
        assert "trading_view" in wrong_trading["failed_checks"]
        wrong_recent = verify_views("Harlequin Crest", _market(root, f"{root}/{section}"))
        assert "recent_view" in wrong_recent["failed_checks"]


def test_the_title_decides_the_item_when_the_page_has_one():
    from jev_ultrafast.traderie.verification import page_matches_item

    assert not page_matches_item("Harlequin Crest", "Shako - Traderie", "Harlequin Crest everywhere in the text")
    assert page_matches_item("Harlequin Crest", "", "Harlequin Crest in the text")


def _passed_market(text, has_more):
    view = {"status": "PASSED", "url": "u", "observed_at": "t", "rows": [], "has_more": has_more, "text": text}
    return {"trading": dict(view), "recent_trades": dict(view)}


def test_the_report_shows_unknown_when_it_could_not_be_told_whether_more_was_left():
    from jev_ultrafast.traderie.controller import _markdown

    assert "未知" in _markdown("Shako", _passed_market("x", None))
    assert "未知" not in _markdown("Shako", _passed_market("x", False))


def test_page_text_cannot_close_the_report_code_block_and_the_item_name_cannot_inject_markdown():
    from jev_ultrafast.traderie.controller import _markdown

    page_text = "before\n```\n# injected heading\n````\nafter"
    report = _markdown("Foo [x](http://evil) *bold*", _passed_market(page_text, False))
    assert report.splitlines()[0].startswith("# Foo \\[x\\](http://evil) \\*bold\\*")
    opening = next(line for line in report.splitlines() if line.startswith("`````"))  # one longer than the longest run
    assert report.count(opening) >= 2 and "`````text" in report


def test_save_report_writes_through_the_atomic_writer(tmp_path):
    import json

    from jev_ultrafast.traderie.controller import save_report

    market = _passed_market("page", False)
    market["verification"] = {"passed": True, "failed_checks": []}
    for key in ("trading", "recent_trades"):
        market[key].update(title="t", reason_code=None, settled=True)
    save_report("Shako", market, tmp_path / "out")
    assert json.loads((tmp_path / "out" / "market.json").read_text(encoding="utf-8"))["trading"]["settled"] is True
    assert not list((tmp_path / "out").glob("*.tmp"))
    market["verification"] = {"passed": False, "failed_checks": ["recent_rows_ok"]}
    assert save_report("Shako", market, tmp_path / "out") is None
    assert not (tmp_path / "out" / "market.json").exists()


def test_a_stale_cosmetic_scroll_does_not_lose_the_handoff(monkeypatch):
    from jev_ultrafast.traderie.controller import advance, new_market

    _read_stub(monkeypatch)

    def stale_scroll(*_args, **_kwargs):
        raise browser_module.StalePage("Document changed during evaluation")

    agent = _FakeAgent({"awaiting_handoff": True, "status": "handoff"}, lambda a: None)
    agent.browser = types.SimpleNamespace(evaluate=stale_scroll)
    market = new_market()
    advance(agent, "Harlequin Crest", market)
    assert agent.calls == ["handoff"]
    assert agent.state["awaiting_handoff"] is False


def test_a_controller_error_during_a_raised_tick_does_not_mask_the_ticks_error(monkeypatch):
    from jev_ultrafast.traderie import controller

    reads = []

    def read_raises_once(_browser, _item, view):
        reads.append(view)
        if len(reads) == 1:
            raise RuntimeError("recent read hiccup")
        return _view("PASSED", "u", title="t", text="t")

    monkeypatch.setattr(controller, "read_view", read_raises_once)

    def tick(agent):
        agent.state["status"] = "done"
        raise ValueError("tick broke")

    agent = _FakeAgent({"awaiting_handoff": False, "status": "ready"}, tick)
    market = controller.new_market()
    with pytest.raises(ValueError, match="tick broke"):  # the tick's error, not the retried controller error
        controller.step(agent, "Harlequin Crest", market)
    assert reads == ["recent_trades"] and market["recent_trades"]["status"] == "NOT_RUN"
    agent._tick = lambda a: None
    controller.step(agent, "Harlequin Crest", market)  # the next step re-runs the controller work
    assert market["recent_trades"]["status"] == "PASSED"


def test_a_row_cell_cannot_inject_a_pipe_or_a_newline_into_the_report_table():
    from jev_ultrafast.traderie.controller import _markdown

    market = _passed_market("page", False)
    market["recent_trades"]["rows"] = [{"buyer_or_seller": "a|b", "price": "1\nUm", "trade_time": "now"}]
    report = _markdown("Shako", market)
    assert "| a\\|b | 1 Um | now |" in report


def test_the_trading_environment_column_joins_the_parts_that_are_there_and_skips_the_empty_ones():
    from jev_ultrafast.traderie.controller import _trading_cells

    row = {
        "seller": "s", "ask": "a", "high_rune_value": "h", "posted_time": "t", "defense": "d",
        "platform": "PC", "mode": "", "ladder": None,
    }
    assert _trading_cells(row)[4] == "PC"
    assert _trading_cells({**row, "mode": "Softcore", "ladder": "Ladder"})[4] == "PC / Softcore / Ladder"
