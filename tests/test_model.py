"""Unit tests for model.py post_json error handling, JSON parsing, and retry resilience."""

import json
import logging
import time
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


def _response(status, text="", payload=None):
    resp = Mock(spec=httpx.Response)
    resp.status_code = status
    resp.is_error = status >= 400 and status not in {429, 503, 529}
    resp.text = text
    resp.json.return_value = payload
    return resp


def test_default_call_sends_no_per_call_timeout(monkeypatch):
    """Without limits the shared client default (the demo's 25 s) applies: nothing is passed per call."""
    mock_post = Mock(return_value=_response(200, payload={"ok": 1}))
    monkeypatch.setattr(model.CLIENT, "post", mock_post)
    model.post_json("https://api.example.com", "fake-key", {})
    assert "timeout" not in mock_post.call_args.kwargs


def test_per_call_timeout_is_cut_to_the_time_left_before_the_deadline(monkeypatch):
    mock_post = Mock(return_value=_response(200, payload={"ok": 1}))
    monkeypatch.setattr(model.CLIENT, "post", mock_post)
    model.post_json("https://api.example.com", "fake-key", {}, timeout=12)
    assert mock_post.call_args.kwargs["timeout"] == 12
    model.post_json("https://api.example.com", "fake-key", {}, timeout=12, deadline=time.monotonic() + 5)
    assert 0 < mock_post.call_args.kwargs["timeout"] <= 5


def test_no_request_is_sent_once_the_deadline_has_passed(monkeypatch):
    mock_post = Mock()
    monkeypatch.setattr(model.CLIENT, "post", mock_post)
    with pytest.raises(RuntimeError, match="Model unavailable"):
        model.post_json("https://api.example.com", "fake-key", {}, timeout=12, deadline=time.monotonic() - 1)
    mock_post.assert_not_called()


@pytest.mark.parametrize("failure", ["status_429", "network"])
def test_a_retry_pause_that_would_end_after_the_deadline_is_not_taken(monkeypatch, failure):
    """Retries continue only while there is time: the first backoff pause (at least 0.5 s) would pass the deadline."""
    if failure == "status_429":
        mock_post = Mock(return_value=_response(429))
    else:
        mock_post = Mock(side_effect=httpx.ConnectError("down"))
    monkeypatch.setattr(model.CLIENT, "post", mock_post)
    slept = []
    monkeypatch.setattr(model.time, "sleep", lambda s: slept.append(s))
    with pytest.raises(RuntimeError, match="after 1 attempts"):
        model.post_json("https://api.example.com", "fake-key", {}, timeout=12, deadline=time.monotonic() + 0.2)
    assert mock_post.call_count == 1 and slept == []


def test_retries_still_happen_while_time_is_left(monkeypatch):
    mock_post = Mock(side_effect=[_response(429), _response(200, payload={"ok": 1})])
    monkeypatch.setattr(model.CLIENT, "post", mock_post)
    monkeypatch.setattr(model.time, "sleep", lambda s: None)
    deadline = time.monotonic() + 30
    assert model.post_json("https://api.example.com", "fake-key", {}, timeout=12, deadline=deadline) == {"ok": 1}
    assert mock_post.call_count == 2


def test_http_error_message_carries_a_short_body_preview_and_never_the_key(monkeypatch):
    body = "quota exceeded " + "x" * 500
    monkeypatch.setattr(model.CLIENT, "post", Mock(return_value=_response(402, text=body)))
    with pytest.raises(RuntimeError) as exc_info:
        model.post_json("https://api.example.com", "secret-key-123", {})
    message = str(exc_info.value)
    assert "HTTP 402" in message and "quota exceeded" in message
    assert body not in message and "x" * 201 not in message
    assert "secret-key-123" not in message


def test_retriable_status_attempts_also_carry_the_preview(monkeypatch):
    monkeypatch.setattr(model.CLIENT, "post", Mock(return_value=_response(503, text="overloaded")))
    monkeypatch.setattr(model.time, "sleep", lambda s: None)
    with pytest.raises(RuntimeError) as exc_info:
        model.post_json("https://api.example.com", "fake-key", {})
    assert "attempt 3: HTTP 503 overloaded" in str(exc_info.value)


@pytest.mark.parametrize(
    "reply",
    [
        None,
        [],
        "text",
        {},
        {"answers": None},
        {"answers": []},
        {"answers": {}, "usage": "many"},
        {"answers": {}, "usage": {"input_tokens": "12"}},
        {"answers": {}, "usage": {"input_tokens": True}},
        {"answers": {}, "usage": {"input_tokens": float("nan")}},
    ],
)
def test_a_malformed_provider_reply_is_a_runtime_error_not_a_caller_mistake(monkeypatch, reply):
    with pytest.raises(RuntimeError, match="Invalid TypeSafe response shape"):
        model.check_provider_result(reply)
    monkeypatch.setenv("TYPESAFE_API_KEY", "test")
    monkeypatch.setattr(model, "post_json", lambda _url, _key, _body: reply)
    with pytest.raises(RuntimeError):
        model.choose(_choose_page(), "goal", [])
    with pytest.raises(RuntimeError):
        model.pick_base("Item", ["Ring"])


def test_a_usage_free_reply_and_numeric_usage_are_accepted():
    assert model.check_provider_result({"answers": {}}) == {"answers": {}}
    reply = {"answers": {}, "usage": {"input_tokens": 3, "output_tokens": 1.5}}
    assert model.check_provider_result(reply) is reply


def _choose_page():
    actions = [
        {"id": f"e{i}", "kind": "click", "label": f"Link {i}", "role": "link", "value": "", "node": i}
        for i in (1, 2, 3)
    ]
    actions.append({"id": "wait", "kind": "wait", "label": "Wait"})
    return {"url": "https://example.test/", "title": "t", "text": "t", "actions": actions}


def _ambiguous_post(requests):
    """First request: CLICK with a 40% target; second (without CLICK): WAIT."""

    def post(_url, _key, body, **limits):
        requests.append((body, limits))
        operations = list(body["questions"]["operation"]["criteria"])
        chosen = "CLICK" if "CLICK" in operations else "WAIT"
        others = [name for name in operations if name != chosen]
        probabilities = {name: 0.1 / len(others) for name in others} | {chosen: 0.9}
        answers = {"operation": {"choice": chosen, "probabilities": probabilities}}
        if chosen == "CLICK":
            answers["click_target"] = {"choice": "1", "probabilities": {"1": 0.4, "2": 0.3, "3": 0.3}}
        return {"model": "test", "usage": {"input_tokens": 100}, "answers": answers}

    return post


def test_choose_hands_its_limits_to_every_request_and_asks_again_while_time_is_left(monkeypatch):
    requests = []
    monkeypatch.setenv("TYPESAFE_API_KEY", "test")
    monkeypatch.setattr(model, "post_json", _ambiguous_post(requests))
    deadline = time.monotonic() + 40
    decision = model.choose(_choose_page(), "goal", [], timeout=12, deadline=deadline)
    assert decision["model_calls"] == 2 and decision["operation"] == "WAIT"
    assert [limits for _body, limits in requests] == [{"timeout": 12, "deadline": deadline}] * 2


def test_choose_does_not_ask_again_when_less_than_one_call_budget_is_left(monkeypatch):
    """No second request fits before the deadline: the uncertain target is not returned for execution either."""
    requests = []
    monkeypatch.setenv("TYPESAFE_API_KEY", "test")
    monkeypatch.setattr(model, "post_json", _ambiguous_post(requests))
    with pytest.raises(RuntimeError, match="no action executed"):
        model.choose(_choose_page(), "goal", [], timeout=12, deadline=time.monotonic() + 5)
    assert len(requests) == 1


def test_choose_without_limits_calls_post_json_exactly_as_before(monkeypatch):
    seen = []

    def post(_url, _key, body):  # the demo's call shape: three positional arguments, nothing else
        seen.append(body)
        return _ambiguous_post([])(_url, _key, body)

    monkeypatch.setenv("TYPESAFE_API_KEY", "test")
    monkeypatch.setattr(model, "post_json", post)
    assert model.choose(_choose_page(), "goal", [])["model_calls"] == 2
    assert len(seen) == 2


def _select_actions():
    """One <select> node reported once per non-selected option, as snapshot.js emits it."""
    base = {"kind": "select", "node": 7, "role": "combobox", "current_value": "Red", "id": "e1"}
    return [
        {**base, "value": "red", "label": "Design → Red"},
        {**base, "value": "blue", "label": "Design → Blue"},
        {**base, "value": "green", "label": "Design → Green"},
    ]


def test_action_space_keeps_the_live_dropdown_value_while_collecting_options():
    elements, _targets, controls = model.action_space(_select_actions())
    assert len(elements) == 1
    element = elements[0]
    assert element["index"] == "1" and element["label"] == "Design" and element["role"] == "combobox"
    assert element["value"] == "Red"  # current_value, never the first option's raw value
    assert [option["value"] for option in element["options"]] == ["red", "blue", "green"]
    assert controls == {}


def test_action_space_numbers_each_dropdown_option_as_its_own_target():
    elements, targets, _controls = model.action_space(_select_actions())
    assert [option["index"] for option in elements[0]["options"]] == ["1:1", "1:2", "1:3"]
    assert set(targets["SELECT"]) == {"1:1", "1:2", "1:3"}
    assert targets["SELECT"]["1:2"]["value"] == "blue" and targets["SELECT"]["1:3"]["id"] == "e1"


def test_action_space_ignores_a_node_already_dropped_as_a_repeat_even_under_a_new_label():
    actions = [
        {"id": "e1", "kind": "fill", "label": "Min", "role": "textbox", "value": "", "node": 1},
        {"id": "e2", "kind": "fill", "label": "Min", "role": "textbox", "value": "", "node": 2},
        {"id": "e3", "kind": "fill", "label": "Min", "role": "textbox", "value": "", "node": 3},  # 3rd "Min": dropped
        {"id": "e4", "kind": "click", "label": "Buy", "role": "button", "value": "", "node": 3},  # same node again
    ]
    elements, targets, _controls = model.action_space(actions)
    assert [element["label"] for element in elements] == ["Min", "Min"]
    assert set(targets["TYPE_TEXT"]) == {"1", "2"}
    assert "CLICK" not in targets


@pytest.mark.parametrize(
    "answer",
    [
        None,                                        # not a mapping at all
        "text",                                      # a string has no "probabilities"
        {"choice": "a"},                             # probabilities missing
        {"probabilities": {"a": 1.0}},               # choice missing
        {"choice": "a", "probabilities": None},      # probabilities is not a mapping
    ],
)
def test_validate_choice_turns_a_malformed_answer_into_a_value_error(answer):
    with pytest.raises(ValueError, match="Invalid TypeSafe response; no action executed."):
        model.validate_choice(answer, {"a", "b"})


def test_preview_returns_empty_string_when_the_body_cannot_be_read():
    class Unreadable:
        @property
        def text(self):
            raise RuntimeError("body gone")

    assert model._preview(Unreadable()) == ""
    assert model._preview(Mock(text="x" * 300)) == "x" * 200  # the happy path still truncates


def _chunk_answers(choices):
    """Fake `_answers`: per question name `choices[name] = (chosen_name, chosen_probability)`."""

    def fake(body, *, key, limits):
        answers = {}
        for name, question in body["questions"].items():
            chosen, probability = choices[name]
            ids = list(question["criteria"])
            rest = [i for i in ids if i != chosen]
            answers[name] = {
                "choice": chosen,
                "probabilities": {i: (1 - probability) / len(rest) for i in rest} | {chosen: probability},
            }
        return {"model": "test", "usage": {"input_tokens": 5}, "answers": answers}

    return fake


def test_pick_base_picks_the_most_probable_non_none_answer_across_chunks(monkeypatch):
    options = [f"Item {i}" for i in range(250)]  # > 200 options: split into base_0 (200) and base_1 (50)
    seen = []
    choices = {"base_0": (model.NONE_OF_THESE, 0.9), "base_1": ("Item 200", 0.9)}

    def fake(body, *, key, limits):
        seen.append(body)
        return _chunk_answers(choices)(body, key=key, limits=limits)

    monkeypatch.setenv("TYPESAFE_API_KEY", "test")
    monkeypatch.setattr(model, "_answers", fake)

    result = model.pick_base("Wanted item", options)

    assert set(seen[0]["questions"]) == {"base_0", "base_1"}
    assert all(model.NONE_OF_THESE in question["criteria"] for question in seen[0]["questions"].values())
    assert result["base"] == "Item 200"
    assert result["choice"] == "Item 200"
    assert result["probability"] == pytest.approx(0.9)
    assert result["model_calls"] == 1


def test_pick_base_returns_no_base_when_every_chunk_answers_none_of_these(monkeypatch):
    options = [f"Item {i}" for i in range(250)]
    choices = {"base_0": (model.NONE_OF_THESE, 0.9), "base_1": (model.NONE_OF_THESE, 0.9)}

    monkeypatch.setenv("TYPESAFE_API_KEY", "test")
    monkeypatch.setattr(model, "_answers", _chunk_answers(choices))

    result = model.pick_base("Wanted item", options)

    assert result["base"] is None
    assert result["choice"] is None
    assert result["probability"] == 0.0


def test_pick_base_accepts_an_answer_exactly_at_the_minimum_probability(monkeypatch):
    options = [f"Item {i}" for i in range(250)]
    choices = {"base_0": (model.NONE_OF_THESE, 0.9), "base_1": ("Item 240", model.BASE_MIN_PROBABILITY)}

    monkeypatch.setenv("TYPESAFE_API_KEY", "test")
    monkeypatch.setattr(model, "_answers", _chunk_answers(choices))

    result = model.pick_base("Wanted item", options)

    assert result["probability"] == pytest.approx(model.BASE_MIN_PROBABILITY)
    assert result["base"] == "Item 240"  # >= the threshold, not only > it
    assert result["choice"] == "Item 240"
