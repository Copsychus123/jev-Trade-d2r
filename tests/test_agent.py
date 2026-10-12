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
        "last_attempt": None,
        "stale_streak": None,
        "stale_events": {},
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


def test_element_freshness_compares_the_page_key_and_the_element_guard(monkeypatch):
    """`fresh` is what stops a stale decision from being executed: the element is re-checked by the node number the
    observation handed out (never a selector), and both the page key and that element's own guard must still match."""
    import jev_ultrafast.browser as browser

    observed = {"page_key": "k", "guards": {"1": "g"}, "marker": "m"}
    b = browser.Browser.__new__(browser.Browser)

    b.evaluate = Mock(return_value=["k", "g"])
    assert b.fresh(observed, {"kind": "click", "node": 1}) is True
    expression = b.evaluate.call_args.args[0]
    assert "c.pageKey()" in expression and "c.nodes.get(1)" in expression

    b.evaluate = Mock(return_value=["k", "moved"])  # the element itself was replaced
    assert b.fresh(observed, {"kind": "click", "node": 1}) is False
    b.evaluate = Mock(return_value=["other", "g"])  # the page moved on
    assert b.fresh(observed, {"kind": "click", "node": 1}) is False
    b.evaluate = Mock(return_value=None)  # the observation bridge is gone
    assert b.fresh(observed, {"kind": "click", "node": 1}) is False

    # A page-level action has no element: it is the marker that must still match.
    b.evaluate = Mock(return_value="m")
    assert b.fresh(observed) is True
    assert b.evaluate.call_args.args[0] == browser.MARKER
    b.evaluate = Mock(return_value="changed")
    assert b.fresh(observed) is False

    # A node that is not the integer the observation handed out never reaches the page.
    b.evaluate = Mock(return_value=["k", "g"])
    assert b.fresh(observed, {"kind": "click", "node": "e1"}) is False
    b.evaluate.assert_not_called()


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
        side_effect=lambda timeout_seconds=2.0: call_order.append(("ready", timeout_seconds))
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


# --- execution is logged before it happens; one recovery path; scope and budget are checked before any cost ---


def test_the_action_is_in_history_as_started_before_the_browser_acts(runner):
    runner.state["decision"] = decision("e3")
    seen = []
    runner.state["browser"].act.side_effect = lambda *_a, **_k: seen.append(dict(runner.state["history"][-1]))
    runner.command("act", {"fingerprint": runner.state["page"]["fingerprint"]})
    assert seen[0]["outcome"] == "started" and seen[0]["page_changed"] is None
    assert runner.state["history"][-1]["outcome"] == "executed"
    assert runner.state["history"][-1]["page_changed"] is False  # observing the same page is no change


def test_an_unconfirmed_mutation_stays_in_history_and_is_never_replayed(runner):
    runner.state["decision"] = decision("e3")
    runner.state["browser"].act.side_effect = RuntimeError("connection lost mid-click")
    with pytest.raises(RuntimeError, match="connection lost"):
        runner.command("act", {"fingerprint": runner.state["page"]["fingerprint"]})
    assert [h["outcome"] for h in runner.state["history"]] == ["unconfirmed"]
    assert runner.state["decision"] is None
    runner.state["browser"].act.assert_called_once()


def test_a_click_refused_as_stale_is_not_counted_as_executed(runner):
    runner.state["decision"] = decision("e3")
    runner.state["browser"].act.side_effect = StalePage("covered")
    with pytest.raises(StalePage):
        runner.command("act", {"fingerprint": runner.state["page"]["fingerprint"]})
    assert runner.state["history"] == []


def test_tick_recovers_from_a_stale_page_by_observing_once(runner, monkeypatch):
    monkeypatch.setattr(loop, "choose", lambda *_a, **_k: _jev_answer("e3", "CLICK", {"CLICK": 1.0}))
    runner.state["decision"] = None
    runner.state["status"] = "ready"
    runner.state["browser"].act.side_effect = StalePage("covered")
    runner.command("tick")
    assert runner.state["browser"].observe.call_count == 1
    assert runner.state["status"] == "ready" and runner.state["history"] == []


def test_three_consecutive_stale_failures_on_one_target_stop_the_run(runner, monkeypatch):
    """A refused action is popped from `history`, so the step budget cannot fire: the streak has to end the run."""
    monkeypatch.setattr(loop, "choose", lambda *_a, **_k: _jev_answer("e3", "CLICK", {"CLICK": 1.0}))
    runner.state["browser"].act.side_effect = StalePage("covered")
    for _ in range(loop.STALE_RETRY_LIMIT):
        runner.state["decision"] = None
        runner.state["status"] = "ready"
        runner.command("tick")
    assert runner.state["status"] == "blocked"
    assert "連續 3 次都無法操作「Go」" in runner.state["scope_blocked_reason"]
    assert runner.state["stale_streak"]["count"] == loop.STALE_RETRY_LIMIT
    event = runner.state["rule_events"][-1]
    assert (event["label"], event["stale"], event["count"]) == ("Go", True, loop.STALE_RETRY_LIMIT)
    assert runner.state["stale_events"].get(runner.state["scope_blocked_reason"]) == 1


def test_a_stale_streak_starts_over_when_the_page_changes(runner, monkeypatch):
    monkeypatch.setattr(loop, "choose", lambda *_a, **_k: _jev_answer("e3", "CLICK", {"CLICK": 1.0}))
    runner.state["browser"].act.side_effect = StalePage("covered")
    changed = {**page(), "text": "Search results"}
    changed["fingerprint"] = fingerprint(changed)  # a real page change, not just a copied fingerprint
    # The page changes while the first failure is being recovered, so the next attempt is made on the new page.
    runner.state["browser"].observe.return_value = changed
    runner.state["decision"] = None
    runner.state["status"] = "ready"
    runner.command("tick")
    runner.state["decision"] = None
    runner.state["status"] = "ready"
    runner.command("tick")
    assert runner.state["status"] == "ready"
    assert runner.state["stale_streak"]["count"] == 1


def test_a_stale_streak_starts_over_when_the_target_changes(runner, monkeypatch):
    answers = iter([_jev_answer("e3", "CLICK", {"CLICK": 1.0}), _jev_answer("e2", "CLICK", {"CLICK": 1.0})])
    monkeypatch.setattr(loop, "choose", lambda *_a, **_k: next(answers))
    runner.state["browser"].act.side_effect = StalePage("covered")
    for _ in range(2):
        runner.state["decision"] = None
        runner.state["status"] = "ready"
        runner.command("tick")
    assert runner.state["status"] == "ready"
    assert runner.state["stale_streak"]["count"] == 1


def test_a_navigation_during_prediction_never_counts_as_a_stale_target(runner, monkeypatch):
    """A page that is still navigating is not a target that keeps failing: three of those must not stop the run."""
    monkeypatch.setattr(loop, "choose", lambda *_a, **_k: pytest.fail("a navigating page must not reach a decision"))
    runner.state["browser"].fresh.side_effect = StalePage("Document navigating")
    for _ in range(loop.STALE_RETRY_LIMIT + 1):
        runner.state["status"] = "ready"
        runner.command("tick")
    assert runner.state["status"] == "ready"
    assert runner.state["stale_streak"] is None
    assert runner.state["scope_blocked_reason"] is None


@pytest.mark.parametrize("status", ["done", "blocked"])
def test_predict_on_a_stopped_run_observes_nothing_and_asks_no_model(runner, monkeypatch, status):
    monkeypatch.setattr(loop, "choose", lambda *_a, **_k: pytest.fail("a stopped run must not cost a model call"))
    runner.state["status"] = status
    runner.state["decision"] = None
    with pytest.raises(ValueError, match="stopped"):
        runner.command("predict")
    runner.state["browser"].fresh.assert_not_called()
    runner.state["browser"].observe.assert_not_called()


def test_predict_at_the_step_budget_blocks_before_observing_or_asking_the_model(runner, monkeypatch):
    monkeypatch.setattr(loop, "choose", lambda *_a, **_k: pytest.fail("the budget is spent"))
    runner.state["status"] = "ready"
    runner.state["decision"] = None
    runner.state["history"] = [{"action": "x", "kind": "click"}] * loop.MAX_STEPS
    with pytest.raises(ValueError, match="budget"):
        runner.command("predict")
    assert runner.state["status"] == "blocked"
    runner.state["browser"].observe.assert_not_called()


@pytest.mark.parametrize("selected", ["DONE", "BLOCKED"])
def test_done_and_blocked_do_not_need_a_byte_identical_page(runner, selected):
    runner.state["browser"].fresh.return_value = False  # ads changed the text since the decision
    runner.state["decision"] = {**decision(selected), "operation": selected, "target": None}
    runner.command("act", {"fingerprint": runner.state["page"]["fingerprint"]})
    assert runner.state["status"] == ("done" if selected == "DONE" else "blocked")


def test_an_off_scope_link_is_refused_before_any_input(runner):
    runner.scope_guard = lambda url: "超出 Traderie D2R 範圍" if "/profile/" in url else None
    link = {"id": "e9", "kind": "click", "label": "Seller", "role": "link", "node": 90,
            "href": "https://www.traderie.com/profile/someone"}
    runner.state["page"]["actions"].append(link)
    runner.state["page"]["fingerprint"] = fingerprint(runner.state["page"])
    runner.state["decision"] = decision("e9")
    runner.command("act", {"fingerprint": runner.state["page"]["fingerprint"]})
    runner.state["browser"].act.assert_not_called()
    assert runner.state["status"] == "blocked" and runner.state["scope_blocked_reason"]
    assert runner.state["history"] == []


def test_javascript_and_in_scope_hrefs_are_not_refused(runner):
    runner.scope_guard = lambda url: "off" if "off.example" in url else None
    for href in ("javascript:void(0)", "#top", "https://www.traderie.com/diablo2resurrected"):
        runner.state["page"]["actions"][2]["href"] = href
        runner.state["page"]["fingerprint"] = fingerprint(runner.state["page"])
        runner.state["decision"] = decision("e3")
        runner.state["history"].clear()
        runner.command("act", {"fingerprint": runner.state["page"]["fingerprint"]})
        assert runner.state["history"], href


def test_the_scope_guard_is_chosen_by_host_only_so_a_path_prefix_cannot_bypass_it():
    from jev_ultrafast.traderie.site import traderie_scope_reason

    assert loop.scope_guard_for("https://WWW.Traderie.com/diablo2resurrected") is traderie_scope_reason
    assert loop.scope_guard_for("https://www.traderie.com/diablo2resurrectedx") is traderie_scope_reason
    assert traderie_scope_reason("https://www.traderie.com/diablo2resurrectedx")
    assert loop.scope_guard_for("https://example.test/diablo2resurrected") is None


# --- evaluation errors: only a navigation is "stale"; a real script error is reported with its text ---

NAVIGATION_ERRORS = [
    {"text": "Execution context was destroyed, most likely because of a navigation."},
    {"text": "Uncaught", "exception": {"description": "Error: Cannot find context with specified id"}},
    {"text": "Inspected target navigated or closed"},
]
SCRIPT_ERROR = {"text": "Uncaught", "exception": {"description": "TypeError: node.focus is not a function"}}


def _browser_with(monkeypatch, response):
    import jev_ultrafast.browser as browser

    b = browser.Browser.__new__(browser.Browser)
    b.session = "s"
    monkeypatch.setattr(browser, "cdp", Mock(return_value=response))
    return b


@pytest.mark.parametrize("details", NAVIGATION_ERRORS)
def test_a_navigation_during_evaluation_is_a_stale_page(monkeypatch, details):
    b = _browser_with(monkeypatch, {"exceptionDetails": details})
    with pytest.raises(StalePage):
        b.evaluate("1")
    with pytest.raises(StalePage):
        browser_operation({"operation": "observe", "session": "s", "screenshot": False})


def test_a_script_error_is_raised_with_its_text_not_hidden_as_a_stale_page(monkeypatch):
    b = _browser_with(monkeypatch, {"exceptionDetails": SCRIPT_ERROR})
    with pytest.raises(RuntimeError, match="node.focus is not a function") as excinfo:
        b.evaluate("1")
    assert not isinstance(excinfo.value, StalePage)
    with pytest.raises(RuntimeError, match="node.focus is not a function"):
        browser_operation({"operation": "observe", "session": "s", "screenshot": False})


def test_closing_always_forgets_the_tab_even_when_closing_fails(monkeypatch):
    import jev_ultrafast.browser as browser

    b = browser.Browser.__new__(browser.Browser)
    b.target = "t"
    monkeypatch.setattr(browser, "cdp", Mock(side_effect=RuntimeError("no connection")))
    with pytest.raises(RuntimeError):
        b.close()
    assert b.target is None
    b.close()  # a second close does nothing and must not raise


# --- the goal becomes a plan, and a goal that says nothing opens nothing ---


def _stub_browser(monkeypatch, observe=None):
    if isinstance(observe, BaseException):
        observed = Mock(side_effect=observe)
    else:
        observed = Mock(return_value=page() if observe is None else observe)
    browser = Mock(observe=observed, close=Mock())
    monkeypatch.setattr(loop, "Browser", lambda url, images=False: browser)
    return browser


def test_a_single_traderie_goal_becomes_the_planned_views(monkeypatch):
    traderie_page = page()
    traderie_page["url"] = f"{TRADERIE_D2R_URL}/product/123"
    traderie_page["fingerprint"] = fingerprint(traderie_page)
    browser = _stub_browser(monkeypatch, observe=traderie_page)
    goal = "Find Harlequin Crest"
    a = loop.Agent(TRADERIE_D2R_URL, goal)
    plan, names = loop.phase_plan(goal)
    assert (a.state["plan"], a.phase_names) == (plan, names) and len(names) == 2
    assert a.state["goal"] == plan[0] and a.state["phase"] == names[0]
    assert (a.state["status"], a.state["plan_index"], a.state["history"]) == ("ready", 0, [])
    assert browser.observe.call_args.kwargs["screenshot"] is False  # no pictures unless asked for
    assert a.scope_guard is loop.traderie_scope_reason  # a Traderie run is guarded by Traderie's own reason rule


def test_a_traderie_goal_that_opens_on_another_site_is_blocked_at_once(monkeypatch):
    _stub_browser(monkeypatch)  # page() lives on example.test
    a = loop.Agent(TRADERIE_D2R_URL, "Find Harlequin Crest")
    assert a.state["status"] == "blocked" and a.state["scope_blocked_reason"]


def test_a_goal_list_is_planned_verbatim_with_generic_phase_names(monkeypatch):
    _stub_browser(monkeypatch)
    a = loop.Agent("https://example.test/", ["  Open the page  ", "", "Read the list"])
    assert a.state["plan"] == ["Open the page", "Read the list"]
    assert a.phase_names == ["phase_1", "phase_2"] and a.state["phase"] == "phase_1"
    assert a.scope_guard is None and a.state["goal"] == "Open the page"


def test_a_single_goal_on_another_site_is_one_unnamed_phase(monkeypatch):
    _stub_browser(monkeypatch)
    a = loop.Agent("https://example.test/", "  Find a book ")
    assert (a.state["plan"], a.phase_names) == (["Find a book"], ["phase_1"])


def test_a_goal_that_says_nothing_opens_nothing(monkeypatch):
    monkeypatch.setattr(loop, "Browser", lambda *a, **k: pytest.fail("a browser must not be opened"))
    for empty in ("   ", ["", "  "]):
        with pytest.raises(ValueError, match="Supply a task"):
            loop.Agent("https://example.test/", empty)


def test_a_first_observation_that_fails_closes_the_browser_and_raises(monkeypatch):
    browser = _stub_browser(monkeypatch, observe=RuntimeError("no tab"))
    with pytest.raises(RuntimeError):
        loop.Agent("https://example.test/", "Find a book")
    assert browser.close.called


# --- the recovery path is bounded: a failed probe is ignored, a stale read is retried, the last try re-raises ---


def test_a_failing_readiness_probe_never_stops_stale_recovery(runner):
    runner.state["browser"].fresh.side_effect = StalePage("Document navigating")
    runner.state["browser"].wait_until_ready = Mock(side_effect=RuntimeError("the daemon went away"))

    runner.command("tick")

    assert runner.state["status"] == "ready"


def test_a_stale_observation_is_retried_before_the_run_gives_up(runner):
    runner.state["browser"].fresh.side_effect = StalePage("Document navigating")
    runner.state["browser"].observe.side_effect = [StalePage("still navigating"), page()]

    runner.command("tick")

    assert runner.state["status"] == "ready"
    assert runner.state["browser"].observe.call_count == 2


def test_the_last_reobserve_attempt_re_raises_so_the_run_cannot_spin(runner):
    runner.state["browser"].fresh.side_effect = StalePage("Document navigating")
    runner.state["browser"].observe.side_effect = StalePage("still navigating")

    with pytest.raises(StalePage):
        runner.command("tick")

    assert runner.state["browser"].observe.call_count == loop.REOBSERVE_ATTEMPTS


# --- the mechanical loading rule hands back to Jev when the page offers nothing to press ---


def test_the_loading_rule_hands_back_to_jev_when_the_next_button_is_missing(runner, monkeypatch):
    runner.finish_phase_after = ("Load More", 5)
    runner.state["history"] = [{"action": "Wait", "choice": "wait", "kind": "wait"}]
    asked = []
    monkeypatch.setattr(
        loop, "choose", lambda *_a, **_k: asked.append(1) or _jev_answer("e3", "CLICK", {"CLICK": 1.0})
    )
    runner.state["decision"] = None
    runner.state["status"] = "ready"

    runner.command("predict")

    assert asked == [1]
    assert runner.state["decision"]["choice"] == "e3"


# --- the decision log names a blocked verdict the way the panel shows it ---


def test_a_blocked_choice_is_logged_as_blocked(runner, monkeypatch):
    monkeypatch.setattr(loop, "choose", lambda *_a, **_k: _jev_answer("BLOCKED", "BLOCKED", {"BLOCKED": 1.0}))
    runner.state["decision"] = None
    runner.state["status"] = "ready"

    runner.command("predict")

    assert runner.state["decisions"][-1]["label"] == "受阻"


# --- every command/guard that must refuse does so with its contract message ---


def test_an_unknown_command_is_refused(runner):
    with pytest.raises(ValueError, match="Unknown command"):
        runner.command("teleport")


def test_predict_without_a_browser_asks_for_a_demo_first(runner):
    runner.state["browser"] = None
    runner.state["decision"] = None
    runner.state["status"] = "ready"

    with pytest.raises(ValueError, match="Start a demo first"):
        runner.command("predict")


def test_the_first_prediction_starts_the_clock(runner, monkeypatch):
    monkeypatch.setattr(loop, "choose", lambda *_a, **_k: _jev_answer("e3", "CLICK", {"CLICK": 1.0}))
    monkeypatch.setattr(loop.time, "perf_counter", lambda: 4321.0)  # a known clock reading
    runner.state["started_at"] = None
    runner.state["decision"] = None
    runner.state["status"] = "ready"

    runner.command("predict")

    assert runner.state["started_at"] == 4321.0  # the first prediction stamps the clock
    assert runner.state["decisions"][-1]["elapsed_ms"] == 0  # and the same reading measures the step


def test_predict_during_a_pending_handoff_is_refused(runner):
    runner.state["awaiting_handoff"] = True
    runner.state["decision"] = None
    runner.state["status"] = "ready"

    with pytest.raises(ValueError, match="Controller handoff required"):
        runner.command("predict")

    runner.state["browser"].fresh.assert_not_called()


def test_predict_stops_when_the_model_call_budget_is_spent(runner, monkeypatch):
    monkeypatch.setattr(loop, "choose", lambda *_a, **_k: pytest.fail("no model call past the budget"))
    runner.state["decisions"] = [{}] * (loop.MAX_STEPS * 2)
    runner.state["history"] = []
    runner.state["decision"] = None
    runner.state["status"] = "ready"

    with pytest.raises(ValueError, match="model-call budget"):
        runner.command("predict")


def test_predict_reobserves_when_the_page_is_no_longer_fresh(runner, monkeypatch):
    monkeypatch.setattr(loop, "choose", lambda *_a, **_k: _jev_answer("e3", "CLICK", {"CLICK": 1.0}))
    fresh_page = {**page(), "text": "Search results"}
    fresh_page["fingerprint"] = fingerprint(fresh_page)
    runner.state["browser"].fresh.return_value = False
    runner.state["browser"].observe.return_value = fresh_page
    runner.state["decision"] = None
    runner.state["status"] = "ready"

    runner.command("predict")

    runner.state["browser"].observe.assert_called_once()
    assert runner.state["page"] is fresh_page
    assert runner.state["decisions"][-1]["fingerprint"] == fresh_page["fingerprint"]


def test_handoff_without_a_pending_phase_is_refused(runner):
    runner.state["awaiting_handoff"] = False

    with pytest.raises(ValueError, match="No phase handoff is pending"):
        runner.command("handoff")

    runner.state["browser"].observe.assert_not_called()


def test_act_without_a_current_decision_is_refused(runner):
    runner.state["decision"] = None

    with pytest.raises(ValueError, match="Observe and choose before acting"):
        runner.command("act", {"fingerprint": runner.state["page"]["fingerprint"]})

    runner.state["browser"].act.assert_not_called()


def test_act_with_a_stale_fingerprint_is_refused(runner):
    with pytest.raises(ValueError, match="Observe and choose before acting"):
        runner.command("act", {"fingerprint": "outdated"})

    runner.state["browser"].act.assert_not_called()
    # a refused act never consumes the decision
    assert (runner.state["decision"]["choice"], runner.state["decision"]["operation"]) == ("e1", "TYPE_TEXT")


def test_a_choice_that_left_the_page_is_stale_and_never_an_input(runner):
    runner.state["decision"] = decision("gone")

    with pytest.raises(StalePage, match="Chosen element is no longer available"):
        runner.command("act", {"fingerprint": runner.state["page"]["fingerprint"]})

    runner.state["browser"].act.assert_not_called()
    assert runner.state["history"] == []


# --- the agent is a context manager over its browser ---


def test_close_hands_off_to_the_browser(runner):
    runner.browser = Mock()
    runner.close()
    runner.browser.close.assert_called_once()


def test_the_agent_closes_its_browser_as_a_context_manager(runner):
    runner.browser = Mock()
    with runner as entered:
        assert entered is runner
    runner.browser.close.assert_called_once()


# --- browser.py: wait_until_ready, observe's probe/retry, act's wait, target resolution, cookies ---


def test_a_cookie_that_cannot_be_set_is_reported_by_name(monkeypatch):
    import jev_ultrafast.browser as browser

    monkeypatch.setattr(browser, "get_settings", lambda: object())
    monkeypatch.setattr(browser, "cookie_specs", lambda _settings: [{"name": "traderie_session", "value": "x"}])

    def call(_method, **params):
        return {"success": False}

    with pytest.raises(RuntimeError, match="Failed to set Traderie cookie 'traderie_session'"):
        browser._inject_traderie_auth(call)


def test_wait_until_ready_polls_past_a_navigation_and_returns_true(monkeypatch):
    import jev_ultrafast.browser as browser

    b = browser.Browser.__new__(browser.Browser)
    b.evaluate = Mock(side_effect=[False, StalePage("navigating"), True])
    monkeypatch.setattr(browser.time, "sleep", lambda _s: None)

    assert b.wait_until_ready(timeout_seconds=1.0) is True
    assert b.evaluate.call_count == 3


def test_wait_until_ready_gives_up_at_its_deadline(monkeypatch):
    import jev_ultrafast.browser as browser

    b = browser.Browser.__new__(browser.Browser)
    b.evaluate = Mock(return_value=False)
    monkeypatch.setattr(browser.time, "sleep", lambda _s: None)

    assert b.wait_until_ready(timeout_seconds=0) is False
    assert b.evaluate.call_count == 1


def test_the_after_input_probe_runs_once_per_action(monkeypatch):
    import jev_ultrafast.browser as browser

    b = browser.Browser.__new__(browser.Browser)
    b.session = "s"
    b.after_input = {"id": "e1", "kind": "click", "label": "Go", "node": 20}
    b.call = Mock(return_value={})
    result = page()
    operation = Mock(return_value=result)
    monkeypatch.setattr(browser, "browser_operation", operation)

    assert b.observe(screenshot=False) is result
    assert b.after_input is None
    assert b.call.call_count == 1  # the settle probe ran exactly once, before the observation
    assert b.call.call_args.args[0] == "Runtime.evaluate"
    assert '"id": "e1"' in b.call.call_args.kwargs["expression"]

    b.observe(screenshot=False)  # no probe is left to run on the next read
    assert b.call.call_count == 1
    assert operation.call_count == 2


def test_a_failed_after_input_probe_never_hides_the_next_observation(monkeypatch):
    import jev_ultrafast.browser as browser

    b = browser.Browser.__new__(browser.Browser)
    b.session = "s"
    b.after_input = {"id": "e1", "kind": "click", "label": "Go", "node": 20}
    b.call = Mock(side_effect=RuntimeError("the page navigated under the probe"))
    result = page()
    monkeypatch.setattr(browser, "browser_operation", Mock(return_value=result))

    assert b.observe(screenshot=False) is result
    assert b.after_input is None


def test_observe_retries_a_stale_document_before_giving_up(monkeypatch):
    import jev_ultrafast.browser as browser

    b = browser.Browser.__new__(browser.Browser)
    b.session = "s"
    operation = Mock(side_effect=StalePage("navigating"))
    monkeypatch.setattr(browser, "browser_operation", operation)
    monkeypatch.setattr(browser.time, "sleep", lambda _s: None)

    with pytest.raises(StalePage):
        b.observe(screenshot=False)

    assert operation.call_count == 10


def test_a_stale_observation_is_retried_without_giving_up(monkeypatch):
    import jev_ultrafast.browser as browser

    b = browser.Browser.__new__(browser.Browser)
    b.session = "s"
    operation = Mock(side_effect=[StalePage("navigating"), page()])
    monkeypatch.setattr(browser, "browser_operation", operation)
    monkeypatch.setattr(browser.time, "sleep", lambda _s: None)

    assert b.observe(screenshot=False)["url"] == "https://example.test/"
    assert operation.call_count == 2


def test_a_wait_action_sleeps_and_leaves_nothing_to_settle(monkeypatch):
    import jev_ultrafast.browser as browser

    b = browser.Browser.__new__(browser.Browser)
    b.session = "s"
    b.fresh = Mock(return_value=True)
    b.after_input = {"id": "old", "kind": "click"}
    sleeps = []
    monkeypatch.setattr(browser.time, "sleep", lambda seconds: sleeps.append(seconds))
    operation = Mock(return_value={"executed": "wait"})
    monkeypatch.setattr(browser, "browser_operation", operation)

    assert b.act({"id": "wait", "kind": "wait", "label": "Wait"}, page()) == {"executed": "wait"}

    assert sleeps == [4.0]
    assert b.after_input is None


def test_acting_on_a_node_that_is_not_an_observed_integer_is_refused(monkeypatch):
    import jev_ultrafast.browser as browser

    cdp = Mock()
    monkeypatch.setattr(browser, "cdp", cdp)

    with pytest.raises(ValueError, match="Invalid observed node"):
        browser_operation(
            {"operation": "act", "session": "s", "action": {"id": "e1", "kind": "click", "node": "e1"}}
        )

    cdp.assert_not_called()


def test_a_click_on_a_target_that_moved_is_stale(monkeypatch):
    import jev_ultrafast.browser as browser

    cdp = Mock(return_value={"result": {"value": None}})
    monkeypatch.setattr(browser, "cdp", cdp)

    with pytest.raises(StalePage, match="Target changed or is covered"):
        browser_operation(
            {"operation": "act", "session": "s", "action": {"id": "e1", "kind": "click", "node": 20}}
        )


def test_a_click_presses_and_releases_at_the_resolved_point(monkeypatch):
    import jev_ultrafast.browser as browser

    cdp = Mock(side_effect=[{"result": {"value": {"x": 12, "y": 34}}}, {}, {}])
    monkeypatch.setattr(browser, "cdp", cdp)

    result = browser_operation(
        {"operation": "act", "session": "s", "action": {"id": "e1", "kind": "click", "node": 20}}
    )

    assert result == {"executed": "e1"}
    methods = [c.args[0] for c in cdp.call_args_list]
    assert methods == ["Runtime.evaluate", "Input.dispatchMouseEvent", "Input.dispatchMouseEvent"]
    assert [c.kwargs["type"] for c in cdp.call_args_list[1:]] == ["mousePressed", "mouseReleased"]
    assert [(c.kwargs["x"], c.kwargs["y"]) for c in cdp.call_args_list[1:]] == [(12, 34), (12, 34)]


def test_a_fill_types_at_the_resolved_point(monkeypatch):
    import jev_ultrafast.browser as browser

    cdp = Mock(side_effect=[{"result": {"value": {"x": 1, "y": 2}}}] + [{}] * 5)
    monkeypatch.setattr(browser, "cdp", cdp)

    browser_operation(
        {
            "operation": "act",
            "session": "s",
            "text": "Shako",
            "action": {"id": "e1", "kind": "fill", "node": 20},
        }
    )

    methods = [c.args[0] for c in cdp.call_args_list]
    assert methods.count("Input.dispatchKeyEvent") == 2
    insert = next(c for c in cdp.call_args_list if c.args[0] == "Input.insertText")
    assert insert.kwargs["text"] == "Shako"


def test_an_observation_while_the_document_is_navigating_is_stale(monkeypatch):
    import jev_ultrafast.browser as browser

    cdp = Mock(return_value={"result": {}})
    monkeypatch.setattr(browser, "cdp", cdp)

    with pytest.raises(StalePage, match="Document is navigating"):
        browser_operation({"operation": "observe", "session": "s", "screenshot": False})
