import json
import sys
import types
from datetime import datetime, timedelta, timezone

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
from jevsvc import app, invites, tokens  # noqa: E402, I001
from jevsvc.store import MemoryStore  # noqa: E402

SECRET = "s" * 40
TAIPEI = invites.TAIPEI
NOW = datetime(2026, 5, 1, 12, 0, tzinfo=TAIPEI)
PRODUCT = "https://www.traderie.com/diablo2resurrected/product/123"
PAGE = {"url": PRODUCT, "title": "t", "text": "hello", "actions": []}


@pytest.fixture
def store():
    return MemoryStore()


@pytest.fixture
def code(store):
    return invites.add(store, "amy")


def start(store, code, ip="1.1.1.1", **extra):
    body = {"invite": code, "item_name": "Harlequin Crest", **extra}
    try:
        return app.run_start(body, ip, store, SECRET, NOW)
    except invites.InviteError as err:
        return err.status, {"error": err.message}


def test_unknown_code_rejected(store):
    assert start(store, "nope") == (401, {"error": "邀請碼無效或已停用"})


def test_disabled_code_rejected(store, code):
    invites.revoke(store, "amy")
    assert start(store, code) == (401, {"error": "邀請碼無效或已停用"})


def test_expired_code_rejected(store):
    code = invites.add(store, "old", expires="2026-04-30")
    assert start(store, code) == (401, {"error": "邀請碼已過期"})
    ok = invites.add(store, "today", expires="2026-05-01")
    assert start(store, ok)[0] == 200


def test_eleventh_wrong_attempt_is_throttled(store, code):
    for _ in range(10):
        assert start(store, "bad", ip="9.9.9.9")[0] == 401
    assert start(store, "bad", ip="9.9.9.9") == (429, {"error": "錯誤次數太多，請 15 分鐘後再試"})
    assert start(store, code, ip="9.9.9.9")[0] == 429
    assert start(store, code, ip="8.8.8.8")[0] == 200


def test_daily_limit(store, code):
    for i in range(100):
        status, body = start(store, code)
        assert status == 200 and body["used"] == i + 1
    status, body = start(store, code)
    assert status == 429 and "100" in body["error"]
    assert store.run("GET", f"used:{invites.code_hash(code)}:2026-05-01") == "100"


def test_day_resets_at_taipei_midnight(store, code):
    for _ in range(100):
        start(store, code)
    later = datetime(2026, 5, 1, 16, 1, tzinfo=timezone.utc)  # 2026-05-02 00:01 in Taipei
    assert app.run_start({"invite": code, "item_name": "x"}, "1.1.1.1", store, SECRET, later)[0] == 200


def test_bad_input_does_not_count(store, code):
    assert start(store, code, item_name="   ")[1]["error"] == "請輸入裝備名稱"
    assert app.run_start({"invite": code, "item_name": "a" * 201}, "i", store, SECRET, NOW) == (
        400,
        {"error": "裝備名稱太長"},
    )
    assert start(store, code, load_more=99)[0] == 400
    assert start(store, code, load_more=True)[0] == 400
    assert store.run("GET", f"used:{invites.code_hash(code)}:2026-05-01") is None


def test_start_response(store, code):
    status, body = start(store, code, item_name="  Harlequin   Crest ", load_more=3)
    assert status == 200
    assert (body["item_name"], body["load_more"], body["used"], body["limit"]) == ("Harlequin Crest", 3, 1, 100)


def token_for(store, code):
    return start(store, code)[1]["run_token"]


def choose(store, token, chooser, page=PAGE, phase="trading", history=()):
    body = {"run_token": token, "phase": phase, "page": page, "history": list(history)}
    return app.choose_step(body, store, SECRET, NOW, chooser)


def test_tampered_and_expired_tokens(store, code):
    token = token_for(store, code)
    payload, sig = token.split(".")
    bad = [payload + "." + sig[:-2] + "AA", "x" + payload + "." + sig, "garbage", None]
    for item in bad:
        with pytest.raises(invites.InviteError) as err:
            choose(store, item, lambda *a: {})
        assert err.value.status == 401
    with pytest.raises(invites.InviteError) as err:
        app.choose_step(
            {"run_token": token, "phase": "trading", "page": PAGE},
            store,
            SECRET,
            NOW + timedelta(seconds=tokens.RUN_SECONDS + 1),
            lambda *a: {},
        )
    assert (err.value.status, err.value.message) == (401, "查詢已逾時或無效，請重新開始")


def test_off_scope_url(store, code):
    status, body = choose(store, token_for(store, code), lambda *a: {}, page={**PAGE, "url": "https://example.com/"})
    assert status == 400 and body["error"].startswith("超出範圍")


def test_bad_page_shapes(store, code):
    token = token_for(store, code)
    assert choose(store, token, lambda *a: {}, phase="other")[0] == 400
    assert choose(store, token, lambda *a: {}, page={**PAGE, "text": "x" * 6001})[0] == 400
    assert choose(store, token, lambda *a: {}, page={**PAGE, "actions": [{}] * 261})[0] == 400
    assert choose(store, token, lambda *a: {}, history=[{}] * 121)[0] == 400
    assert choose(store, token, lambda *a: {}, page="nope")[0] == 400


def test_chooser_gets_server_goal_and_item(store, code):
    calls = []

    def chooser(page, goal, history, typed):
        calls.append((page, goal, history, typed))
        return {"operation": "CLICK", "request": {"secret": 1}, "raw_answers": [], "usage": {}, "model_calls": 1}

    token = token_for(store, code)
    history = [{"action": "a", "kind": "click", "text": "t", "page_changed": True}]
    status, body = choose(store, token, chooser, phase="recent_trades", history=history)
    assert status == 200 and body["operation"] == "CLICK"
    assert "request" not in body and "raw_answers" not in body
    page, goal, hist, typed = calls[0]
    assert typed == "Harlequin Crest" and hist == history
    assert "Harlequin Crest" in goal
    choose(store, token, chooser, phase="trading")
    assert calls[1][1] != goal


def test_a_run_never_exceeds_30_model_calls(store, code):
    token = token_for(store, code)
    used = 0

    def chooser(*args):
        nonlocal used
        calls = 2 if used % 5 == 4 else 1  # an occasional re-ask costs two calls
        used += calls
        return {"operation": "CLICK", "usage": {}, "model_calls": calls}

    statuses = [choose(store, token, chooser)[0] for _ in range(40)]
    assert 429 in statuses and used <= 30
    assert statuses.index(429) > 15  # the limit is reached by calls, not by an early cut
    status, body = choose(store, token, chooser)
    assert status == 429 and "上限" in body["error"]


def test_chooser_failure_is_502(store, code):
    def boom(*args):
        raise RuntimeError("jev down")

    status, body = choose(store, token_for(store, code), boom)
    assert status == 502 and "Jev 暫時無法回應" in body["error"]


def test_chooser_type_error_is_400(store, code):
    def bad(*args):
        raise KeyError("actions")

    assert choose(store, token_for(store, code), bad) == (400, {"error": "頁面資料格式錯誤"})


def pick(store, token, picker, options=("Ring", "Grand Charm")):
    return app.pick_base_step({"run_token": token, "options": list(options)}, store, SECRET, NOW, picker)


def test_a_picked_base_gets_a_new_token_for_the_base_in_the_same_run(store, code):
    token = token_for(store, code)
    status, body = pick(store, token, lambda item, options: {"base": "Ring", "probability": 0.9, "usage": {}})
    assert status == 200 and body["base"] == body["item_name"] == "Ring"
    old, new = tokens.verify(SECRET, token, NOW.timestamp()), tokens.verify(SECRET, body["run_token"], NOW.timestamp())
    assert (new["item"], new["rid"], new["exp"]) == ("Ring", old["rid"], old["exp"])
    goals = []
    seen = lambda page, goal, history, typed: goals.append((goal, typed)) or {"model_calls": 1}  # noqa: E731
    choose(store, body["run_token"], seen)
    assert 'item "Ring"' in goals[0][0] and goals[0][1] == "Ring"


def test_no_base_or_a_base_outside_the_list_returns_no_token(store, code):
    token = token_for(store, code)
    assert pick(store, token, lambda item, options: {"base": None})[1]["base"] is None
    status, body = pick(store, token, lambda item, options: {"base": "Amulet"})
    assert status == 200 and body["base"] is None and "run_token" not in body


def test_base_picking_uses_the_run_call_limit_and_rejects_bad_lists(store, code):
    token = token_for(store, code)
    for _ in range(30):
        pick(store, token, lambda item, options: {"base": None})
    status, body = pick(store, token, lambda item, options: {"base": None})
    assert status == 429 and "上限" in body["error"]
    fresh = token_for(store, code)
    for bad in ([], ["Ring", "Ring"], ["x" * 81], [1]):
        assert pick(store, fresh, lambda item, options: {"base": None}, options=bad)[0] == 400
    assert pick(store, fresh, lambda *a: (_ for _ in ()).throw(RuntimeError("down")))[0] == 502


def test_invite_management(store):
    code = invites.add(store, "bob", limit=5)
    with pytest.raises(ValueError, match="已經有邀請碼"):
        invites.add(store, "bob")
    with pytest.raises(ValueError, match="名字不可空白"):
        invites.add(store, " ")
    with pytest.raises(ValueError, match="找不到"):
        invites.revoke(store, "ghost")
    start(store, code)
    assert invites.list_invites(store, NOW) == [
        {"name": "bob", "limit": 5, "expires": "", "disabled": False, "used_today": 1}
    ]
    assert not any(code in str(v) for v in store.data.values())


def call_wsgi(method, path, body=b"", store=None):
    import io

    from jevsvc.http import wsgi

    seen = {}
    environ = {
        "REQUEST_METHOD": method,
        "PATH_INFO": path,
        "CONTENT_LENGTH": str(len(body)),
        "wsgi.input": io.BytesIO(body),
        "REMOTE_ADDR": "1.2.3.4",
    }
    routes = {"/api/run/start": app.run_start, "/api/choose": app.choose_route}

    def start_response(status, headers):
        seen["status"], seen["headers"] = status, dict(headers)

    data = b"".join(wsgi(environ, start_response, routes, store))
    return seen["status"], seen["headers"], data


def test_wsgi_serves_the_two_routes_with_cors_and_rejects_everything_else(monkeypatch):
    monkeypatch.setenv("RUN_TOKEN_SECRET", "s" * 40)
    store = MemoryStore()
    code = invites.add(store, "小明")
    start = json.dumps({"invite": code, "item_name": "Shako"}).encode()
    status, headers, data = call_wsgi("POST", "/api/run/start", start, store)
    assert status.startswith("200") and json.loads(data)["used"] == 1
    assert headers["Access-Control-Allow-Origin"] == "*"
    assert call_wsgi("OPTIONS", "/api/choose", store=store)[0].startswith("204")
    assert call_wsgi("GET", "/api/choose", store=store)[0].startswith("405")
    assert call_wsgi("POST", "/api/other", store=store)[0].startswith("404")
    wrong = json.dumps({"invite": "inv-wrong", "item_name": "Shako"}).encode()
    assert call_wsgi("POST", "/api/run/start", wrong, store)[0].startswith("401")


def test_a_client_can_ask_again_without_the_blocked_option(store, code):
    seen = []

    def chooser(page, goal, history, typed, **extra):
        seen.append(extra)
        return {"operation": "CLICK", "usage": {}, "model_calls": 1}

    token = token_for(store, code)
    choose(store, token, chooser)
    body = {"run_token": token, "phase": "trading", "page": PAGE, "history": [], "no_block": True}
    assert app.choose_step(body, store, SECRET, NOW, chooser)[0] == 200
    assert seen == [{}, {"allow_blocked": False}]


def test_a_base_the_client_matched_itself_costs_no_model_call(store, code):
    token = token_for(store, code)

    def never(*args):
        raise AssertionError("the model must not be called")

    body = {"run_token": token, "options": ["Ring", "Amulet"], "base": "Ring"}
    status, reply = app.pick_base_step(body, store, SECRET, NOW, never)
    assert status == 200 and tokens.verify(SECRET, reply["run_token"], NOW.timestamp())["item"] == "Ring"
    assert store.data.get(f"run:{tokens.verify(SECRET, token, NOW.timestamp())['rid']}") is None
    body["base"] = "Helm"
    assert app.pick_base_step(body, store, SECRET, NOW, never)[0] == 400
