"""The complete agent loop. Typed choices, observable state, bounded execution."""

import base64
import time
from pathlib import Path

from .browser import Browser, StalePage
from .model import action_space, choose, field_context, field_text
from .questions import MAX_STEPS


class Agent:
    def __init__(self, url, goals, *, record_dir=None, screenshots=False):
        task = goals.strip() if isinstance(goals, str) else "\n".join(goals).strip()
        if not task:
            raise ValueError("Supply a task")
        plan = [task]
        self.pending_text = None
        self.record_dir = Path(record_dir) if record_dir else None
        self.screenshots = screenshots or bool(record_dir)
        self.browser = Browser(url)
        try:
            page = self.browser.observe(screenshot=self.screenshots)
            if self.record_dir:
                self.record_dir.mkdir(parents=True, exist_ok=True)
                self._record_frame(page, 0)
        except Exception:
            self.browser.close()
            raise
        self.state = dict(
            browser=self.browser,
            goal="\n".join(plan),
            page=page,
            decision=None,
            history=[],
            status="ready",
            plan=plan,
            plan_index=0,
            decisions=[],
            last_decision=None,
            text_calls=[],
            errors=[],
            fallback_used=False,
            stale_recoveries=0,
            elapsed_ms=0,
            started_at=None,
            record=bool(self.record_dir),
        )

    def _record_error(self, phase, error):
        self.state["errors"].append({"phase": phase, "type": type(error).__name__, "message": str(error)})

    def _record_frame(self, page, elapsed_ms):
        if not getattr(self, "record_dir", None):
            return
        timestamp = max(0, int(elapsed_ms))
        path = self.record_dir / f"{timestamp:06d}.jpg"
        while path.exists():
            timestamp += 1
            path = self.record_dir / f"{timestamp:06d}.jpg"
        path.write_bytes(base64.b64decode(page["screenshot"]))

    def result(self, extracted_result=None):
        """Return a stable, secret-free summary for another model or caller."""
        state = self.state
        page = state.get("page") or {}
        decisions = state.get("decisions", [])
        latest = state.get("last_decision") or {}
        helper_models = sorted({call["model"] for call in state.get("text_calls", []) if call.get("model")})
        actions = []
        for history in state.get("history", []):
            actions.append({
                key: history.get(key)
                for key in (
                    "step", "action", "kind", "choice", "operation", "target", "text",
                    "probability", "confidence", "page_changed", "url", "text_helper",
                    "text_latency_ms", "latency_ms", "usage", "executed_ms", "elapsed_ms", "execution_status",
                )
            })
        return {
            "schema_version": "jev.result.v1",
            "status": state.get("status"),
            "actions": actions,
            "final_url": page.get("url"),
            "final_title": page.get("title"),
            "extracted_result": (
                extracted_result if extracted_result is not None else {"visible_text": page.get("text", "")}
            ),
            "confidence": (
                latest.get("target_confidence")
                if latest.get("target_confidence") is not None
                else latest.get("confidence")
            ),
            "probabilities": latest.get("probabilities", {}),
            "operation_confidence": latest.get("confidence"),
            "operation_probabilities": latest.get("operation_probabilities", {}),
            "target_confidence": latest.get("target_confidence"),
            "target_probabilities": latest.get("target_probabilities", {}),
            "errors": list(state.get("errors", [])),
            "fallback_used": bool(state.get("fallback_used")),
            "model": {"decision": latest.get("model"), "text_helpers": helper_models},
            "provenance": {
                "source": "jev-ultrafast",
                "decision_count": len(decisions),
                "text_call_count": len(state.get("text_calls", [])),
                "omitted_actions": page.get("omitted_actions", 0),
            },
            "omitted_actions": page.get("omitted_actions", 0),
        }

    def snapshot(self):
        return {
            **{k: v for k, v in self.state.items() if k != "browser"},
            "elements": action_space(self.state["page"]["actions"])[0],
        }

    def command(self, name, body=None):
        body = body or {}
        state = self.state
        if name == "tick":
            history_start = len(state["history"])
            try:
                self.command("predict", {})
                return self.command("act", {"fingerprint": state["page"]["fingerprint"]})
            except StalePage:
                previous_page = state["page"]
                executed = bool(
                    len(state["history"]) > history_start
                    and state["history"]
                    and state["history"][-1].get("execution_status") == "executed"
                )
                state["stale_recoveries"] += 1
                state["decision"] = None
                state["status"] = "ready"
                state["fallback_used"] = True
                state["errors"].append({
                    "phase": "stale_recovery",
                    "type": "StalePage",
                    "message": (
                        "Executed action re-observed." if executed else "Decision discarded and page re-observed."
                    ),
                })
                if state["stale_recoveries"] > MAX_STEPS:
                    try:
                        state["page"] = state["browser"].observe(screenshot=self.screenshots)
                        state["elapsed_ms"] = round((time.perf_counter() - state["started_at"]) * 1000)
                        self._record_frame(state["page"], state["elapsed_ms"])
                    except Exception as error:
                        self._record_error("stale_recovery_final_observe", error)
                    else:
                        state["elapsed_ms"] = round((time.perf_counter() - state["started_at"]) * 1000)
                    state["status"] = "blocked"
                    state["last_decision"] = None
                    self._record_error("stale_recovery_budget", ValueError("Exceeded stale recovery budget."))
                    return self.snapshot()
                try:
                    state["page"] = state["browser"].observe(screenshot=self.screenshots)
                except Exception as error:
                    state["status"] = "blocked"
                    self._record_error("stale_recovery_observe", error)
                    raise
                state["elapsed_ms"] = round((time.perf_counter() - state["started_at"]) * 1000)
                self._record_frame(state["page"], state["elapsed_ms"])
                if executed:
                    state["history"][-1].update(
                        page_changed=state["page"]["fingerprint"] != previous_page["fingerprint"],
                        url=state["page"]["url"],
                        elapsed_ms=state["elapsed_ms"],
                    )
                    repeated = state["history"][-3:]
                    if len(repeated) == 3 and all(
                        h["page_changed"] is False and h["kind"] != "wait" for h in repeated
                    ):
                        state["status"] = "blocked"
                        state["last_decision"] = None
                return self.snapshot()
        elif name == "predict":
            if not state["browser"]:
                raise ValueError("Start a demo first")
            if state["started_at"] is None:
                state["started_at"] = time.perf_counter()
            if not state["browser"].fresh(state["page"]):
                state["page"] = state["browser"].observe(screenshot=self.screenshots)
                state["elapsed_ms"] = round((time.perf_counter() - state["started_at"]) * 1000)
                self._record_frame(state["page"], state["elapsed_ms"])
            state["decision"] = None
            if state["status"] in {"done", "blocked"}:
                error = ValueError("This run has stopped. Start a fresh demo.")
                self._record_error("lifecycle", error)
                raise error
            if len(state["decisions"]) >= MAX_STEPS * 2:
                state["status"] = "blocked"
                state["last_decision"] = None
                error = ValueError("Reached the demo's model-call budget")
                self._record_error("decision_budget", error)
                raise error
            try:
                state["decision"] = choose(state["page"], state["goal"], state["history"])
            except (RuntimeError, ValueError) as error:
                self._record_error("decision", error)
                raise
            state["decisions"].append(
                {
                    **state["decision"],
                    "fingerprint": state["page"]["fingerprint"],
                    "elapsed_ms": round((time.perf_counter() - state["started_at"]) * 1000),
                }
            )
            state["status"] = "predicted"
        elif name == "act":
            decision, page = state["decision"], state["page"]
            if not decision or body.get("fingerprint") != page["fingerprint"]:
                raise ValueError("Observe and choose before acting")
            # Consume once, before any mutation or model call. A retry cannot double-click.
            state["decision"] = None
            selected = decision["choice"]
            if selected in {"DONE", "BLOCKED"}:
                if not state["browser"].fresh(page):
                    state["status"] = "ready"
                    raise StalePage("Page changed since the decision. Choose again.")
                state["last_decision"] = decision
                state["status"] = "done" if selected == "DONE" else "blocked"
                state["plan_index"] = int(selected == "DONE")
                state["elapsed_ms"] = round((time.perf_counter() - state["started_at"]) * 1000)
                return self.snapshot()
            try:
                action = next(a for a in page["actions"] if a["id"] == selected)
            except StopIteration:
                error = ValueError("Selected action is no longer observed; choose again.")
                self._record_error("action", error)
                raise error from None
            if len(state["history"]) >= MAX_STEPS:
                state["status"] = "blocked"
                state["last_decision"] = None
                error = ValueError(f"Stopped at the {MAX_STEPS}-action demo budget")
                self._record_error("action_budget", error)
                raise error
            text, helper = None, None
            if action["kind"] == "fill":
                if not state["browser"].fresh(page):
                    raise StalePage("Page changed before text generation. Choose again.")
                context = field_context(state["goal"], action, page, state["history"])
                if self.pending_text and self.pending_text[0] == context:
                    _, text, helper = self.pending_text
                else:
                    try:
                        text, helper = field_text(context)
                    except (RuntimeError, ValueError) as error:
                        self._record_error("text_helper", error)
                        raise
                    self.pending_text = (context, text, helper)
                    state["text_calls"].append({**helper, "field": action["label"], "value": text})
            # Browser.act checks freshness immediately before input, including after text generation.
            try:
                state["browser"].act(action, page, text=text)
            except (RuntimeError, ValueError) as error:
                if isinstance(error, StalePage):
                    # The tick-level recovery owns re-observation for a pre-input stale page.
                    # Do not inspect or mutate the previous action's finalized history row here.
                    raise
                state["last_decision"] = None
                elapsed_ms = round((time.perf_counter() - state["started_at"]) * 1000)
                state["elapsed_ms"] = elapsed_ms
                state["history"].append({
                    "step": len(state["history"]) + 1,
                    "action": action["label"],
                    "kind": action["kind"],
                    "choice": selected,
                    "probability": decision["probabilities"][selected],
                    "confidence": decision["confidence"],
                    "latency_ms": decision["latency_ms"],
                    "text": text,
                    "text_helper": helper["model"] if helper else None,
                    "text_latency_ms": helper["latency_ms"] if helper else 0,
                    "operation": decision["operation"],
                    "target": decision["target"],
                    "page_changed": None,
                    "url": page["url"],
                    "usage": decision["usage"],
                    "executed_ms": elapsed_ms,
                    "elapsed_ms": elapsed_ms,
                    "execution_status": "unknown",
                })
                self._record_error("browser", error)
                try:
                    state["page"] = state["browser"].observe(screenshot=self.screenshots)
                except Exception as observe_error:
                    self._record_error("browser_reobserve", observe_error)
                else:
                    if state["history"]:
                        state["history"][-1].update(
                            page_changed=state["page"]["fingerprint"] != page["fingerprint"],
                            url=state["page"]["url"],
                        )
                raise
            state["last_decision"] = decision
            self.pending_text = None
            state["elapsed_ms"] = round((time.perf_counter() - state["started_at"]) * 1000)
            # Record execution before observing. A stale post-action observation must not erase the action.
            state["history"].append(
                {
                    "step": len(state["history"]) + 1,
                    "action": action["label"],
                    "kind": action["kind"],
                    "choice": selected,
                    "probability": decision["probabilities"][selected],
                    "confidence": decision["confidence"],
                    "latency_ms": decision["latency_ms"],
                    "text": text,
                    "text_helper": helper["model"] if helper else None,
                    "text_latency_ms": helper["latency_ms"] if helper else 0,
                    "operation": decision["operation"],
                    "target": decision["target"],
                    "page_changed": None,
                    "url": page["url"],
                    "usage": decision["usage"],
                    "executed_ms": round((time.perf_counter() - state["started_at"]) * 1000),
                    "elapsed_ms": state["elapsed_ms"],
                    "execution_status": "executed",
                }
            )
            try:
                state["page"] = state["browser"].observe(screenshot=self.screenshots)
            except StalePage:
                raise
            except (RuntimeError, ValueError) as error:
                state["status"] = "blocked"
                self._record_error("post_action_observe", error)
                raise
            state["elapsed_ms"] = round((time.perf_counter() - state["started_at"]) * 1000)
            state["history"][-1].update(
                page_changed=state["page"]["fingerprint"] != page["fingerprint"],
                url=state["page"]["url"],
                elapsed_ms=state["elapsed_ms"],
            )
            self._record_frame(state["page"], state["elapsed_ms"])
            repeated = state["history"][-3:]
            state["status"] = (
                "blocked"
                if len(repeated) == 3 and all(h["page_changed"] is False and h["kind"] != "wait" for h in repeated)
                else "ready"
            )
            if state["status"] == "blocked":
                state["last_decision"] = None
        else:
            raise ValueError("Unknown command")
        return self.snapshot()

    def run(self):
        while self.state["status"] not in {"done", "blocked"}:
            try:
                yield self.command("tick")
            except (RuntimeError, ValueError):
                self.state["status"] = "blocked"
                self.state["last_decision"] = None
                yield self.snapshot()
                return

    def close(self):
        self.browser.close()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()
