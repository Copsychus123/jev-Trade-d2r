// Port of core/jev_ultrafast/agent.py. No chrome.*; the tab is injected so tests can fake it.

import { StalePage } from "./errors.js";
import { traderieScopeReason } from "./traderie/site.js";

export const MAX_STEPS = 60;
export const JEV_CALL_LIMIT = 30;

const now = () => performance.now();

export class Agent {
  constructor({ tab, phases, text, finishPhaseAfter, choose, vetoBlocked }) {
    this.tab = tab;
    this.phases = phases;
    this.text = text ?? null;
    this.finishPhaseAfter = finishPhaseAfter ?? null;
    this.choose = choose;
    this.vetoBlocked = vetoBlocked ?? null;
    this.state = null;
  }

  static async create({
    tab,
    phases = ["trading", "recent_trades"],
    text = null,
    finishPhaseAfter = null,
    choose,
    vetoBlocked = null,
  }) {
    if (!phases.length) throw new Error("Supply a task");
    const agent = new Agent({ tab, phases, text, finishPhaseAfter, choose, vetoBlocked });
    const page = await tab.observe();
    agent.state = {
      page,
      decision: null,
      history: [],
      status: "ready",
      plan: [...phases],
      plan_index: 0,
      phase: phases[0],
      awaiting_handoff: false,
      phase_start: 0,
      scope_blocked_reason: null,
      decisions: [],
      rule_events: [],
      elapsed_ms: 0,
      started_at: null,
    };
    agent._applyScopeGuard(agent.state);
    return agent;
  }

  _elapsedMs() {
    const started = this.state.started_at;
    return started !== null ? Math.round(now() - started) : 0;
  }

  async _waitUntilReady() {
    try {
      await this.tab.waitUntilReady(2000);
    } catch {
      // best effort
    }
  }

  async _refreshForRetry(state) {
    await this._waitUntilReady();
    state.page = await this.tab.observe();
    state.status = "ready";
    state.elapsed_ms = this._elapsedMs();
  }

  _applyScopeGuard(state) {
    const reason = traderieScopeReason(state.page.url);
    state.scope_blocked_reason = reason;
    if (reason) {
      state.decision = null;
      state.status = "blocked";
      state.awaiting_handoff = false;
    }
    return reason;
  }

  _advancePhase(state) {
    const next = state.plan_index + 1;
    if (next >= state.plan.length) return false;
    state.plan_index = next;
    state.phase = state.plan[next];
    state.status = "handoff";
    state.awaiting_handoff = true;
    state.elapsed_ms = this._elapsedMs();
    return true;
  }

  /** After Load More comes Scroll to bottom; after Scroll to bottom comes Load More when it is on the page. */
  _nextByRule(state, phaseHistory) {
    const rule = this.finishPhaseAfter;
    if (!rule || !phaseHistory.length) return null;
    const label = rule[0].toLowerCase();
    const last = phaseHistory[phaseHistory.length - 1];
    const actions = state.page.actions;
    if (last.action.toLowerCase() === label) return actions.find((a) => a.id === "scroll_bottom") ?? null;
    if (last.choice === "scroll_bottom") {
      return actions.find((a) => a.kind === "click" && a.label.toLowerCase() === label) ?? null;
    }
    return null;
  }

  _ruleDecision(state, action) {
    const step = state.history.length + 1;
    state.rule_events = state.rule_events.filter((e) => !(e.press && e.step >= step));
    state.rule_events.push({ step, phase: state.phase, label: action.label, press: true });
    const operation = action.kind === "click" ? "CLICK" : "SCROLL_BOTTOM";
    return {
      choice: action.id,
      operation,
      target: null,
      probabilities: { [action.id]: 1.0 },
      operation_probabilities: { [operation]: 1.0 },
      usage: {},
      reasked: null,
      model_calls: 0,
      latency_ms: 0,
      by_rule: true,
    };
  }

  _finishPhaseByRule(state) {
    const rule = this.finishPhaseAfter;
    if (!rule) return;
    const [label, limit] = rule;
    const done = state.history
      .slice(state.phase_start)
      .filter((h) => h.action.toLowerCase() === label.toLowerCase()).length;
    if (done < limit) return;
    state.rule_events.push({ step: state.history.length, phase: state.phase, label, count: limit });
    if (!this._advancePhase(state)) {
      state.status = "done";
      state.plan_index = state.plan.length - 1;
      state.awaiting_handoff = false;
      state.elapsed_ms = this._elapsedMs();
    }
  }

  snapshot() {
    return { ...this.state };
  }

  _decisionInfo(state) {
    const decision = state.decision;
    const choice = decision.choice;
    let label;
    if (choice === "DONE") label = "完成";
    else if (choice === "BLOCKED") label = "受阻";
    else {
      const action = state.page.actions.find((a) => a.id === choice);
      label = (action ? action.label : choice).split(" → ")[0].slice(0, 60);
    }
    const others = Object.entries(decision.operation_probabilities)
      .filter(([name]) => name !== decision.operation)
      .sort((a, b) => b[1] - a[1]);
    const targetProbability = decision.target_probabilities?.[decision.target];
    const round4 = (p) => Math.round(p * 10000) / 10000;
    return {
      label,
      probability: round4(decision.operation_probabilities[decision.operation]),
      target_probability: targetProbability ? round4(targetProbability) : (targetProbability ?? null),
      reasked: decision.reasked ?? null,
      phase: state.phase,
      step: state.history.length,
      alternatives: others.slice(0, 2).map(([name, p]) => [name, round4(p)]),
    };
  }

  async command(name, body = {}) {
    const state = this.state;
    if (name === "tick") {
      try {
        await this.command("predict", {});
        if (state.status !== "predicted" || !state.decision) return this.snapshot();
        return await this.command("act", { fingerprint: state.page.fingerprint });
      } catch (error) {
        if (!(error instanceof StalePage)) throw error;
        state.decision = null;
        await this._refreshForRetry(state);
        return this.snapshot();
      }
    } else if (name === "predict") {
      if (state.started_at === null) state.started_at = now();
      if (state.awaiting_handoff) throw new Error("Controller handoff required before continuing this run.");
      try {
        if (!(await this.tab.fresh(state.page))) state.page = await this.tab.observe();
      } catch (error) {
        if (error instanceof StalePage) await this._refreshForRetry(state);
        throw error;
      }
      state.decision = null;
      if (this._applyScopeGuard(state)) {
        state.elapsed_ms = this._elapsedMs();
        return this.snapshot();
      }
      if (state.status === "done" || state.status === "blocked") {
        throw new Error("This run has stopped. Start a fresh run.");
      }
      const phaseHistory = state.history.slice(state.phase_start);
      const byRule = this._nextByRule(state, phaseHistory);
      if (byRule) {
        state.decision = this._ruleDecision(state, byRule);
        state.status = "predicted";
        state.elapsed_ms = this._elapsedMs();
        return this.snapshot();
      }
      // Mirrors the server: a request may cost two model calls, so stop while two more would not fit.
      const usedCalls = state.decisions.reduce((sum, d) => sum + (d.model_calls ?? 0), 0);
      if (usedCalls + 2 > JEV_CALL_LIMIT) throw new Error(`Jev 呼叫次數已達這次查詢的上限（${JEV_CALL_LIMIT} 次），查詢已停止`);
      let decision = await this.choose(state.page, state.phase, phaseHistory);
      // Jev gave up on a page the caller can see is fine: ask once more without the BLOCKED option.
      if (
        decision.choice === "BLOCKED" &&
        this.vetoBlocked?.(state.page) &&
        state.veto_fingerprint !== state.page.fingerprint &&
        usedCalls + (decision.model_calls ?? 1) + 2 <= JEV_CALL_LIMIT
      ) {
        state.veto_fingerprint = state.page.fingerprint;
        state.decision = decision;
        state.decisions.push({ ...decision, vetoed: true, fingerprint: state.page.fingerprint, ...this._decisionInfo(state) });
        decision = await this.choose(state.page, state.phase, phaseHistory, { noBlock: true });
      }
      state.decision = decision;
      state.decisions.push({
        ...state.decision,
        fingerprint: state.page.fingerprint,
        elapsed_ms: this._elapsedMs(),
        ...this._decisionInfo(state),
      });
      state.status = "predicted";
    } else if (name === "handoff") {
      if (!state.awaiting_handoff) throw new Error("No phase handoff is pending.");
      state.awaiting_handoff = false;
      state.phase_start = state.history.length;
      await this._refreshForRetry(state);
      if (!this._applyScopeGuard(state)) state.status = "ready";
      state.elapsed_ms = this._elapsedMs();
    } else if (name === "act") {
      const decision = state.decision;
      const page = state.page;
      if (!decision || body.fingerprint !== page.fingerprint) throw new Error("Observe and choose before acting");
      // Consume once, before any mutation. A retry cannot double-click.
      state.decision = null;
      const selected = decision.choice;
      if (selected === "DONE" || selected === "BLOCKED") {
        let isFresh;
        try {
          isFresh = await this.tab.fresh(page);
        } catch (error) {
          if (error instanceof StalePage) await this._refreshForRetry(state);
          throw error;
        }
        if (!isFresh) {
          state.status = "ready";
          await this._refreshForRetry(state);
          throw new StalePage("Page changed since the decision. Choose again.");
        }
        if (selected === "DONE" && this._advancePhase(state)) return this.snapshot();
        state.status = selected === "DONE" ? "done" : "blocked";
        if (selected === "DONE") state.plan_index = state.plan.length - 1;
        state.awaiting_handoff = false;
        state.elapsed_ms = this._elapsedMs();
        return this.snapshot();
      }
      const action = page.actions.find((a) => a.id === selected);
      if (!action) {
        await this._refreshForRetry(state);
        throw new StalePage("Chosen element is no longer available. Choose again.");
      }
      if (state.history.length >= MAX_STEPS) {
        state.status = "blocked";
        throw new Error(`已達 ${MAX_STEPS} 個動作的上限，查詢已停止`);
      }
      let text = null;
      if (action.kind === "fill") {
        let isFresh;
        try {
          isFresh = await this.tab.fresh(page, action);
        } catch (error) {
          if (error instanceof StalePage) await this._refreshForRetry(state);
          throw error;
        }
        if (!isFresh) {
          await this._refreshForRetry(state);
          throw new StalePage("Page changed before typing. Choose again.");
        }
        if (this.text === null) throw new Error("Supply the text to type");
        text = this.text;
      }
      try {
        await this.tab.act(action, page, text);
      } catch (error) {
        if (error instanceof StalePage) await this._refreshForRetry(state);
        throw error;
      }
      state.elapsed_ms = this._elapsedMs();
      // Record execution before observing. A stale post-action observation must not erase the action.
      state.history.push({
        step: state.history.length + 1,
        action: action.label,
        kind: action.kind,
        choice: selected,
        probability: decision.probabilities[selected],
        latency_ms: decision.latency_ms,
        text,
        operation: decision.operation,
        target: decision.target,
        page_changed: null,
        url: page.url,
        usage: decision.usage,
        by_rule: Boolean(decision.by_rule),
        executed_ms: this._elapsedMs(),
        elapsed_ms: state.elapsed_ms,
      });
      const entry = state.history[state.history.length - 1];
      try {
        state.page = await this.tab.observe();
      } catch (error) {
        if (error instanceof StalePage) {
          await this._refreshForRetry(state);
          Object.assign(entry, { page_changed: true, url: state.page.url, elapsed_ms: state.elapsed_ms });
        }
        throw error;
      }
      state.elapsed_ms = this._elapsedMs();
      Object.assign(entry, {
        page_changed: state.page.fingerprint !== page.fingerprint,
        url: state.page.url,
        elapsed_ms: state.elapsed_ms,
      });
      if (this._applyScopeGuard(state)) {
        state.elapsed_ms = this._elapsedMs();
        return this.snapshot();
      }
      const repeated = state.history.slice(-3);
      state.status =
        repeated.length === 3 && repeated.every((h) => h.page_changed === false && h.kind !== "wait")
          ? "blocked"
          : "ready";
      if (state.status === "ready") this._finishPhaseByRule(state);
    } else {
      throw new Error("Unknown command");
    }
    return this.snapshot();
  }

  async close() {
    await this.tab.close();
  }
}
