"""Offline contracts for a dynamic operation/target policy. No paid APIs."""

import time
from copy import deepcopy
from unittest.mock import Mock

import pytest

from jev_ultrafast import agent as loop
from jev_ultrafast import model
from jev_ultrafast.browser import StalePage, browser_operation, fingerprint
from jev_ultrafast.questions import NEXT_ACTION, TARGET
from jev_ultrafast.traderie import TRADERIE_D2R_URL


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
    return {"choice": selected, "probabilities": {i: float(i == selected) for i in ids}}


def decision(action="e1"):
    return {
        "choice": action,
        "operation": "TYPE_TEXT",
        "target": "1",
        "probabilities": {action: 1.0},
        "latency_ms": 10,
        "usage": {},
    }


@pytest.mark.parametrize("mutation", ["unknown", "nan", "missing", "negative", "non_max"])
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
    with pytest.raises(ValueError, match="Invalid TypeSafe"):
        model.validate_choice(a, {"a", "b"})


def test_one_index_per_node_with_operation_specific_targets():
    elements, targets, controls = model.action_space(page()["actions"])
    assert len(elements) == 2
    assert "operations" not in elements[0]  # the question heads already say which operations exist
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
    monkeypatch.setattr(model, "post_json", post)
    d = model.choose(page(), "Find a book", [])
    assert len(calls) == 1
    assert d["operation"] == "TYPE_TEXT" and d["target"] == "1" and d["choice"] == "e1"
    assert set(calls[0]["questions"]) == {"operation", "click_target", "type_text_target"}


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
    monkeypatch.setattr(model, "post_json", post)
    with pytest.raises(ValueError, match="Invalid TypeSafe"):
        model.choose(page(), "Find a book", [])


def test_target_head_gets_bare_indexes_and_target_rules_while_operation_keeps_full_rules(monkeypatch):
    p = page()
    p["actions"].insert(0, {
        "id": "toggle", "kind": "click", "label": "Free cancellation", "node": 30,
        "role": "checkbox", "checked": "true", "selected": False,
    })

    def post(_url, _key, body):
        questions = body["questions"]
        target = questions["click_target"]
        first = next(e for e in body["state"]["elements"] if e["index"] == "1")
        assert first["checked"] == "true" and first["selected"] is False  # the state lives in `elements` once
        assert set(target["criteria"]) == {"1", "2", "3"}
        assert all(value is None for value in target["criteria"].values())  # options are bare element indexes
        assert target["instructions"]["rules"] == TARGET  # the next-step rules are only in the operation question
        operation_instructions = questions["operation"]["instructions"]
        assert operation_instructions == {"goal": "Search with free cancellation", "rules": NEXT_ACTION}
        return {
            "model": "test",
            "answers": {
                "operation": choice(questions["operation"]["criteria"], "CLICK"),
                "click_target": choice(target["criteria"], "3"),
            },
        }

    monkeypatch.setenv("TYPESAFE_API_KEY", "test")
    monkeypatch.setattr(model, "post_json", post)
    d = model.choose(p, "Search with free cancellation", [])
    assert d["choice"] == "e3"



@pytest.fixture
def runner():
    a = loop.Agent.__new__(loop.Agent)
    a.screenshots = False
    a.text = "book"
    a.scope_guard = None
    a.phase_names = ["phase_1"]
    a.finish_phase_after = None
    p = page()
    a.state = {
        "browser": Mock(fresh=Mock(return_value=True), observe=Mock(return_value=p)),
        "page": p,
        "decision": decision(),
        "goal": "Find a book",
        "history": [],
        "plan": ["Find a book"],
        "plan_index": 0,
        "phase": "phase_1",
        "awaiting_handoff": False,
        "phase_start": 0,
        "rule_events": [],
        "scope_blocked_reason": None,
        "decisions": [],
        "status": "predicted",
        "started_at": time.perf_counter(),
    }
    return a


def test_stale_decision_is_consumed_before_any_mutation(runner):
    runner.state["browser"].fresh.return_value = False
    with pytest.raises(StalePage):
        runner.command("act", {"fingerprint": runner.state["page"]["fingerprint"]})
    runner.state["browser"].act.assert_not_called()
    assert runner.state["decision"] is None


def test_fill_types_exactly_the_text_given_to_the_agent(runner):
    runner.text = "Shako"
    runner.command("act", {"fingerprint": runner.state["page"]["fingerprint"]})
    runner.state["browser"].act.assert_called_once()
    assert runner.state["browser"].act.call_args.kwargs["text"] == "Shako"
    assert runner.state["history"][-1]["text"] == "Shako"


def test_fill_without_supplied_text_raises_before_any_browser_input(runner):
    runner.text = None
    with pytest.raises(ValueError, match="Supply the text"):
        runner.command("act", {"fingerprint": runner.state["page"]["fingerprint"]})
    runner.state["browser"].act.assert_not_called()



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
    with pytest.raises(RuntimeError, match="Dropdown execution"):
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


def test_navigation_during_prediction_reobserves_without_action(runner):
    runner.state["browser"].fresh.side_effect = StalePage("Document navigating")
    runner.command("tick")
    assert runner.state["status"] == "ready"
    assert runner.state["decision"] is None
    runner.state["browser"].act.assert_not_called()


def test_stale_recovery_checks_readiness_before_reobserve(runner):
    call_order = []
    runner.state["browser"].fresh.side_effect = StalePage("Document navigating")
    runner.state["browser"].wait_until_ready = Mock(
        side_effect=lambda timeout=2.0: call_order.append(("ready", timeout))
    )
    runner.state["browser"].observe = Mock(
        side_effect=lambda screenshot=False: call_order.append(("observe", screenshot)) or page()
    )

    runner.command("tick")

    assert [step for step, _value in call_order[:2]] == ["ready", "observe"]


def test_done_is_two_phase_with_controller_handoff(runner):
    done_decision = {
        "choice": "DONE",
        "operation": "DONE",
        "target": "DONE",
        "probabilities": {"DONE": 1.0},
        "latency_ms": 10,
        "usage": {},
    }
    runner.phase_names = ["trading", "recent_trades"]
    runner.scope_guard = lambda _url: None
    runner.state["plan"] = ["phase-a", "phase-b"]
    runner.state["goal"] = "phase-a"
    runner.state["plan_index"] = 0
    runner.state["phase"] = "trading"
    runner.state["awaiting_handoff"] = False

    product_page = page()
    product_page["url"] = f"{TRADERIE_D2R_URL}/product/shako"
    product_page["fingerprint"] = fingerprint(product_page)
    runner.state["page"] = product_page
    runner.state["decision"] = done_decision

    first = runner.command("act", {"fingerprint": product_page["fingerprint"]})

    assert first["status"] == "handoff"
    assert first["awaiting_handoff"] is True
    assert first["plan_index"] == 1
    assert first["phase"] == "recent_trades"

    recent_page = page()
    recent_page["url"] = f"{TRADERIE_D2R_URL}/product/shako/recent"
    recent_page["fingerprint"] = fingerprint(recent_page)
    runner.state["browser"].observe.return_value = recent_page
    runner.command("handoff")
    assert runner.state["status"] == "ready"
    assert runner.state["awaiting_handoff"] is False

    runner.state["decision"] = done_decision
    runner.state["page"] = recent_page
    final = runner.command("act", {"fingerprint": recent_page["fingerprint"]})
    assert final["status"] == "done"


def test_the_request_carries_how_often_each_action_ran_in_this_phase(monkeypatch):
    seen = {}

    def post(_url, _key, body):
        seen.update(body["state"])
        return {"model": "test", "answers": {"operation": choice(body["questions"]["operation"]["criteria"], "WAIT")}}

    monkeypatch.setenv("TYPESAFE_API_KEY", "test")
    monkeypatch.setattr(model, "post_json", post)
    history = [{"action": "Load More"}, {"action": "Scroll to bottom of page"}, {"action": "Load More"}]
    model.choose(page(), "goal", history)
    assert seen["action_counts"] == {"Load More": 2, "Scroll to bottom of page": 1}


def test_each_phase_sees_only_its_own_recent_actions(runner, monkeypatch):
    seen = []
    def fake_choose(_page, _goal, history, _text):
        seen.append(list(history))
        return _jev_answer("e3", "CLICK", {"CLICK": 1.0})

    monkeypatch.setattr(loop, "choose", fake_choose)
    runner.state["decision"] = None
    runner.state["status"] = "ready"
    runner.state["history"] = [{"step": 1}, {"step": 2}, {"step": 3}]
    runner.state["awaiting_handoff"] = True
    runner.state["browser"].observe.return_value = runner.state["page"]
    runner.command("handoff")
    assert runner.state["phase_start"] == 3
    runner.state["status"] = "ready"
    runner.command("predict")
    assert seen[-1] == []  # the new phase starts with an empty action list
    runner.state["history"].append({"step": 4})
    runner.command("predict")
    assert seen[-1] == [{"step": 4}]


def test_scope_guard_blocks_off_scope_url_after_action(runner):
    runner.scope_guard = lambda url: "超出 Traderie D2R 範圍：/messages" if url.endswith("/messages") else None
    runner.state["decision"] = decision("e3")
    off_scope = page()
    off_scope["url"] = "https://www.traderie.com/messages"
    off_scope["fingerprint"] = fingerprint(off_scope)
    runner.state["browser"].observe.return_value = off_scope

    runner.command("act", {"fingerprint": runner.state["page"]["fingerprint"]})

    assert runner.state["status"] == "blocked"
    assert runner.state["scope_blocked_reason"] == "超出 Traderie D2R 範圍：/messages"



def _jev_answer(choice_id, operation, probabilities):
    return {
        "choice": choice_id,
        "operation": operation,
        "target": "2",
        "probabilities": {choice_id: 1.0},
        "operation_probabilities": probabilities,
        "target_probabilities": {"2": 0.9, "3": 0.1} if operation == "CLICK" else {},
        "latency_ms": 12,
        "usage": {"input_tokens": 100, "output_tokens": 7},
    }


def test_predict_records_label_phase_step_and_closest_alternatives(runner, monkeypatch):
    runner.state["decision"] = None
    runner.state["status"] = "ready"
    answers = iter(
        [
            _jev_answer("e3", "CLICK", {"CLICK": 0.7, "WAIT": 0.2, "TYPE_TEXT": 0.07, "DONE": 0.03}),
            _jev_answer("DONE", "DONE", {"DONE": 0.6, "CLICK": 0.4}),
        ]
    )
    monkeypatch.setattr(loop, "choose", lambda *_a, **_k: next(answers))
    runner.command("predict")
    first = runner.state["decisions"][-1]
    assert first["label"] == "Go"
    assert first["phase"] == "phase_1"
    assert first["step"] == 0
    assert first["alternatives"] == [["WAIT", 0.2], ["TYPE_TEXT", 0.07]]
    assert first["probability"] == 0.7 and first["target_probability"] == 0.9
    runner.state["history"].append({"step": 1})
    runner.command("predict")
    second = runner.state["decisions"][-1]
    assert second["label"] == "完成"
    assert second["step"] == 1
    assert second["alternatives"] == [["CLICK", 0.4]]
    assert second["probability"] == 0.6 and second["target_probability"] is None


@pytest.mark.parametrize(
    "field_value, typed, offers_typing",
    [("", "Harlequin Crest", True), ("Harlequin Crest", "Harlequin Crest", False), ("Harlequin Crest", None, True)],
)
def test_typing_is_not_offered_once_the_field_already_holds_the_text(monkeypatch, field_value, typed, offers_typing):
    p = page()
    p["actions"][0]["value"] = field_value
    seen = {}

    def post(_url, _key, body):
        seen.update(body["questions"])
        return {"model": "test", "answers": {"operation": choice(body["questions"]["operation"]["criteria"], "CLICK"),
                                              "click_target": choice(["1", "2"], "2")}}

    monkeypatch.setenv("TYPESAFE_API_KEY", "test")
    monkeypatch.setattr(model, "post_json", post)
    model.choose(p, "Find a book", [], typed)
    assert ("type_text_target" in seen) is offers_typing
    assert ("TYPE_TEXT" in seen["operation"]["criteria"]) is offers_typing


def _answers(operations, chosen, target_probabilities=None):
    others = [name for name in operations if name != chosen]
    probabilities = {name: 0.1 / len(others) for name in others} | {chosen: 0.9}
    answers = {"operation": {"choice": chosen, "probabilities": probabilities}}
    if target_probabilities:
        answers["click_target"] = {"choice": "1", "probabilities": target_probabilities}
    return answers


@pytest.mark.parametrize(
    "target_probabilities, asked_again",
    [({"1": 0.4, "2": 0.3, "3": 0.3}, True), ({"1": 0.7, "2": 0.2, "3": 0.1}, False)],
)
def test_an_ambiguous_target_is_not_executed_jev_is_asked_again_without_that_operation(
    monkeypatch, target_probabilities, asked_again
):
    p = page()
    third = {"id": "e4", "kind": "click", "label": "Go again", "role": "button", "value": "", "node": 30}
    p["actions"].insert(3, third)
    requests = []

    def post(_url, _key, body):
        requests.append(body)
        operations = body["questions"]["operation"]["criteria"]
        usage = {"input_tokens": 100, "output_tokens": 5}
        chosen = "CLICK" if "CLICK" in operations else "WAIT"
        return {"model": "test", "usage": usage, "answers": _answers(operations, chosen, target_probabilities)}

    monkeypatch.setenv("TYPESAFE_API_KEY", "test")
    monkeypatch.setattr(model, "post_json", post)
    decision = model.choose(p, "Find a book", [])
    assert len(requests) == (2 if asked_again else 1)
    if asked_again:
        second = requests[1]["questions"]
        assert "CLICK" not in second["operation"]["criteria"] and "click_target" not in second
        assert decision["operation"] == "WAIT"
        assert decision["reasked"] == {"operation": "CLICK", "target_probability": 0.4}
        assert decision["model_calls"] == 2 and decision["usage"] == {"input_tokens": 200, "output_tokens": 10}
    else:
        assert decision["operation"] == "CLICK" and decision["reasked"] is None and decision["model_calls"] == 1


def test_repeated_names_keep_only_the_first_two_and_the_rest_cannot_be_chosen():
    actions = [
        {"id": f"e{i}", "kind": "fill", "label": "Min", "role": "textbox", "value": "", "node": i} for i in range(1, 14)
    ]
    actions.append({"id": "e99", "kind": "click", "label": "Load More", "role": "button", "value": "", "node": 99})
    elements, targets, _controls = model.action_space(actions)
    assert [e["label"] for e in elements] == ["Min", "Min", "Load More"]
    assert [e["index"] for e in elements] == ["1", "2", "3"]
    assert set(targets["TYPE_TEXT"]) == {"1", "2"} and set(targets["CLICK"]) == {"3"}


def _press(runner, times):
    for _ in range(times):
        runner.state["decision"] = decision("e3")
        runner.command("act", {"fingerprint": runner.state["page"]["fingerprint"]})


def test_a_phase_ends_by_rule_after_the_set_number_of_presses_without_asking_jev(runner, monkeypatch):
    monkeypatch.setattr(loop, "choose", lambda *_a, **_k: pytest.fail("Jev must not be asked"))
    runner.finish_phase_after = ("go", 2)  # the label on the page is "Go": the comparison ignores case
    runner.phase_names = ["phase_1", "phase_2"]
    runner.state["plan"] = ["first", "second"]
    _press(runner, 1)
    assert runner.state["status"] == "ready" and runner.state["rule_events"] == []
    _press(runner, 1)
    assert runner.state["status"] == "handoff" and runner.state["awaiting_handoff"] is True
    assert runner.state["plan_index"] == 1 and runner.state["phase"] == "phase_2"
    assert runner.state["rule_events"] == [{"step": 2, "phase": "phase_1", "label": "go", "count": 2}]


def test_the_last_phase_ends_by_rule_as_done(runner):
    runner.finish_phase_after = ("Go", 1)
    _press(runner, 1)
    assert runner.state["status"] == "done" and runner.state["awaiting_handoff"] is False


def test_the_rule_counts_only_this_phase_and_only_its_own_label(runner):
    runner.finish_phase_after = ("Go", 2)
    runner.state["history"] = [{"action": "Go", "kind": "click", "page_changed": True}]  # pressed in the previous phase
    runner.state["phase_start"] = 1
    _press(runner, 1)
    assert runner.state["status"] == "ready"
    runner.finish_phase_after = ("Load More", 1)
    _press(runner, 1)
    assert runner.state["status"] == "ready" and runner.state["rule_events"] == []


def test_the_loading_cycle_alternates_without_asking_jev_and_hands_back_when_no_button(runner, monkeypatch):
    runner.finish_phase_after = ("Load More", 5)
    more = {"id": "e9", "kind": "click", "label": "Load more", "node": 9}
    bottom = {"id": "scroll_bottom", "kind": "scroll", "label": "Scroll to bottom of page", "delta": 900}
    runner.state["page"]["actions"] = [more, bottom]
    asked = []
    jev = {**decision("e3"), "operation_probabilities": {"TYPE_TEXT": 1.0}}
    monkeypatch.setattr(loop, "choose", lambda *_a, **_k: asked.append(1) or jev)
    runner.state["history"] = [{"action": "Scroll to bottom of page", "choice": "scroll_bottom", "kind": "scroll"}]
    runner.command("predict")
    assert runner.state["decision"]["choice"] == "e9" and runner.state["decision"]["model_calls"] == 0
    runner.state["history"].append({"action": "Load more", "choice": "e9", "kind": "click"})
    runner.command("predict")
    assert runner.state["decision"]["choice"] == "scroll_bottom" and asked == []
    # After a scroll with no Load More on the page the choice is Jev's.
    runner.state["page"]["actions"] = [bottom]
    runner.state["history"].append({"action": "Scroll to bottom of page", "choice": "scroll_bottom", "kind": "scroll"})
    runner.command("predict")
    assert asked == [1]
