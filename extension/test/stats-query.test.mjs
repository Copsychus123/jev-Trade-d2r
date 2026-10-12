// The affix search as the side panel runs it (stats-query.js::runStatsFlow): what it tells the running screen, what
// address the session is sent to, when a stop request cuts it short and what it hands back. The panel owns the tab and
// the market, so a fake tab, a fake store and fake hooks below make the whole flow run offline. `stats_flow.test.mjs`
// already covers the page flow itself (findAndReadStats); this file pins the panel-side decisions that wrap it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { Tab } from "../src/cdp.js";
import { runStatsFlow } from "../src/stats-query.js";
import { newMarket } from "../src/traderie/controller.js";
import { indexTables } from "../src/traderie/lookup.js";
import { TRADERIE_D2R_URL } from "../src/traderie/site.js";

const listText = readFileSync(new URL("../../tests/fixtures/home_stats.txt", import.meta.url), "utf8");
const properties = JSON.parse(readFileSync(new URL("./fixtures/properties.json", import.meta.url), "utf8"));
const HOME_TEXT = ["Marketplace", "Stats", "Item Type", "Amulet", "Ring", "Skills", "Apply FiltersClear Filters"].join("\n");

const tables = indexTables({
  generated_at: "2026-01-01T00:00:00+00:00",
  products: [{ name: "Ring", slug: "ring", category: "base" }],
  zh: { 戒指: "Ring" },
  bases: ["Ring"],
  game_only: [],
});

/** The tab `Tab.open` hands back: the home read, the property list, and the filtered read's address are all it serves. */
class FlowTab {
  constructor(url) {
    this.url = url;
    this.navigated = [];
  }
  async readSettledPage() {
    return {
      url: this.url,
      title: "Traderie",
      text: this.url === TRADERIE_D2R_URL ? HOME_TEXT : listText,
      settled: true,
    };
  }
  async navigate(url) {
    this.navigated.push(url);
    this.url = url;
  }
  async settle() {}
  async evaluate(expression) {
    // Keyed on the path shape, not Traderie's exact query string: `loadProperties` owns the flags.
    return expression.includes("/properties?") ? { status: 200, body: properties } : false;
  }
}

class FakeStore {
  data = {};
  async get(key) {
    return key in this.data ? { [key]: this.data[key] } : {};
  }
  async set(values) {
    Object.assign(this.data, values);
  }
}

const cond = (key, label, min, on = true) => ({ key, label, kind: "percent", on, min, max: null });

// The flow builds its own `openTab` from `Tab.open`, which the panel owns; the real one opens a chrome window, so the
// test records the addresses it is asked for and hands back the fake tab instead.
const openedUrls = [];
let openedTabs = [];
const realTabOpen = Tab.open;
Tab.open = async (url) => {
  openedUrls.push(url);
  const tab = new FlowTab(url);
  openedTabs.push(tab);
  return tab;
};
// The patch is a test fixture; put the real opener back so this file cannot leak it into another.
test.after(() => {
  Tab.open = realTabOpen;
});

function installGlobals(store) {
  globalThis.fetch = async () => ({ text: async () => "(async (path) => path)" }); // what loadPageScripts reads
  globalThis.chrome = { runtime: { getURL: (path) => `chrome-extension://test/${path}` }, storage: { local: store } };
}

async function run(input, { shouldStop = () => false } = {}) {
  openedUrls.length = 0;
  openedTabs = [];
  const store = new FakeStore();
  installGlobals(store);
  const session = { tab: null };
  const calls = { begin: [], status: [], renders: 0, painted: [] };
  const hooks = {
    begin: (text) => {
      calls.begin.push(text);
      calls.market = newMarket();
      return calls.market;
    },
    setStatus: (text) => calls.status.push(text),
    render: () => {
      calls.renders += 1;
      calls.painted.push(calls.status.length); // how many statuses had been reported when this paint ran
    },
    shouldStop,
    loadTables: async () => tables,
  };
  const returned = await runStatsFlow(input, session, hooks);
  return { returned, session, calls, store, tabs: openedTabs, urls: [...openedUrls] };
}

test("the running screen names the ticked labels, the quality and the resolved base, and the session goes to the filtered address", async () => {
  const { returned, session, calls, tabs, urls } = await run({
    base: "Ring",
    quality: "rare",
    conditions: [cond("fcr", "施法速度", 10), cond("life", "生命", 36, false)],
  });
  assert.deepEqual(calls.begin, ["施法速度・黃裝・Ring"], "only the ticked labels, then the quality, then the base");
  assert.equal(returned, "Ring");
  assert.deepEqual(urls, [TRADERIE_D2R_URL], "the home page is the only page opened fresh");
  assert.deepEqual(tabs[0].navigated, [`${TRADERIE_D2R_URL}?prop_520Min=10&prop_Rarity=rare&tags[]=Ring`]);
  assert.equal(session.outcome, "ran");
});

test("no base and the 'any' quality leave only the ticked labels in the running screen", async () => {
  const { returned, calls } = await run({
    base: "  ",
    quality: "any",
    conditions: [cond("fcr", "施法速度", 10)],
  });
  assert.deepEqual(calls.begin, ["施法速度"]);
  assert.equal(returned, "stats", "with no base the downloads fall back to the plain name");
});

test("a Chinese base is translated before it is named and searched", async () => {
  const { returned, calls, tabs } = await run({
    base: "戒指",
    quality: "rare",
    conditions: [cond("fcr", "施法速度", 10)],
  });
  assert.equal(returned, "Ring", "the resolved English name is what comes back");
  assert.deepEqual(calls.begin, ["施法速度・黃裝・Ring"]);
  assert.deepEqual(tabs[0].navigated, [`${TRADERIE_D2R_URL}?prop_520Min=10&prop_Rarity=rare&tags[]=Ring`]);
});

test("a base the tables do not know is passed back as typed and stays a display filter", async () => {
  const { returned, tabs } = await run({
    base: "Coronet",
    quality: "any",
    conditions: [cond("fcr", "施法速度", 10)],
  });
  assert.equal(returned, "Coronet");
  assert.deepEqual(tabs[0].navigated, [`${TRADERIE_D2R_URL}?prop_520Min=10`], "an unknown base adds no type parameter");
});

test("a stop request once the filters are planned ends the query without opening the filtered page", async () => {
  const { returned, session, tabs } = await run(
    { base: "Ring", quality: "rare", conditions: [cond("fcr", "施法速度", 10)] },
    { shouldStop: () => true },
  );
  assert.deepEqual(tabs[0].navigated, [], "the filtered address is never opened");
  assert.equal(session.outcome, "ran", "a stop is an ordinary end, not a failure");
  assert.equal(returned, "Ring");
});

test("the running screen is prepared once, then every later status is painted", async () => {
  const { calls } = await run({ base: "Ring", quality: "rare", conditions: [cond("fcr", "施法速度", 10)] });
  assert.equal(calls.status[0], "正在準備…");
  assert.equal(calls.status.filter((s) => s === "正在準備…").length, 1, "the preparation is reported once, not by every later step");
  assert.ok(calls.status.includes("開啟 Traderie 首頁…"));
  assert.ok(calls.status.includes("讀取符合條件的掛單…"));
  assert.ok(calls.renders >= 1, "the running screen is painted as the query reports progress");
  assert.equal(calls.painted.at(-1), calls.status.length, "the last status is painted once it is reported");
});
