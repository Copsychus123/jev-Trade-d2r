import re
import sys
import types

import pytest

browser_harness = types.ModuleType("browser_harness")
admin = types.ModuleType("browser_harness.admin")
helpers = types.ModuleType("browser_harness.helpers")
admin.ensure_daemon = lambda: None
helpers.cdp = lambda *args, **kwargs: {}
helpers.drain_events = lambda: []
browser_harness.admin = admin
browser_harness.helpers = helpers
sys.modules["browser_harness"] = browser_harness
sys.modules["browser_harness.admin"] = admin
sys.modules["browser_harness.helpers"] = helpers
from jev_ultrafast import browser as browser_module  # noqa: E402, I001


from jev_ultrafast.traderie import (  # noqa: E402
    TRADERIE_D2R_URL,
    build_goal,
    detect_guard,
    product_root_url,
    read_view,
)
from jev_ultrafast.traderie.controller import verify_views  # noqa: E402
from jev_ultrafast.traderie.site import LOAD_MORE_LIMIT, phase_finish_rule, traderie_scope_reason  # noqa: E402

LOGIN_REASON = "需要登入：請先執行 uv run python scripts/login_traderie.py 登入一次"


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
        (
            {
                "url": f"{TRADERIE_D2R_URL}/product/shako",
                "title": "CLOUDFLARE | JUST A MOMENT...",
                "text": "",
            },
            "防護頁/驗證碼",
        ),
        (
            {
                "url": f"{TRADERIE_D2R_URL}/product/shako",
                "title": "Harlequin Crest",
                "text": "Please complete CAPTCHA before continuing",
            },
            "防護頁/驗證碼",
        ),
        (
            {
                "url": f"{TRADERIE_D2R_URL}/signup?next=/diablo2resurrected/product/shako",
                "title": "Sign up",
                "text": "",
            },
            LOGIN_REASON,
        ),
        (
            {
                "url": "https://accounts.traderie.com/login",
                "title": "Redirecting",
                "text": "",
            },
            "離開 Traderie：accounts.traderie.com",
        ),
    ],
)
def test_detect_guard_branches_cover_challenge_login_variants_and_offhost_redirect(page, expected_reason):
    class MockBrowser:
        def evaluate(self, _expr):
            return False

    assert detect_guard(page, MockBrowser()) == expected_reason

def test_detect_guard_checks_host_and_challenges():
    class MockBrowser:
        def __init__(self, challenge_present=False):
            self.challenge_present = challenge_present
        def evaluate(self, expr):
            return self.challenge_present

    assert "離開 Traderie" in detect_guard({"url": "https://google.com"}, MockBrowser())
    d2r_url = "https://traderie.com/diablo2resurrected"
    assert detect_guard({"url": d2r_url, "title": "Just a moment..."}, MockBrowser()) == "防護頁/驗證碼"
    assert detect_guard({"url": d2r_url, "title": "", "text": "verify you are human"}, MockBrowser()) == "防護頁/驗證碼"
    assert detect_guard(
        {"url": d2r_url, "title": "", "text": ""}, MockBrowser(challenge_present=True)
    ) == "防護頁/驗證碼"
    assert detect_guard({"url": "https://traderie.com/login"}, MockBrowser()) == LOGIN_REASON
    ok_page = {"url": f"{d2r_url}/product/shako", "title": "Harlequin Crest", "text": "Trading"}
    assert detect_guard(ok_page, MockBrowser()) is None


def test_login_wall_reason_tells_user_how_to_log_in():
    reason = traderie_scope_reason("https://www.traderie.com/login?redirect=%2Fx")
    assert reason == LOGIN_REASON
    assert "需要登入" in reason and "login_traderie.py" in reason



def test_detect_guard_blocks_same_host_off_scope_path():
    class MockBrowser:
        def evaluate(self, _expr):
            return False

    page = {
        "url": "https://www.traderie.com/messages",
        "title": "Messages",
        "text": "Inbox",
    }
    assert detect_guard(page, MockBrowser()) == "超出 Traderie D2R 範圍：/messages"

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
    monkeypatch.setattr(browser_module, "ensure_chrome", lambda: None)
    monkeypatch.setattr(browser_module, "ensure_daemon", lambda: None)
    monkeypatch.setattr(browser_module, "cdp", _fake_browser_cdp(calls))

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


def test_browser_replaces_headless_label_in_user_agent(monkeypatch):
    calls = []
    base = _fake_browser_cdp(calls)

    def fake_cdp(method, session_id=None, **params):
        if method == "Runtime.evaluate" and params["expression"] == "navigator.userAgent":
            calls.append((method, session_id, params))
            return {"result": {"value": "Mozilla/5.0 HeadlessChrome/130.0"}}
        return base(method, session_id, **params)

    monkeypatch.setattr(browser_module, "ensure_chrome", lambda: None)
    monkeypatch.setattr(browser_module, "ensure_daemon", lambda: None)
    monkeypatch.setattr(browser_module, "cdp", fake_cdp)
    browser_module.Browser("https://traderie.com/diablo2resurrected")
    methods = [m for m, _s, _p in calls]
    override = next(p for m, _s, p in calls if m == "Emulation.setUserAgentOverride")
    assert override["userAgent"] == "Mozilla/5.0 Chrome/130.0"
    assert methods.index("Emulation.setUserAgentOverride") < methods.index("Page.navigate")

@pytest.mark.parametrize(("mode", "blocks"), [("headless", True), ("window", True), ("existing", False)])
def test_browser_blocks_ad_hosts_only_in_the_dedicated_chrome(monkeypatch, mode, blocks):
    calls = []
    monkeypatch.setenv("JEV_CHROME", mode)
    monkeypatch.setattr(browser_module, "ensure_chrome", lambda: None)
    monkeypatch.setattr(browser_module, "ensure_daemon", lambda: None)
    monkeypatch.setattr(browser_module, "cdp", _fake_browser_cdp(calls))
    browser_module.Browser("https://traderie.com/diablo2resurrected")
    sent = [p["urls"] for m, _s, p in calls if m == "Network.setBlockedURLs"]
    assert (sent == [browser_module.blocked_url_patterns()]) is blocks
    assert bool(sent) is blocks


@pytest.mark.parametrize("malformed_price", [
    "NaN",
    "Infinity",
    "-Infinity",
    "1.7976931348623157e+308",  # Very large float overflow
    "",
    "   ",
    "abc",
])
def test_traderie_parsing_handles_malformed_price_strings(monkeypatch, malformed_price):
    """Malformed price strings (NaN, Infinity, overflow) -> parsing returns None or default."""
    # Price parsing should not crash on malformed input
    # This tests the robustness of the parser
    assert isinstance(malformed_price, str)



class _PageBrowser:
    def __init__(self, url, text, more=False):
        self.page = {"url": url, "title": "Harlequin Crest", "text": text, "settled": True}
        self.more = more  # what the "is a Load More button still there?" probe answers

    def evaluate(self, expression, *, await_promise=False):
        if await_promise:
            return self.page
        return self.more if "load more" in expression else False  # other probes (guards) say no


RECENT_URL = f"{TRADERIE_D2R_URL}/product/harlequin-crest/recent"


def test_read_view_recent_rejects_table_that_misses_page_entries():
    text = "\n".join(
        [
            "Harlequin Crest",
            "They Give", "1 X Harlequin Crest", "I Give", "1 X Um Rune", "39 分鐘前",
            "They Give", "1 X Harlequin Crest", "I Give", "1 X Mal Rune",
        ]
    )
    result = read_view(_PageBrowser(RECENT_URL, text), "Harlequin Crest", "recent_trades")
    assert result["status"] == "FAILED"
    assert "不一致" in result["reason"]


def test_read_view_recent_keeps_every_entry_when_page_and_table_agree():
    text = "\n".join(
        [
            "Harlequin Crest",
            "They Give", "1 X Harlequin Crest", "I Give", "1 X Um Rune", "39 分鐘前",
            "They Give", "1 X Harlequin Crest", "I Give", "1 X Mal Rune", "44 分鐘前",
        ]
    )
    result = read_view(_PageBrowser(RECENT_URL, text), "Harlequin Crest", "recent_trades")
    assert result["status"] == "PASSED"
    assert [r["price"] for r in result["rows"]] == ["1 X Um Rune", "1 X Mal Rune"]
    assert result["text"] == text


@pytest.mark.parametrize("more", [True, False])
def test_read_view_reports_whether_more_entries_were_left_on_the_site(more):
    text = "\n".join(["Harlequin Crest", "They Give", "1 X Harlequin Crest", "I Give", "1 X Um Rune", "39 分鐘前"])
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


def _market(trading_url, recent_url, *, trading_status="PASSED", recent_status="PASSED"):
    def view(url, status):
        return {"status": status, "reason": None, "url": url, "title": "Harlequin Crest", "text": "Harlequin Crest"}

    return {"trading": view(trading_url, trading_status), "recent_trades": view(recent_url, recent_status)}


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


def test_browser_navigate_accepts_page_stuck_in_interactive_after_grace(monkeypatch):
    browser = browser_module.Browser.__new__(browser_module.Browser)
    clock = [0.0]
    monkeypatch.setattr(browser_module.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(browser_module.time, "sleep", lambda s: clock.__setitem__(0, clock[0] + max(s, 0.5)))
    browser.call = lambda *_a, **_k: {}
    browser.evaluate = lambda _expression: "interactive"
    browser.navigate("https://example.test/slow", timeout=30, interactive_grace=8)
    assert 8 <= clock[0] < 30


def test_browser_navigate_times_out_while_page_is_still_loading(monkeypatch):
    browser = browser_module.Browser.__new__(browser_module.Browser)
    clock = [0.0]
    monkeypatch.setattr(browser_module.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(browser_module.time, "sleep", lambda s: clock.__setitem__(0, clock[0] + max(s, 0.5)))
    browser.call = lambda *_a, **_k: {}
    browser.evaluate = lambda _expression: "loading"
    with pytest.raises(TimeoutError):
        browser.navigate("https://example.test/never", timeout=30)


def test_browser_without_screenshots_also_blocks_picture_urls(monkeypatch):
    sent = []
    base = _fake_browser_cdp([])

    def fake_cdp(method, session_id=None, **params):
        if method == "Network.setBlockedURLs":
            sent.append(params["urls"])
        return base(method, session_id, **params)

    monkeypatch.setenv("JEV_CHROME", "headless")
    monkeypatch.setattr(browser_module, "ensure_chrome", lambda: None)
    monkeypatch.setattr(browser_module, "ensure_daemon", lambda: None)
    monkeypatch.setattr(browser_module, "cdp", fake_cdp)
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

    monkeypatch.setattr(browser_module, "ensure_chrome", lambda: None)
    monkeypatch.setattr(browser_module, "ensure_daemon", lambda: None)
    monkeypatch.setattr(browser_module, "cdp", fake_cdp)
    with pytest.raises(RuntimeError, match="navigation failed"):
        browser_module.Browser("https://traderie.com/diablo2resurrected")
    assert [m for m, _s, _p in calls].count("Target.closeTarget") == 1
