"""Offline contracts for Ego's indexed-state adapter, freshness probe, and lifecycle."""

from __future__ import annotations

import copy

import pytest

from jev_ultrafast.backends.ego import (
    EgoActionError,
    EgoBrowserBackend,
    EgoProcessExited,
    EgoRemoteError,
    EgoTransportError,
    classify_ego_error,
)
from jev_ultrafast.browser import StalePage

EPOCH = "epoch-1"


def _guard(node, role, label, *extra):
    """A READ_STATE guard: code-owned identity followed by nearby scope text."""
    return [node, role, label, *extra]


def _state(text="Search"):
    return {
        "url": "https://example.test/",
        "title": "Search",
        "text": text,
        "epoch": EPOCH,
        "scroll": {"y": 0, "height": 780},
        "actions": [
            {"id": "e1", "kind": "fill", "label": "Search", "role": "textbox", "value": "", "node": 10},
            {"id": "e2", "kind": "click", "label": "Go", "role": "button", "value": "", "node": 20},
            {"id": "wait", "kind": "wait", "label": "Wait", "node": None},
        ],
        "guards": {
            "10": _guard(10, "textbox", "Search", "scope text before"),
            "20": _guard(20, "button", "Go", "scope text before"),
        },
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
        self.probe_states = []
        self.observe_states = []
        self.cleanup_status = {
            "graceful_exit": True,
            "forced_terminate": False,
            "forced_kill": False,
            "orphan_process_remaining": False,
        }
        self.current = _state()
        self.fresh_error: BaseException | None = None
        self.act_error: BaseException | None = None
        self.probe_overrides: dict[str, dict] = {}

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
            if self.fresh_error is not None:
                raise self.fresh_error
            state = self.probe_states.pop(0) if self.probe_states else self.current
            return {"probe": self.probe(state, payload.get("nodes") or [], self.probe_overrides)}
        if operation == "act":
            if self.act_error is not None:
                raise self.act_error
            if self.fail_act:
                raise EgoRemoteError(self.fail_act_error)
            return {"executed": payload["action"]["id"]}
        if operation == "finish":
            return None
        raise AssertionError(operation)

    @staticmethod
    def probe(state, nodes, overrides=None):
        """Mirror the shape of the in-page freshness probe for the fake page."""
        found = {}
        for node in nodes:
            guard = state.get("guards", {}).get(str(node))
            # READ_STATE guards carry trailing scope text; the probe trims it.
            entry = None if guard is None else {"guard": guard[:-1], "actionable": True, "writable": True}
            if entry is not None and overrides:
                entry.update(overrides.get(str(node), {}))
            found[str(node)] = entry
        return {"identity": {"epoch": state.get("epoch"), "url": state.get("url"), "ready": "complete"}, "nodes": found}

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
        assert first["epoch"] == EPOCH
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


def test_fill_followup_observe_settles_on_a_stable_action_set(monkeypatch):
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
        after["guards"]["30"] = _guard(30, "button", "Go", "scope text after")
        fake.observe_states = [before, after, after, after]

        settled = value.observe()
        # 200 ms probe delay, then polls until three consecutive reads agree.
        assert sleeps == [0.2, 0.2, 0.2, 0.2]
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


def test_fresh_ignores_unrelated_text_scroll_and_toolbar_churn(monkeypatch):
    """The whole-page fingerprint is not the freshness contract any more."""
    value, fake = backend()
    try:
        monkeypatch.setattr("jev_ultrafast.backends.ego.time.sleep", lambda _seconds: None)
        page = value.observe()
        fake.current["text"] = "Search result rotated while the target stayed put"
        fake.current["page_key"] = ["key", [[999, "late control"]]]
        fake.current["scroll"] = {"y": 640, "height": 780}
        fake.current["actions"].append({"id": "e9", "kind": "click", "label": "Late", "node": 40})
        fake.current["guards"]["40"] = _guard(40, "button", "Late")
        assert value.fresh(page, page["actions"][1]) is True
        assert value.fresh(page) is True
        assert value.fresh(page, page["actions"][0]) is True
    finally:
        value.close()


def test_fresh_ignores_container_text_next_to_the_target(monkeypatch):
    value, fake = backend()
    try:
        monkeypatch.setattr("jev_ultrafast.backends.ego.time.sleep", lambda _seconds: None)
        page = value.observe()
        # Only the trailing scope text of the observed target changes.
        fake.current["guards"]["20"] = _guard(20, "button", "Go", "autocomplete suggestions appeared")
        assert value.fresh(page, page["actions"][1]) is True
        value.act(page["actions"][1], page)
        assert [operation for operation, _payload in fake.requests].count("act") == 1
    finally:
        value.close()


def test_fresh_requires_the_same_document(monkeypatch):
    value, fake = backend()
    try:
        monkeypatch.setattr("jev_ultrafast.backends.ego.time.sleep", lambda _seconds: None)
        page = value.observe()
        fake.current["epoch"] = "epoch-2"
        assert value.fresh(page, page["actions"][1]) is False
        fake.current["epoch"] = EPOCH
        fake.current["url"] = "https://example.test/next"
        assert value.fresh(page, page["actions"][1]) is False
    finally:
        value.close()


def test_fresh_rejects_a_replaced_target_without_acting(monkeypatch):
    value, fake = backend()
    try:
        sleeps = []
        monkeypatch.setattr("jev_ultrafast.backends.ego.time.sleep", sleeps.append)
        page = value.observe()
        fake.current["guards"]["20"] = _guard(20, "button", "Different")
        assert value.fresh(page, page["actions"][1]) is False
        assert sleeps == [0.1, 0.2, 0.3]
        with pytest.raises(StalePage):
            value.act(page["actions"][1], page)
        assert [operation for operation, _payload in fake.requests].count("act") == 0
    finally:
        value.close()


def test_fresh_recovers_from_a_transient_detach(monkeypatch):
    value, fake = backend()
    try:
        sleeps = []
        monkeypatch.setattr("jev_ultrafast.backends.ego.time.sleep", sleeps.append)
        page = value.observe()
        detached = copy.deepcopy(fake.current)
        detached["guards"]["20"] = None
        fake.probe_states = [detached]
        assert value.fresh(page, page["actions"][1]) is True
        assert sleeps == [0.1]
        value.act(page["actions"][1], page)
        assert [operation for operation, _payload in fake.requests].count("act") == 1
    finally:
        value.close()


def test_fresh_rejects_a_covered_or_disabled_target(monkeypatch):
    value, fake = backend()
    try:
        monkeypatch.setattr("jev_ultrafast.backends.ego.time.sleep", lambda _seconds: None)
        page = value.observe()
        fake.probe_overrides = {"20": {"actionable": False}}
        assert value.fresh(page, page["actions"][1]) is False
        fake.probe_overrides = {"20": {"actionable": True}}
        assert value.fresh(page, page["actions"][1]) is True
    finally:
        value.close()


def test_fill_freshness_requires_a_writable_target(monkeypatch):
    value, fake = backend()
    try:
        monkeypatch.setattr("jev_ultrafast.backends.ego.time.sleep", lambda _seconds: None)
        page = value.observe()
        fake.probe_overrides = {"10": {"writable": False}}
        assert value.fresh(page, page["actions"][0]) is False
        assert value.fresh(page, page["actions"][1]) is True
    finally:
        value.close()


def test_probe_failure_is_stale_and_never_mutates():
    value, fake = backend()
    try:
        page = value.observe()
        fake.fresh_error = EgoRemoteError("Unknown ref: 9999; take a new snapshot", "ElementResolutionError")
        with pytest.raises(StalePage):
            value.fresh(page, page["actions"][1])
        with pytest.raises(StalePage):
            value.act(page["actions"][1], page)
        assert [operation for operation, _payload in fake.requests].count("act") == 0
    finally:
        value.close()


def test_runtime_exit_during_probe_is_a_transport_error_not_stale():
    value, fake = backend()
    try:
        page = value.observe()
        fake.fresh_error = EgoProcessExited("Ego runtime exited with code 1")
        with pytest.raises(EgoTransportError) as raised:
            value.fresh(page, page["actions"][1])
        assert not isinstance(raised.value, StalePage)
        with pytest.raises(EgoTransportError):
            value.act(page["actions"][1], page)
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


def test_act_action_failure_is_reported_and_never_recast_as_stale():
    value, fake = backend()
    try:
        page = value.observe()
        fake.act_error = EgoRemoteError(
            "Error: page.fill failed: element is not an input, textarea, or contenteditable element"
        )
        with pytest.raises(EgoActionError):
            value.act(page["actions"][0], page, "hello")
        assert [item[0] for item in fake.requests].count("act") == 1
    finally:
        value.close()


def test_act_detached_target_is_stale_but_other_post_input_failures_are_not():
    value, fake = backend()
    try:
        page = value.observe()
        fake.act_error = EgoRemoteError("Error: page.fill could not verify the result: element is not connected")
        with pytest.raises(StalePage, match="not connected"):
            value.act(page["actions"][0], page, "hello")
        assert [item[0] for item in fake.requests].count("act") == 1
        fake.act_error = EgoRemoteError("Error: page.click timed out after 3000ms: element intercepts pointer events")
        with pytest.raises(EgoActionError):
            value.act(page["actions"][1], page)
        assert [item[0] for item in fake.requests].count("act") == 2
    finally:
        value.close()


def test_runtime_exit_during_act_is_not_recast_as_stale():
    value, fake = backend()
    try:
        page = value.observe()
        fake.act_error = EgoProcessExited("Ego runtime exited with code 1")
        with pytest.raises(EgoTransportError) as raised:
            value.act(page["actions"][0], page, "hello")
        assert not isinstance(raised.value, StalePage)
        assert [item[0] for item in fake.requests].count("act") == 1
    finally:
        value.close()


def test_classify_ego_error_covers_the_proven_live_messages():
    assert isinstance(
        classify_ego_error(EgoRemoteError("Unknown ref: 9999; take a new snapshot"), phase="act"), StalePage
    )
    assert isinstance(
        classify_ego_error(EgoRemoteError("page.is navigating"), phase="probe"), StalePage
    )
    assert isinstance(
        classify_ego_error(EgoRemoteError("Error: Ego page is navigating"), phase="probe"), StalePage
    )
    assert isinstance(
        classify_ego_error(EgoRemoteError("could not verify", "Error"), phase="act"), EgoActionError
    )
    assert isinstance(classify_ego_error(EgoProcessExited("exited"), phase="act"), EgoTransportError)
    assert not isinstance(classify_ego_error(EgoProcessExited("exited"), phase="act"), StalePage)
    assert isinstance(classify_ego_error(RuntimeError("boom"), phase="act"), EgoTransportError)


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


def test_missing_ref_is_reported_as_stale_without_a_probe():
    value, fake = backend()
    try:
        page = value.observe()
        action = dict(page["actions"][1])
        action["ref"] = None
        assert value.fresh(page, action) is False
        assert [operation for operation, _payload in fake.requests].count("fresh") == 0
    finally:
        value.close()


def test_explicit_aria_roles_and_labels_keep_targets_addressable():
    value, fake = backend()
    try:
        page = value.observe()
        fake.current["actions"] = [
            {"id": "e1", "kind": "fill", "label": "Search Wikipedia", "role": "combobox", "value": "", "node": 50},
            {"id": "e2", "kind": "click", "label": "Go typing", "role": "option", "value": "0", "node": 60},
        ]
        fake.current["guards"] = {
            "50": _guard(50, "combobox", "Search Wikipedia"),
            "60": _guard(60, "option", "Go typing"),
        }
        fake.semantic_text = (
            'root\n  comboboxgrouping "Search Wikipedia" [ref=92]\n'
            '  anchor [ref=94, loc=href:/go]\n    text "Go typing"\n'
        )
        fake.semantic = lambda: fake.semantic_text
        mapped = value.observe()
        assert mapped["actions"][0]["ref"] == "@92"
        assert mapped["actions"][1]["ref"] == "@94"
        assert page["actions"][0]["ref"] == "@21"
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


def test_timeline_records_ref_and_stale_lifecycle():
    value, fake = backend()
    events = []

    class Recorder:
        def record(self, event, **fields):
            events.append((event, fields))

    value.attach_timeline(Recorder())
    try:
        page = value.observe()
        value.act(page["actions"][1], page)
        fake.current["epoch"] = "epoch-2"
        with pytest.raises(StalePage):
            value.act(page["actions"][1], page)
    finally:
        value.close()
    observed = [fields for event, fields in events if event == "observe"]
    assert observed and observed[0]["generation"] == 1 and observed[0]["actions"] == 3
    acted = [fields for event, fields in events if event == "act" and fields["result"] == "success"]
    assert acted[0]["ref"] == "@38" and acted[0]["index"] == "e2" and acted[0]["operation"] == "click"
    stale = [fields for event, fields in events if event == "stale"]
    assert stale and stale[-1]["source"] == "act" and stale[-1]["reason"] == "fresh_check_failed"
    assert stale[-1]["index"] == "e2" and stale[-1]["ref"] == "@38"


def test_constructor_failure_still_closes_transport():
    fake = FakeTransport(fail_init=True)
    with pytest.raises(RuntimeError, match="init failed"):
        EgoBrowserBackend("https://example.test/", transport=fake, task_name="ultrafast:failed")
    assert fake.closed == 1