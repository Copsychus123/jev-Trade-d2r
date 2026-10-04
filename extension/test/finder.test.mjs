import assert from "node:assert/strict";
import test from "node:test";

import { findAndRead } from "../src/traderie/finder.js";
import { indexTables } from "../src/traderie/lookup.js";
import { newMarket } from "../src/traderie/controller.js";

const ROOT = "https://www.traderie.com/diablo2resurrected";
const tables = indexTables({
  generated_at: "2026-01-01T00:00:00+00:00",
  products: [
    { name: "Harlequin Crest", slug: "harlequin-crest", category: "uniques" },
    { name: "Ring", slug: "ring", category: "base" },
  ],
  zh: {},
  bases: ["Ring", "Grand Charm"],
  game_only: [],
});

class FakeTab {
  constructor(url, page) {
    this.url = url;
    this.page = page;
    this.visited = [url];
  }
  async readSettledPage() {
    return this.page;
  }
  async evaluate() {
    return false; // no challenge frame
  }
  async navigate(url) {
    this.visited.push(url);
  }
  async settle() {}
  async close() {}
}

function setup({ landing, agents }) {
  const calls = { opened: [], picked: 0, runTokens: [], tab: null };
  const queue = [...agents];
  const session = {};
  const args = {
    rawItem: "harlequin crest",
    tables,
    loadMore: 0,
    startRun: async ({ itemName }) => ({ run_token: "t0", item_name: itemName, load_more: 0 }),
    pickBase: async (pickArgs) => {
      calls.picked += 1;
      calls.pickArgs = pickArgs;
      return calls.base;
    },
    openTab: async (url) => {
      calls.opened.push(url);
      calls.tab = new FakeTab(url, landing);
      return calls.tab;
    },
    // A stopped agent state ends runAgent at once, so only the finder's decisions are exercised.
    makeAgent: async (tab, run) => {
      calls.runTokens.push(run.run_token);
      return { state: queue.shift() };
    },
    market: newMarket(),
    session,
  };
  return { args, calls, session };
}

const done = { status: "done", page: { text: "product" } };
const noResults = { status: "blocked", page: { text: "Best Match\nNo results could be found" } };

test("a name in the table opens its product page directly and never searches or asks for a base", async () => {
  const { args, calls, session } = setup({
    landing: { url: `${ROOT}/product/harlequin-crest`, title: "Harlequin Crest - Diablo II: Resurrected (D2R) Trade" },
    agents: [done],
  });
  assert.equal(await findAndRead(args), "ran");
  assert.deepEqual(calls.opened, [`${ROOT}/product/harlequin-crest`]);
  assert.equal(args.market.lookup.layer, "table");
  assert.equal(calls.picked, 0);
  assert.equal(session.itemName, "Harlequin Crest");
});

test("a table page that is not the promised item falls back to search from the home page", async () => {
  const { args, calls } = setup({
    landing: { url: `${ROOT}/product/harlequin-crest`, title: "Shako - Diablo II: Resurrected (D2R) Trade" },
    agents: [done],
  });
  assert.equal(await findAndRead(args), "ran");
  assert.equal(args.market.lookup.layer, "search");
  assert.deepEqual(calls.tab.visited.at(-1), ROOT);
  assert.match(args.market.lookup.notes.join(" "), /改用搜尋/);
});

test("a site challenge on the table page stops the run instead of searching", async () => {
  const { args } = setup({ landing: { url: `${ROOT}/product/harlequin-crest`, title: "Just a moment...", text: "" }, agents: [] });
  assert.equal(await findAndRead(args), "guard");
});

test("an empty search falls to the base list once, then searches again with the picked base under a new token", async () => {
  const { args, calls, session } = setup({ landing: { url: ROOT, title: "t" }, agents: [noResults, done] });
  args.rawItem = "Rare Ring";
  calls.base = { base: "Ring", run_token: "t1" };
  assert.equal(await findAndRead(args), "ran");
  assert.equal(calls.picked, 1);
  assert.equal(calls.pickArgs.base, "Ring"); // matched by the program: Jev is not asked
  assert.deepEqual(calls.runTokens, ["t0", "t1"]);
  assert.equal(args.market.lookup.layer, "base");
  assert.equal(session.itemName, "Ring");
  assert.match(args.market.lookup.notes.join(" "), /Rare Ring.*Ring/);
});

test("when no base fits, the run ends as not found and does not search again", async () => {
  const { args, calls } = setup({ landing: { url: ROOT, title: "t" }, agents: [noResults] });
  args.rawItem = "Zzzz Qqqq";
  calls.base = { base: null };
  assert.equal(await findAndRead(args), "not_found");
  assert.equal(calls.pickArgs.base, null); // nothing to match by the program: Jev is asked
  assert.deepEqual(calls.runTokens, ["t0"]);
  assert.match(args.market.lookup.notes.join(" "), /打錯字/);
});

test("an empty search after the base search is not found, with no third try", async () => {
  const { args, calls } = setup({ landing: { url: ROOT, title: "t" }, agents: [noResults, noResults] });
  args.rawItem = "Rare Ring";
  calls.base = { base: "Ring", run_token: "t1" };
  assert.equal(await findAndRead(args), "not_found");
  assert.equal(calls.picked, 1);
});
