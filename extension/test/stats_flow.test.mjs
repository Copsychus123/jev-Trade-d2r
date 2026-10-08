import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { newMarket } from "../src/traderie/controller.js";
import { PROPERTIES_KEY } from "../src/traderie/properties.js";
import { TRADERIE_D2R_URL } from "../src/traderie/site.js";
import { findAndReadStats } from "../src/traderie/stats_flow.js";

const list = readFileSync(new URL("../../tests/fixtures/home_stats.txt", import.meta.url), "utf8");
const apiProperties = JSON.parse(readFileSync(new URL("./fixtures/properties.json", import.meta.url), "utf8"));
const HOME_TEXT = ["Marketplace", "Stats", "Item Type", "Amulet", "Ring", "Skills", "Apply FiltersClear Filters"].join("\n");

class FlowTab {
  constructor({ home = HOME_TEXT, results = list, properties = { status: 200, body: apiProperties } } = {}) {
    Object.assign(this, { home, results, properties, url: TRADERIE_D2R_URL, navigated: [], fetches: 0 });
  }
  async readSettledPage() {
    const home = Array.isArray(this.home) ? (this.home.length > 1 ? this.home.shift() : this.home[0]) : this.home;
    return { url: this.url, title: "Traderie", text: this.url === TRADERIE_D2R_URL ? home : this.results, settled: true };
  }
  async navigate(url) {
    this.navigated.push(url);
    this.url = url;
  }
  async settle() {}
  async evaluate(expression) {
    if (expression.includes("properties?global=true")) {
      this.fetches += 1;
      return this.properties;
    }
    return false;
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

async function run(tab, input) {
  const market = newMarket();
  const session = { tab: null };
  const stages = [];
  const outcome = await findAndReadStats({
    conditions: [],
    base: "",
    quality: "any",
    openTab: async () => (session.tab = tab),
    scripts: { fetchJson: "(async (path) => path)" },
    store: new FakeStore(),
    market,
    session,
    onStatus: (text) => stages.push(text),
    ...input,
  });
  return { outcome, market, stages, tab };
}

test("a query opens the home page, reads Traderie's list, then the home page again with the filters in its address", async () => {
  const tab = new FlowTab();
  const { outcome, market } = await run(tab, {
    conditions: [cond("fcr", "施法速度", 10), cond("life", "生命", 36, false)],
    base: "Ring",
    quality: "rare",
  });
  assert.equal(outcome, "ran");
  assert.deepEqual(tab.navigated, [`${TRADERIE_D2R_URL}?prop_520Min=10&prop_Rarity=rare&tags[]=Ring`]);
  assert.equal(tab.fetches, 1);
  assert.equal(market.mode, "stats");
  assert.equal(market.lookup.stage, "read");
  assert.equal(market.lookup.description, "施法速度 ≥10、黃裝、類型 Ring");
  assert.equal(market.trading.status, "PASSED");
  assert.equal(market.verification.passed, true);
});

test("a page that listed everything because the filter was not applied fails the check that every listing has the condition", async () => {
  const { market } = await run(new FlowTab(), { conditions: [{ key: "all_skills", label: "所有技能", kind: "plain", on: true, min: 1, max: null }] });
  assert.ok(market.trading.rows.length > 0);
  assert.ok(market.verification.failed_checks.includes("rows_match_filters"));
  assert.equal(market.verification.passed, false);
});

test("a base keeps only listings whose item has that name, and says how many the page had", async () => {
  const { market } = await run(new FlowTab(), { conditions: [cond("fcr", "施法速度", 10)], base: "Ring" });
  assert.ok(market.trading.rows.length > 0);
  assert.ok(market.trading.rows.every((row) => row.item_name === "Ring"));
  assert.ok(market.trading.rows_before_base > market.trading.rows.length);
  assert.ok(market.lookup.notes.some((note) => note.includes("Ring")));
});

test("a base that is not a site item type is only a display filter, and the address has no type", async () => {
  const tab = new FlowTab();
  const { market } = await run(tab, { conditions: [cond("fcr", "施法速度", 10)], base: "Coronet" });
  assert.deepEqual(tab.navigated, [`${TRADERIE_D2R_URL}?prop_520Min=10`]);
  assert.ok(market.lookup.notes.some((note) => note.includes("Coronet")));
});

test("a condition Traderie has no property for stops the query before anything is opened with filters", async () => {
  const cut = { status: 200, body: { properties: apiProperties.properties.filter((p) => p.id !== 520) } };
  const tab = new FlowTab({ properties: cut });
  const { outcome, market } = await run(tab, { conditions: [cond("fcr", "施法速度", 10)] });
  assert.equal(outcome, "unmapped");
  assert.deepEqual(market.lookup.unmapped, ["fcr"]);
  assert.equal(market.lookup.stage, "apply");
  assert.deepEqual(tab.navigated, []);
});

test("a challenge page on the home page ends the query before Traderie's list is asked for", async () => {
  const tab = new FlowTab({ home: "Please complete the CAPTCHA" });
  const { outcome } = await run(tab, { conditions: [cond("fcr", "施法速度", 10)] });
  assert.equal(outcome, "guard");
  assert.equal(tab.fetches, 0);
});

test("a quality Traderie's list cannot filter on is noted, not silently dropped", async () => {
  const cut = { status: 200, body: { properties: apiProperties.properties.filter((p) => p.name !== "Rarity") } };
  const tab = new FlowTab({ properties: cut });
  const { market } = await run(tab, { conditions: [cond("fcr", "施法速度", 10)], quality: "magic" });
  assert.deepEqual(tab.navigated, [`${TRADERIE_D2R_URL}?prop_520Min=10`]);
  assert.ok(market.lookup.notes.some((note) => note.includes("品質")));
});

test("nothing to filter on is refused with a sentence the player can act on", async () => {
  await assert.rejects(run(new FlowTab(), { base: "Coronet" }), /至少勾選一個詞綴條件/u);
});

test("a refused property list is an error and nothing is stored", async () => {
  const store = new FakeStore();
  const tab = new FlowTab({ properties: { status: 403, body: "Just a moment" } });
  await assert.rejects(run(tab, { conditions: [cond("fcr", "施法速度", 10)], store }), /HTTP 403/u);
  assert.equal(PROPERTIES_KEY in store.data, false);
});

test("the property list of an earlier query is reused", async () => {
  const store = new FakeStore();
  await run(new FlowTab(), { conditions: [cond("fcr", "施法速度", 10)], store });
  const second = new FlowTab();
  await run(second, { conditions: [cond("fcr", "施法速度", 10)], store });
  assert.equal(second.fetches, 0);
});

test("a search nothing matches ends with a sentence", async () => {
  const none = "Marketplace\nStats\nActive Filters\n+X% Faster Cast Rate\nApply FiltersClear Filters\nThere are no listings";
  const { outcome, market } = await run(new FlowTab({ results: none }), { conditions: [cond("fcr", "施法速度", 10)], base: "Ring" });
  assert.equal(outcome, "ran");
  assert.equal(market.trading.rows.length, 0);
  assert.ok(market.lookup.notes.includes("沒有符合條件的掛單"));
  assert.equal(market.verification.passed, true);
});

test("the sidebar's type list that is drawn late is waited for before a base is called 'not a type'", async () => {
  const tab = new FlowTab({ home: ["Marketplace\nStats", HOME_TEXT] });
  await run(tab, { conditions: [cond("fcr", "施法速度", 10)], base: "Ring" });
  assert.deepEqual(tab.navigated, [`${TRADERIE_D2R_URL}?prop_520Min=10&tags[]=Ring`]);
  const never = new FlowTab({ home: "Marketplace\nStats" });
  const { market } = await run(never, { conditions: [cond("fcr", "施法速度", 10)], base: "Ring" });
  assert.deepEqual(never.navigated, [`${TRADERIE_D2R_URL}?prop_520Min=10`]);
  assert.ok(market.lookup.notes.some((note) => note.includes("不是網站的物品類型")));
});
