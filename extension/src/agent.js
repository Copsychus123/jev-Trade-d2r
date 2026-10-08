// Port of src/jev_ultrafast/agent.py. No chrome.*; the tab is injected so tests can fake it.

import { StalePage } from "./errors.js";
import { traderieScopeReason } from "./traderie/site.js";

const MAX_STEPS = 60;
const JEV_CALL_LIMIT = 30;
// Consecutive StalePage failures on the same target on the same page: the click never ran, so nothing changed.
// Three is enough for a real layout shift to settle (one retry) plus one slower case; a covered element never clears.
const STALE_RETRY_LIMIT = 3;

/** The Jev calls one run has used. One query can build more than one Agent (finder layer 3), so they share this. */
export const newCallBudget = () => ({ used: 0 });

const now = () => performance.now();

export class Agent {
  constructor({ tab, phases, text, finishPhaseAfter, choose, vetoBlocked, callBudget }) {
    this.tab = tab;
    this.phases = phases;
    this.text = text ?? null;
    this.finishPhaseAfter = finishPhaseAfter ?? null;
    this.choose = choose;
    this.vetoBlocked = vetoBlocked ?? null;
    this.callBudget = callBudget ?? newCallBudget();
    this.state = null;
  }

  static async create({
    tab,
    phases = ["trading", "recent_trades"],
    text = null,
    finishPhaseAfter = null,
    choose,
    vetoBlocked = null,
    callBudget = null,
  }) {
    if (!phases.length) throw new Error("Supply a task");
    const agent = new Agent({ tab, phases, text, finishPhaseAfter, choose, vetoBlocked, callBudget });
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
      stale_events: {}, // measurement only: StalePage count by reason
      attempts: 0, // every action attempt (executed or stale), so the step bound also covers failed presses
      stale_streak: null, // {key, count}: consecutive StalePage failures on one target on one page
      last_attempt: null, // {choice, fingerprint}: the target the last action attempt went for
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

  /** Counts a stale page by its reason (measurement only), then hands it back to be thrown. */
  _stale(state, error) {
    const reason = error?.message || "stale";
    state.stale_events[reason] = (state.stale_events[reason] ?? 0) + 1;
    return error;
  }

  /**
   * Counts consecutive StalePage failures on the same target on the same page. The action never ran, so no history
   * entry was pushed and the fingerprint did not move: without this bound the retry loop would never end.
   */
  _noteStaleFailure(state) {
    const attempt = state.last_attempt;
    if (!attempt) return 0;
    const key = `${attempt.fingerprint}|${attempt.choice}`;
    const count = state.stale_streak?.key === key ? state.stale_streak.count + 1 : 1;
    state.stale_streak = { key, count };
    return count;
  }

  /** Whether a full-viewport fixed overlay covers the failed target. Any failure keeps today's message. */
  async _coveredByOverlay(action) {
    if (!action || typeof this.tab.overlayCover !== "function") return false;
    try {
      return (await this.tab.overlayCover(action)) === true;
    } catch {
      return false;
    }
  }

  /** End a run whose target keeps failing on an unchanged page, with a reason the panel shows and logs. */
  async _stopAfterStale(state, count) {
    const target = state.last_attempt?.choice ?? "";
    const action = state.page.actions.find((a) => a.id === target) ?? null;
    const label = action?.label ?? target;
    const reason = (await this._coveredByOverlay(action))
      ? `有彈出視窗蓋住頁面，無法操作「${label}」；請關掉那個視窗（Traderie 的公告視窗請按右上角 ×，關一次之後會記住）再重新查詢`
      : `連續 ${count} 次都無法操作「${label}」（畫面沒有變化），查詢已停止`;
    state.status = "blocked";
    state.awaiting_handoff = false;
    state.scope_blocked_reason = reason;
    state.rule_events.push({ step: state.history.length, phase: state.phase, label, stale: true, count });
    state.stale_events[reason] = (state.stale_events[reason] ?? 0) + 1;
    state.elapsed_ms = this._elapsedMs();
  }

  /** this.choose plus its round trip as the client saw it (`choose_ms`, next to Jev's own `latency_ms`). */
  async _choose(...args) {
    const started = now();
    const decision = await this.choose(...args);
    return { ...decision, choose_ms: Math.round(now() - started) };
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

  /** Tick, predict, handoff or act. Prediction and execution stay separate commands: the caller can hold a decision. */
  async command(name, body = {}) {
    if (name === "tick") return this._tick();
    if (name === "predict") return this._predict();
    if (name === "handoff") return this._handoff();
    if (name === "act") return this._act(body);
    throw new Error("Unknown command");
  }

  /** Predict, then act. A stale page anywhere in the step recovers here: re-observe and stop; nothing is replayed. */
  async _tick() {
    const state = this.state;
    try {
      await this.command("predict", {});
      if (state.status !== "predicted" || !state.decision) return this.snapshot();
      return await this.command("act", { fingerprint: state.page.fingerprint });
    } catch (error) {
      if (!(error instanceof StalePage)) throw error;
      this._stale(state, error);
      const streak = this._noteStaleFailure(state);
      state.decision = null;
      await this._refreshForRetry(state);
      if (streak >= STALE_RETRY_LIMIT) await this._stopAfterStale(state, streak);
      return this.snapshot();
    }
  }

  /** Observe the page if it changed, then let Jev (or the mechanical loading rule) choose the next step. */
  async _predict() {
    const state = this.state;
    if (state.started_at === null) state.started_at = now();
    if (state.awaiting_handoff) throw new Error("Controller handoff required before continuing this run.");
    try {
      if (!(await this.tab.fresh(state.page))) state.page = await this.tab.observe();
    } catch (error) {
      if (error instanceof StalePage) await this._refreshForRetry(state);
      throw error;
    }
    state.decision = null;
    state.last_attempt = null; // only an action attempt (below) may extend a stale streak
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
    const budget = this.callBudget;
    if (budget.used + 2 > JEV_CALL_LIMIT) throw new Error(`Jev 呼叫次數已達這次查詢的上限（${JEV_CALL_LIMIT} 次），查詢已停止`);
    let decision = await this._choose(state.page, state.phase, phaseHistory);
    budget.used += decision.model_calls ?? 0;
    // Jev gave up on a page the caller can see is fine: ask once more without the BLOCKED option.
    if (
      decision.choice === "BLOCKED" &&
      this.vetoBlocked?.(state.page) &&
      state.veto_fingerprint !== state.page.fingerprint &&
      budget.used + 2 <= JEV_CALL_LIMIT
    ) {
      state.veto_fingerprint = state.page.fingerprint;
      state.decision = decision;
      state.decisions.push({ ...decision, vetoed: true, fingerprint: state.page.fingerprint, ...this._decisionInfo(state) });
      decision = await this._choose(state.page, state.phase, phaseHistory, { noBlock: true });
      budget.used += decision.model_calls ?? 0;
    }
    state.decision = decision;
    state.decisions.push({
      ...state.decision,
      fingerprint: state.page.fingerprint,
      elapsed_ms: this._elapsedMs(),
      ...this._decisionInfo(state),
    });
    state.status = "predicted";
    return this.snapshot();
  }

  /** The controller's handoff: re-observe the page and count the next phase's actions from here. */
  async _handoff() {
    const state = this.state;
    if (!state.awaiting_handoff) throw new Error("No phase handoff is pending.");
    state.awaiting_handoff = false;
    state.phase_start = state.history.length;
    await this._refreshForRetry(state);
    if (!this._applyScopeGuard(state)) state.status = "ready";
    state.elapsed_ms = this._elapsedMs();
    return this.snapshot();
  }

  /** Execute the pending decision once, then observe its result. The action is recorded before it can happen. */
  async _act(body) {
    const state = this.state;
    const decision = state.decision;
    const page = state.page;
    if (!decision || body.fingerprint !== page.fingerprint) throw new Error("Observe and choose before acting");
    // Consume once, before any mutation. A retry cannot double-click.
    state.decision = null;
    const selected = decision.choice;
    if (selected === "DONE" || selected === "BLOCKED") return await this._finishByVerdict(selected, page);

    state.last_attempt = { choice: selected, fingerprint: page.fingerprint };
    state.attempts += 1; // counts failed presses too: an action that keeps going stale still costs a step
    const { action, text } = await this._prepareAction(selected, page);
    await this._runAction(action, page, decision, selected, text);

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
    return this.snapshot();
  }

  /** A DONE or BLOCKED choice is a verdict about the page: it only stands while the page is still the same one. */
  async _finishByVerdict(selected, page) {
    const state = this.state;
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

  /** The element the decision chose (still on the page, and within the step budget) plus the text to type into it. */
  async _prepareAction(selected, page) {
    const state = this.state;
    const action = page.actions.find((a) => a.id === selected);
    if (!action) {
      await this._refreshForRetry(state);
      throw new StalePage("Chosen element is no longer available. Choose again.");
    }
    if (state.history.length >= MAX_STEPS || state.attempts > MAX_STEPS) {
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
    return { action, text };
  }

  /** Run the action and read the page it produced, keeping its history entry truthful at every step. */
  async _runAction(action, page, decision, selected, text) {
    const state = this.state;
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
      choose_ms: decision.choose_ms ?? null,
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
  }

  async close() {
    await this.tab.close();
  }
}
