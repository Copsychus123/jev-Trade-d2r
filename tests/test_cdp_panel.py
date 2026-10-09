"""The shared CDP panel's state contract, offline: a panel that never declared `STATE_JS` says so.

`scripts/_cdp.py` is the Chrome scripts' common client, so nothing here opens a websocket: the panel is built with a
stand-in socket and answers a canned payload.
"""

import asyncio

import pytest

pytest.importorskip("websockets")  # scripts/_cdp.py imports it; the default lane does not install the e2e group

from scripts._cdp import Environment, Panel  # noqa: E402


class AnsweredPanel(Panel):
    """A panel that declares its state expression and answers a canned payload instead of talking to a browser."""

    STATE_JS = "state"

    def __init__(self, answer: str):
        super().__init__(ws=object())
        self.answer = answer

    async def evaluate(self, expression: str):
        assert expression == self.STATE_JS  # only the panel's own state expression is ever evaluated
        return self.answer


def test_a_panel_without_state_js_names_the_missing_declaration():
    """Without `STATE_JS`, the failure names the declaration instead of a JSON error about an empty answer."""
    with pytest.raises(Environment, match="STATE_JS"):
        asyncio.run(Panel(object()).state())


def test_a_panel_with_state_js_returns_the_parsed_state():
    panel = AnsweredPanel('{"view": "scan", "records": [], "csv": false}')
    assert asyncio.run(panel.state()) == {"view": "scan", "records": [], "csv": False}
