"""Offline contracts for Ego's indexed-state adapter and lifecycle."""

from __future__ import annotations

import copy

import pytest

from jev_ultrafast.backends.ego import EgoBrowserBackend
from jev_ultrafast.backends.transport import EgoRemoteError
from jev_ultrafast.browser import StalePage


def _state(text="Search"):
    return {
        "url": "https://example.test/",
        "title": "Search",
        "text": text,
        "scroll": {"y": 0, "height": 780},
        "actions": [
            {"id": "e1", "kind": "fill", "label": "Search", "role": "textbox", "value": "", "node": 10},
            {"id": "e2", "kind": "click", "label": "Go", "role": "button", "value": "", "node": 20},
            {"id": "wait", "kind": "wait", "label": "Wait", "node": None},
        ],
        "guards": {"10": [10, "textbox", "Search"], "20": [20, "button", "Go"]},
        "page_key": ["key"],
    }


class FakeTransport:
    runtime_spawn_count = 0

    def __init__(self, *, fail_init=False, fail_act=False, fail_act_error="unknown ref @21", navigate_once=False):
        self.fail_init = fail_init
        self.fail_act = fail_act
        self.fail_act_error = fail_act_error
        self.navigate_once = navigate_once
        self.started = 0
        self.closed = 0
        self.requests = []
        self.fresh_states = []
        self.observe_states = []
        self.cleanup_status = {
            "graceful_exit": True,
            "forced_terminate": False,
            "forced_kill": False,
            "orphan_process_remaining": False,
        }
        self.current = _state()

    def start(self, _source):
        self.started += 1
        FakeTransport.runtime_spawn_count += 1

    def request(self, operation, payload, **_kwargs):
        self.requests.append((operation, copy.deepcopy(payload)))
        if operation == "init":
            if self.fail_init:
                raise RuntimeError("init failed")
            return {"space_id": 123, "page_label": "p1"}
        if operation == "observe":
            if self.navigate_once:
                self.navigate_once = False
                raise EgoRemoteError("Error: Ego page is navigating")
            state = self.observe_states.pop(0) if self.observe_states else self.current
            self.current = copy.deepcopy(state)
            return {"state": copy.deepcopy(state), "semantic": self.semantic(), "screenshot": None}
        if operation == "fresh":
            state = self.fresh_states.pop(0) if self.fresh_states else self.current
            return {"state": copy.deepcopy(state)}
        if operation == "act":
            if self.fail_act:
                raise EgoRemoteError(self.fail_act_error)
            return {"executed": payload["action"]["id"]}
        if operation == "finish":
            return None
        raise AssertionError(operation)

    def semantic(self):
        go_ref = "99" if any(action.get("node") == 30 for action in self.current.get("actions", [])) else "38"
        return f'root\n  textbox "Search" [ref=21, value=""]\n  button "Go" [ref={go_ref}]\n'

    def close(self):
        self.closed += 1


def backend(**kwargs):
    fake = FakeTransport(**kwargs)
    value = EgoBrowserBackend("https://example.test/", transport=fake, task_name="ultrafast:test")
    return value, fake


def test_persistent_runtime_starts_once_and_maps_observed_refs():
    value, fake = backend()
    try:
        first = value.observe()
        second = value.observe()
        assert fake.started == 1
        assert [item[0] for item in fake.requests].count("init") == 1
        assert first["generation"] == 1 and second["generation"] == 2
        assert first["actions"][0]["ref"] == "@21"
        assert first["actions"][1]["ref"] == "@38"
    finally:
        value.close()


def test_observe_retries_only_a_navigation_transient():
    value, fake = backend(navigate_once=True)
    try:
        page = value.observe()
        assert page["generation"] == 1
        assert [item[0] for item in fake.requests].count("observe") == 2
    finally:
        value.close()


def test_fill_followup_observe_rebuilds_target_and_invalidates_old_generation(monkeypatch):
    value, fake = backend()
    try:
        sleeps = []
        monkeypatch.setattr("jev_ultrafast.backends.ego.time.sleep", sleeps.append)
        page = value.observe()
        fill = page["actions"][0]
        value.act(fill, page, "Ada")

        before = copy.deepcopy(fake.current)
        after = copy.deepcopy(fake.current)
        after["actions"][1]["node"] = 30
        after["guards"].pop("20")
        after["guards"]["30"] = [30, "button", "Go"]
        fake.observe_states = [before, after, after]

        settled = value.observe()
        assert sleeps == [0.5, 0.2, 0.2]
        assert settled["generation"] == 2
        assert settled["guards"]["30"] == [30, "button", "Go"]
        assert page["actions"][1]["ref"] == "@38"
        assert settled["actions"][1]["ref"] == "@99"
        with pytest.raises(StalePage):
            value.act(fill, page, "again")

        click = next(action for action in settled["actions"] if action.get("node") == 30)
        value.act(click, settled)
        assert [operation for operation, _payload in fake.requests].count("act") == 2
    finally:
        value.close()


def test_post_mutation_disconnected_error_is_not_recast_as_stale():
    value, fake = backend(
        fail_act=True,
        fail_act_error="Error: page.fill could not verify the result: element is not connected",
    )
    try:
        page = value.observe()
        with pytest.raises(EgoRemoteError, match="element is not connected"):
            value.act(page["actions"][0], page, "hello")
        assert [operation for operation, _payload in fake.requests].count("act") == 1
    finally:
        value.close()


def test_old_observation_generation_is_stale():
    value, _fake = backend()
    try:
        first = value.observe()
        value.observe()
        assert value.fresh(first) is False
        with pytest.raises(StalePage):
            value.act(first["actions"][0], first, "hello")
    finally:
        value.close()


def test_click_freshness_ignores_unrelated_dynamic_body_text(monkeypatch):
    value, fake = backend()
    try:
        monkeypatch.setattr("jev_ultrafast.backends.ego.time.sleep", lambda _seconds: None)
        page = value.observe()
        fake.current["text"] = "Search result rotated while the target stayed put"
        fake.current["page_key"] = ["key", [[999, "late control"]]]
        assert value.fresh(page, page["actions"][1]) is True
        assert value.fresh(page) is False
        fake.current["guards"]["20"] = [999, "button", "Replaced target"]
        assert value.fresh(page, page["actions"][1]) is False
        with pytest.raises(StalePage):
            value.act(page["actions"][1], page)
        assert [operation for operation, _payload in fake.requests].count("act") == 0
    finally:
        value.close()


def test_click_freshness_settles_transient_missing_guard_without_mutation(monkeypatch):
    value, fake = backend()
    try:
        sleeps = []
        monkeypatch.setattr("jev_ultrafast.backends.ego.time.sleep", sleeps.append)
        page = value.observe()
        transient = copy.deepcopy(fake.current)
        transient["guards"]["20"] = None
        changed = copy.deepcopy(fake.current)
        changed["guards"]["20"] = [20, "button", "Interim target"]
        fake.fresh_states = [transient, changed, copy.deepcopy(fake.current)]
        assert value.fresh(page, page["actions"][1]) is True
        value.act(page["actions"][1], page)
        fresh_payloads = [payload for operation, payload in fake.requests if operation == "fresh"]
        assert fresh_payloads == [{}, {}, {}, {}]
        assert sleeps == [0.1, 0.2]
        assert sum(sleeps) < 1.0
        assert [operation for operation, _payload in fake.requests].count("act") == 1
    finally:
        value.close()


def test_click_freshness_returns_stale_after_bounded_missing_guard_settle(monkeypatch):
    value, fake = backend()
    try:
        sleeps = []
        monkeypatch.setattr("jev_ultrafast.backends.ego.time.sleep", sleeps.append)
        page = value.observe()
        transient = copy.deepcopy(fake.current)
        transient["guards"]["20"] = None
        fake.fresh_states = [transient] * 5
        assert value.fresh(page, page["actions"][1]) is False
        fresh_payloads = [payload for operation, payload in fake.requests if operation == "fresh"]
        assert len(fresh_payloads) == 5
        assert sleeps == [0.1, 0.2, 0.3, 0.3]
        assert sum(sleeps) < 1.0
        assert [operation for operation, _payload in fake.requests].count("act") == 0
    finally:
        value.close()


def test_unknown_ref_becomes_stale_and_does_not_retry_mutation():
    value, fake = backend(fail_act=True)
    try:
        page = value.observe()
        with pytest.raises(StalePage, match="unknown ref"):
            value.act(page["actions"][0], page, "hello")
        assert [item[0] for item in fake.requests].count("act") == 1
    finally:
        value.close()


def test_timings_and_cleanup_are_exposed_and_close_is_idempotent():
    value, fake = backend()
    page = value.observe()
    assert value.fresh(page) is True
    value.act(page["actions"][1], page)
    value.close()
    value.close()
    assert value.ego_timings["observe"]["count"] == 1
    assert value.ego_timings["fresh"]["count"] == 2  # explicit + act freshness guard
    assert value.ego_timings["act"]["count"] == 1
    assert value.ego_timings["ego_total_operation_ms"] >= 0
    assert value.runtime_spawn_count == fake.runtime_spawn_count
    assert fake.closed == 1
    assert value.cleanup_status["orphan_process_remaining"] is False


def test_constructor_failure_still_closes_transport():
    fake = FakeTransport(fail_init=True)
    with pytest.raises(RuntimeError, match="init failed"):
        EgoBrowserBackend("https://example.test/", transport=fake, task_name="ultrafast:failed")
    assert fake.closed == 1


def test_action_without_ego_ref_is_stale():
    value, fake = backend()
    try:
        page = value.observe()
        action = page["actions"][0]
        action.pop("ref")
        with pytest.raises(StalePage, match="no valid ref"):
            value.act(action, page, "hello")
        assert [item[0] for item in fake.requests].count("act") == 0
    finally:
        value.close()
