"""The complete agent loop. Typed choices, observable state, bounded execution."""

import time

from .browser import Browser
from .config import MAX_STEPS
from .errors import StalePage
from .model import action_space, choose
from .traderie.site import is_traderie_host, phase_plan, traderie_scope_reason


def _normalize_plan(goals):
    if isinstance(goals, str):
        items = [goals.strip()]
    else:
        items = [str(goal).strip() for goal in goals]
    return [item for item in items if item]


def _action_by_id(actions, action_id):
    """The observed action with this id, or None when the page changed under the decision."""
    return next((a for a in actions if a["id"] == action_id), None)


REOBSERVE_ATTEMPTS = 3
# Consecutive StalePage failures on one target on one page end the run: `_execute` pops a refused action from
# `history`, so the step budget alone can never fire on a covered element (measured on the extension side: 1379
# retries in 177 s, each one a Jev call). Mirrors STALE_RETRY_LIMIT in extension/src/agent.js.
STALE_RETRY_LIMIT = 3


def scope_guard_for(url: str):
    """The scope guard of a run that starts at `url`: Traderie's rules for any Traderie host, none for other sites.
    One function decides; `traderie_scope_reason` itself says what is in scope inside that host."""
    return traderie_scope_reason if is_traderie_host(url) else None


class Agent:
    def __init__(self, url, goals, *, text=None, screenshots=False, finish_phase_after=None):
        plan = _normalize_plan(goals)
        if not plan:
            raise ValueError("Supply a task")

        self.scope_guard = scope_guard_for(url)
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
            last_attempt=None,  # {choice, fingerprint, label}: the target the last action attempt went for
            stale_streak=None,  # {key, count}: consecutive StalePage failures on one target on one page
            stale_events={},  # measurement only: StalePage stop count by reason
            elapsed_ms=0,
            started_at=None,
        )
        self._apply_scope_guard(self.state)

    def _elapsed_ms(self):
        started = self.state.get("started_at")
        return round((time.perf_counter() - started) * 1000) if started is not None else 0

    def _sync_elapsed(self, state):
        state["elapsed_ms"] = self._elapsed_ms()

    def _wait_until_ready(self, state):
        waiter = getattr(state["browser"], "wait_until_ready", None)
        if callable(waiter):
            try:
                waiter(timeout_seconds=2.0)
            except Exception:
                pass

    def _reobserve(self, state):
        """Observe the page again after a stale page (bounded: three tries), apply the scope guard, and make the
        run ready for a fresh decision. The one recovery path of the Agent; it never replays an action."""
        for attempt in range(REOBSERVE_ATTEMPTS):
            self._wait_until_ready(state)
            try:
                state["page"] = state["browser"].observe(screenshot=self.screenshots)
                break
            except StalePage:
                if attempt == REOBSERVE_ATTEMPTS - 1:
                    raise
        self._sync_elapsed(state)
        last = state["history"][-1] if state["history"] else None
        if last and last.get("url") is None:
            last["url"] = state["page"]["url"]  # the action whose result page could not be read at the time
        if not self._apply_scope_guard(state):
            state["status"] = "ready"

    def _block(self, state):
        """Stop the run: blocked status, no pending handoff, elapsed time updated. Callers record their own reason."""
        state["status"] = "blocked"
        state["awaiting_handoff"] = False
        self._sync_elapsed(state)

    def _finish_run(self, state):
        """The last phase is over: done status, no pending handoff, elapsed time updated."""
        state["status"] = "done"
        state["plan_index"] = len(state["plan"]) - 1
        state["awaiting_handoff"] = False
        self._sync_elapsed(state)

    def _note_stale_failure(self, state) -> int:
        """One more consecutive stale failure on the same target on the same page; a new page or target starts over."""
        attempt = state.get("last_attempt")
        if not attempt:
            return 0  # a stale page that was not an action attempt (a navigation) does not count
        key = f"{attempt['fingerprint']}|{attempt['choice']}"
        streak = state.get("stale_streak")
        count = streak["count"] + 1 if streak and streak["key"] == key else 1
        state["stale_streak"] = {"key": key, "count": count}
        return count

    def _stop_after_stale(self, state, count) -> None:
        """End a run whose target keeps failing on an unchanged page, with a reason the panel shows and logs."""
        attempt = state.get("last_attempt") or {}
        label = attempt.get("label") or attempt.get("choice") or ""
        reason = f"連續 {count} 次都無法操作「{label}」（畫面沒有變化），查詢已停止"
        self._block(state)
        state["scope_blocked_reason"] = reason
        state["rule_events"].append(
            {"step": len(state["history"]), "phase": state["phase"], "label": label, "stale": True, "count": count}
        )
        state["stale_events"][reason] = state["stale_events"].get(reason, 0) + 1

    def _apply_scope_guard(self, state):
        if not callable(self.scope_guard):
            return None
        reason = self.scope_guard(state["page"]["url"])
        state["scope_blocked_reason"] = reason
        if reason:
            state["decision"] = None
            self._block(state)
        return reason

    def _stop_if_off_scope(self, state) -> bool:
        """True once the scope guard has blocked the run; the caller must then end the step."""
        if not self._apply_scope_guard(state):
            return False
        self._sync_elapsed(state)
        return True

    def _require_step_budget(self, state):
        if len(state["history"]) >= MAX_STEPS:
            state["status"] = "blocked"
            raise ValueError(f"Stopped at the {MAX_STEPS}-action demo budget")

    def _apply_verdict(self, state, selected):
        """A DONE or BLOCKED choice is a verdict about the view, not an input: ads may change the text between the
        decision and now, and the controller reads and checks the live page itself right after, so no freshness gate."""
        if selected != "DONE":
            self._block(state)
        elif not self._advance_phase(state):
            self._finish_run(state)

    def _advance_phase(self, state):
        next_index = state["plan_index"] + 1
        if next_index >= len(state["plan"]):
            return False
        state["plan_index"] = next_index
        state["goal"] = state["plan"][next_index]
        state["phase"] = self.phase_names[next_index] if next_index < len(self.phase_names) else None
        state["status"] = "handoff"
        state["awaiting_handoff"] = True
        self._sync_elapsed(state)
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
            return _action_by_id(actions, "scroll_bottom")
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
        if not self._advance_phase(state):
            self._finish_run(state)

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
            action = _action_by_id(state["page"]["actions"], choice)
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
        handler = {"tick": self._tick, "predict": self._predict, "handoff": self._handoff, "act": self._act}.get(name)
        if handler is None:
            raise ValueError("Unknown command")
        handler(body or {})
        return self.snapshot()

    def _tick(self, _body):
        """Predict, then act. A stale page anywhere in the step ends it here: re-observe once, decide again next tick.
        This is the only place the Agent recovers from a stale page; nothing is ever replayed."""
        state = self.state
        try:
            self._predict({})
            if state["status"] == "predicted" and state["decision"]:
                self._act({"fingerprint": state["page"]["fingerprint"]})
        except StalePage:
            state["decision"] = None
            count = self._note_stale_failure(state)
            if count >= STALE_RETRY_LIMIT:
                self._stop_after_stale(state, count)
                return
            self._reobserve(state)

    def _predict(self, _body):
        state = self.state
        if not state["browser"]:
            raise ValueError("Start a demo first")
        if state["started_at"] is None:
            state["started_at"] = time.perf_counter()
        if state.get("awaiting_handoff"):
            raise ValueError("Controller handoff required before continuing this run.")
        # Nothing below may cost anything (a page read, a model call) for a run that cannot continue.
        if state["status"] in {"done", "blocked"}:
            raise ValueError("This run has stopped. Start a fresh demo.")
        self._require_step_budget(state)
        if len(state["decisions"]) >= MAX_STEPS * 2:
            raise ValueError("Reached the demo's model-call budget")
        # Cleared before the page read: a stale read is a navigation, not a target that keeps failing, and it must not
        # be charged to the step before (whose action may have succeeded).
        state["last_attempt"] = None
        if not state["browser"].fresh(state["page"]):
            state["page"] = state["browser"].observe(screenshot=self.screenshots)
        state["decision"] = None
        if self._stop_if_off_scope(state):
            return
        phase_history = state["history"][state["phase_start"] :]
        by_rule = self._next_by_rule(state, phase_history)
        if by_rule:
            state["decision"] = self._rule_decision(state, by_rule)
            state["status"] = "predicted"
            self._sync_elapsed(state)
            return
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

    def _handoff(self, _body):
        state = self.state
        if not state.get("awaiting_handoff"):
            raise ValueError("No phase handoff is pending.")
        self._reobserve(state)
        state["awaiting_handoff"] = False
        state["phase_start"] = len(state["history"])  # the next phase counts its own actions from here
        self._sync_elapsed(state)

    def _history_entry(self, state, action, selected, decision, text, page) -> dict:
        """The record of one action, built before the browser call so a half-done action is still visible."""
        return {
            "step": len(state["history"]) + 1,
            "action": action["label"],
            "kind": action["kind"],
            "choice": selected,
            "probability": decision["probabilities"][selected],
            "latency_ms": decision["latency_ms"],
            "text": text,
            "operation": decision["operation"],
            "target": decision["target"],
            "outcome": "started",
            "page_changed": None,
            "url": page["url"],
            "usage": decision["usage"],
            "executed_ms": state["elapsed_ms"],
            "elapsed_ms": state["elapsed_ms"],
        }

    def _execute(self, state, entry, action, page, text):
        """Run the action and observe its result, updating `entry` at every step. A failure is never replayed."""
        try:
            # Browser.act checks freshness immediately before input, including after text generation.
            state["browser"].act(action, page, text=text)
        except StalePage:
            state["history"].pop()  # refused before any input: nothing was executed
            raise
        except BaseException:
            entry.update(outcome="unconfirmed", elapsed_ms=self._elapsed_ms())  # may have happened; never replayed
            raise
        # It ran: only a refused attempt may extend the stale streak, so a stale read of the page it produced is not
        # charged to it (see `_note_stale_failure`).
        state["last_attempt"] = None
        self._sync_elapsed(state)
        entry.update(outcome="executed", executed_ms=state["elapsed_ms"], elapsed_ms=state["elapsed_ms"])
        try:
            state["page"] = state["browser"].observe(screenshot=self.screenshots)
        except StalePage:
            entry.update(page_changed=True, url=None, elapsed_ms=self._elapsed_ms())  # tick fills the url in
            raise

    def _act(self, body):
        state = self.state
        decision, page = state["decision"], state["page"]
        if not decision or body.get("fingerprint") != page["fingerprint"]:
            raise ValueError("Observe and choose before acting")
        # Consume once, before any mutation or model call. A retry cannot double-click.
        state["decision"] = None
        selected = decision["choice"]
        if selected in {"DONE", "BLOCKED"}:
            self._apply_verdict(state, selected)
            return
        action = _action_by_id(page["actions"], selected)
        if action is None:
            raise StalePage("Chosen element is no longer available. Choose again.")
        state["last_attempt"] = {"choice": selected, "fingerprint": page["fingerprint"], "label": action["label"]}
        self._require_step_budget(state)
        text = None
        if action["kind"] == "fill":
            if not state["browser"].fresh(page, action):
                raise StalePage("Page changed before text generation. Choose again.")
            if self.text is None:
                raise ValueError("Supply the text to type: Agent(..., text=...)")
            text = self.text
        # Log the action before it can happen: if the browser call dies half-way, history still says it was tried.
        self._sync_elapsed(state)
        entry = self._history_entry(state, action, selected, decision, text, page)
        state["history"].append(entry)
        self._execute(state, entry, action, page, text)
        self._sync_elapsed(state)
        entry.update(
            page_changed=state["page"]["fingerprint"] != page["fingerprint"],
            url=state["page"]["url"],
            elapsed_ms=state["elapsed_ms"],
        )
        if self._stop_if_off_scope(state):
            return
        repeated = state["history"][-3:]
        state["status"] = (
            "blocked"
            if len(repeated) == 3 and all(h["page_changed"] is False and h["kind"] != "wait" for h in repeated)
            else "ready"
        )
        if state["status"] == "ready":
            self._finish_phase_by_rule(state)

    def close(self):
        self.browser.close()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()
