import json
import os
import sys
from datetime import date, datetime, timedelta, timezone

import pytest

from tests._harness_stub import install

install()  # before the backend import below: nothing here may start the Chrome daemon

from jevsvc import app, invites, tokens  # noqa: E402, I001
from jevsvc import http as backend_http  # noqa: E402
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


def test_a_failed_base_pick_keeps_its_call_and_gives_the_start_use_back_once(store, code):
    """A pick Jev cannot answer still costs the run the call it reserved, and — since the run got no answer at all —
    the start use comes back once: the counter stays at one while the invitation's `used` drops by one."""
    token = token_for(store, code)
    rid = tokens.verify(SECRET, token, NOW.timestamp())["rid"]
    record = invites.record_key(invites.code_hash(code))

    def down(*args, **kw):
        raise RuntimeError("jev down")

    status, reply = pick(store, token, down)
    assert (status, reply["code"]) == (502, "model_unavailable")
    assert store.run("GET", f"run:{rid}") == "1"  # the reserved call is this attempt's cost, not handed back
    assert store.run("HGET", record, "used") == "0"  # but the start use of the unanswered run came back
    assert store.run("GET", f"refund:{rid}") == "1"  # claimed, so no later step of the run refunds again


def test_a_second_failed_base_pick_in_a_run_does_not_give_the_start_use_back_again(store, code):
    """The refund is claimed once per run: Jev failing twice keeps both attempts' calls, but the start use goes back
    on the first failure only (`refund:{rid}` is set with NX)."""
    token = token_for(store, code)
    rid = tokens.verify(SECRET, token, NOW.timestamp())["rid"]
    record = invites.record_key(invites.code_hash(code))

    def down(*args, **kw):
        raise RuntimeError("jev down")

    assert pick(store, token, down)[0] == 502
    assert pick(store, token, down)[0] == 502
    assert store.run("GET", f"run:{rid}") == "2"  # each attempt kept its own reserved call
    assert store.run("HGET", record, "used") == "0"  # one start use given back, not two
    assert store.run("GET", f"refund:{rid}") == "1"


def test_a_failed_base_pick_after_an_answered_step_keeps_the_start_use(store, code):
    """Once any step of the run was answered (the `ok:{rid}` marker), a later base pick that fails costs only its own
    call: the start use stays counted, because the run did get an answer."""
    token = token_for(store, code)
    rid = tokens.verify(SECRET, token, NOW.timestamp())["rid"]
    record = invites.record_key(invites.code_hash(code))
    assert choose(store, token, lambda *a, **k: {"operation": "CLICK", "usage": {}})[0] == 200

    def down(*args, **kw):
        raise RuntimeError("jev down")

    assert pick(store, token, down)[0] == 502
    assert store.run("GET", f"run:{rid}") == "2"  # the answered choose kept one of two, the pick kept its one
    assert store.run("HGET", record, "used") == "1"  # no refund: this run already got an answer


def test_a_successful_base_pick_costs_one_call_and_hands_nothing_back(store, code):
    """A pick Jev answers is exactly the one call it reserved and nothing else: no spare exists to hand back, and the
    start use stays counted (the person got their answer)."""
    token = token_for(store, code)
    rid = tokens.verify(SECRET, token, NOW.timestamp())["rid"]
    record = invites.record_key(invites.code_hash(code))

    status, body = pick(store, token, lambda item, options, **kw: {"base": "Ring", "probability": 0.9, "usage": {}})
    assert status == 200 and body["base"] == "Ring"
    assert store.run("GET", f"run:{rid}") == "1"  # exactly one call, nothing handed back
    assert store.run("HGET", record, "used") == "1"
    assert store.run("GET", f"refund:{rid}") is None


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


class FakeHeaders:
    """`Request.header` is documented case-insensitive, as a BaseHTTPRequestHandler's message object is."""

    def __init__(self, values):
        self.values = values

    def get(self, name, default=None):
        for key, value in self.values.items():
            if key.lower() == name.lower():
                return value
        return default


class FakeHandler:
    """The slice of BaseHTTPRequestHandler that `http.serve` touches; it records exactly what the transport wrote."""

    def __init__(self, method, path, body=b"", length=None, address="1.2.3.4"):
        import io

        self.command = method
        self.path = path
        self.rfile = io.BytesIO(body)
        self.wfile = io.BytesIO()
        self.client_address = (address, 12345)
        self.headers = FakeHeaders({"Content-Length": str(len(body)) if length is None else length})
        self.status = None
        self.sent = []

    def send_response(self, status):
        self.status = status

    def send_header(self, name, value):
        self.sent.append((name, value))

    def end_headers(self):
        pass


def serve_once(method, path, body=b"", length=None, store=None):
    from jevsvc.http import serve

    handler = FakeHandler(method, path, body, length)
    routes = {"/api/run/start": app.run_start, "/api/choose": app.choose_route}
    serve(handler, routes, store)
    return handler.status, dict(handler.sent), handler.wfile.getvalue()


def test_the_dev_server_refuses_a_body_over_the_limit_with_the_exact_413(monkeypatch):
    monkeypatch.setenv("RUN_TOKEN_SECRET", "s" * 40)
    over = str(backend_http.MAX_BODY + 1)
    status, headers, data = serve_once("POST", "/api/run/start", length=over, store=MemoryStore())
    assert status == 413
    assert json.loads(data) == {"error": "請求太大", "code": "too_large"}
    assert headers["Content-Length"] == str(len(data))


def test_a_request_is_refused_with_500_not_configured_when_the_secret_is_missing_or_short(monkeypatch, capsys):
    for secret in (None, "s" * 31):  # None: absent; 31 bytes: present but under the 32-byte floor
        if secret is None:
            monkeypatch.delenv("RUN_TOKEN_SECRET", raising=False)
        else:
            monkeypatch.setenv("RUN_TOKEN_SECRET", secret)
        status, _headers, data = serve_once("POST", "/api/run/start", body=b"{}", store=MemoryStore())
        assert status == 500
        assert json.loads(data) == {"error": "伺服器設定不完整", "code": "not_configured"}
    assert capsys.readouterr().out.count("missing or short env: RUN_TOKEN_SECRET") == 2


def test_a_404_and_a_405_carry_their_exact_payloads():
    store = MemoryStore()
    status, headers, data = call_wsgi("GET", "/api/choose", store=store)
    assert status == "405 Method Not Allowed"
    assert json.loads(data) == {"error": "只接受 POST", "code": "method_not_allowed"}
    assert headers["Allow"] == "POST, OPTIONS"
    status, _headers, data = call_wsgi("POST", "/api/nope", store=store)
    assert status == "404 Not Found"
    assert json.loads(data) == {"error": "找不到", "code": "not_found"}


def client_key(headers, remote="203.0.113.9"):
    """Who the throttle counts: `Client_key` reads the address Vercel saw, else the proxy headers, else the socket."""
    lower = {name.lower(): value for name, value in headers.items()}
    request = backend_http.Request(
        method="POST",
        path="/api/run/start",
        content_length="2",
        header=lambda name: lower.get(name.lower()),
        read=lambda _length: b"{}",
        remote=remote,
    )
    return backend_http.client_key(request)


def test_the_throttle_key_prefers_the_address_the_platform_saw():
    """The key decides whether the ten-wrong-guesses limit can be rotated away, so the order matters: Vercel's own
    header wins (a client cannot set it there), the generic proxy headers are only a fallback for other hosts, and the
    socket address is the last resort."""
    assert client_key({"X-Vercel-Forwarded-For": "1.1.1.1", "X-Forwarded-For": "9.9.9.9"}) == client_key(
        {"X-Vercel-Forwarded-For": "1.1.1.1"}
    )
    assert client_key({"X-Vercel-Forwarded-For": "1.1.1.1"}) != client_key({"X-Vercel-Forwarded-For": "2.2.2.2"})
    # The key is the address, not the header: the same caller is the same key whichever header carried it.
    assert client_key({"X-Vercel-Forwarded-For": "1.1.1.1"}) == client_key({"X-Forwarded-For": "1.1.1.1"})
    assert client_key({"X-Real-IP": "3.3.3.3"}) == client_key({"X-Forwarded-For": "3.3.3.3"})
    assert client_key({"X-Forwarded-For": "9.9.9.9, 10.0.0.1"}) == client_key({"X-Forwarded-For": "9.9.9.9"})
    assert client_key({}, remote="198.51.100.7") == client_key({}, remote="198.51.100.7")
    assert client_key({}, remote="198.51.100.7") != client_key({}, remote="198.51.100.8")


def test_the_throttle_key_is_a_short_hash_and_keeps_no_address():
    key = client_key({"X-Forwarded-For": "9.9.9.9"})
    assert len(key) == 16 and "9.9.9.9" not in key


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


# --- what the client gets when the store or the request is wrong ---


def test_a_body_that_is_not_an_object_is_refused_by_every_route(store):
    for path, route in app.ROUTES.items():
        answer = route([], "1.1.1.1", store, SECRET, NOW)
        assert answer == (400, {"error": "請求格式錯誤", "code": "bad_request"}), path


def test_a_request_id_of_the_wrong_shape_is_refused_before_the_use_is_counted(store, code):
    status, body = start(store, code, request_id="short")
    assert (status, body["code"]) == (400, "bad_request")
    assert "used" not in store.data[f"invite:{invites.code_hash(code)}"]


def test_repeating_a_start_with_the_same_request_id_answers_the_same_and_counts_once(store, code):
    first = start(store, code, request_id="abcdefgh")
    assert start(store, code, request_id="abcdefgh") == first
    assert store.data[f"invite:{invites.code_hash(code)}"]["used"] == "1"


def test_a_store_that_cannot_remember_the_start_still_answers(store, code, capsys):
    class Forgetful(MemoryStore):
        def run(self, *command):
            if command[0] == "SET" and str(command[1]).startswith("start:"):
                raise StoreError("kv down")
            return super().run(*command)

    forgetful = Forgetful()
    its_code = invites.add(forgetful, "amy")
    status, body = app.run_start(
        {"invite": its_code, "item_name": "Shako", "request_id": "abcdefgh"}, "1.1.1.1", forgetful, SECRET, NOW
    )
    assert (status, body["used"]) == (200, 1)  # the use is already counted: the answer must not be lost to it
    assert "start not remembered" in capsys.readouterr().out


def test_a_store_that_cannot_record_usage_still_answers_the_step(store, code, capsys):
    class NoUsage(MemoryStore):
        def pipeline(self, commands, atomic=False):
            if any(c[0] == "SET" and str(c[1]).startswith("ok:") for c in commands):
                raise StoreError("kv down")
            return super().pipeline(commands, atomic=atomic)

    quiet = NoUsage()
    its_code = invites.add(quiet, "amy")
    token = app.run_start({"invite": its_code, "item_name": "Shako"}, "1.1.1.1", quiet, SECRET, NOW)[1]["run_token"]
    status, body = app.choose_step(
        {"run_token": token, "phase": "trading", "page": PAGE, "history": []},
        quiet,
        SECRET,
        NOW,
        lambda *a, **k: {"operation": "CLICK", "target": "1", "model_calls": 1, "usage": {}},
    )
    assert (status, body["operation"]) == (200, "CLICK")
    assert "usage not recorded" in capsys.readouterr().out


def test_a_step_without_a_model_key_is_not_configured(store, code, monkeypatch):
    monkeypatch.delenv("TYPESAFE_API_KEY", raising=False)
    token = token_for(store, code)
    body = {"run_token": token, "phase": "trading", "page": PAGE, "history": []}
    status, reply = app.choose_step(body, store, SECRET, NOW)
    assert (status, reply["code"]) == (500, "not_configured")


def test_a_page_that_is_not_an_object_is_a_bad_page(store, code):
    token = token_for(store, code)
    body = {"run_token": token, "phase": "trading", "page": PRODUCT, "history": []}
    status, reply = app.choose_step(body, store, SECRET, NOW, lambda *a, **k: {})
    assert (status, reply["code"]) == (400, "bad_page")


def test_an_item_name_the_goal_cannot_carry_is_refused_and_not_counted(store, code):
    for bad in ('Shako"', "Sha\u200bko"):
        status, body = start(store, code, item_name=bad)
        assert (status, body["error"]) == (400, "裝備名稱含有不允許的字元"), bad
    assert "used" not in store.data[f"invite:{invites.code_hash(code)}"]


# --- the invite rules that keep a name or an unreadable date from granting anything ---


def test_an_invite_whose_stored_expiry_cannot_be_read_never_grants_access(store, code):
    store.run("HSET", invites.record_key(invites.code_hash(code)), "expires", "2026/05/01")
    assert start(store, code) == (401, {"error": "邀請碼已過期"})


def test_a_second_invite_with_the_same_name_is_refused(store, code):
    with pytest.raises(ValueError) as err:
        invites.add(store, "amy")
    assert str(err.value) == invites.DUPLICATE


def test_a_name_claimed_between_the_check_and_the_write_is_refused(store, code):
    class Racing(MemoryStore):
        def run(self, *command):
            if command[0] == "HSETNX":
                return 0  # another admin claimed the name in between
            return super().run(*command)

    with pytest.raises(ValueError) as err:
        invites.add(Racing(), "amy")
    assert str(err.value) == invites.DUPLICATE


def test_a_name_missing_from_the_index_is_found_and_indexed_again(store, code):
    digest = invites.code_hash(code)
    store.run("HDEL", invites.NAME_INDEX, "amy")
    found = invites._find(store, "amy")
    assert found["key"] == invites.record_key(digest)
    assert store.run("HGET", invites.NAME_INDEX, "amy") == digest


# --- the base list is the server's, and a broken one is refused rather than served ---


def test_a_base_list_that_is_not_a_clean_list_of_names_is_refused(tmp_path):
    path = tmp_path / "bases.json"
    for broken in ({"bases": []}, {"bases": ["Ring", "Ring"]}, {"bases": ["Ring", ""]}, {"bases": ['Say "hi"']}):
        path.write_text(json.dumps(broken), encoding="utf-8")
        with pytest.raises(ValueError, match="non-empty list of unique item names"):
            app.bases.load(path)
    path.write_text(json.dumps({"bases": ["Ring", "Circlet"]}), encoding="utf-8")
    assert app.bases.load(path) == ("Ring", "Circlet")


def test_an_expiry_may_be_a_date_a_datetime_or_a_day_string_but_not_anything_else(store):
    assert invites.parse_expires(datetime(2026, 5, 1, 15, 30, tzinfo=TAIPEI)) == "2026-05-01"
    assert invites.parse_expires(date(2026, 5, 1)) == "2026-05-01"
    assert invites.parse_expires("2026-05-01") == "2026-05-01"
    assert invites.parse_expires(None) == "" and invites.parse_expires("") == ""
    with pytest.raises(ValueError, match="YYYY-MM-DD"):
        invites.parse_expires("01/05/2026")
    # The last valid day still counts as valid, whichever way it was given.
    assert start(store, invites.add(store, "day", expires=date(2026, 5, 1)))[0] == 200


def test_a_store_that_cannot_settle_a_failed_step_still_reports_the_failure(store, code, capsys):
    class NoSettle(MemoryStore):
        def pipeline(self, commands, atomic=False):
            if any(c[0] == "DECRBY" and str(c[1]).startswith("run:") for c in commands):
                raise StoreError("kv down")
            return super().pipeline(commands, atomic=atomic)

    broken = NoSettle()
    its_code = invites.add(broken, "amy")
    token = app.run_start({"invite": its_code, "item_name": "Shako"}, "1.1.1.1", broken, SECRET, NOW)[1]["run_token"]

    def jev_is_down(*_args, **_kwargs):
        raise RuntimeError("provider down")

    body = {"run_token": token, "phase": "trading", "page": PAGE, "history": []}
    status, reply = app.choose_step(body, broken, SECRET, NOW, jev_is_down)
    assert (status, reply["code"]) == (502, "model_unavailable")
    assert "failed step not settled" in capsys.readouterr().out


# --- settling one step: what a paying player is actually charged ---


def test_a_failed_step_gives_back_exactly_one_of_the_two_reserved_calls(store):
    """The attempt was spent, so the run keeps one call and returns the other: `_after_failure` does one `DECRBY`."""
    run_key = "run:r1"
    store.run("SET", run_key, "2")
    app._after_failure(store, {"rid": "r1", "inv": "a" * 64, "item": "Harlequin Crest"}, run_key)
    assert store.run("GET", run_key) == "1"


def test_a_failed_step_refunds_the_start_use_once_when_the_run_never_got_an_answer(store, code):
    """Jev being down is not the person's fault: the invitation's `used` goes back down by one, and only once."""
    digest = invites.code_hash(code)
    record = invites.record_key(digest)
    store.run("HSET", record, "used", "5")
    run_key = "run:r1"
    store.run("SET", run_key, "2")
    claims = {"rid": "r1", "inv": digest, "item": "Harlequin Crest"}

    app._after_failure(store, claims, run_key)
    assert store.run("HGET", record, "used") == "4"
    assert store.run("GET", "refund:r1") == "1"

    app._after_failure(store, claims, run_key)  # the marker must stop a second refund
    assert store.run("HGET", record, "used") == "4"


def test_a_failed_step_never_refunds_when_a_condition_does_not_hold(store, code):
    """The refund is deliberately narrow: an answered run, an already-refunded one, a token without a record digest,
    and a record with no `limit` all leave the counter untouched."""
    digest = invites.code_hash(code)
    record = invites.record_key(digest)
    store.run("HSET", record, "used", "5")

    def fail(rid, inv, *, answered=False, refunded=False):
        run_key = f"run:{rid}"
        store.run("SET", run_key, "2")
        if answered:
            store.run("SET", f"ok:{rid}", "1")
        if refunded:
            store.run("SET", f"refund:{rid}", "1")
        app._after_failure(store, {"rid": rid, "inv": inv, "item": "Harlequin Crest"}, run_key)

    fail("answered", digest, answered=True)
    assert store.run("HGET", record, "used") == "5"

    fail("refunded", digest, refunded=True)
    assert store.run("HGET", record, "used") == "5"

    short = "not-a-64-character-digest"
    store.run("HSET", invites.record_key(short), "limit", "5", "used", "5")  # a real record: only the length blocks it
    fail("shorthash", short)
    assert store.run("HGET", invites.record_key(short), "used") == "5"

    bare = "b" * 64
    store.run("HSET", invites.record_key(bare), "name", "x")  # a record with no `limit`: nothing was ever granted
    fail("nolimit", bare)
    assert store.run("HGET", invites.record_key(bare), "used") is None


def test_a_store_that_fails_mid_settlement_lets_a_failed_step_still_report_normally(store, capsys):
    """`_after_failure` is best-effort: a store error is printed and swallowed, never raised, so the 502 the caller
    already prepared is what the player sees."""
    class NoSettle(MemoryStore):
        def pipeline(self, commands, atomic=False):
            if any(c[0] == "DECRBY" and str(c[1]).startswith("run:") for c in commands):
                raise StoreError("kv down")
            return super().pipeline(commands, atomic=atomic)

    broken = NoSettle()
    broken.run("SET", "run:r1", "2")
    app._after_failure(broken, {"rid": "r1", "inv": "a" * 64, "item": "Harlequin Crest"}, "run:r1")
    assert "failed step not settled" in capsys.readouterr().out


def test_a_successful_step_hands_back_its_spare_call_and_records_the_usage(store, code):
    """The answer costs what it used: the unused reservation goes back and the invitation's totals gain the calls and
    input tokens of the step; an older token with no record digest is skipped, not crashed on."""
    digest = invites.code_hash(code)
    record = invites.record_key(digest)

    store.run("SET", "run:a", "2")
    app._after_success(store, {"rid": "a", "inv": digest}, "run:a", spare=1, calls=1, usage={"input_tokens": 123})
    assert store.run("GET", "run:a") == "1"
    assert store.run("GET", "ok:a") == "1"
    assert store.run("HGET", record, "calls") == "1"
    assert store.run("HGET", record, "input_tokens") == "123"

    store.run("SET", "run:b", "1")
    app._after_success(store, {"rid": "b", "inv": digest}, "run:b", spare=0, calls=1, usage={})
    assert store.run("GET", "run:b") == "1"  # a step that used its full reservation hands nothing back
    assert store.run("HGET", record, "calls") == "2"
    assert store.run("HGET", record, "input_tokens") == "123"  # no tokens reported: nothing added

    store.run("SET", "run:c", "2")
    app._after_success(store, {"rid": "c", "inv": "old"}, "run:c", spare=1, calls=2, usage={"input_tokens": 7})
    assert store.run("GET", "run:c") == "1"  # the reservation still settles even for an old token
    # ...but its totals are skipped: neither the calls nor the tokens of that step are added.
    assert (store.run("HGET", record, "calls"), store.run("HGET", record, "input_tokens")) == ("2", "123")


# --- the route branches the earlier rounds left unpinned: replay memory, call counting, a bad base and usage ---


def test_a_start_whose_remembered_answer_cannot_be_read_starts_again():
    """A client repeats a start it never got an answer for; if the stored answer is garbage the route must neither
    replay it nor crash. Every unreadable shape falls back to a fresh, counted answer that is then remembered."""
    unreadable = ("not json", "[]", "[1, 2]", '["a", "b", "c"]', "{}")
    for saved in unreadable:
        store = MemoryStore()
        its_code = invites.add(store, "amy")
        key = f"start:{invites.code_hash(its_code)}:abcdefgh"
        store.run("SET", key, saved)
        status, body = app.run_start(
            {"invite": its_code, "item_name": "Shako", "request_id": "abcdefgh"}, "1.1.1.1", store, SECRET, NOW
        )
        assert (status, body["used"]) == (200, 1), saved
        assert json.loads(store.run("GET", key))[1] == 1  # the fresh answer replaced the unreadable one


def test_a_non_string_invite_is_treated_as_no_invite_and_counts_a_failure(store):
    """The invite field is client input: an object, a number or a list must read as no code at all, be refused as
    invalid (never granted), and cost one of the ten wrong guesses like any other bad code."""
    with pytest.raises(invites.InviteError) as err:
        app.run_start({"invite": 1234, "item_name": "Shako"}, "1.1.1.1", store, SECRET, NOW)
    assert (err.value.status, err.value.message, err.value.code) == (401, "邀請碼無效或已停用", "invite_invalid")
    assert store.run("GET", "fail:1.1.1.1") == "1"


def test_a_step_that_re_asks_keeps_two_calls_and_a_single_answer_hands_one_back(store, code):
    """Two calls are reserved up front for every step: a re-ask (`model_calls` 2) spends both, a single answer hands
    the spare back, and a count that is over the reservation, zero or missing is clamped to what was reserved."""
    token = token_for(store, code)
    rid = tokens.verify(SECRET, token, NOW.timestamp())["rid"]
    run_key = f"run:{rid}"
    record = invites.record_key(invites.code_hash(code))

    def step(model_calls):
        decision = {"operation": "CLICK", "usage": {}}
        if model_calls is not None:
            decision["model_calls"] = model_calls
        body = {"run_token": token, "phase": "trading", "page": PAGE, "history": []}
        return app.choose_step(body, store, SECRET, NOW, lambda *a, **k: decision)

    assert step(2)[0] == 200 and store.run("GET", run_key) == "2"  # a re-ask spent both reserved calls
    assert step(1)[0] == 200 and store.run("GET", run_key) == "3"  # a single answer handed the spare back
    assert step(9)[0] == 200 and store.run("GET", run_key) == "5"  # over the reservation: clamped to two, no spare
    assert step(0)[0] == 200 and store.run("GET", run_key) == "6"  # zero counts as one call, spare handed back
    assert step(None)[0] == 200 and store.run("GET", run_key) == "7"  # a missing count is one call too
    assert store.run("HGET", record, "calls") == "7"  # 2 + 1 + 2 + 1 + 1


def test_a_given_base_that_is_not_a_string_is_refused_without_a_model_call(store, code):
    """The self-matched base shortcut keys off `base` being a name on the list: any non-string is a bad base and must
    be refused before a run call is reserved or the model is reached."""
    token = token_for(store, code)
    rid = tokens.verify(SECRET, token, NOW.timestamp())["rid"]

    def never(*args, **kw):
        raise AssertionError("the model must not be asked for a given base")

    for bad in (5, True, [], 3.5):
        status, reply = app.pick_base_step({"run_token": token, "base": bad}, store, SECRET, NOW, never)
        assert (status, reply) == (400, {"error": "底材不在清單裡", "code": "bad_base"}), bad
    assert store.data.get(f"run:{rid}") is None  # a refused base reserves nothing


def test_several_answered_steps_accumulate_in_the_invite_record(store, code):
    """The person's totals are the sum of their answered steps, not of one: each step's calls and input tokens add to
    the running counters the record carries, while `used` stays at the one start use."""
    digest = invites.code_hash(code)
    record = invites.record_key(digest)
    token = token_for(store, code)
    rid = tokens.verify(SECRET, token, NOW.timestamp())["rid"]

    def step(usage, model_calls):
        body = {"run_token": token, "phase": "trading", "page": PAGE, "history": []}
        decision = {"operation": "CLICK", "usage": usage, "model_calls": model_calls}
        return app.choose_step(body, store, SECRET, NOW, lambda *a, **k: decision)

    assert step({"input_tokens": 100, "output_tokens": 5}, 1)[0] == 200
    assert step({"input_tokens": 50}, 2)[0] == 200
    assert store.run("GET", f"run:{rid}") == "3"  # 2 reserved, 1 handed back, then 2 reserved and spent
    assert (
        store.run("HGET", record, "used"),
        store.run("HGET", record, "calls"),
        store.run("HGET", record, "input_tokens"),
    ) == ("1", "3", "150")


def test_history_that_is_not_a_list_of_shaped_entries_is_a_bad_page(store, code):
    """`history` is bounded and typed field by field: a non-list, an over-long list, an entry that is not an object,
    or a field of the wrong type is the client's error. An absent history is an empty one, an all-None entry is fine."""
    token = token_for(store, code)
    ok = lambda *a, **k: {"operation": "CLICK", "usage": {}, "model_calls": 1}  # noqa: E731
    for bad in ([1], "nope", [{"action": 5}], [{"page_changed": "yes"}], [{"text": 5}], [{}] * (app.MAX_HISTORY + 1)):
        body = {"run_token": token, "phase": "trading", "page": PAGE, "history": bad}
        assert app.choose_step(body, store, SECRET, NOW, ok) == (400, {"error": app.BAD_PAGE, "code": "bad_page"}), bad
    assert app.choose_step({"run_token": token, "phase": "trading", "page": PAGE}, store, SECRET, NOW, ok)[0] == 200
    body = {"run_token": token, "phase": "trading", "page": PAGE, "history": [{"action": None}]}
    assert app.choose_step(body, store, SECRET, NOW, ok)[0] == 200
