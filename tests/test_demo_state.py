"""The demo sends a trimmed copy of the Agent state to the browser."""

import json

import pytest

from jev_ultrafast import demo
from jev_ultrafast.usage import usage_summary


class _StubAgent:
    phase_names = ["trading", "recent_trades"]

    def __init__(self):
        self.decisions = [
            {
                "operation": "CLICK",
                "choice": f"e{i}",
                "probabilities": {f"e{i}": 0.9},
                "request": {"blob": "x" * 50_000},
                "raw_answers": {"a": "y" * 1000},
                "usage": {"input_tokens": 5000 + i, "output_tokens": 400},
                "latency_ms": 300,
                "label": f"button {i}",
                "phase": "trading",
                "step": i,
                "alternatives": [["WAIT", 0.05], ["SCROLL_DOWN", 0.02]],
                "probability": 0.9,
                "target_probability": 0.8,
                "target": f"e{i}",
                "target_probabilities": {},
                "operation_probabilities": {},
            }
            for i in range(40)
        ]
        self.state = {"plan": ["full goal text " * 40, "full goal text " * 40]}
        # One persistent page object, handed back on every `snapshot()`: `response_state` must copy it, never write
        # the overlay's `node_indices` onto the agent's own page (it is page-only and never part of Jev's state).
        self.page = {
            "url": "u",
            "screenshot": "A" * 60_000,
            # Three same-name buttons: `model.action_space` keeps the first two and skips the third, so the element
            # indices (1, 2, then 3 for the select) are not the raw positions in `actions`. `node_indices` carries
            # them to the page's overlay.
            "actions": [
                {"kind": "click", "id": "a", "node": 11, "label": "Min", "role": "button",
                 "rect": {"x": 1, "y": 2, "w": 3, "h": 4}},
                {"kind": "click", "id": "b", "node": 12, "label": "Min", "role": "button",
                 "rect": {"x": 1, "y": 2, "w": 3, "h": 4}},
                {"kind": "click", "id": "c", "node": 13, "label": "Min", "role": "button",
                 "rect": {"x": 1, "y": 2, "w": 3, "h": 4}},
                {"kind": "select", "id": "s", "node": 14, "label": "Rune → Ist", "role": "combobox",
                 "value": "Ist", "current_value": "Ist", "rect": {"x": 1, "y": 2, "w": 3, "h": 4}},
            ],
        }

    def snapshot(self):
        return {"page": self.page, "status": "ready", "history": [], "decision": None, "decisions": self.decisions}


def stub_demo(monkeypatch, run=None) -> _StubAgent:
    """Install a stub Agent and a RUN (an empty market by default), the pair every `response_state` test needs."""
    stub = _StubAgent()
    monkeypatch.setattr(demo, "AGENT", stub)
    monkeypatch.setattr(demo, "RUN", {"item_name": "Shako", "market": {}} if run is None else run)
    return stub


def test_response_state_stays_small_and_keeps_what_the_panels_need(monkeypatch):
    market = {
        "trading": {"status": "PASSED", "rows": [], "text": "page text " * 1000},
        "recent_trades": {"status": "NOT_RUN", "rows": [], "text": ""},
        "verification": None,
    }
    stub = stub_demo(monkeypatch, {"item_name": "Shako", "market": market, "report_md": "r" * 50_000})

    state = demo.response_state()

    assert len(json.dumps(state)) < 200_000
    assert "screenshot" not in state["page"]
    assert state["page"]["screenshot_id"]
    assert "report_md" not in state
    assert state["report_ready"] is True
    assert stub.snapshot()["page"]["screenshot"]  # the Agent page is not changed
    assert "request" in state["decisions"][-1]
    assert "request" not in state["decisions"][0]
    assert "raw_answers" not in state["decisions"][-1]
    assert state["market"]["trading"]["text_length"] == len(market["trading"]["text"])
    assert "text" not in state["market"]["trading"]
    assert "text" in market["trading"]  # the stored run is not changed
    assert "request" in stub.decisions[0]  # the Agent state is not changed


def test_response_state_gives_the_overlay_each_node_s_element_index(monkeypatch):
    """The overlay's numbers must be the choice list's element indices, not raw positions in `actions`."""
    stub = stub_demo(monkeypatch)

    state = demo.response_state()

    # Node 13 is the third "Min" button: `action_space` skipped it, so it has no element index and no overlay box.
    # The select's node maps to its element index (3), without the `:option` suffix.
    assert state["page"]["node_indices"] == {11: "1", 12: "2", 14: "3"}
    # Page-only: the mapping is for the overlay, so it is never written back onto the agent's own page (and so never
    # reaches Jev, whose state holds only what it decides on).
    assert "node_indices" not in stub.page


def test_response_state_reports_usage_and_decision_labels_for_every_decision(monkeypatch):
    stub = stub_demo(monkeypatch)

    state = demo.response_state()

    assert state["usage"] == usage_summary(stub.decisions, [])
    assert state["usage"]["calls"] == 40
    assert state["usage"]["input_tokens"] == sum(5000 + i for i in range(40))
    for trimmed in state["decisions"]:
        assert trimmed["usage"]["input_tokens"] >= 5000
        assert trimmed["label"].startswith("button ")
        assert trimmed["alternatives"][0][0] == "WAIT"
        assert trimmed["probability"] == 0.9 and trimmed["target_probability"] == 0.8
    assert state["phase_labels"] == ["階段 1：目前掛單", "階段 2：近期成交"]


def test_response_state_without_a_run_has_no_usage_and_no_phase_labels(monkeypatch):
    monkeypatch.setattr(demo, "AGENT", None)
    monkeypatch.setattr(demo, "RUN", {})
    state = demo.response_state()
    assert state["usage"] is None
    assert state["phase_labels"] == []


@pytest.mark.parametrize("bad", [-1, 6, "2"])
def test_reset_rejects_a_bad_load_more_count_before_opening_anything(monkeypatch, bad):
    monkeypatch.setattr(demo, "Agent", lambda *a, **k: pytest.fail("a browser must not be opened"))
    monkeypatch.setattr(demo, "close_browser", lambda: pytest.fail("the running browser must not be closed"))
    with pytest.raises(ValueError, match="載入更多次數"):
        demo.command("reset", {"goal": "Shako", "load_more": bad})
