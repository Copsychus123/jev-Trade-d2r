"""Integration tests for scripts/export_traderie_session.py main flow."""

import importlib
from pathlib import Path

import pytest

from scripts import export_traderie_session as mod


class _FakeSettings:
    traderie_session_cookie_name = "traderie_session"


@pytest.fixture
def stubbed(tmp_path, monkeypatch):
    """Stub browser_harness/CDP and .env writer; return capture lists."""
    state = {
        "cookies": [],
        "upserts": [],
        "env_path": tmp_path / ".env",
    }
    monkeypatch.setattr(mod, "ENV_PATH", state["env_path"])
    monkeypatch.setattr(mod, "ensure_daemon", lambda: None)
    monkeypatch.setattr(mod, "get_settings", lambda: _FakeSettings())

    def fake_upsert(path, payload):
        state["upserts"].append((path, dict(payload)))

    monkeypatch.setattr(mod, "upsert_dotenv", fake_upsert)

    def fake_cdp(method, **kwargs):
        if method == "Network.getCookies":
            return {"cookies": state["cookies"]}
        if method == "Target.createTarget":
            return {"targetId": "fake-target"}
        if method == "Target.attachToTarget":
            return {"sessionId": "fake-session"}
        return {}

    monkeypatch.setattr(mod, "cdp", fake_cdp)
    return state


def test_no_cookies_returns_1_and_no_env_write(stubbed, capsys):
    rc = mod.main()
    assert rc == 1
    assert stubbed["upserts"] == []
    out = capsys.readouterr().out
    assert "no traderie.com cookies" in out
    assert "NOT WRITTEN" in out


def test_session_cookie_writes_traderie_session_token(stubbed, capsys):
    stubbed["cookies"] = [
        {"name": "other", "value": "x"},
        {"name": "traderie_session", "value": "sess-token"},
    ]
    rc = mod.main()
    assert rc == 0
    assert len(stubbed["upserts"]) == 1
    path, payload = stubbed["upserts"][0]
    assert path == stubbed["env_path"]
    assert payload == {"TRADERIE_SESSION_TOKEN": "sess-token"}
    out = capsys.readouterr().out
    assert "Wrote TRADERIE_SESSION_TOKEN" in out
    assert "sess-token" not in out  # values never printed


def test_no_session_cookie_writes_cookie_pair_string(stubbed, capsys):
    stubbed["cookies"] = [
        {"name": "b", "value": "2"},
        {"name": "a", "value": "1"},
    ]
    rc = mod.main()
    assert rc == 0
    path, payload = stubbed["upserts"][0]
    assert path == stubbed["env_path"]
    assert payload == {"TRADERIE_COOKIE": "b=2; a=1"}
    out = capsys.readouterr().out
    assert "Wrote TRADERIE_COOKIE" in out
    assert "a=1; b=2" not in out  # values never printed


def test_module_importable():
    importlib.import_module("scripts.export_traderie_session")


def test_upsert_dotenv_preserves_comments_and_replaces(tmp_path: Path):
    env_file = tmp_path / ".env"
    env_file.write_text(
        "# Leading comment\n"
        "KEEP_ME=untouched\n"
        "UPDATE_ME=old_val\n"
        "\n"
        "# Another comment\n",
        encoding="utf-8",
    )

    mod.upsert_dotenv(env_file, {"UPDATE_ME": "new_val", "APPEND_ME": "appended_val"})

    lines = env_file.read_text(encoding="utf-8").splitlines()
    assert "# Leading comment" in lines
    assert "KEEP_ME=untouched" in lines
    assert "UPDATE_ME=new_val" in lines
    assert "UPDATE_ME=old_val" not in lines
    assert "APPEND_ME=appended_val" in lines
    assert "# Another comment" in lines
