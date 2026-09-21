"""Offline contracts for focus changes during text input. No model calls."""

from unittest.mock import Mock

import pytest

from jev_ultrafast import browser


@pytest.mark.parametrize("focused", [False, None, "exception"])
@pytest.mark.parametrize("after_select_all", [False, True])
def test_focus_loss_stops_text_input_without_retry(monkeypatch, focused, after_select_all):
    result = {"result": {"value": focused}}
    if focused == "exception":
        result = {"exceptionDetails": {"text": "Execution context destroyed"}}
    evaluations = iter([
        {"result": {"value": {"x": 40, "y": 40}}},
        *([{"result": {"value": True}}] if after_select_all else []),
        result,
    ])

    def cdp(method, **_params):
        return next(evaluations) if method == "Runtime.evaluate" else {}

    calls = Mock(side_effect=cdp)
    monkeypatch.setattr(browser, "cdp", calls)
    instance = browser.Browser.__new__(browser.Browser)
    instance.session = "test"
    instance.fresh = Mock(return_value=True)

    with pytest.raises(RuntimeError, match="Text target"):
        instance.act({"id": "e1", "kind": "fill", "node": 1}, {}, text="replacement")

    methods = [call.args[0] for call in calls.call_args_list]
    assert methods.count("Input.dispatchMouseEvent") == 2
    assert methods.count("Input.dispatchKeyEvent") == (2 if after_select_all else 0)
    assert "Input.insertText" not in methods


def test_click_does_not_require_keyboard_focus(monkeypatch):
    cdp = Mock(return_value={"result": {"value": {"x": 40, "y": 40}}})
    monkeypatch.setattr(browser, "cdp", cdp)

    result = browser.browser_operation({
        "operation": "act", "session": "test", "action": {"id": "e1", "kind": "click", "node": 1},
    })

    assert result == {"executed": "e1"}
    assert [call.args[0] for call in cdp.call_args_list] == [
        "Runtime.evaluate", "Input.dispatchMouseEvent", "Input.dispatchMouseEvent",
    ]


def test_focused_fill_inserts_the_requested_text_once(monkeypatch):
    evaluations = iter([{"x": 40, "y": 40}, True, True])

    def cdp(method, **_params):
        return {"result": {"value": next(evaluations)}} if method == "Runtime.evaluate" else {}

    calls = Mock(side_effect=cdp)
    monkeypatch.setattr(browser, "cdp", calls)
    result = browser.browser_operation({
        "operation": "act", "session": "test", "action": {"id": "e1", "kind": "fill", "node": 1},
        "text": "replacement",
    })

    assert result == {"executed": "e1"}
    assert [call.args[0] for call in calls.call_args_list] == [
        "Runtime.evaluate", "Input.dispatchMouseEvent", "Input.dispatchMouseEvent",
        "Runtime.evaluate", "Input.dispatchKeyEvent", "Input.dispatchKeyEvent",
        "Runtime.evaluate", "Input.insertText",
    ]
    assert [call.kwargs["type"] for call in calls.call_args_list if call.args[0] == "Input.dispatchKeyEvent"] == [
        "keyDown", "keyUp",
    ]
    key_down = next(call for call in calls.call_args_list if call.kwargs.get("type") == "keyDown")
    assert key_down.kwargs["commands"] == ["selectAll"]
    assert calls.call_args.kwargs == {"session_id": "test", "text": "replacement"}
