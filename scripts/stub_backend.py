"""The zero-Jev backend behind `extension_e2e.py --stub-chooser`: the stub chooser and its routes.

`STUB_SERVER` is the launch string `extension_e2e.start_backend(stub=True)` feeds to `python -c`, and
`serve_stub_backend` serves services/jevsvc's own routes with a chooser injected behind /api/choose. The HTTP handler
is `services/dev_server.make_server`, so the request pipeline is built in one place; nothing under services/** is
touched, and the paid API is unreachable from here on purpose.
"""

import os
import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services"))
sys.path.insert(0, str(ROOT / "src"))

from dev_server import HOST, PORT, ensure_run_secret, make_server  # noqa: E402
from jev_ultrafast.traderie.site import product_section  # noqa: E402
from jevsvc import invites  # noqa: E402
from jevsvc.app import ROUTES, choose_step  # noqa: E402
from jevsvc.store import MemoryStore  # noqa: E402

STUB_SERVER = "import stub_backend; stub_backend.serve_stub_backend()"
# The stub has to know which phase it is answering for, and the only phase signal a chooser is handed is the goal:
# services/jevsvc/app.py builds it per phase from traderie.site.phase_plan, which ends with "Current phase: Phase A
# (Trading) only…" or "Phase B (Recent Trades)…". The letter -> view name map is the repo's own phase order.
PHASE_IN_GOAL = re.compile(r"Current phase: Phase ([AB])")
PHASE_BY_LETTER = {"A": "trading", "B": "recent_trades"}
# site.build_goal writes the two phases differently depending on the requested batches: with them the goal says the
# program "ends the phase itself after N presses", without them it says to choose DONE as soon as the view is open.
BATCHES_IN_GOAL = re.compile(r"ends the phase itself after (\d+) presses")
RECENT_TAB = "recent trades"  # the accessible name Traderie gives the Recent Trades tab (measured: "Recent Trades")
LOAD_MORE = "load more"


def say(message: str) -> None:
    print(message, flush=True)


def stub_stamp() -> str:
    """Wall-clock time with milliseconds: a log reader counts requests per second when a run looks slow."""
    now = time.time()
    return f"{time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(now))}.{int(now % 1 * 1000):03d}"


def _label(action) -> str:
    """An action's accessible name, whitespace collapsed (the page's own text, never a hardcoded name)."""
    return re.sub(r"\s+", " ", str(action.get("label") or "")).strip()


def stub_phase(goal: str) -> str:
    """The phase the backend is asking about, read from the goal it built for that phase."""
    found = PHASE_IN_GOAL.search(goal or "")
    # Every goal this repo produces carries the line (site.phase_plan appends it), so a goal without one means the
    # backend changed and the guess is wrong: the first phase is the safe answer, and the log shows what was sent.
    return PHASE_BY_LETTER.get(found.group(1), "trading") if found else "trading"


def goal_batches(goal: str) -> int:
    """How many Load More presses the goal asks for this phase (0 when it asks for none)."""
    found = BATCHES_IN_GOAL.search(goal or "")
    return int(found.group(1)) if found else 0


def recent_tab(actions) -> dict | None:
    """The page's own Recent Trades tab: looked up by its accessible name, never by an element id (ids come from the
    order of one observation, so they are only meaningful inside that same page)."""
    clicks = [action for action in actions if action.get("kind") == "click"]
    for action in clicks:
        if _label(action).casefold() == RECENT_TAB:
            return action
    return next((action for action in clicks if RECENT_TAB in _label(action).casefold()), None)


def stub_decision(operation: str, choice: str, probabilities: dict) -> dict:
    """One chooser answer in the shape model.choose returns (tests/test_services.py stubs the same keys)."""
    return {
        "choice": choice,
        "operation": operation,
        "target": None,  # the stub answers with an element id it already picked, so there is no target head to read
        "probabilities": probabilities,
        "operation_probabilities": {operation: 1.0},
        "target_probabilities": {},
        "usage": {},
        "reasked": None,
        "model_calls": 1,
        "latency_ms": 0,
    }


class StubChooser:
    """The fixed answers that let one real query through the side panel finish without a single Jev call.

    The plan, and why each answer is given:
      * Phase A (trading) — the panel opened the item's product page itself (the table jump needs no model), so the
        Trading view is already the view phase A must end on. When the goal asks for Load More batches, the one move
        the stub makes is the same first move the real chooser makes (measured: SCROLL_BOTTOM in every recorded run
        with batches): the page's Load More button only enters the action list once the list bottom is on screen, and
        from there the extension's own phase-finish rule (site.phase_finish_rule) runs the press/scroll cycle and ends
        the phase after the requested number of presses, without asking anyone. Otherwise — and whenever the phase
        already moved once, which is the goal's own "choose DONE only after scrolling to the bottom when no Load More
        button is visible" — the answer is DONE.
      * Phase B (recent_trades) — the page is still the Trading view. The Recent Trades tab is found in the action
        list the panel sent, by its accessible name, and clicked by its id; once the address says that section is
        open (site.product_section — the same rule controller.read_view verifies the read with), the view is there:
        DONE.

    Every request is logged with a timestamp, the phase, the page and the answer, so the backend log shows the stub
    answering and holds no line about a real model.
    """

    def __init__(self, log=say) -> None:
        self.log = log
        self.requests = 0

    def __call__(self, page, goal, history, typed=None, *, timeout=None, deadline=None, allow_blocked=True):
        """choose_step's chooser signature: (page, goal, history, typed, *, timeout, deadline, allow_blocked)."""
        self.requests += 1
        phase = stub_phase(goal)
        actions = page.get("actions") or []
        answer, why = self._answer(phase, page, actions, goal, history)
        more = next((action for action in actions if LOAD_MORE in _label(action).casefold()), None)
        more_label = "none" if more is None else _label(more)
        self.log(
            f"[{stub_stamp()}] stub #{self.requests} phase={phase} url={page.get('url')} actions={len(actions)}"
            f" load_more={more_label!r} -> {answer['operation']} {answer['choice']} ({why})"
        )
        return answer

    def _answer(self, phase: str, page: dict, actions, goal: str, history) -> tuple[dict, str]:
        if phase == "recent_trades":
            if product_section(page.get("url") or "") == "recent":
                return stub_decision("DONE", "DONE", {"DONE": 1.0}), "Recent Trades view is open"
            tab = recent_tab(actions)
            if tab is not None:
                return stub_decision("CLICK", tab["id"], {tab["id"]: 1.0}), f"clicked the {_label(tab)!r} tab"
            return stub_decision("DONE", "DONE", {"DONE": 1.0}), "no Recent Trades tab on the page: DONE as it is"
        batches = goal_batches(goal)
        scrolling = any(action.get("id") == "scroll_bottom" for action in actions)
        if batches and not history and scrolling:
            return (
                stub_decision("SCROLL_BOTTOM", "scroll_bottom", {"scroll_bottom": 1.0}),
                f"goal asks for {batches} Load More presses: scrolling to the bottom so the rule can press them",
            )
        return stub_decision("DONE", "DONE", {"DONE": 1.0}), "Trading view is open; DONE"


def stub_routes(chooser=None) -> dict:
    """The backend's own routes with a chooser behind /api/choose: the only thing stub mode replaces.

    `services/jevsvc/app.py`'s choose_step takes the chooser as an argument, so the route table itself is the seam;
    every other route (run start, base picking, the store, token checks, usage accounting) is the backend's own.
    """
    stub = chooser or StubChooser()

    def choose_with_stub(body, ip, store, secret, now):
        return choose_step(body, store, secret, now, chooser=stub)

    return {**ROUTES, "/api/choose": choose_with_stub}


def serve_stub_backend() -> None:
    """Serve the backend's own routes with StubChooser behind them (what `start_backend(stub=True)` starts).

    The handler is services/dev_server.make_server (the real local backend's own builder), so the request-method
    table exists once; the only difference from `services/dev_server.py` is the routes it is handed. The paid API is
    unreachable from here on purpose — TYPESAFE_API_KEY is removed from this process, so even a route that ignored
    the chooser could not spend anything, and the log would say so.
    """
    os.environ.pop("TYPESAFE_API_KEY", None)
    ensure_run_secret()
    store = MemoryStore()
    print(f"開發用邀請碼：{invites.add(store, 'dev')}", flush=True)
    print(f"Jev backend: http://{HOST}:{PORT}（stub 選擇器：這支後端不會呼叫 Jev）", flush=True)
    make_server(store, stub_routes(StubChooser())).serve_forever()
