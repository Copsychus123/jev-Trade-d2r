import assert from "node:assert/strict";
import test from "node:test";

import { newMarket, readView, verifyViews } from "../src/traderie/controller.js";
import { TRADERIE_D2R_URL } from "../src/traderie/site.js";

const RECENT_URL = `${TRADERIE_D2R_URL}/product/harlequin-crest/recent`;

class FakeTab {
  constructor(url, text, { more = false } = {}) {
    this.page = { url, title: "Harlequin Crest", text, settled: true };
    this.more = more;
  }

  async readSettledPage() {
    return this.page;
  }

  async evaluate(expression) {
    return expression.includes("load more") ? this.more : false;
  }
}

const lines = (...items) => items.join("\n");

test("recent view with a trade lacking its time line is FAILED as inconsistent", async () => {
  const text = lines(
    "Harlequin Crest",
    "They Give", "1 X Harlequin Crest", "I Give", "1 X Um Rune", "39 分鐘前",
    "They Give", "1 X Harlequin Crest", "I Give", "1 X Mal Rune",
  );
  const result = await readView(new FakeTab(RECENT_URL, text), "Harlequin Crest", "recent_trades");
  assert.equal(result.status, "FAILED");
  assert.match(result.reason, /不一致/);
});

test("recent view keeps every entry when page and table agree", async () => {
  const text = lines(
    "Harlequin Crest",
    "They Give", "1 X Harlequin Crest", "I Give", "1 X Um Rune", "39 分鐘前",
    "They Give", "1 X Harlequin Crest", "I Give", "1 X Mal Rune", "44 分鐘前",
  );
  const result = await readView(new FakeTab(RECENT_URL, text, { more: true }), "Harlequin Crest", "recent_trades");
  assert.equal(result.status, "PASSED");
  assert.deepEqual(result.rows.map((r) => r.price), ["1 X Um Rune", "1 X Mal Rune"]);
  assert.equal(result.has_more, true);
});

test("trading read on a recent URL fails with 不是掛單頁", async () => {
  const result = await readView(new FakeTab(RECENT_URL, "Harlequin Crest"), "Harlequin Crest", "trading");
  assert.equal(result.status, "FAILED");
  assert.match(result.reason, /不是掛單頁/);
});

test("a good trading and recent pair verifies", () => {
  const view = (url) => ({ status: "PASSED", reason: null, url, title: "Harlequin Crest", text: "Harlequin Crest" });
  const market = newMarket();
  market.trading = view(`${TRADERIE_D2R_URL}/product/a`);
  market.recent_trades = view(`${TRADERIE_D2R_URL}/product/a/recent`);
  const result = verifyViews("Harlequin Crest", market);
  assert.equal(result.passed, true);
  assert.equal(result.product_url, `${TRADERIE_D2R_URL}/product/a`);
});

const TRADING_URL = `${TRADERIE_D2R_URL}/product/harlequin-crest`;

test("an empty market is PASSED with no rows only when the page itself says so", async () => {
  const empty = await readView(
    new FakeTab(TRADING_URL, lines("Harlequin Crest", "There are no listings")), "Harlequin Crest", "trading");
  assert.deepEqual([empty.status, empty.rows.length], ["PASSED", 0]);
  const silent = await readView(new FakeTab(TRADING_URL, "Harlequin Crest"), "Harlequin Crest", "trading");
  assert.equal(silent.status, "FAILED");

  const none = await readView(
    new FakeTab(RECENT_URL, lines("Harlequin Crest", "There are no offers")), "Harlequin Crest", "recent_trades");
  assert.deepEqual([none.status, none.rows.length], ["PASSED", 0]);
  const unknown = await readView(new FakeTab(RECENT_URL, "Harlequin Crest"), "Harlequin Crest", "recent_trades");
  assert.equal(unknown.status, "FAILED");
});

test("a sign-in wall on the trades page is still BLOCKED even when an empty message is also present", async () => {
  const text = lines("Harlequin Crest", "Please sign in to view offers", "There are no offers");
  const result = await readView(new FakeTab(RECENT_URL, text), "Harlequin Crest", "recent_trades");
  assert.equal(result.status, "BLOCKED");
});
