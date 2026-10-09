import json
import os
import sys
from datetime import datetime, timedelta, timezone

import pytest

from tests._harness_stub import install

install()  # before the backend import below: nothing here may start the Chrome daemon

from jevsvc import app, invites, tokens  # noqa: E402, I001
from jevsvc.store import MemoryStore, StoreError  # noqa: E402

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


def test_total_limit_is_per_code_not_per_day(store, code):
    for i in range(100):
        status, body = start(store, code)
        assert status == 200 and body["used"] == i + 1
    status, body = start(store, code)
    assert status == 429 and "100" in body["error"]
    assert store.data[f"invite:{invites.code_hash(code)}"]["used"] == "100"


def test_used_up_code_stays_used_up_on_a_later_day(store, code):
    for _ in range(100):
        start(store, code)
    later = datetime(2026, 5, 1, 16, 1, tzinfo=timezone.utc)  # 2026-05-02 00:01 in Taipei
    with pytest.raises(invites.InviteError) as err:
        app.run_start({"invite": code, "item_name": "x"}, "1.1.1.1", store, SECRET, later)
    assert err.value.status == 429


def test_bad_input_does_not_count(store, code):
    assert start(store, code, item_name="   ")[1]["error"] == "請輸入裝備名稱"
    status, body = app.run_start({"invite": code, "item_name": "a" * 201}, "i", store, SECRET, NOW)
    assert (status, body["error"]) == (400, "裝備名稱太長")
    assert start(store, code, load_more=99)[0] == 400
    assert start(store, code, load_more=True)[0] == 400
    assert "used" not in store.data[f"invite:{invites.code_hash(code)}"]


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
    assert choose(store, token, lambda *a: {}, page={**PAGE, "title": "x" * 501})[0] == 400
    assert choose(store, token, lambda *a: {}, page={**PAGE, "url": "https://traderie.com/" + "x" * 2000})[0] == 400
    assert choose(store, token, lambda *a: {}, history=[{}] * 121)[0] == 400
    assert choose(store, token, lambda *a: {}, page="nope")[0] == 400


def test_chooser_gets_server_goal_and_item(store, code):
    calls = []

    def chooser(page, goal, history, typed, **extra):
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

    def chooser(*args, **extra):
        nonlocal used
        calls = 2 if used % 5 == 4 else 1  # an occasional re-ask costs two calls
        used += calls
        return {"operation": "CLICK", "usage": {}, "model_calls": calls}

    statuses = [choose(store, token, chooser)[0] for _ in range(40)]
    assert 429 in statuses and used <= 30
    assert statuses.index(429) > 15  # the limit is reached by calls, not by an early cut
    status, body = choose(store, token, chooser)
    assert status == 429 and "上限" in body["error"]


def test_a_reservation_that_does_not_fit_takes_nothing_from_the_run(store):
    """The run budget is a reservation: a step that cannot fit must leave the counter exactly as it was, or the client
    silently loses calls it never used and the run is cut short."""
    run = "run:reserve-test"
    assert app._reserve(store, run, 2) is True
    assert int(store.run("GET", run)) == 2

    store.run("SET", run, str(app.MAX_MODEL_CALLS - 1))
    assert app._reserve(store, run, 1) is True  # filling the budget exactly is allowed
    assert int(store.run("GET", run)) == app.MAX_MODEL_CALLS

    assert app._reserve(store, run, 1) is False
    assert int(store.run("GET", run)) == app.MAX_MODEL_CALLS  # nothing was taken
    assert app._reserve(store, run, 2) is False
    assert int(store.run("GET", run)) == app.MAX_MODEL_CALLS


def test_chooser_failure_is_502(store, code):
    def boom(*args, **extra):
        raise RuntimeError("jev down")

    status, body = choose(store, token_for(store, code), boom)
    assert status == 502 and "Jev 暫時無法回應" in body["error"]


def test_chooser_type_error_is_400(store, code):
    def never(*args, **extra):
        raise AssertionError("a page of the wrong shape must be refused before the model is asked")

    page = {**PAGE, "actions": [{"kind": "click"}]}
    assert choose(store, token_for(store, code), never, page=page)[0] == 400


def pick(store, token, picker, **extra):
    return app.pick_base_step({"run_token": token, **extra}, store, SECRET, NOW, picker)


def test_a_picked_base_gets_a_new_token_for_the_base_in_the_same_run(store, code):
    token = token_for(store, code)
    status, body = pick(store, token, lambda item, options, **kw: {"base": "Ring", "probability": 0.9, "usage": {}})
    assert status == 200 and body["base"] == body["item_name"] == "Ring"
    old, new = tokens.verify(SECRET, token, NOW.timestamp()), tokens.verify(SECRET, body["run_token"], NOW.timestamp())
    assert (new["item"], new["rid"], new["exp"]) == ("Ring", old["rid"], old["exp"])
    goals = []
    seen = lambda page, goal, history, typed, **kw: goals.append((goal, typed)) or {"model_calls": 1}  # noqa: E731
    choose(store, body["run_token"], seen)
    assert 'item "Ring"' in goals[0][0] and goals[0][1] == "Ring"


def test_no_base_or_a_base_outside_the_list_returns_no_token(store, code):
    token = token_for(store, code)
    assert pick(store, token, lambda item, options, **kw: {"base": None})[1]["base"] is None
    status, body = pick(store, token, lambda item, options, **kw: {"base": "Not A Base"})
    assert status == 200 and body["base"] is None and "run_token" not in body


def test_base_picking_uses_the_run_call_limit_and_rejects_bad_lists(store, code):
    token = token_for(store, code)
    for _ in range(30):
        pick(store, token, lambda item, options, **kw: {"base": None})
    status, body = pick(store, token, lambda item, options, **kw: {"base": None})
    assert status == 429 and "上限" in body["error"]
    fresh = token_for(store, code)
    seen = []

    def picker(item, options, **kw):
        seen.append(options)
        return {"base": None}

    pick(store, fresh, picker, options=["Only This"])  # the client's own list is ignored
    assert "Only This" not in seen[0] and "Ring" in seen[0]
    assert pick(store, fresh, lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("down")))[0] == 502


def test_invite_management(store):
    code = invites.add(store, "bob", limit=5)
    with pytest.raises(ValueError, match="已經有邀請碼"):
        invites.add(store, "bob")
    with pytest.raises(ValueError, match="名字不可空白"):
        invites.add(store, " ")
    with pytest.raises(ValueError, match="找不到"):
        invites.revoke(store, "ghost")
    start(store, code)
    listed = invites.list_invites(store)
    row = lambda r: (r["name"], r["limit"], r["expires"], r["disabled"], r["used"])  # noqa: E731
    assert [row(r) for r in listed] == [("bob", 5, "", False, 1)]
    assert not any(code in str(v) for v in store.data.values())


def call_wsgi(method, path, body=b"", store=None, length=None):
    import io

    from jevsvc.http import wsgi

    seen = {}
    environ = {
        "REQUEST_METHOD": method,
        "PATH_INFO": path,
        "CONTENT_LENGTH": str(len(body)) if length is None else length,
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


def test_wsgi_rejects_unusable_content_length_and_hostile_json_with_400(monkeypatch):
    monkeypatch.setenv("RUN_TOKEN_SECRET", "s" * 40)
    store = MemoryStore()
    body = b'{"invite": "x"}'
    assert call_wsgi("POST", "/api/run/start", body, store, length="abc")[0].startswith("400")
    assert call_wsgi("POST", "/api/run/start", body, store, length="-1")[0].startswith("400")
    assert call_wsgi("POST", "/api/run/start", b"[" * 100000, store)[0].startswith("400")


def test_a_client_can_ask_again_without_the_blocked_option(store, code):
    seen = []

    def chooser(page, goal, history, typed, **extra):
        seen.append(extra)
        return {"operation": "CLICK", "usage": {}, "model_calls": 1}

    token = token_for(store, code)
    choose(store, token, chooser)
    body = {"run_token": token, "phase": "trading", "page": PAGE, "history": [], "no_block": True}
    assert app.choose_step(body, store, SECRET, NOW, chooser)[0] == 200
    asked = [{k: v for k, v in extra.items() if k == "allow_blocked"} for extra in seen]
    assert asked == [{}, {"allow_blocked": False}]


def test_a_base_the_client_matched_itself_costs_no_model_call(store, code):
    token = token_for(store, code)

    def never(*args, **kw):
        raise AssertionError("the model must not be called")

    body = {"run_token": token, "options": ["Ring", "Amulet"], "base": "Ring"}
    status, reply = app.pick_base_step(body, store, SECRET, NOW, never)
    assert status == 200 and tokens.verify(SECRET, reply["run_token"], NOW.timestamp())["item"] == "Ring"
    assert store.data.get(f"run:{tokens.verify(SECRET, token, NOW.timestamp())['rid']}") is None
    body["base"] = "Not A Base"
    assert app.pick_base_step(body, store, SECRET, NOW, never)[0] == 400


def test_one_record_per_user_and_nothing_else(store, code):
    key = f"invite:{invites.code_hash(code)}"
    start(store, code)
    assert [k for k in store.data if k.startswith(("invite:", "used"))] == [key]
    assert set(store.data) == {key, "invite-names"}  # the record and the name index, nothing else
    invites.revoke(store, "amy")
    assert store.data[key]["disabled"] == "1"


def test_a_name_missing_from_its_family_raises_instead_of_returning_none(store):
    """The router's tuples and the family methods must agree; a drift used to come back as None silently."""
    for family in (store._string, store._hash, store._keyspace):
        with pytest.raises(StoreError, match="unsupported command NOPE"):
            family("NOPE", [])


def test_staged_backend_imports_without_browser_harness_in_environment(tmp_path):
    """Staged app built by services/build.py can import without browser_harness module."""
    import importlib.util
    import subprocess
    from pathlib import Path
    
    # Import build function from services/build.py
    services_dir = Path(__file__).resolve().parents[1] / "services"
    build_spec = importlib.util.spec_from_file_location("build_module", services_dir / "build.py")
    build_module = importlib.util.module_from_spec(build_spec)
    build_spec.loader.exec_module(build_module)
    build = build_module.build
    
    # Build staged app to tmp_path
    build(tmp_path)
    
    # Run in subprocess with browser_harness blocked: verify import succeeds
    code = """
import sys
sys.modules["browser_harness"] = None
import app
print("ok")
"""
    result = subprocess.run(
        [sys.executable, "-c", code],
        cwd=str(tmp_path),
        capture_output=True,
        text=True,
        stdin=subprocess.DEVNULL,  # see tests/test_csv_export.py: an invalid inherited stdin fails with WinError 6
        env={k: v for k, v in os.environ.items() if k != "RUN_TOKEN_SECRET"},
    )
    assert result.returncode == 0, f"Build import failed: {result.stderr}"
    assert "ok" in result.stdout
