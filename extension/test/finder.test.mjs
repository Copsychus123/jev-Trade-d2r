import assert from "node:assert/strict";
import test from "node:test";

import { findAndRead } from "../src/traderie/finder.js";
import { indexTables } from "../src/traderie/lookup.js";
import { newMarket } from "../src/traderie/controller.js";

const ROOT = "https://www.traderie.com/diablo2resurrected";
const CREST_TITLE = "Harlequin Crest - Diablo II: Resurrected (D2R) Trade";
const SHAKO_TITLE = "Shako - Diablo II: Resurrected (D2R) Trade";

/** A fresh per-run table-jump counter, so each test's misses and jumps start from zero. */
const freshTableStats = () => ({ jumps: 0, misses: 0 });
const tables = indexTables({
  generated_at: "2026-01-01T00:00:00+00:00",
  products: [
    { name: "Harlequin Crest", slug: "harlequin-crest", category: "uniques" },
    { name: "Ring", slug: "ring", category: "base" },
  ],
  zh: { 哈勒昆之冠: "Harlequin Crest", 戒指: "Ring", 大型護身符: "Grand Charm" },
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
    landing: { url: `${ROOT}/product/harlequin-crest`, title: CREST_TITLE },
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
    landing: { url: `${ROOT}/product/harlequin-crest`, title: SHAKO_TITLE },
    agents: [done],
  });
  assert.equal(await findAndRead(args), "ran");
  assert.equal(args.market.lookup.layer, "search");
  assert.deepEqual(calls.tab.visited.at(-1), ROOT);
  assert.match(args.market.lookup.notes.join(" "), /改用搜尋/);
});

test("table jumps and misses are counted across runs and each miss note says how old the table is", async () => {
  const tableStats = freshTableStats();
  const wrong = { url: `${ROOT}/product/harlequin-crest`, title: SHAKO_TITLE };
  const right = { url: `${ROOT}/product/harlequin-crest`, title: CREST_TITLE };
  const notes = [];
  for (const landing of [right, wrong, wrong]) {
    const { args } = setup({ landing, agents: [done] });
    await findAndRead({ ...args, tableStats });
    notes.push(args.market.lookup.notes.join(" "));
  }
  assert.deepEqual(tableStats, { jumps: 3, misses: 2 });
  assert.equal(notes[0], "");
  assert.match(notes[1], /查表落空 1\/2 次/);
  assert.match(notes[2], /查表落空 2\/3 次/);
  assert.match(notes[2], /名稱表更新於 2026-01-01/);
});

test("a site challenge on the table page is not counted as a miss", async () => {
  const tableStats = freshTableStats();
  const { args } = setup({ landing: { url: `${ROOT}/product/harlequin-crest`, title: "Just a moment...", text: "" }, agents: [] });
  assert.equal(await findAndRead({ ...args, tableStats }), "guard");
  assert.deepEqual(tableStats, { jumps: 1, misses: 0 });
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

test("a table landing whose page never settles is a miss and search takes over", async () => {
  const { args, calls } = setup({
    landing: { url: `${ROOT}/product/harlequin-crest`, title: "Harlequin Crest" },
    agents: [done],
  });
  const stuck = new FakeTab(`${ROOT}/product/harlequin-crest`, null);
  stuck.readSettledPage = async () => {
    throw new Error("never settled");
  };
  args.openTab = async (url) => {
    calls.opened.push(url);
    calls.tab = stuck;
    return stuck;
  };
  const tableStats = freshTableStats();
  assert.equal(await findAndRead({ ...args, tableStats }), "ran");
  assert.equal(args.market.lookup.layer, "search");
  assert.deepEqual(tableStats, { jumps: 1, misses: 1 });
  assert.match(args.market.lookup.notes.join(" "), /商品頁沒有載入完成/u);
  assert.equal(calls.tab.visited.at(-1), ROOT);
});

// --- Traderie is always queried in English, whatever the name field shows -------------------------------------------

test("a Chinese name in the field reaches the backend, the product page and the search as its English name", async () => {
  const { args, calls, session } = setup({
    landing: { url: `${ROOT}/product/harlequin-crest`, title: CREST_TITLE },
    agents: [done],
  });
  const asked = [];
  args.startRun = async ({ itemName }) => {
    asked.push(itemName);
    return { run_token: "t0", item_name: itemName, load_more: 0 };
  };
  args.rawItem = "哈勒昆之冠";
  assert.equal(await findAndRead(args), "ran");
  assert.deepEqual(asked, ["Harlequin Crest"], "the backend is told the English name");
  assert.deepEqual(calls.opened, [`${ROOT}/product/harlequin-crest`], "the table jump uses the product slug");
  assert.equal(session.itemName, "Harlequin Crest", "and the name the search types is English");
  assert.equal(args.market.lookup.requested, "Harlequin Crest");
  assert.equal(args.market.lookup.used, "Harlequin Crest");
});

test("a Chinese name whose product page misses is searched in English, never in Chinese", async () => {
  const { args, session } = setup({
    landing: { url: `${ROOT}/product/harlequin-crest`, title: SHAKO_TITLE },
    agents: [done],
  });
  args.rawItem = "哈勒昆之冠";
  assert.equal(await findAndRead(args), "ran");
  assert.equal(args.market.lookup.layer, "search");
  assert.equal(session.itemName, "Harlequin Crest");
  assert.doesNotMatch(session.itemName, /[\u3400-\u9fff]/u);
});

test("a Chinese base name is queried as the English base, also through the base layer", async () => {
  const { args, calls, session } = setup({ landing: { url: ROOT, title: "t" }, agents: [noResults, done] });
  const asked = [];
  args.startRun = async ({ itemName }) => {
    asked.push(itemName);
    return { run_token: "t0", item_name: itemName, load_more: 0 };
  };
  args.rawItem = "大型護身符";
  calls.base = { base: "Grand Charm", run_token: "t1" };
  assert.equal(await findAndRead(args), "ran");
  assert.deepEqual(asked, ["Grand Charm"]);
  assert.deepEqual(calls.pickArgs.options, tables.bases);
  assert.equal(session.itemName, "Grand Charm");
});

test("a Chinese name that is not in the table stops before the backend or the browser is touched", async () => {
  const { args, calls } = setup({ landing: { url: ROOT, title: "t" }, agents: [] });
  let started = 0;
  args.startRun = async () => {
    started += 1;
    return { run_token: "t0", item_name: "x", load_more: 0 };
  };
  for (const rawItem of ["不存在的裝備", "Ring 戒指", "稀有戒指"]) {
    args.rawItem = rawItem;
    await assert.rejects(findAndRead(args), /對照表裡沒有「.+」的英文名稱/u);
  }
  assert.equal(started, 0, "no run was started, so no quota was used");
  assert.deepEqual(calls.opened, [], "and no tab was opened");
  assert.equal(calls.picked, 0);
});
