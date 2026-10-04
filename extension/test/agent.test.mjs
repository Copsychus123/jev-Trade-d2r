import assert from "node:assert/strict";
import test from "node:test";

import { Agent } from "../src/agent.js";
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
