"""Unit tests for the in-memory store: the semantics other modules rely on, without a network."""

import pytest

from jevsvc import store as backend_store
from jevsvc.store import MemoryStore, StoreError


def _store(start=1000.0):
    """A memory store with a clock the test moves by hand, so no test has to sleep."""
    now = [start]
    return MemoryStore(clock=lambda: now[0]), now


def test_a_key_with_a_lifetime_is_gone_once_the_clock_passes_it():
    store, now = _store()
    store.run("SET", "run:1", "1", "EX", 5)
    assert store.run("GET", "run:1") == "1"
    now[0] += 4
    assert store.run("GET", "run:1") == "1"  # still inside its lifetime
    now[0] += 2
    assert store.run("GET", "run:1") is None
    assert "run:1" not in store.data and "run:1" not in store.expiry


def test_a_set_only_if_missing_keeps_the_value_that_is_already_there():
    store, _ = _store()
    assert store.run("SET", "refund:1", "1", "NX", "EX", 5) == "OK"
    assert store.run("SET", "refund:1", "again", "NX", "EX", 5) is None
    assert store.run("GET", "refund:1") == "1"


def test_a_hash_field_is_claimed_once():
    store, _ = _store()
    assert store.run("HSETNX", "invite-names", "amy", "digest") == 1
    assert store.run("HSETNX", "invite-names", "amy", "other") == 0
    assert store.run("HGET", "invite-names", "amy") == "digest"


def test_deleting_keys_reports_how_many_were_there():
    store, _ = _store()
    store.run("SET", "a", "1")
    store.run("SET", "b", "2")
    assert store.run("DEL", "a", "b", "missing") == 2
    assert store.run("GET", "a") is None


def test_an_unsupported_command_is_a_loud_error_not_a_silent_zero():
    store, _ = _store()
    with pytest.raises(StoreError, match="unsupported command LPUSH"):
        store.run("LPUSH", "a", "1")


def test_the_shared_store_is_one_client_per_address_and_the_old_one_is_closed(monkeypatch):
    built, closed = [], []

    class FakeStore:
        def __init__(self, url, token):
            built.append((url, token))
            self.client = type("C", (), {"close": lambda self: closed.append(True)})()

    monkeypatch.setattr(backend_store, "Store", FakeStore)
    monkeypatch.setattr(backend_store, "_shared", None)
    first = backend_store.shared_store("https://kv.test", "t")
    assert backend_store.shared_store("https://kv.test", "t") is first
    assert closed == [] and len(built) == 1
    backend_store.shared_store("https://kv.test", "other")  # a new token is a new client
    assert closed == [True] and len(built) == 2
