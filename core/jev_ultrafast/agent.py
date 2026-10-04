"""The complete agent loop. Typed choices, observable state, bounded execution."""

import time
from urllib.parse import urlparse

from .browser import Browser, StalePage
from .config import MAX_STEPS
from .model import action_space, choose
from .traderie.site import TRADERIE_HOSTS, phase_plan, traderie_scope_reason


def _normalize_plan(goals):
    if isinstance(goals, str):
        items = [goals.strip()]
    else:
        items = [str(goal).strip() for goal in goals]
    return [item for item in items if item]


def _is_traderie_scope(url: str) -> bool:
    parsed = urlparse(url)
    return parsed.netloc in TRADERIE_HOSTS and parsed.path.startswith("/diablo2resurrected")




class Agent:
    def __init__(self, url, goals, *, text=None, screenshots=False, finish_phase_after=None):
        plan = _normalize_plan(goals)
        if not plan:
            raise ValueError("Supply a task")

        self.scope_guard = traderie_scope_reason if _is_traderie_scope(url) else None
        if self.scope_guard and len(plan) == 1:
            plan, self.phase_names = phase_plan(plan[0])
        else:
            self.phase_names = [f"phase_{i + 1}" for i in range(len(plan))]

        self.text = text
        self.finish_phase_after = finish_phase_after
        self.screenshots = screenshots
        # Pictures are only needed when screenshots are shown; without them the page loads faster.
        self.browser = Browser(url, images=self.screenshots)
        try:
            page = self.browser.observe(screenshot=self.screenshots)
        except Exception:
            self.browser.close()
            raise
        self.state = dict(
            browser=self.browser,
            goal=plan[0],
            page=page,
            decision=None,
            history=[],
            status="ready",
            plan=plan,
            plan_index=0,
            phase=self.phase_names[0] if self.phase_names else None,
            awaiting_handoff=False,
            phase_start=0,
            scope_blocked_reason=None,
            decisions=[],
            rule_events=[],
            elapsed_ms=0,
            started_at=None,
        )
        self._apply_scope_guard(self.state)

    def _elapsed_ms(self):
        started = self.state.get("started_at")
        return round((time.perf_counter() - started) * 1000) if started is not None else 0

    def _wait_until_ready(self, state):
        waiter = getattr(state["browser"], "wait_until_ready", None)
        if callable(waiter):
            try:
                waiter(timeout=2.0)
            except Exception:
                pass

    def _refresh_for_retry(self, state):
        self._wait_until_ready(state)
        state["page"] = state["browser"].observe(screenshot=self.screenshots)
        state["status"] = "ready"
        state["elapsed_ms"] = self._elapsed_ms()

    def _apply_scope_guard(self, state):
        if not callable(self.scope_guard):
            return None
        reason = self.scope_guard(state["page"]["url"])
        state["scope_blocked_reason"] = reason
        if reason:
            state["decision"] = None
            state["status"] = "blocked"
            state["awaiting_handoff"] = False
        return reason

    def _advance_phase(self, state, page):
        next_index = state["plan_index"] + 1
        if next_index >= len(state["plan"]):
            return False
        state["plan_index"] = next_index
        state["goal"] = state["plan"][next_index]
        state["phase"] = self.phase_names[next_index] if next_index < len(self.phase_names) else None
        state["status"] = "handoff"
        state["awaiting_handoff"] = True
        state["elapsed_ms"] = self._elapsed_ms()
        return True

    def _next_by_rule(self, state, phase_history):
        """The mechanical half of the loading cycle: after Load More comes Scroll to bottom, after Scroll to bottom
        comes Load More when it is on the page. Anything else (first step of a phase, no button visible) is Jev's."""
        rule = self.finish_phase_after
        if not rule or not phase_history:
            return None
        label = rule[0].casefold()
        last = phase_history[-1]
        actions = state["page"]["actions"]
        if last["action"].casefold() == label:
            return next((a for a in actions if a["id"] == "scroll_bottom"), None)
        if last["choice"] == "scroll_bottom":
            return next((a for a in actions if a["kind"] == "click" and a["label"].casefold() == label), None)
        return None

    def _rule_decision(self, state, action):
        step = len(state["history"]) + 1
        state["rule_events"] = [e for e in state["rule_events"] if not (e.get("press") and e["step"] >= step)]
        state["rule_events"].append({"step": step, "phase": state["phase"], "label": action["label"], "press": True})
        operation = "CLICK" if action["kind"] == "click" else "SCROLL_BOTTOM"
        return {
            "choice": action["id"],
            "operation": operation,
            "target": None,
            "probabilities": {action["id"]: 1.0},
            "operation_probabilities": {operation: 1.0},
            "usage": {},
            "reasked": None,
            "model_calls": 0,
            "latency_ms": 0,
            "request": None,
        }

    def _finish_phase_by_rule(self, state):
        """Bookkeeping, not a browser action: the phase is over once the configured action ran the set number of
        times in it. Jev is not asked; the phase ends exactly as it does when Jev chooses DONE."""
        rule = self.finish_phase_after
        if not rule:
            return
        label, limit = rule
        done = sum(1 for h in state["history"][state["phase_start"] :] if h["action"].casefold() == label.casefold())
        if done < limit:
            return
        state["rule_events"].append(
            {"step": len(state["history"]), "phase": state["phase"], "label": label, "count": limit}
        )
        if not self._advance_phase(state, state["page"]):
            state["status"] = "done"
            state["plan_index"] = len(state["plan"]) - 1
            state["awaiting_handoff"] = False
            state["elapsed_ms"] = self._elapsed_ms()

    def snapshot(self):
        return {
            **{k: v for k, v in self.state.items() if k != "browser"},
            "elements": action_space(self.state["page"]["actions"])[0],
        }

    @staticmethod
    def _decision_info(state):
        """What the inspector shows for a decision: the chosen element, the phase and the closest alternatives."""
        decision = state["decision"]
        choice = decision["choice"]
        if choice == "DONE":
            label = "完成"
        elif choice == "BLOCKED":
            label = "受阻"
        else:
            action = next((a for a in state["page"]["actions"] if a["id"] == choice), None)
            label = (action["label"] if action else choice).split(" → ")[0][:60]
        others = sorted(
            ((name, p) for name, p in decision["operation_probabilities"].items() if name != decision["operation"]),
            key=lambda item: item[1],
            reverse=True,
        )
        target_probability = decision.get("target_probabilities", {}).get(decision["target"])
        return {
            "label": label,
            "probability": round(decision["operation_probabilities"][decision["operation"]], 4),
            "target_probability": target_probability and round(target_probability, 4),
            "reasked": decision.get("reasked"),
            "phase": state["phase"],
            "step": len(state["history"]),
            "alternatives": [[name, round(p, 4)] for name, p in others[:2]],
        }

    def command(self, name, body=None):
        body = body or {}
        state = self.state
        if name == "tick":
            try:
                self.command("predict", {})
                if state["status"] != "predicted" or not state["decision"]:
                    return self.snapshot()
                return self.command("act", {"fingerprint": state["page"]["fingerprint"]})
            except StalePage:
                state["decision"] = None
                self._refresh_for_retry(state)
                return self.snapshot()
        elif name == "predict":
            if not state["browser"]:
                raise ValueError("Start a demo first")
            if state["started_at"] is None:
                state["started_at"] = time.perf_counter()
            if state.get("awaiting_handoff"):
                raise ValueError("Controller handoff required before continuing this run.")
            try:
                if not state["browser"].fresh(state["page"]):
                    state["page"] = state["browser"].observe(screenshot=self.screenshots)
            except StalePage:
                self._refresh_for_retry(state)
                raise
            state["decision"] = None
            if self._apply_scope_guard(state):
                state["elapsed_ms"] = self._elapsed_ms()
                return self.snapshot()
            if state["status"] in {"done", "blocked"}:
                raise ValueError("This run has stopped. Start a fresh demo.")
            if len(state["decisions"]) >= MAX_STEPS * 2:
                raise ValueError("Reached the demo's model-call budget")
            phase_history = state["history"][state["phase_start"] :]
            by_rule = self._next_by_rule(state, phase_history)
            if by_rule:
                state["decision"] = self._rule_decision(state, by_rule)
                state["status"] = "predicted"
                state["elapsed_ms"] = self._elapsed_ms()
                return self.snapshot()
            state["decision"] = choose(state["page"], state["goal"], phase_history, self.text)
            state["decisions"].append(
                {
                    **state["decision"],
                    "fingerprint": state["page"]["fingerprint"],
                    "elapsed_ms": self._elapsed_ms(),
                    **self._decision_info(state),
                }
            )
            state["status"] = "predicted"
        elif name == "handoff":
            if not state.get("awaiting_handoff"):
                raise ValueError("No phase handoff is pending.")
            state["awaiting_handoff"] = False
            state["phase_start"] = len(state["history"])  # the next phase counts its own actions from here
            self._refresh_for_retry(state)
            if not self._apply_scope_guard(state):
                state["status"] = "ready"
            state["elapsed_ms"] = self._elapsed_ms()
        elif name == "act":
            decision, page = state["decision"], state["page"]
            if not decision or body.get("fingerprint") != page["fingerprint"]:
                raise ValueError("Observe and choose before acting")
            # Consume once, before any mutation or model call. A retry cannot double-click.
            state["decision"] = None
            selected = decision["choice"]
            if selected in {"DONE", "BLOCKED"}:
                try:
                    is_fresh = state["browser"].fresh(page)
                except StalePage:
                    self._refresh_for_retry(state)
                    raise
                if not is_fresh:
                    state["status"] = "ready"
                    self._refresh_for_retry(state)
                    raise StalePage("Page changed since the decision. Choose again.")
                if selected == "DONE" and self._advance_phase(state, page):
                    return self.snapshot()
                state["status"] = "done" if selected == "DONE" else "blocked"
                if selected == "DONE":
                    state["plan_index"] = len(state["plan"]) - 1
                state["awaiting_handoff"] = False
                state["elapsed_ms"] = self._elapsed_ms()
                return self.snapshot()
            action = next((a for a in page["actions"] if a["id"] == selected), None)
            if action is None:
                self._refresh_for_retry(state)
                raise StalePage("Chosen element is no longer available. Choose again.")
            if len(state["history"]) >= MAX_STEPS:
                state["status"] = "blocked"
                raise ValueError(f"Stopped at the {MAX_STEPS}-action demo budget")
            text = None
            if action["kind"] == "fill":
                try:
                    is_fresh = state["browser"].fresh(page, action)
                except StalePage:
                    self._refresh_for_retry(state)
                    raise
                if not is_fresh:
                    self._refresh_for_retry(state)
                    raise StalePage("Page changed before text generation. Choose again.")
                if self.text is None:
                    raise ValueError("Supply the text to type: Agent(..., text=...)")
                text = self.text
            # Browser.act checks freshness immediately before input, including after text generation.
            try:
                state["browser"].act(action, page, text=text)
            except StalePage:
                self._refresh_for_retry(state)
                raise
            state["elapsed_ms"] = self._elapsed_ms()
            # Record execution before observing. A stale post-action observation must not erase the action.
            state["history"].append(
                {
                    "step": len(state["history"]) + 1,
                    "action": action["label"],
                    "kind": action["kind"],
                    "choice": selected,
                    "probability": decision["probabilities"][selected],
                    "latency_ms": decision["latency_ms"],
                    "text": text,
                    "operation": decision["operation"],
                    "target": decision["target"],
                    "page_changed": None,
                    "url": page["url"],
                    "usage": decision["usage"],
                    "executed_ms": self._elapsed_ms(),
                    "elapsed_ms": state["elapsed_ms"],
                }
            )
            try:
                state["page"] = state["browser"].observe(screenshot=self.screenshots)
            except StalePage:
                self._refresh_for_retry(state)
                state["history"][-1].update(
                    page_changed=True,
                    url=state["page"]["url"],
                    elapsed_ms=state["elapsed_ms"],
                )
                raise
            state["elapsed_ms"] = self._elapsed_ms()
            state["history"][-1].update(
                page_changed=state["page"]["fingerprint"] != page["fingerprint"],
                url=state["page"]["url"],
                elapsed_ms=state["elapsed_ms"],
            )
            if self._apply_scope_guard(state):
                state["elapsed_ms"] = self._elapsed_ms()
                return self.snapshot()
            repeated = state["history"][-3:]
            state["status"] = (
                "blocked"
                if len(repeated) == 3 and all(h["page_changed"] is False and h["kind"] != "wait" for h in repeated)
                else "ready"
            )
            if state["status"] == "ready":
                self._finish_phase_by_rule(state)
        else:
            raise ValueError("Unknown command")
        return self.snapshot()

    def run(self):
        while self.state["status"] not in {"done", "blocked"}:
            yield self.command("tick")

    def close(self):
        self.browser.close()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()
