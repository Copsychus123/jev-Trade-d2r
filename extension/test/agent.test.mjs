import assert from "node:assert/strict";
import test from "node:test";

import { Agent, newCallBudget } from "../src/agent.js";
import { StalePage } from "../src/errors.js";

const URL_OK = "https://www.traderie.com/diablo2resurrected/product/1234567890";

const click = (id, label) => ({ id, kind: "click", label, node: 1 });
const SCROLL = { id: "scroll_bottom", kind: "scroll", label: "Scroll to bottom", delta: 3000 };

function page(fingerprint, actions, url = URL_OK) {
  return { url, title: "t", text: "x", actions, fingerprint, marker: fingerprint, page_key: "k", guards: {} };
}

class FakeTab {
  constructor(pages) {
    this.pages = [...pages];
    this.current = this.pages.shift();
    this.isFresh = true;
    this.acts = [];
  }
  async observe() {
    return this.current;
  }
  async fresh() {
    return this.isFresh;
  }
  async act(action, _page, text) {
    this.acts.push({ id: action.id, text });
    if (this.pages.length) this.current = this.pages.shift();
  }
  async waitUntilReady() {
    return true;
  }
  /** The page-side overlay measurement (`Tab.overlayCover`): the fake reports what the test tells it to. */
  async overlayCover() {
    this.overlayChecks = (this.overlayChecks ?? 0) + 1;
    if (this.overlayThrows) throw new Error("measurement failed");
    return this.overlayCovered ?? false;
  }
  async close() {}
}

const decide = (choice, operation = "CLICK") => ({
  choice,
  operation,
  target: null,
  probabilities: { [choice]: 0.9 },
  operation_probabilities: { [operation]: 0.9 },
  usage: {},
  reasked: null,
  model_calls: 1,
  latency_ms: 1,
});

function makeChoose(...decisions) {
  const calls = [];
  const choose = async (pg, phase, history) => {
    calls.push({ phase, history: history.length });
    return decisions.shift();
  };
  choose.calls = calls;
  return choose;
}

test("stale page on act raises StalePage and never acts", async () => {
  const fill = { id: "a1", kind: "fill", label: "Search", node: 5 };
  const tab = new FakeTab([page("p1", [fill])]);
  const agent = await Agent.create({ tab, text: "Harlequin", choose: makeChoose(decide("a1", "TYPE_TEXT")) });
  await agent.command("predict");
  tab.isFresh = false;
  await assert.rejects(agent.command("act", { fingerprint: "p1" }), StalePage);
  assert.equal(tab.acts.length, 0);
  assert.equal(agent.state.decision, null);
});

test("rule presses Load More without calling choose", async () => {
  const more = click("a2", "Load More");
  const tab = new FakeTab([page("p1", [SCROLL, more]), page("p2", [SCROLL, more]), page("p3", [SCROLL, more])]);
  const choose = makeChoose(decide("scroll_bottom", "SCROLL_BOTTOM"));
  const agent = await Agent.create({ tab, finishPhaseAfter: ["Load More", 5], choose });
  await agent.command("tick"); // Jev: scroll
  await agent.command("tick"); // rule: Load More
  assert.equal(choose.calls.length, 1);
  assert.deepEqual(
    tab.acts.map((a) => a.id),
    ["scroll_bottom", "a2"],
  );
  const last = agent.state.history.at(-1);
  assert.equal(last.by_rule, true);
  assert.equal(agent.state.history[0].by_rule, false);
  assert.equal(agent.state.rule_events.some((e) => e.press && e.label === "Load More"), true);
});

test("limit reached hands off, then finishes on the last phase", async () => {
  const more = click("a2", "Load More");
  const pages = ["p1", "p2", "p3", "p4"].map((f) => page(f, [SCROLL, more]));
  const tab = new FakeTab(pages);
  const choose = makeChoose(decide("a2"), decide("scroll_bottom", "SCROLL_BOTTOM"), decide("a2"));
  const agent = await Agent.create({ tab, finishPhaseAfter: ["Load More", 1], choose });
  await agent.command("tick");
  assert.equal(agent.state.status, "handoff");
  assert.equal(agent.state.awaiting_handoff, true);
  assert.equal(agent.state.phase, "recent_trades");
  await assert.rejects(agent.command("predict"), /handoff/i);
  await agent.command("handoff");
  assert.equal(agent.state.status, "ready");
  assert.equal(agent.state.phase_start, 1);
  await agent.command("tick"); // scroll in new phase
  await agent.command("tick"); // rule: Load More -> second phase counts its own presses
  assert.equal(agent.state.status, "done");
  assert.equal(agent.state.awaiting_handoff, false);
});

test("three clicks that change nothing block the run", async () => {
  const btn = click("a1", "Nothing");
  const same = page("p1", [btn]);
  const tab = new FakeTab([same, same, same, same]);
  const choose = makeChoose(decide("a1"), decide("a1"), decide("a1"));
  const agent = await Agent.create({ tab, choose });
  await agent.command("tick");
  await agent.command("tick");
  assert.equal(agent.state.status, "ready");
  await agent.command("tick");
  assert.equal(agent.state.status, "blocked");
});

test("fill types exactly the agent text", async () => {
  const fill = { id: "a1", kind: "fill", label: "Search", node: 5 };
  const tab = new FakeTab([page("p1", [fill]), page("p2", [fill])]);
  const agent = await Agent.create({ tab, text: "Harlequin Crest", choose: makeChoose(decide("a1", "TYPE_TEXT")) });
  await agent.command("tick");
  assert.deepEqual(tab.acts, [{ id: "a1", text: "Harlequin Crest" }]);
  assert.equal(agent.state.history[0].text, "Harlequin Crest");
});

test("the agent stops asking Jev when two more calls would not fit under the limit", async () => {
  const wait = { id: "wait", kind: "wait", label: "Wait" };
  const tab = new FakeTab([page("p1", [wait])]);
  let calls = 0;
  const choose = async () => {
    calls += 1;
    return decide("wait", "WAIT");
  };
  const agent = await Agent.create({ tab, text: "Harlequin", choose });
  let failure = null;
  for (let i = 0; i < 100 && !failure; i++) {
    try {
      await agent.command("tick");
    } catch (error) {
      failure = error;
    }
  }
  assert.match(failure.message, /上限（30 次）/);
  assert.equal(calls, 29); // 29 + 2 would exceed 30
});

test("the call limit counts the whole run: a second agent continues the first one's count", async () => {
  const wait = { id: "wait", kind: "wait", label: "Wait" };
  const callBudget = newCallBudget();
  let calls = 0;
  const choose = async () => {
    calls += 1;
    return decide("wait", "WAIT");
  };
  const first = await Agent.create({ tab: new FakeTab([page("p1", [wait])]), choose, callBudget });
  for (let i = 0; i < 10; i++) await first.command("tick");
  assert.equal(calls, 10);
  const second = await Agent.create({ tab: new FakeTab([page("p2", [wait])]), choose, callBudget });
  let failure = null;
  for (let i = 0; i < 100 && !failure; i++) {
    try {
      await second.command("tick");
    } catch (error) {
      failure = error;
    }
  }
  assert.match(failure.message, /上限（30 次）/);
  assert.equal(calls, 29); // the same ceiling as one agent: 10 + 19
});

test("a BLOCKED answer the caller vetoes is asked again once without the BLOCKED option", async () => {
  const tab = new FakeTab([page("p1", [click("e1", "Jewel")])]);
  const asked = [];
  const choose = async (_pg, _phase, _history, options = {}) => {
    asked.push(Boolean(options.noBlock));
    return options.noBlock ? decide("e1") : decide("BLOCKED", "BLOCKED");
  };
  const agent = await Agent.create({ tab, text: "Jewel", choose, vetoBlocked: () => true });
  await agent.command("predict");
  assert.deepEqual(asked, [false, true]);
  assert.equal(agent.state.decision.choice, "e1");
  assert.equal(agent.state.decisions.filter((d) => d.vetoed).length, 1);
});

test("a vetoed BLOCKED is asked again only once per page", async () => {
  const tab = new FakeTab([page("p1", [click("e1", "Jewel")])]);
  const choose = async () => decide("BLOCKED", "BLOCKED");
  const agent = await Agent.create({ tab, text: "Jewel", choose, vetoBlocked: () => true });
  await agent.command("predict");
  assert.equal(agent.state.decision.choice, "BLOCKED");
  assert.equal(agent.state.decisions.length, 2);
  await agent.command("predict");
  assert.equal(agent.state.decisions.length, 3); // same page: no second veto
});

/** A tab whose `act` throws StalePage for the given action ids (the element is covered), like resolveTarget null. */
class StaleTab extends FakeTab {
  constructor(pages, staleIds) {
    super(pages);
    this.staleIds = staleIds;
  }
  async act(action, _page, text) {
    if (this.staleIds.includes(action.id)) throw new StalePage("Target changed or is covered. Observe again.");
    return super.act(action, _page, text);
  }
}

test("a rule action whose target is always covered blocks the run after N attempts", async () => {
  const more = click("a2", "Load More");
  const tab = new StaleTab(
    ["p1", "p2"].map((f) => page(f, [SCROLL, more])),
    ["a2"],
  );
  const choose = makeChoose(decide("scroll_bottom", "SCROLL_BOTTOM"));
  const agent = await Agent.create({ tab, finishPhaseAfter: ["Load More", 5], choose });
  let ticks = 0;
  while (agent.state.status !== "blocked" && ticks < 20) {
    await agent.command("tick");
    ticks += 1;
  }
  assert.equal(agent.state.status, "blocked");
  assert.ok(ticks <= 5, `the tick loop must be bounded, but ran ${ticks} times`);
  assert.ok(agent.state.scope_blocked_reason && agent.state.scope_blocked_reason.length > 0);
  assert.equal(choose.calls.length, 1); // the mechanical rule itself asks Jev nothing
  assert.equal(agent.state.rule_events.some((e) => e.stale), true);
});

test("a model target that is never resolvable stops asking the model after N attempts", async () => {
  const covered = click("a1", "Load More");
  const tab = new StaleTab([page("p1", [covered])], ["a1"]);
  const choose = makeChoose(decide("a1"), decide("a1"), decide("a1"), decide("a1"));
  const agent = await Agent.create({ tab, choose });
  let ticks = 0;
  while (agent.state.status !== "blocked" && ticks < 20) {
    await agent.command("tick");
    ticks += 1;
  }
  assert.equal(agent.state.status, "blocked");
  assert.ok(ticks <= 5, `the tick loop must be bounded, but ran ${ticks} times`);
  assert.ok(choose.calls.length <= 3, `the model must not be re-asked forever, but was asked ${choose.calls.length} times`);
  assert.ok(agent.state.scope_blocked_reason && agent.state.scope_blocked_reason.length > 0);
});

/** Drive a run whose only target is always stale until it stops. */
async function runToStaleStop(tab) {
  const agent = await Agent.create({
    tab,
    choose: makeChoose(decide("a1"), decide("a1"), decide("a1"), decide("a1")),
  });
  for (let ticks = 0; agent.state.status !== "blocked" && ticks < 20; ticks += 1) await agent.command("tick");
  assert.equal(agent.state.status, "blocked");
  return agent;
}

test("a stale stop on a target under a full-viewport overlay tells the player to close the pop-up", async () => {
  const tab = new StaleTab([page("p1", [click("a1", "Load More")])], ["a1"]);
  tab.overlayCovered = true;
  const agent = await runToStaleStop(tab);
  assert.equal(
    agent.state.scope_blocked_reason,
    "有彈出視窗蓋住頁面，無法操作「Load More」；請關掉那個視窗（Traderie 的公告視窗請按右上角 ×，關一次之後會記住）再重新查詢",
  );
  assert.equal(agent.state.rule_events.some((e) => e.stale), true);
  assert.equal(agent.state.stale_events[agent.state.scope_blocked_reason], 1);
  assert.equal(tab.overlayChecks, 1); // measured once, only when the bound trips
});

test("a stale stop without an overlay, or with a failing measurement, keeps the plain message", async () => {
  const plain = "連續 3 次都無法操作「Load More」（畫面沒有變化），查詢已停止";
  for (const overlayThrows of [false, true]) {
    const tab = new StaleTab([page("p1", [click("a1", "Load More")])], ["a1"]);
    tab.overlayThrows = overlayThrows;
    const agent = await runToStaleStop(tab);
    const note = `overlayThrows=${overlayThrows}`;
    assert.equal(agent.state.scope_blocked_reason, plain, note);
    assert.equal(agent.state.rule_events.some((e) => e.stale), true, note);
    assert.equal(agent.state.stale_events[plain], 1, note);
    assert.equal(tab.overlayChecks, 1, note);
  }
});
