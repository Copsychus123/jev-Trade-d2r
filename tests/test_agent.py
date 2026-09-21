"""Offline contracts for a dynamic operation/target policy. No paid APIs."""

import json
import time
from copy import deepcopy
from unittest.mock import Mock

import httpx
import pytest

from jev_ultrafast import agent as loop
from jev_ultrafast import model
from jev_ultrafast.browser import StalePage, browser_operation, fingerprint


def page():
    state = {
        "url": "https://example.test/",
        "title": "Search",
        "text": "Search",
        "scroll": {"y": 0},
        "actions": [
            {"id": "e1", "kind": "fill", "label": "Search", "role": "textbox", "value": "", "node": 10},
            {"id": "e2", "kind": "click", "label": "Open Search", "role": "textbox", "value": "", "node": 10},
            {"id": "e3", "kind": "click", "label": "Go", "role": "button", "value": "", "node": 20},
            {"id": "wait", "kind": "wait", "label": "Wait"},
        ],
    }
    state["fingerprint"] = fingerprint(state)
    return state


def choice(ids, selected):
    return {"choice": selected, "confidence": 1.0, "probabilities": {i: float(i == selected) for i in ids}}


def decision(action="e1"):
    return {
        "choice": action,
        "operation": "TYPE_TEXT",
        "target": "1",
        "confidence": 1.0,
        "probabilities": {action: 1.0},
        "latency_ms": 10,
        "usage": {},
    }


@pytest.mark.parametrize("mutation", ["unknown", "nan", "missing", "negative", "non_max", "confidence", "list"])
def test_invalid_choice_is_rejected(mutation):
    a = choice(["a", "b"], "a")
    if mutation == "unknown":
        a["choice"] = "invented"
    elif mutation == "nan":
        a["probabilities"]["a"] = float("nan")
    elif mutation == "missing":
        del a["probabilities"]["b"]
    elif mutation == "negative":
        a["probabilities"]["b"] = -1
    elif mutation == "non_max":
        a["choice"] = "b"
    elif mutation == "list":
        a["probabilities"] = [0.5, 0.5]
    else:
        a["confidence"] = 5
    with pytest.raises(ValueError, match="Invalid TypeSafe"):
        model.validate_choice(a, {"a", "b"})


def test_one_index_per_node_with_operation_specific_targets():
    elements, targets, controls = model.action_space(page()["actions"])
    assert len(elements) == 2
    assert elements[0]["operations"] == ["TYPE_TEXT", "CLICK"]
    assert targets["TYPE_TEXT"]["1"]["id"] == "e1"
    assert targets["CLICK"]["1"]["id"] == "e2"
    assert targets["CLICK"]["2"]["id"] == "e3"
    assert "WAIT" in controls


def test_all_heads_are_one_request_and_only_matching_head_executes(monkeypatch):
    calls = []

    def post(_url, _key, body):
        calls.append(body)
        return {
            "model": "test",
            "answers": {
                "operation": choice(body["questions"]["operation"]["criteria"], "TYPE_TEXT"),
                "type_text_target": choice(["1"], "1"),
                "click_target": {"choice": "invented"},
            },
        }

    monkeypatch.setenv("TYPESAFE_API_KEY", "test")
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.setattr(model, "post_json", post)
    d = model.choose(page(), "Find a book", [])
    assert len(calls) == 1
    assert calls[0]["state"]["omitted_actions"] == 0
    assert d["operation"] == "TYPE_TEXT" and d["target"] == "1" and d["choice"] == "e1"
    assert "request" not in d and "raw_answers" not in d
    assert set(calls[0]["questions"]) == {"operation", "click_target", "type_text_target"}


def test_openrouter_decisions_provider_uses_native_endpoint(monkeypatch):
    calls = []

    def post(url, key, body):
        calls.append((url, key, body["model"]))
        return {
            "model": "typesafe/jev-1.13-20260917",
            "answers": {
                "operation": choice(body["questions"]["operation"]["criteria"], "DONE"),
            },
        }

    monkeypatch.delenv("TYPESAFE_API_KEY", raising=False)
    monkeypatch.setenv("OPENROUTER_API_KEY", "openrouter-test")
    monkeypatch.delenv("OPENROUTER_MODEL", raising=False)
    monkeypatch.setattr(model, "post_json", post)
    d = model.choose(page(), "Find a book", [])
    assert d["choice"] == "DONE"
    assert calls == [(model.OPENROUTER_DECISIONS_URL, "openrouter-test", "~typesafe/jev-latest")]


def test_missing_decision_credential_is_actionable(monkeypatch):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.delenv("TYPESAFE_API_KEY", raising=False)
    with pytest.raises(ValueError, match="OPENROUTER_API_KEY or TYPESAFE_API_KEY"):
        model.decision_provider()


def test_malformed_decision_envelope_stops_before_action(monkeypatch):
    monkeypatch.setenv("TYPESAFE_API_KEY", "test")
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.setattr(model, "post_json", Mock(return_value={"error": {"code": "provider_unavailable"}}))
    with pytest.raises(RuntimeError, match="invalid decisions response"):
        model.choose(page(), "Find a book", [])


def test_http_error_retries_then_reports_without_action(monkeypatch):
    response = Mock(status_code=429, is_error=True)
    post = Mock(return_value=response)
    monkeypatch.setattr(model.CLIENT, "post", post)
    monkeypatch.setattr(model, "sleep", Mock())
    with pytest.raises(RuntimeError, match="HTTP 429"):
        model.post_json("https://example.test/decisions", "test", {})
    assert post.call_count == 3


def test_provider_timeout_reports_without_action(monkeypatch):
    monkeypatch.setattr(model.CLIENT, "post", Mock(side_effect=httpx.ReadTimeout("timed out")))
    with pytest.raises(RuntimeError, match="connection failed"):
        model.post_json("https://example.test/decisions", "test", {})


def test_click_cannot_consume_a_text_target(monkeypatch):
    def post(_url, _key, body):
        return {
            "model": "test",
            "answers": {
                "operation": choice(body["questions"]["operation"]["criteria"], "CLICK"),
                "type_text_target": choice(["1"], "1"),
                "click_target": choice(["1", "2", "999"], "999"),
            },
        }

    monkeypatch.setenv("TYPESAFE_API_KEY", "test")
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.setattr(model, "post_json", post)
    with pytest.raises(ValueError, match="Invalid TypeSafe"):
        model.choose(page(), "Find a book", [])


def test_target_head_receives_control_state_and_full_next_step_rules(monkeypatch):
    p = page()
    p["actions"].insert(0, {
        "id": "toggle", "kind": "click", "label": "Free cancellation", "node": 30,
        "role": "checkbox", "checked": "true", "selected": False,
    })

    def post(_url, _key, body):
        questions = body["questions"]
        target = questions["click_target"]
        assert target["criteria"]["1"]["checked"] == "true"
        assert target["criteria"]["1"]["selected"] is False
        assert questions["operation"]["instructions"]["rules"] in target["instructions"]["rules"]
        return {
            "model": "test",
            "answers": {
                "operation": choice(questions["operation"]["criteria"], "CLICK"),
                "click_target": choice(target["criteria"], "3"),
            },
        }

    monkeypatch.setenv("TYPESAFE_API_KEY", "test")
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.setattr(model, "post_json", post)
    d = model.choose(p, "Search with free cancellation", [])
    assert d["choice"] == "e3"


def test_quoted_task_text_still_uses_the_llm(monkeypatch):
    monkeypatch.setenv("TEXT_MODEL_API_KEY", "test")
    monkeypatch.setenv("TEXT_MODEL_BASE_URL", "https://openrouter.ai/api/v1")
    monkeypatch.setenv("TEXT_MODEL_REASONING", "none")
    post = Mock(return_value={"choices": [{"message": {"content": '{"text":"Zurich"}'}}]})
    monkeypatch.setattr(model, "post_json", post)
    context = model.field_context('Fly from "Zurich" to London', page()["actions"][0], page(), [])
    assert model.field_text(context)[0] == "Zurich"
    assert post.call_count == 1
    sent = json.loads(post.call_args.args[2]["messages"][1]["content"])
    assert sent["goal"] == 'Fly from "Zurich" to London'


def test_missing_text_credential_stops_before_guessing(monkeypatch):
    monkeypatch.delenv("TEXT_MODEL_API_KEY", raising=False)
    with pytest.raises(ValueError, match="TEXT_MODEL_API_KEY"):
        model.field_text({"goal": 'Enter "Zurich"'})


@pytest.fixture
def runner():
    a = loop.Agent.__new__(loop.Agent)
    a.screenshots = False
    a.pending_text = None
    p = page()
    a.state = {
        "browser": Mock(fresh=Mock(return_value=True), observe=Mock(return_value=p)),
        "page": p,
        "decision": decision(),
        "goal": "Find a book",
        "history": [],
        "decisions": [],
        "last_decision": None,
        "status": "predicted",
        "started_at": time.perf_counter(),
        "record": False,
        "text_calls": [],
        "errors": [],
        "fallback_used": False,
        "stale_recoveries": 0,
    }
    return a


def test_result_envelope_is_stable_and_excludes_raw_requests(runner):
    runner.state["status"] = "done"
    runner.state["decisions"] = [{
        "model": "jev-test", "confidence": 0.9, "target_confidence": None,
        "probabilities": {"DONE": 0.9}, "target_probabilities": {},
        "raw_answers": {"secret": "must not leak"}, "request": {"secret": "must not leak"},
    }]
    runner.state["last_decision"] = runner.state["decisions"][0]
    runner.state["history"] = [{
        "step": 1, "action": "Search", "kind": "fill", "choice": "e1", "operation": "TYPE_TEXT",
        "target": "1", "text": "Zurich", "probability": 0.9, "confidence": 0.9,
        "page_changed": True, "url": "https://example.test/results", "text_helper": "helper", "text_latency_ms": 20,
        "latency_ms": 30, "usage": {}, "executed_ms": 40, "elapsed_ms": 50,
    }]
    result = runner.result({"matches": 3})
    assert set(result) == {
        "schema_version", "status", "actions", "final_url", "final_title", "extracted_result",
        "confidence", "probabilities", "target_confidence", "target_probabilities", "errors",
        "operation_confidence", "operation_probabilities", "fallback_used", "model", "provenance",
        "omitted_actions",
    }
    assert result["schema_version"] == "jev.result.v1"
    assert result["extracted_result"] == {"matches": 3}
    assert result["confidence"] == 0.9
    assert result["probabilities"] == {"DONE": 0.9}
    assert result["actions"][0]["elapsed_ms"] == 50
    serialized = json.dumps(result)
    assert "request" not in serialized and "raw_answers" not in serialized and "must not leak" not in serialized


def test_recorded_frames_do_not_overwrite_same_millisecond(tmp_path):
    recorder = loop.Agent.__new__(loop.Agent)
    recorder.record_dir = tmp_path
    page = {"screenshot": "ZGF0YQ=="}

    recorder._record_frame(page, 12)
    recorder._record_frame(page, 12)

    assert sorted(path.name for path in tmp_path.iterdir()) == ["000012.jpg", "000013.jpg"]


def test_stale_decision_is_consumed_before_any_mutation(runner):
    runner.state["browser"].fresh.return_value = False
    with pytest.raises(StalePage):
        runner.command("act", {"fingerprint": runner.state["page"]["fingerprint"]})
    runner.state["browser"].act.assert_not_called()
    assert runner.state["decision"] is None


def test_generated_text_reused_only_for_identical_retry_context(runner, monkeypatch):
    helper = Mock(return_value=("book", {"model": "test", "latency_ms": 10}))
    monkeypatch.setattr(loop, "field_text", helper)
    runner.state["browser"].act.side_effect = [StalePage("Changed before input"), None]
    with pytest.raises(StalePage):
        runner.command("act", {"fingerprint": runner.state["page"]["fingerprint"]})
    runner.state["decision"] = decision()
    runner.command("act", {"fingerprint": runner.state["page"]["fingerprint"]})
    assert helper.call_count == 1
    assert runner.state["browser"].act.call_count == 2  # The first call rejects before any browser input.
    assert runner.pending_text is None


def test_changed_field_context_does_not_reuse_generated_text(runner, monkeypatch):
    helper = Mock(return_value=("book", {"model": "test", "latency_ms": 10}))
    monkeypatch.setattr(loop, "field_text", helper)
    runner.state["browser"].act.side_effect = [StalePage("Changed before input"), None]
    with pytest.raises(StalePage):
        runner.command("act", {"fingerprint": runner.state["page"]["fingerprint"]})
    runner.state["page"]["text"] = "Different page context"
    runner.state["decision"] = decision()
    runner.command("act", {"fingerprint": runner.state["page"]["fingerprint"]})
    assert helper.call_count == 2


def test_loading_waits_do_not_trigger_no_progress_stop(runner):
    for _ in range(5):
        runner.state["decision"] = decision("wait")
        runner.command("act", {"fingerprint": runner.state["page"]["fingerprint"]})
    assert len(runner.state["history"]) == 5 and runner.state["status"] == "ready"


def test_stale_observation_preserves_executed_action(runner):
    runner.state["decision"] = decision("e3")
    runner.state["browser"].observe.side_effect = StalePage("changed")
    with pytest.raises(StalePage):
        runner.command("act", {"fingerprint": runner.state["page"]["fingerprint"]})
    assert runner.state["history"][-1]["action"] == "Go"
    runner.state["browser"].act.assert_called_once()


def test_pre_input_stale_recovery_does_not_rewrite_previous_history(runner, monkeypatch):
    previous = {
        "step": 1, "action": "Previous", "kind": "click", "choice": "e3",
        "page_changed": True, "url": "https://example.test/previous", "execution_status": "executed",
    }
    runner.state["history"] = [previous.copy()]
    runner.state["last_decision"] = decision("e3")
    runner.state["browser"].act.side_effect = StalePage("Changed before input")
    monkeypatch.setattr(loop, "choose", Mock(return_value=decision("e3")))

    runner.command("tick")

    assert runner.state["history"] == [previous]
    assert runner.state["errors"][-1]["message"] == "Decision discarded and page re-observed."
    assert runner.state["last_decision"]["choice"] == "e3"


def test_browser_error_records_ambiguous_execution_metadata(runner):
    runner.state["decision"] = decision("e3")
    runner.state["browser"].act.side_effect = RuntimeError("input follow-up failed")

    with pytest.raises(RuntimeError, match="input follow-up failed"):
        runner.command("act", {"fingerprint": runner.state["page"]["fingerprint"]})

    row = runner.state["history"][-1]
    assert row["execution_status"] == "unknown"
    assert row["usage"] == {}
    assert isinstance(row["executed_ms"], int)
    assert isinstance(row["elapsed_ms"], int)


def test_observation_is_one_atomic_browser_read(monkeypatch):
    import jev_ultrafast.browser as browser

    p = page()
    cdp = Mock(return_value={"result": {"value": p}})
    monkeypatch.setattr(browser, "cdp", cdp)
    actual = browser_operation({"operation": "observe", "session": "test", "screenshot": False})
    assert actual["actions"] == p["actions"]
    assert cdp.call_count == 1
    assert cdp.call_args.args[0] == "Runtime.evaluate"


def test_executor_rejects_a_stale_page_before_browser_input(monkeypatch):
    import jev_ultrafast.browser as browser

    b = browser.Browser.__new__(browser.Browser)
    b.fresh = Mock(return_value=False)
    operation = Mock()
    monkeypatch.setattr(browser, "browser_operation", operation)
    with pytest.raises(StalePage):
        b.act(page()["actions"][0], page(), "book")
    operation.assert_not_called()


@pytest.mark.parametrize("response", [{"exceptionDetails": {}}, {"result": {}}])
def test_interrupted_dropdown_mutation_cannot_be_retried_as_stale(monkeypatch, response):
    import jev_ultrafast.browser as browser

    # A navigation can destroy the evaluation result after the change event already fired.
    if "exceptionDetails" in response:
        response["exceptionDetails"] = {"text": "Execution context destroyed"}
    cdp = Mock(return_value=response)
    monkeypatch.setattr(browser, "cdp", cdp)
    expected = RuntimeError if "exceptionDetails" in response else StalePage
    with pytest.raises(expected, match="Dropdown execution" if expected is RuntimeError else "Target changed"):
        browser_operation({"operation": "act", "session": "test", "action": {
            "id": "e1", "kind": "select", "node": 1, "value": "Design",
        }})
    assert cdp.call_count == 1


def test_fingerprint_tracks_values_and_identity_not_screenshots():
    p = page()
    other = deepcopy(p)
    other["screenshot"] = "changed"
    assert fingerprint(p) == fingerprint(other)
    other["actions"][0]["node"] = 99
    assert fingerprint(p) != fingerprint(other)


@pytest.mark.parametrize("changed", ["Departure", "Where from?", "Where to?", "year"])
def test_flight_verification_rejects_wrong_trip(changed):
    from examples.flights import verify

    actual = {
        "url": "https://www.google.com/travel/flights/search?tfs=example",
        "text": "Track prices from Zürich to London departing 2026-09-20",
        "actions": [
            {"label": k, "value": v}
            for k, v in [
                ("Change ticket type. One way", "One way"),
                ("Where from?", "Zürich"),
                ("Where to?", "London"),
                ("Departure", "Sun, Sep 20"),
                ("Nonstop flight on Sunday, September 20. Select flight", ""),
            ]
        ],
    }
    assert verify(actual)["passed"]
    if changed == "year":
        actual["text"] = actual["text"].replace("2026", "2027")
    else:
        next(a for a in actual["actions"] if a["label"] == changed)["value"] = "wrong"
    assert not verify(actual)["passed"]


@pytest.mark.parametrize(
    "content", ["Thinking: Zurich", '{"text":null}', '{"text":"Zurich","extra":true}', '{"text":123}']
)
def test_text_helper_rejects_invalid_values(monkeypatch, content):
    monkeypatch.setenv("TEXT_MODEL_API_KEY", "test")
    monkeypatch.setenv("TEXT_MODEL_BASE_URL", "https://openrouter.ai/api/v1")
    monkeypatch.setenv("TEXT_MODEL_REASONING", "none")
    monkeypatch.setattr(model, "post_json", Mock(return_value={"choices": [{"message": {"content": content}}]}))
    with pytest.raises(ValueError, match="nothing typed"):
        model.field_text({"goal": "Find a flight"})


def test_text_helper_defaults_to_reasoning_disabled_for_openrouter(monkeypatch):
    monkeypatch.setenv("TEXT_MODEL_API_KEY", "test")
    monkeypatch.setenv("TEXT_MODEL_BASE_URL", "https://openrouter.ai/api/v1")
    monkeypatch.delenv("TEXT_MODEL_REASONING", raising=False)
    post = Mock(return_value={"choices": [{"message": {"content": '{"text":"Zurich"}'}}]})
    monkeypatch.setattr(model, "post_json", post)
    model.field_text({"goal": "Find a flight"})
    assert post.call_args.args[2]["reasoning"] == {"enabled": False}


def test_text_helper_rejects_empty_choices(monkeypatch):
    monkeypatch.setenv("TEXT_MODEL_API_KEY", "test")
    monkeypatch.setenv("TEXT_MODEL_BASE_URL", "https://openrouter.ai/api/v1")
    monkeypatch.setenv("TEXT_MODEL_REASONING", "none")
    monkeypatch.setattr(model, "post_json", Mock(return_value={"choices": []}))
    with pytest.raises(ValueError, match="nothing typed"):
        model.field_text({"goal": "Find a flight"})


def test_deepseek_root_uses_thinking_field(monkeypatch):
    monkeypatch.setenv("TEXT_MODEL_API_KEY", "test")
    monkeypatch.setenv("TEXT_MODEL_BASE_URL", "https://api.deepseek.com")
    monkeypatch.setenv("TEXT_MODEL_REASONING", "enabled")
    post = Mock(return_value={"choices": [{"message": {"content": '{"text":"Zurich"}'}}]})
    monkeypatch.setattr(model, "post_json", post)
    model.field_text({"goal": "Find a flight"})
    assert post.call_args.args[2]["thinking"] == {"type": "enabled"}


def test_deepseek_default_omits_reasoning_field(monkeypatch):
    monkeypatch.setenv("TEXT_MODEL_API_KEY", "test")
    monkeypatch.setenv("TEXT_MODEL_BASE_URL", "https://api.deepseek.com")
    monkeypatch.delenv("TEXT_MODEL_REASONING", raising=False)
    post = Mock(return_value={"choices": [{"message": {"content": '{"text":"Zurich"}'}}]})
    monkeypatch.setattr(model, "post_json", post)
    model.field_text({"goal": "Find a flight"})
    assert "thinking" not in post.call_args.args[2]


def test_generic_text_provider_omits_unknown_reasoning_field(monkeypatch):
    monkeypatch.setenv("TEXT_MODEL_API_KEY", "test")
    monkeypatch.setenv("TEXT_MODEL_BASE_URL", "https://text.example.test/v1")
    monkeypatch.delenv("TEXT_MODEL_REASONING", raising=False)
    post = Mock(return_value={"choices": [{"message": {"content": '{"text":"Zurich"}'}}]})
    monkeypatch.setattr(model, "post_json", post)
    model.field_text({"goal": "Find a flight"})
    assert "reasoning" not in post.call_args.args[2]


def test_generic_text_provider_rejects_provider_specific_reasoning(monkeypatch):
    monkeypatch.setenv("TEXT_MODEL_API_KEY", "test")
    monkeypatch.setenv("TEXT_MODEL_BASE_URL", "https://text.example.test/v1")
    monkeypatch.setenv("TEXT_MODEL_REASONING", "low")
    with pytest.raises(ValueError, match="OpenRouter or DeepSeek"):
        model.field_text({"goal": "Find a flight"})


def test_openrouter_root_accepts_reasoning_override(monkeypatch):
    monkeypatch.setenv("TEXT_MODEL_API_KEY", "test")
    monkeypatch.setenv("TEXT_MODEL_BASE_URL", "https://openrouter.ai")
    monkeypatch.setenv("TEXT_MODEL_REASONING", "high")
    post = Mock(return_value={"choices": [{"message": {"content": '{"text":"Zurich"}'}}]})
    monkeypatch.setattr(model, "post_json", post)

    model.field_text({"goal": "Find a flight"})

    assert post.call_args.args[2]["reasoning"] == {"effort": "high"}


def test_navigation_during_prediction_reobserves_without_action(runner):
    runner.state["browser"].fresh.side_effect = StalePage("Document navigating")
    runner.command("tick")
    assert runner.state["status"] == "ready"
    assert runner.state["decision"] is None
    assert runner.state["fallback_used"] is True
    assert runner.state["errors"][0]["phase"] == "stale_recovery"
    runner.state["browser"].act.assert_not_called()


def test_failed_stale_recovery_is_recorded(runner):
    runner.state["browser"].fresh.side_effect = StalePage("Document navigating")
    runner.state["browser"].observe.side_effect = StalePage("Still navigating")
    with pytest.raises(StalePage):
        runner.command("tick")
    assert runner.state["status"] == "blocked"
    assert runner.state["fallback_used"] is True
    assert runner.state["errors"][-1]["phase"] == "stale_recovery_observe"


def test_run_yields_terminal_state_on_model_error(runner, monkeypatch):
    monkeypatch.setattr(loop, "choose", Mock(side_effect=ValueError("bad response")))
    runner.state["status"] = "ready"
    states = list(runner.run())
    assert states[-1]["status"] == "blocked"
    assert runner.state["errors"][-1]["phase"] == "decision"


def test_post_action_stale_recovery_preserves_execution_result(runner, monkeypatch):
    monkeypatch.setattr(loop, "choose", Mock(return_value=decision("e3")))
    runner.state["browser"].observe.side_effect = [StalePage("Navigation in progress"), page()]
    runner.command("tick")
    assert runner.state["history"][-1]["choice"] == "e3"
    assert runner.state["errors"][-1]["message"] == "Executed action re-observed."
    assert runner.state["history"][-1]["page_changed"] is False
