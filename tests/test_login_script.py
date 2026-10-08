import builtins
import time

import pytest

from scripts import login as login_traderie


def _eof(*_args):
    raise EOFError


class FakeClock:
    """A monotonic clock that advances a fixed step on every call, so the bounded wait is instant in tests."""

    def __init__(self, start=0.0, step=1.0):
        self.now = start
        self.step = step

    def __call__(self):
        value = self.now
        self.now += self.step
        return value


class FakeBrowser:
    """Reports a login only after `logged_out_polls` polls that still show the `Log In` link."""

    def __init__(self, url, events, logged_out_polls=0):
        self.url = url
        self.events = events
        self.logged_out_polls = logged_out_polls
        self.polls = 0

    def call(self, method, **params):
        self.events.append(("call", method))

    def evaluate(self, expression):
        if expression == login_traderie.BANNER_JS:
            self.events.append(("banner",))
            return None
        assert expression == login_traderie.LOGGED_IN_JS
        self.events.append(("poll",))
        self.polls += 1
        return self.polls > self.logged_out_polls

    def close(self):
        self.events.append(("browser_close",))


def _patch_script(monkeypatch, events, logged_out_polls, wait_seconds):
    monkeypatch.setenv("JEV_CHROME", "headless")  # main() overwrites it; monkeypatch restores it
    monkeypatch.setenv("JEV_LOGIN_WAIT_SECONDS", str(wait_seconds))
    monkeypatch.setattr(login_traderie, "ensure_chrome", lambda: "started")
    monkeypatch.setattr(login_traderie, "Browser", lambda url: FakeBrowser(url, events, logged_out_polls))
    monkeypatch.setattr(login_traderie, "close_chrome", lambda: events.append(("chrome_close",)))
    monkeypatch.setattr(login_traderie, "_clock", FakeClock())
    # A real (tiny) sleep yields the GIL so the Enter-reading thread gets to run.
    monkeypatch.setattr(login_traderie, "_sleep", lambda _seconds: time.sleep(0.001))


def test_logged_in_check_reuses_the_needs_login_expression():
    # Same-tab check as `needs_login`, guarded against blank / challenge pages reporting no "Log In".
    assert login_traderie.LOGGED_OUT_JS in login_traderie.LOGGED_IN_JS
    assert "traderie.com" in login_traderie.LOGGED_IN_JS


def test_login_refuses_when_chrome_already_running(monkeypatch, capsys):
    monkeypatch.setenv("JEV_CHROME", "headless")  # main() overwrites it; monkeypatch restores it
    monkeypatch.setattr(login_traderie, "ensure_chrome", lambda: "reused")
    monkeypatch.setattr(login_traderie, "Browser", lambda _url: pytest.fail("must not open a tab"))
    with pytest.raises(SystemExit) as exc:
        login_traderie.main()
    assert exc.value.code == 1
    assert "專用 Chrome 已在背景執行" in capsys.readouterr().out


def test_login_waits_while_logged_out_then_closes_chrome_after_login(monkeypatch, capsys):
    events = []
    _patch_script(monkeypatch, events, logged_out_polls=2, wait_seconds=600)
    # The terminal cannot wait for a key: without polling, this used to end instantly.
    monkeypatch.setattr(builtins, "input", _eof)

    login_traderie.main()

    assert events == [
        ("call", "Page.addScriptToEvaluateOnNewDocument"),
        ("banner",),
        ("poll",),
        ("poll",),
        ("poll",),
        ("browser_close",),
        ("chrome_close",),
    ]
    assert "已偵測到登入" in capsys.readouterr().out


def test_login_closes_chrome_as_soon_as_login_is_detected(monkeypatch, capsys):
    events = []
    _patch_script(monkeypatch, events, logged_out_polls=0, wait_seconds=600)
    monkeypatch.setattr(builtins, "input", _eof)

    login_traderie.main()

    assert events == [
        ("call", "Page.addScriptToEvaluateOnNewDocument"),
        ("banner",),
        ("poll",),
        ("browser_close",),
        ("chrome_close",),
    ]
    assert "已偵測到登入" in capsys.readouterr().out


def test_login_enter_ends_the_wait_without_waiting_for_the_bound(monkeypatch, capsys):
    events = []
    _patch_script(monkeypatch, events, logged_out_polls=10**9, wait_seconds=600)
    monkeypatch.setattr(builtins, "input", lambda *_a: "")

    login_traderie.main()

    assert ("browser_close",) in events and ("chrome_close",) in events
    assert "沒偵測到登入" not in capsys.readouterr().out


def test_login_reports_when_the_bound_is_reached_without_a_login(monkeypatch, capsys):
    events = []
    _patch_script(monkeypatch, events, logged_out_polls=10**9, wait_seconds=3)
    monkeypatch.setattr(builtins, "input", _eof)

    with pytest.raises(SystemExit) as exc:
        login_traderie.main()

    assert exc.value.code == 1
    out = capsys.readouterr().out
    assert "沒偵測到登入" in out and "scripts/login.py" in out
    # Even on the timeout the window is closed properly.
    assert ("browser_close",) in events and ("chrome_close",) in events
