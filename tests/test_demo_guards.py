"""The loopback demo's local-only guards: the Host check on every request, token and Origin on POST.

`demo.py` drives a real browser agent, so the guards are what keep another page (or a rebound DNS name) from using it.
Nothing exercised them before: deleting all three kept the offline suite green. The handler is built without a socket,
so the guards are the only thing under test here.
"""

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
