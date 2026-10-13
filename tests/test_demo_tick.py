"""The demo's tick runs the same controller step the CLI does.

`controller.step` exists so the controller work also runs when the tick raised (the Agent may have reached DONE or a
handoff before the error) and so leftover work from an earlier step is finished before the next tick. The demo used to
call `advance` only *after* a successful tick, so a tick that raised left the run without its verification -- and a read
that failed left the run `awaiting_handoff`, where every later tick raises 「Controller handoff required」 and the
player has to start again, with the Jev calls of the failed query spent.
"""

import pytest

from jev_ultrafast import demo


def _market():
    """The two views `verify_views` reads, with both still unread."""
    view = {"url": "", "title": "", "text": "", "status": "NOT_RUN", "reason": None}
    return {"trading": dict(view), "recent_trades": dict(view), "verification": None}


class _RaisingAgent:
    """A stand-in Agent whose tick throws, the way the step budget and a browser error do."""

    def __init__(self, seen):
        self.seen = seen
        # The two fields `advance` reads before it decides what is due.
        self.state = {"status": "blocked", "awaiting_handoff": False}

    def command(self, name, _body=None):
        # True when the controller work of this step already ran, which is what `step` guarantees.
        self.seen.append((name, demo.RUN["market"].get("verification") is not None))
        raise ValueError("tick blew up")

    def snapshot(self):
        return self.state


def test_a_tick_that_raises_still_runs_the_controller_work(monkeypatch):
    seen = []
    monkeypatch.setattr(demo, "AGENT", _RaisingAgent(seen))
    monkeypatch.setattr(demo, "RUN", {"item_name": "Shako", "market": _market()})

    with pytest.raises(ValueError, match="tick blew up"):
        demo.command("tick", {})

    # The controller work ran before the tick (leftover work is never lost) and again once the tick had raised.
    assert seen == [("tick", True)]
    assert demo.RUN["market"]["verification"] is not None
