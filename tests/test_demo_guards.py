"""The loopback demo's local-only guards: the Host check on every request, token and Origin on POST.

`demo.py` drives a real browser agent, so the guards are what keep another page (or a rebound DNS name) from using it.
The predicates are checked directly, and the wiring — that `do_GET`/`do_POST` call them at all, and that a second step
while one runs is refused — is checked against the real handler on a loopback socket.
"""

import json
import threading
from http.server import ThreadingHTTPServer

import httpx
import pytest

from jev_ultrafast import demo


def request(host=None, token=None, origin=None):
    """A Handler carrying only the headers a guard reads; `send` is captured instead of written to a socket."""
    handler = demo.Handler.__new__(demo.Handler)  # BaseHTTPRequestHandler.__init__ would need a live socket
    headers = {}
    if host is not None:
        headers["Host"] = host
    if token is not None:
        headers["X-Demo-Token"] = token
    if origin is not None:
        headers["Origin"] = origin
    handler.headers = headers
    handler.sent = []
    handler.send = lambda status, content, mime="application/json": handler.sent.append(status)
    return handler


LOCAL = f"127.0.0.1:{demo.PORT}"


def test_every_request_must_come_from_the_local_address():
    assert request(host=LOCAL).forbidden() is False
    assert request(host="evil.example").forbidden() is True
    assert request(host=f"localhost:{demo.PORT}").forbidden() is True  # the name is not the address
    assert request().forbidden() is True  # no Host at all


def test_a_post_must_carry_this_run_token():
    assert request(host=LOCAL, token=demo.TOKEN).forbidden_post() is False
    assert request(host=LOCAL).forbidden_post() is True
    assert request(host=LOCAL, token=f"{demo.TOKEN}x").forbidden_post() is True
    assert request(host=LOCAL, token="inv-whatever").forbidden_post() is True


def test_a_post_comes_from_the_demo_page_or_from_no_page_at_all():
    assert request(host=LOCAL, token=demo.TOKEN, origin=demo.ORIGIN).forbidden_post() is False
    assert request(host=LOCAL, token=demo.TOKEN).forbidden_post() is False  # same-origin fetch may omit it
    assert request(host=LOCAL, token=demo.TOKEN, origin="https://evil.example").forbidden_post() is True
    assert request(
        host=LOCAL, token=demo.TOKEN, origin="http://127.0.0.1:1"
    ).forbidden_post() is True  # another port is another origin


# The predicates above are only worth their lines if the request path actually calls them: deleting the `forbidden()`
# call from `do_GET`, both calls from `do_POST`, or the busy-lock check used to keep this whole file green. These drive
# the real Handler over a loopback socket, which is the only way to pin the wiring.

PORT_IN_HOST = f"127.0.0.1:{demo.PORT}"


@pytest.fixture()
def served(monkeypatch):
    """The real `demo.Handler` on an ephemeral loopback port, with this run's token patched to a known value.

    Yields a function that opens one fresh client per request: an answered 403 never reads the request body, so the
    connection must not be reused for the next call.
    """
    monkeypatch.setattr(demo, "TOKEN", "run-token")
    server = ThreadingHTTPServer(("127.0.0.1", 0), demo.Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base_url = f"http://127.0.0.1:{server.server_address[1]}"

    def call(method, path, **kwargs):
        with httpx.Client(base_url=base_url, timeout=10) as client:
            return client.request(method, path, **kwargs)

    try:
        yield call
    finally:
        server.shutdown()
        server.server_close()


def test_a_get_whose_host_is_not_this_one_is_refused_by_the_get_path(served):
    assert served("GET", "/").status_code == 403  # httpx sends the ephemeral port as Host: not this demo's
    page = served("GET", "/", headers={"Host": PORT_IN_HOST})
    assert page.status_code == 200 and page.headers["content-type"].startswith("text/html")
    assert "run-token" in page.text  # the page carries the run's token, substituted into the template


def test_a_post_needs_both_guards_on_the_post_path(served):
    # The refused requests carry no body on purpose: a refusal answers without reading one, and closing a socket that
    # still holds an unread body makes Windows reset the connection, which would make this test flaky.
    assert served("POST", "/api/tick").status_code == 403  # no token, and the wrong Host
    no_token = served("POST", "/api/tick", headers={"Host": PORT_IN_HOST})
    assert no_token.status_code == 403  # the Host is right, the token is missing
    with_headers = {"Host": PORT_IN_HOST, "X-Demo-Token": "run-token", "Origin": demo.ORIGIN}
    refused_origin = {**with_headers, "Origin": "https://evil.example"}
    assert served("POST", "/api/tick", headers=refused_origin).status_code == 403
    # Past the guards the request reaches the command, which the demo cannot run without an agent (400): what this pins
    # is that it is no longer refused, and that an absent Origin is allowed as well.
    body = json.dumps({"command": "tick"})
    assert served("POST", "/api/tick", content=body, headers=with_headers).status_code == 400
    no_origin = {"Host": PORT_IN_HOST, "X-Demo-Token": "run-token"}
    assert served("POST", "/api/tick", content=body, headers=no_origin).status_code == 400


def test_a_second_step_while_one_is_running_is_refused_by_the_lock(served):
    demo.LOCK.acquire()
    try:
        # No body either: the 409 is answered before the body is read, and the same reset race applies.
        response = served(
            "POST",
            "/api/tick",
            headers={"Host": PORT_IN_HOST, "X-Demo-Token": "run-token", "Origin": demo.ORIGIN},
        )
    finally:
        demo.LOCK.release()
    assert response.status_code == 409 and "執行中" in response.json()["error"]
