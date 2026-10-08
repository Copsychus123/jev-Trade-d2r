import os

import pytest

from jev_ultrafast import chrome

_REAL_BIND = chrome._bind_harness


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    monkeypatch.delenv("JEV_CHROME", raising=False)
    monkeypatch.delenv("BU_NAME", raising=False)
    monkeypatch.delenv("BU_CDP_URL", raising=False)
    monkeypatch.setattr(chrome, "_LAUNCHED", None)
    monkeypatch.setattr(chrome, "_DAEMON", None)
    monkeypatch.setattr(chrome, "_ATEXIT_REGISTERED", True)
    monkeypatch.setattr(chrome, "_bind_harness", lambda _name: None)

    def no_popen(*_a, **_k):
        raise AssertionError("Chrome must not be launched")

    monkeypatch.setattr(chrome.subprocess, "Popen", no_popen)


def test_chrome_mode_default_window_and_invalid(monkeypatch):
    assert chrome.chrome_mode() == "headless"
    monkeypatch.setenv("JEV_CHROME", "window")
    assert chrome.chrome_mode() == "window"
    monkeypatch.setenv("JEV_CHROME", "bogus")
    with pytest.raises(ValueError, match="JEV_CHROME"):
        chrome.chrome_mode()


def test_existing_mode_changes_nothing(monkeypatch):
    monkeypatch.setenv("JEV_CHROME", "existing")
    assert chrome.ensure_chrome() is None
    assert "BU_NAME" not in os.environ and "BU_CDP_URL" not in os.environ


def test_answering_port_is_reused(monkeypatch):
    class Ok:
        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

    monkeypatch.setattr(chrome.urllib.request, "urlopen", lambda *a, **k: Ok())
    assert chrome.ensure_chrome() == "reused"
    assert os.environ["BU_NAME"] == f"jev-{os.getpid()}"
    assert os.environ["BU_CDP_URL"] == "http://127.0.0.1:9355"


@pytest.mark.parametrize(("mode", "headless"), [("headless", True), ("window", False)])
def test_launch_command_depends_on_mode(monkeypatch, mode, headless):
    monkeypatch.setenv("JEV_CHROME", mode)
    monkeypatch.setattr(chrome, "chrome_binary", lambda: "fake-chrome")
    monkeypatch.setattr(chrome.time, "sleep", lambda _s: None)
    answers = iter([False, True])
    monkeypatch.setattr(chrome, "_answering", lambda _url: next(answers))
    launched = []

    class FakeProc:
        pid = 1

        def terminate(self):
            pass

    monkeypatch.setattr(chrome.subprocess, "Popen", lambda cmd, **_k: launched.append(cmd) or FakeProc())
    monkeypatch.setattr(chrome.subprocess, "run", lambda *a, **k: None)
    assert chrome.ensure_chrome() == "started"
    (cmd,) = launched
    assert "--remote-debugging-port=9355" in cmd
    assert ("--headless=new" in cmd) is headless
    assert "--renderer-process-limit=1" in cmd and "--disable-site-isolation-trials" in cmd
    assert "--disable-gpu" in cmd and "--disable-component-update" in cmd
    assert sum(a.startswith("--disable-features=") for a in cmd) == 1  # a second flag would replace the first
    monkeypatch.setattr(chrome, "_graceful_close", lambda: True)
    chrome.close_chrome()
    assert chrome._LAUNCHED is None


def test_close_chrome_stops_every_process_of_our_profile_only_when_it_does_not_quit(monkeypatch):
    calls = []
    monkeypatch.setattr(chrome, "_LAUNCHED", object())
    monkeypatch.setattr(chrome, "_DAEMON", "jev-test")
    monkeypatch.setattr(chrome, "_graceful_close", lambda: False)
    monkeypatch.setattr(chrome.time, "sleep", lambda _s: None)
    monkeypatch.setattr(chrome, "_stop_daemon", lambda name: calls.append(["stop-daemon", name]))
    monkeypatch.setattr(chrome.subprocess, "run", lambda cmd, **_k: calls.append(cmd))
    chrome.close_chrome()
    cmd, stopped = calls
    assert stopped == ["stop-daemon", "jev-test"]
    assert chrome.PROFILE_DIR.name in " ".join(cmd)
    assert chrome._LAUNCHED is None
    chrome.close_chrome()  # nothing launched by us: must not kill anything
    assert len(calls) == 2


def test_close_chrome_skips_the_process_sweep_when_chrome_quits_by_itself(monkeypatch):
    calls = []
    monkeypatch.setattr(chrome, "_LAUNCHED", object())
    monkeypatch.setattr(chrome, "_DAEMON", None)
    monkeypatch.setattr(chrome, "_graceful_close", lambda: True)
    monkeypatch.setattr(chrome.subprocess, "run", lambda cmd, **_k: calls.append(cmd))
    chrome.close_chrome()
    assert calls == []


def test_bind_harness_points_the_imported_modules_at_our_daemon(monkeypatch):
    import types

    ipc = types.SimpleNamespace(sock_addr=lambda name: f"sock-{name}")
    admin = types.SimpleNamespace(NAME="default")
    helpers = types.SimpleNamespace(NAME="default", SOCK="old")
    monkeypatch.setattr(chrome, "_ipc", ipc)
    monkeypatch.setattr(chrome, "_admin", admin)
    monkeypatch.setattr(chrome, "_helpers", helpers)
    _REAL_BIND("jev-123")
    assert admin.NAME == "jev-123" and helpers.NAME == "jev-123"
    assert helpers.SOCK == "sock-jev-123"


def test_blocked_url_patterns_cover_ad_hosts_with_and_without_subdomains():
    patterns = chrome.blocked_url_patterns()
    assert "*://*.doubleclick.net/*" in patterns
    assert "*://mediavine.com/*" in patterns
    assert not any("traderie.com" in p for p in patterns)


def test_close_chrome_removes_small_caches_but_keeps_the_login_and_page_cache(monkeypatch, tmp_path):
    folders = (
        "Default/Cache",
        "Default/GPUCache",
        "ShaderCache",
        "optimization_guide_model_store",
        "component_crx_cache",
    )
    for relative in folders:
        (tmp_path / relative).mkdir(parents=True)
        (tmp_path / relative / "x").write_text("cache")
    (tmp_path / "Default/Network").mkdir(parents=True)
    (tmp_path / "Default/Network/Cookies").write_text("login")
    monkeypatch.setattr(chrome, "PROFILE_DIR", tmp_path)
    monkeypatch.setattr(chrome, "_LAUNCHED", object())
    monkeypatch.setattr(chrome, "_graceful_close", lambda: True)
    chrome.close_chrome()
    assert (tmp_path / "Default/Cache/x").exists()  # the page cache stays warm (capped by a Chrome flag)
    assert not (tmp_path / "Default/GPUCache").exists()
    assert not (tmp_path / "ShaderCache").exists()
    assert not (tmp_path / "optimization_guide_model_store").exists()
    assert not (tmp_path / "component_crx_cache").exists()
    assert (tmp_path / "Default/Network/Cookies").read_text() == "login"
