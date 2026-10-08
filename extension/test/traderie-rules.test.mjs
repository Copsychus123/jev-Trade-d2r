import assert from "node:assert/strict";
import test from "node:test";

import { AbortedError } from "../src/errors.js";
import { pageMatchesItem, readView, runAgent, step } from "../src/traderie/controller.js";
import { TIME_REGEX } from "../src/traderie/parsing.js";
import { TRADERIE_D2R_URL, isTraderieHost, productSection } from "../src/traderie/site.js";

const ROOT = `${TRADERIE_D2R_URL}/product/harlequin-crest`;
const ONE_TRADE = ["They Give", "1 X Harlequin Crest", "I Give", "1 X Um Rune", "39 分鐘前"].join("\n");

const tabFor = (url, text, { more = false, settled = true } = {}) => ({
  async readSettledPage() {
    return { url, title: "Harlequin Crest", text, settled };
  },
  async evaluate(expression) {
    if (!expression.includes("load more")) return false;
    if (more === "raise") throw new Error("probe failed");
    return more;
  },
});

test("only the product's own page has no section; /buying and /wiki are not the trading view", () => {
  assert.equal(productSection(ROOT), null);
  assert.equal(productSection(`${ROOT}/recent/`), "recent");
  assert.equal(productSection(`${ROOT}/buying`), "buying");
  assert.equal(isTraderieHost("https://WWW.Traderie.com/x"), true);
});

test("a page that never settled is a typed failure, not a silent pass", async () => {
  const result = await readView(tabFor(`${ROOT}/recent`, ONE_TRADE, { settled: false }), "Harlequin Crest", "recent_trades");
  assert.deepEqual([result.status, result.reason_code, result.settled], ["FAILED", "unsettled", false]);
});

test("has_more is unknown (null) when the Load More probe cannot run", async () => {
  const result = await readView(tabFor(`${ROOT}/recent`, ONE_TRADE, { more: "raise" }), "Harlequin Crest", "recent_trades");
  assert.deepEqual([result.status, result.has_more], ["PASSED", null]);
});

test("the title decides the item when the page has one", () => {
  assert.equal(pageMatchesItem("Harlequin Crest", "Shako - Traderie", "Harlequin Crest"), false);
  assert.equal(pageMatchesItem("Harlequin Crest", "", "Harlequin Crest"), true);
});

test("one regex ends a card for every relative time form", () => {
  for (const t of ["a day ago", "an hour ago", "just now", "2 週前", "3 周前", "4 個月前", "5 月前", "1 年前", "5m ago"]) {
    assert.ok(TIME_REGEX.test(t), t);
  }
  assert.ok(!TIME_REGEX.test("1 X Um Rune"));
});

function fakeAgent({ state, commands }) {
  const calls = [];
  return {
    state,
    tab: { evaluate: async () => null, readSettledPage: async () => ({ url: `${ROOT}`, title: "Harlequin Crest", text: "x" }) },
    calls,
    async command(name) {
      calls.push(name);
      return commands[name]?.(this);
    },
  };
}

test("controller work runs first even when the previous tick threw during a handoff", async () => {
  const agent = fakeAgent({
    state: { awaiting_handoff: true, status: "handoff" },
    commands: {
      handoff: (a) => { a.state.awaiting_handoff = false; a.state.status = "ready"; },
      tick: () => { throw new Error("stopped"); },
    },
  });
  const market = { trading: { status: "NOT_RUN" }, recent_trades: { status: "NOT_RUN" }, verification: null };
  await assert.rejects(step(agent, "Harlequin Crest", market), /stopped/);
  assert.deepEqual(agent.calls, ["handoff", "tick"]);
  assert.notEqual(market.trading.status, "NOT_RUN");
});

test("an aborted tick does not trigger page reads", async () => {
  const agent = fakeAgent({
    state: { awaiting_handoff: false, status: "ready" },
    commands: {
      tick: (a) => { a.state.status = "done"; throw new AbortedError(); },
    },
  });
  const market = { trading: { status: "PASSED" }, recent_trades: { status: "NOT_RUN" }, verification: null };
  await assert.rejects(step(agent, "Harlequin Crest", market), AbortedError);
  assert.equal(market.recent_trades.status, "NOT_RUN");
});

test("the run's last update already has the recent trades read when the agent finishes", async () => {
  const agent = fakeAgent({
    state: { awaiting_handoff: false, status: "ready" },
    commands: { tick: (a) => { a.state.status = "done"; return { status: "done" }; } },
  });
  agent.tab.readSettledPage = async () => ({ url: `${ROOT}/recent`, title: "Harlequin Crest", text: ONE_TRADE, settled: true });
  const market = {
    trading: { status: "PASSED", url: ROOT, title: "Harlequin Crest", text: "" },
    recent_trades: { status: "NOT_RUN" },
    verification: null,
  };
  const seen = [];
  await runAgent(agent, "Harlequin Crest", market, { onUpdate: (snapshot, m) => seen.push(m.recent_trades.status) });
  assert.deepEqual(seen, ["PASSED"]);
  assert.ok(market.verification);
});
