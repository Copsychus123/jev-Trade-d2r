"""Offline transport retries for model HTTP calls. No paid APIs."""

from unittest.mock import Mock

import httpx
import pytest

from jev_ultrafast import model


def test_transient_connection_errors_are_retried(monkeypatch):
    success = Mock(status_code=200, is_error=False)
    success.json.return_value = {"ok": True}
    post = Mock(side_effect=[httpx.ConnectError("temporary"), success])
    monkeypatch.setattr(model.CLIENT, "post", post)
    monkeypatch.setattr(model.time, "sleep", Mock())
    assert model.post_json("https://example.test/v1", "k", {}) == {"ok": True}
    assert post.call_count == 2


def test_exhausted_connection_errors_still_fail(monkeypatch):
    post = Mock(side_effect=httpx.ConnectError("down"))
    monkeypatch.setattr(model.CLIENT, "post", post)
    monkeypatch.setattr(model.time, "sleep", Mock())
    with pytest.raises(RuntimeError, match="Model connection failed"):
        model.post_json("https://example.test/v1", "k", {})
    assert post.call_count == 3
