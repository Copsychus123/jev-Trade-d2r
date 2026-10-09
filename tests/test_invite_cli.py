"""The invite admin CLI (`services/invite.py`): what the owner types, offline.

`main(argv)` is driven against the in-memory store, so no `.env`, no Upstash and no window are needed. Each case is a
mistake the operator would make: the printed code must be the real one and appear once, `revoke` must disable (not
enable), `pause` must engage the kill switch the backend checks (`jevsvc/http.py`), a bad date must not reach the
database, and the listing must never print the code or its hash.
"""

from datetime import datetime, timezone

import pytest

from tests._harness_stub import install

install()  # before the backend imports below: nothing here may start the Chrome daemon

from jevsvc import http as backend_http, invites  # noqa: E402, I001
from jevsvc.store import MemoryStore  # noqa: E402

import invite  # noqa: E402

NOW = datetime(2026, 5, 1, 12, 0, tzinfo=timezone.utc)


@pytest.fixture
def cli(monkeypatch):
    """One in-memory store behind the CLI, with `.env` and the Upstash client out of the way."""
    store = MemoryStore()
    built: list[tuple[str, str]] = []

    def factory(url, token):
        built.append((url, token))
        return store

    monkeypatch.setattr(invite, "load_dotenv", lambda: None)
    monkeypatch.setattr(invite, "Store", factory)
    monkeypatch.setenv("KV_REST_API_URL", "https://example.test")
    monkeypatch.setenv("KV_REST_API_TOKEN", "t")
    return store, built


def printed_code(out: str) -> str:
    """The code from the `邀請碼：…` (add) or `新的邀請碼：…` (reissue) line."""
    return next(line.split("：", 1)[1] for line in out.splitlines() if "邀請碼：" in line)


def test_add_prints_the_real_code_exactly_once(cli, capsys):
    store, _ = cli
    assert invite.main(["add", "amy"]) == 0
    out = capsys.readouterr().out
    code = printed_code(out)
    assert code.startswith("inv-")
    assert out.count(code) == 1  # 這組碼只會顯示一次
    assert invites.code_hash(code) == store.run("HGET", invites.NAME_INDEX, "amy")


def test_revoke_disables_and_enable_restores(cli, capsys):
    store, _ = cli
    assert invite.main(["add", "amy"]) == 0
    assert invite.main(["revoke", "amy"]) == 0
    assert [row["disabled"] for row in invites.list_invites(store)] == [True]
    assert invite.main(["enable", "amy"]) == 0
    assert [row["disabled"] for row in invites.list_invites(store)] == [False]


def test_pause_engages_the_kill_switch_the_backend_checks(cli, monkeypatch):
    store, _ = cli
    monkeypatch.setenv("RUN_TOKEN_SECRET", "s" * 40)  # process() refuses to route without it

    def route(*args):
        return 200, {"ok": True}  # the pause check runs before any route is reached

    assert invite.main(["pause"]) == 0
    assert store.run("GET", invites.PAUSE_KEY)
    assert backend_http.process("2", lambda _n: b"{}", "1.2.3.4", route, store)[0] == 503
    assert invite.main(["resume"]) == 0
    assert store.run("GET", invites.PAUSE_KEY) is None
    assert backend_http.process("2", lambda _n: b"{}", "1.2.3.4", route, store)[0] == 200


def test_a_bad_date_is_refused_before_the_database_is_touched(cli, capsys):
    _, built = cli
    assert invite.main(["add", "amy", "--expires", "2026-13-40"]) == 1
    assert "YYYY-MM-DD" in capsys.readouterr().out
    assert built == []  # the store was never built: a typo costs no round trip


def test_a_limit_of_zero_is_refused_before_the_database_is_touched(cli, capsys):
    _, built = cli
    assert invite.main(["add", "amy", "--limit", "0"]) == 1
    assert "1 以上" in capsys.readouterr().out
    assert built == []


def test_without_the_database_credentials_it_says_so(monkeypatch, capsys):
    monkeypatch.setattr(invite, "load_dotenv", lambda: None)
    monkeypatch.delenv("KV_REST_API_URL", raising=False)
    monkeypatch.delenv("KV_REST_API_TOKEN", raising=False)
    assert invite.main(["list"]) == 1
    assert "KV_REST_API_URL" in capsys.readouterr().out


def test_an_unknown_name_is_reported_and_exits_nonzero(cli, capsys):
    assert invite.main(["revoke", "nobody"]) == 1
    assert "找不到這個名字" in capsys.readouterr().out


def test_the_listing_shows_usage_but_never_the_code_or_its_hash(cli, capsys):
    store, _ = cli
    assert invite.main(["add", "amy", "--limit", "7"]) == 0
    code = printed_code(capsys.readouterr().out)
    store.run("HINCRBY", invites.record_key(invites.code_hash(code)), "used", 2)

    assert invite.main(["list"]) == 0
    out = capsys.readouterr().out
    assert "amy" in out and "7" in out and "2" in out
    assert code not in out and invites.code_hash(code) not in out


def test_reissue_prints_a_new_code_once_and_the_old_one_stops_working(cli, capsys):
    store, _ = cli
    assert invite.main(["add", "amy"]) == 0
    old = printed_code(capsys.readouterr().out)
    assert invite.main(["reissue", "amy"]) == 0
    out = capsys.readouterr().out
    new = printed_code(out)
    assert new != old and out.count(new) == 1
    with pytest.raises(invites.InviteError):  # the retired code no longer authenticates
        invites.check_and_count(store, old, "1.1.1.1", NOW)
    assert invites.check_and_count(store, new, "1.1.1.1", NOW)["used"] == 1
