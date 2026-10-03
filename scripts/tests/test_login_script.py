import builtins

import pytest

from scripts import login as login_traderie


def test_login_refuses_when_chrome_already_running(monkeypatch, capsys):
    monkeypatch.setenv("JEV_CHROME", "headless")  # main() overwrites it; monkeypatch restores it
    monkeypatch.setattr(login_traderie, "ensure_chrome", lambda: "reused")
    monkeypatch.setattr(login_traderie, "Browser", lambda _url: pytest.fail("must not open a tab"))
    with pytest.raises(SystemExit) as exc:
        login_traderie.main()
    assert exc.value.code == 1
    assert "專用 Chrome 已在背景執行" in capsys.readouterr().out


def test_login_waits_for_enter_then_closes_chrome(monkeypatch):
    monkeypatch.setenv("JEV_CHROME", "headless")
    events = []

    class FakeBrowser:
        def __init__(self, url):
            events.append(("open", url))
        def call(self, method, **params):
            events.append(("call", method))

        def evaluate(self, expression):
            events.append(("evaluate", expression == login_traderie.BANNER_JS))

        def close(self):
            events.append("browser_close")

    monkeypatch.setattr(login_traderie, "ensure_chrome", lambda: "started")
    monkeypatch.setattr(login_traderie, "Browser", FakeBrowser)
    monkeypatch.setattr(login_traderie, "close_chrome", lambda: events.append("chrome_close"))
    monkeypatch.setattr(builtins, "input", lambda *_a: events.append("input") or "")
    login_traderie.main()
    assert events == [
        ("open", login_traderie.LOGIN_URL),
        ("call", "Page.addScriptToEvaluateOnNewDocument"),
        ("evaluate", True),
        "input",
        "browser_close",
        "chrome_close",
    ]
