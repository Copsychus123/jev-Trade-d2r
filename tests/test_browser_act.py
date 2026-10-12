"""Offline contracts for the act/observe branches of `browser_operation` that no other test executes.

Every case drives the code through a fake `cdp` (the same `Mock` pattern as `tests/test_agent.py`) so no Chrome,
no socket and no timer is involved; the injected responses decide exactly what the page script "returned".
"""

import hashlib
import json
from copy import deepcopy
from unittest.mock import Mock

import pytest

import jev_ultrafast.browser as browser
from jev_ultrafast.browser import browser_operation


def observed():
    """The plain `READ_STATE` payload the page script returns, before `browser_operation` hashes it."""
    state = {
        "url": "https://example.test/",
        "title": "Search",
        "text": "Search",
        "scroll": {"y": 0},
        "actions": [
            {"id": "e1", "kind": "click", "label": "Go", "role": "button", "value": "", "node": 20},
        ],
    }
    return state


SELECT_ACTION = {"id": "e1", "kind": "select", "node": 20, "value": "Design"}


def test_a_scroll_wheels_at_the_fixed_point_and_never_resolves_a_target_or_presses(monkeypatch):
    """`kind == "scroll"` is the keyless branch: one wheel event at the fixed (550, 650) and nothing else."""
    cdp = Mock(return_value={})
    monkeypatch.setattr(browser, "cdp", cdp)

    result = browser_operation(
        {"operation": "act", "session": "s", "action": {"id": "scroll_down", "kind": "scroll", "delta": 560}}
    )

    assert result == {"executed": "scroll_down"}
    assert cdp.call_count == 1
    (wheel,) = cdp.call_args_list
    assert wheel.args[0] == "Input.dispatchMouseEvent"
    assert wheel.kwargs["type"] == "mouseWheel"
    assert (wheel.kwargs["x"], wheel.kwargs["y"]) == (550, 650)
    assert wheel.kwargs["deltaX"] == 0
    assert wheel.kwargs["deltaY"] == 560
    # No route through `resolve_target` and no press/release: a scroll has no element.
    assert [c.args[0] for c in cdp.call_args_list] == ["Input.dispatchMouseEvent"]
    assert [c.kwargs["type"] for c in cdp.call_args_list] == ["mouseWheel"]


def test_a_select_is_performed_by_the_page_script_with_no_mouse_events(monkeypatch):
    """`kind == "select"` resolves the target, hands the chosen value to the page script and dispatches no input."""
    action = {"id": "e1", "kind": "select", "node": 20, "value": "Design"}
    cdp = Mock(return_value={"result": {"value": {"x": 12, "y": 34}}})
    monkeypatch.setattr(browser, "cdp", cdp)

    result = browser_operation({"operation": "act", "session": "s", "action": action})

    assert result == {"executed": "e1"}
    assert cdp.call_count == 1
    (resolve,) = cdp.call_args_list
    assert resolve.args[0] == "Runtime.evaluate"
    # The value the caller chose is echoed into the page script's own call; the script (not CDP input) does the work.
    expected = f'{browser.RESOLVE_TARGET}({{"id": "e1", "kind": "select", "node": 20, "value": "Design"}})'
    assert resolve.kwargs["expression"] == expected
    assert resolve.kwargs["returnByValue"] is True
    assert [c.args[0] for c in cdp.call_args_list] == ["Runtime.evaluate"]


def test_an_interrupted_select_reports_the_exact_message(monkeypatch):
    """A select whose evaluation died (e.g. the change event navigated) must not look like a retryable stale page."""
    cdp = Mock(return_value={"exceptionDetails": {"text": "Execution context destroyed"}})
    monkeypatch.setattr(browser, "cdp", cdp)

    with pytest.raises(RuntimeError, match=r"^Dropdown execution was interrupted; inspect before retrying\.$"):
        browser_operation({"operation": "act", "session": "s", "action": SELECT_ACTION})

    assert cdp.call_count == 1


def test_a_select_the_page_never_confirmed_reports_the_exact_message(monkeypatch):
    """"The page script could not select it" is a distinct message from the interrupted case, and needs one call."""
    cdp = Mock(return_value={"result": {"value": None}})
    monkeypatch.setattr(browser, "cdp", cdp)

    with pytest.raises(RuntimeError, match=r"^Dropdown execution was not confirmed; inspect before retrying\.$"):
        browser_operation({"operation": "act", "session": "s", "action": SELECT_ACTION})

    assert cdp.call_count == 1


def test_a_click_presses_then_releases_once_with_the_left_button(monkeypatch):
    """A click is exactly `mousePressed` then `mouseReleased`, both at the resolved point, left button, one click."""
    cdp = Mock(side_effect=[{"result": {"value": {"x": 120, "y": 340}}}, {}, {}])
    monkeypatch.setattr(browser, "cdp", cdp)

    result = browser_operation(
        {"operation": "act", "session": "s", "action": {"id": "e3", "kind": "click", "node": 20}}
    )

    assert result == {"executed": "e3"}
    assert [c.args[0] for c in cdp.call_args_list] == [
        "Runtime.evaluate",
        "Input.dispatchMouseEvent",
        "Input.dispatchMouseEvent",
    ]
    events = cdp.call_args_list[1:]
    assert [c.kwargs["type"] for c in events] == ["mousePressed", "mouseReleased"]
    assert [(c.kwargs["x"], c.kwargs["y"]) for c in events] == [(120, 340), (120, 340)]
    assert [c.kwargs["button"] for c in events] == ["left", "left"]
    assert [c.kwargs["clickCount"] for c in events] == [1, 1]


def test_the_observation_fingerprint_is_a_hash_of_url_text_actions_and_scroll(monkeypatch):
    """Two byte-identical observations hash the same; changing the visible text changes it."""
    first_state = observed()
    changed = deepcopy(first_state)
    changed["text"] = "No results"
    cdp = Mock(side_effect=[
        {"result": {"value": deepcopy(first_state)}},
        {"result": {"value": deepcopy(first_state)}},
        {"result": {"value": changed}},
    ])
    monkeypatch.setattr(browser, "cdp", cdp)

    first = browser_operation({"operation": "observe", "session": "s", "screenshot": False})
    second = browser_operation({"operation": "observe", "session": "s", "screenshot": False})
    third = browser_operation({"operation": "observe", "session": "s", "screenshot": False})

    content = {k: first_state[k] for k in ("url", "text", "actions", "scroll")}
    expected = hashlib.sha256(json.dumps(content, sort_keys=True).encode()).hexdigest()
    assert first["fingerprint"] == expected
    assert len(first["fingerprint"]) == 64
    assert second["fingerprint"] == first["fingerprint"]
    assert third["fingerprint"] != first["fingerprint"]


def test_a_screenshot_key_is_present_only_when_the_page_asked_for_one(monkeypatch):
    """`screenshot` is added for a real capture only when requested (it is `True` by default)."""
    state = observed()
    cdp = Mock(side_effect=[
        {"result": {"value": deepcopy(state)}},
        {"result": {"value": deepcopy(state)}},
        {"data": "AAAA"},
    ])
    monkeypatch.setattr(browser, "cdp", cdp)

    without = browser_operation({"operation": "observe", "session": "s", "screenshot": False})
    assert "screenshot" not in without
    assert [c.args[0] for c in cdp.call_args_list] == ["Runtime.evaluate"]

    with_shot = browser_operation({"operation": "observe", "session": "s", "screenshot": True})
    assert with_shot["screenshot"] == "AAAA"
    shot = cdp.call_args_list[2]
    assert shot.args[0] == "Page.captureScreenshot"
    assert shot.kwargs["format"] == "jpeg"
    assert shot.kwargs["quality"] == 60
    assert shot.kwargs["optimizeForSpeed"] is True


def test_a_screenshot_is_taken_by_default_when_the_request_omits_the_flag(monkeypatch):
    """An observe request that does not mention `screenshot` still captures one (`request.get("screenshot", True)`)."""
    cdp = Mock(side_effect=[
        {"result": {"value": observed()}},
        {"data": "BBBB"},
    ])
    monkeypatch.setattr(browser, "cdp", cdp)

    info = browser_operation({"operation": "observe", "session": "s"})

    assert info["screenshot"] == "BBBB"
    assert [c.args[0] for c in cdp.call_args_list] == ["Runtime.evaluate", "Page.captureScreenshot"]
