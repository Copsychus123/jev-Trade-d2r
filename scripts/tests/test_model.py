"""Unit tests for model.py post_json error handling, JSON parsing, and retry resilience."""

import json
import logging
from unittest.mock import Mock

import httpx
import pytest

from jev_ultrafast import model
from jev_ultrafast.config import Settings


def test_json_decode_error_on_valid_status_200_raises_value_error(monkeypatch):
    """JSONDecodeError on valid status (200) -> ValueError raised with context, not silent crash."""
    mock_resp = Mock(spec=httpx.Response)
    mock_resp.status_code = 200
    mock_resp.is_error = False
    mock_resp.text = "invalid json payload"
    mock_resp.json.side_effect = json.JSONDecodeError("Expecting value", "invalid json payload", 0)

    monkeypatch.setattr(model.CLIENT, "post", Mock(return_value=mock_resp))

    with pytest.raises(ValueError, match="Failed to parse JSON response from model provider.*HTTP 200"):
        model.post_json("https://api.example.com", "fake-key", {"prompt": "test"})


def test_json_partial_response_truncated_includes_body_preview(monkeypatch):
    """Partial JSON response (truncated) -> ValueError with body preview included."""
    partial_body = '{"choice": "e1", "confidence": 0.95, "pro'
    mock_resp = Mock(spec=httpx.Response)
    mock_resp.status_code = 200
    mock_resp.is_error = False
    mock_resp.text = partial_body
    mock_resp.json.side_effect = json.JSONDecodeError("Unterminated string", partial_body, 35)

    monkeypatch.setattr(model.CLIENT, "post", Mock(return_value=mock_resp))

    with pytest.raises(ValueError) as exc_info:
        model.post_json("https://api.example.com", "fake-key", {"prompt": "test"})

    err_msg = str(exc_info.value)
    assert "HTTP 200" in err_msg
    assert partial_body in err_msg


def test_json_network_timeout_during_json_call_caught_and_logged(monkeypatch, caplog):
    """Network timeout during json() call -> caught, logged with error, and re-raised."""
    mock_resp = Mock(spec=httpx.Response)
    mock_resp.status_code = 200
    mock_resp.is_error = False
    mock_resp.json.side_effect = httpx.ReadTimeout("Stream read timed out")

    monkeypatch.setattr(model.CLIENT, "post", Mock(return_value=mock_resp))

    with caplog.at_level(logging.ERROR):
        with pytest.raises(httpx.TimeoutException):
            model.post_json("https://api.example.com", "fake-key", {"prompt": "test"})

    assert "Network timeout during json() call" in caplog.text


def test_retry_valid_response_after_retry_succeeds(monkeypatch):
    """Valid response after retry -> succeeds."""
    mock_429 = Mock(spec=httpx.Response)
    mock_429.status_code = 429
    mock_429.is_error = False

    expected_payload = {"answers": {"operation": {"choice": "CLICK"}}}
    mock_200 = Mock(spec=httpx.Response)
    mock_200.status_code = 200
    mock_200.is_error = False
    mock_200.json.return_value = expected_payload

    mock_post = Mock(side_effect=[mock_429, mock_200])
    monkeypatch.setattr(model.CLIENT, "post", mock_post)

    sleep_calls = []
    monkeypatch.setattr(model.time, "sleep", lambda s: sleep_calls.append(s))

    result = model.post_json("https://api.example.com", "fake-key", {"prompt": "test"})

    assert result == expected_payload
    assert mock_post.call_count == 2
    assert len(sleep_calls) == 1
    # 0.5s * (1 + jitter) -> between 0.5 and 0.55
    assert 0.5 <= sleep_calls[0] <= 0.55


def test_retry_exhausted_retries_final_error_includes_all_attempts(monkeypatch):
    """Exhausted retries -> final error includes all attempts."""
    mock_429 = Mock(spec=httpx.Response)
    mock_429.status_code = 429
    mock_429.is_error = False

    mock_503 = Mock(spec=httpx.Response)
    mock_503.status_code = 503
    mock_503.is_error = False

    mock_529 = Mock(spec=httpx.Response)
    mock_529.status_code = 529
    mock_529.is_error = False

    mock_post = Mock(side_effect=[mock_429, mock_503, mock_529])
    monkeypatch.setattr(model.CLIENT, "post", mock_post)
    monkeypatch.setattr(model.time, "sleep", lambda s: None)

    with pytest.raises(RuntimeError) as exc_info:
        model.post_json("https://api.example.com", "fake-key", {"prompt": "test"})

    err_msg = str(exc_info.value)
    assert "Model unavailable after 3 attempts" in err_msg
    assert "attempt 1: HTTP 429" in err_msg
    assert "attempt 2: HTTP 503" in err_msg
    assert "attempt 3: HTTP 529" in err_msg
    assert mock_post.call_count == 3


def test_retry_configurable_settings_and_max_backoff_cap(monkeypatch):
    """Settings override retry count and cap exponential backoff at api_max_retry_delay_seconds."""
    custom_settings = Settings(
        api_retry_count=4,
        api_initial_retry_delay_seconds=5.0,
        api_max_retry_delay_seconds=16.0,
    )
    monkeypatch.setattr(model, "get_settings", lambda: custom_settings)

    mock_429 = Mock(spec=httpx.Response)
    mock_429.status_code = 429
    mock_429.is_error = False

    mock_post = Mock(return_value=mock_429)
    monkeypatch.setattr(model.CLIENT, "post", mock_post)

    sleep_calls = []
    monkeypatch.setattr(model.time, "sleep", lambda s: sleep_calls.append(s))

    with pytest.raises(RuntimeError, match="Model unavailable after 4 attempts"):
        model.post_json("https://api.example.com", "fake-key", {"prompt": "test"})

    assert mock_post.call_count == 4
    assert len(sleep_calls) == 3
    # attempt 0: delay base = 5.0 -> with jitter [5.0, 5.5]
    assert 5.0 <= sleep_calls[0] <= 5.5
    # attempt 1: delay base = 10.0 -> with jitter [10.0, 11.0]
    assert 10.0 <= sleep_calls[1] <= 11.0
    # attempt 2: delay base = 20.0 capped at 16.0 -> with jitter [16.0, 17.6]
    assert 16.0 <= sleep_calls[2] <= 17.6


def test_api_timeout_during_choice_prediction_mocks_slow_response(monkeypatch):
    """API timeout during choice prediction (slow response) -> caught and retried."""
    import time

    # Mock a slow response that simulates a timeout
    call_times = []

    def slow_post(*args, **kwargs):
        call_times.append(time.time())
        if len(call_times) < 2:
            # First call times out
            raise httpx.TimeoutException("Request timed out")
        # Second call succeeds
        mock_resp = Mock(spec=httpx.Response)
        mock_resp.status_code = 200
        mock_resp.is_error = False
        mock_resp.json.return_value = {"choice": 0, "thoughts": "Selected first option"}
        return mock_resp

    monkeypatch.setattr(model.CLIENT, "post", slow_post)
    monkeypatch.setattr(model.time, "sleep", lambda s: None)

    result = model.post_json("https://api.example.com", "fake-key", {"prompt": "test"})
    assert result == {"choice": 0, "thoughts": "Selected first option"}
    assert len(call_times) == 2  # First failed, second succeeded


def test_json_response_very_large_timeout_during_parse(monkeypatch):
    """JSON parse timeout with very large response -> ValueError with size info."""
    huge_response = "x" * 10_000_000  # 10MB of invalid JSON

    mock_resp = Mock(spec=httpx.Response)
    mock_resp.status_code = 200
    mock_resp.is_error = False
    mock_resp.text = huge_response
    mock_resp.json.side_effect = json.JSONDecodeError("Document too large", huge_response, 0)

    monkeypatch.setattr(model.CLIENT, "post", Mock(return_value=mock_resp))

    with pytest.raises(ValueError, match="Failed to parse JSON response"):
        model.post_json("https://api.example.com", "fake-key", {"prompt": "test"})


def test_retry_exhaustion_with_full_backoff_sequence(monkeypatch):
    """Retry exhaustion with full exponential backoff sequence -> all delays applied."""
    custom_settings = Settings(
        api_retry_count=5,
        api_initial_retry_delay_seconds=0.1,
        api_max_retry_delay_seconds=3.0,
    )
    monkeypatch.setattr(model, "get_settings", lambda: custom_settings)

    # All requests fail with 503
    mock_resp = Mock(spec=httpx.Response)
    mock_resp.status_code = 503
    mock_resp.is_error = False
    mock_post = Mock(return_value=mock_resp)
    monkeypatch.setattr(model.CLIENT, "post", mock_post)

    sleep_calls = []
    monkeypatch.setattr(model.time, "sleep", lambda s: sleep_calls.append(s))

    with pytest.raises(RuntimeError, match="Model unavailable after 5 attempts"):
        model.post_json("https://api.example.com", "fake-key", {"prompt": "test"})

    assert mock_post.call_count == 5
    assert len(sleep_calls) == 4  # 4 sleeps before 5th attempt
    # Verify exponential backoff capped at max
    assert sleep_calls[0] >= 0.1  # base 0.1
    assert sleep_calls[-1] <= 3.3  # capped at 3.0 + jitter


@pytest.mark.parametrize("status_code,should_retry", [
    (429, True),   # Rate limit - should retry
    (503, True),   # Service unavailable - should retry
    (400, False),  # Bad request - should not retry
    (401, False),  # Unauthorized - should not retry
    (500, False),  # Server error - should not retry
])
def test_retry_mixed_success_failure_pattern(monkeypatch, status_code, should_retry):
    """Mixed success/failure retry pattern -> retries only on transient errors."""
    call_count = [0]
    def mock_post(*args, **kwargs):
        call_count[0] += 1
        if call_count[0] == 1:
            mock_resp = Mock(spec=httpx.Response)
            mock_resp.status_code = status_code
            mock_resp.is_error = not should_retry
            return mock_resp
        # Success case on subsequent calls
        mock_resp = Mock(spec=httpx.Response)
        mock_resp.status_code = 200
        mock_resp.is_error = False
        mock_resp.json.return_value = {"result": "success"}
        return mock_resp

    monkeypatch.setattr(model.CLIENT, "post", mock_post)
    monkeypatch.setattr(model.time, "sleep", lambda s: None)

    if should_retry:
        result = model.post_json("https://api.example.com", "fake-key", {"prompt": "test"})
        assert result == {"result": "success"}
        assert call_count[0] == 2
    else:
        with pytest.raises(RuntimeError, match=f"Model provider returned HTTP {status_code}"):
            model.post_json("https://api.example.com", "fake-key", {"prompt": "test"})
        assert call_count[0] == 1

def test_json_decode_error_with_unicode_content_preserves_encoding(monkeypatch):
    """JSONDecodeError with unicode content -> error message preserves unicode."""
    unicode_text = 'Invalid JSON with emoji 🎯 and CJK 中文'
    mock_resp = Mock(spec=httpx.Response)
    mock_resp.status_code = 200
    mock_resp.is_error = False
    mock_resp.text = unicode_text
    mock_resp.json.side_effect = json.JSONDecodeError("Invalid", unicode_text, 0)

    monkeypatch.setattr(model.CLIENT, "post", Mock(return_value=mock_resp))

    with pytest.raises(ValueError) as exc_info:
        model.post_json("https://api.example.com", "fake-key", {"prompt": "test"})

    err_msg = str(exc_info.value)
    assert "emoji" in err_msg or "中文" in err_msg or "Invalid JSON" in err_msg
