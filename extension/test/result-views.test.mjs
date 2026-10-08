import assert from "node:assert/strict";
import test from "node:test";

import { openable, tabKeysFor, viewConfigFor } from "../src/result-views.js";
import { STATS_COLUMNS, TRADING_COLUMNS } from "../src/traderie/controller.js";
import { TRADERIE_D2R_URL } from "../src/traderie/site.js";

test("the affix search shows its own columns in the trading slot and has no recent-trades tab", () => {
  assert.equal(viewConfigFor({ mode: "stats" }, "trading").head, STATS_COLUMNS);
  assert.equal(viewConfigFor({ mode: "name" }, "trading").head, TRADING_COLUMNS);
  assert.deepEqual(tabKeysFor({ mode: "stats" }), ["trading"]);
  assert.deepEqual(tabKeysFor({ mode: "name" }), ["trading", "recent_trades"]);
});

test("only a product page or the D2R home page can be opened from the results", () => {
  assert.equal(openable(`${TRADERIE_D2R_URL}?prop_520Min=1`), true);
  assert.equal(openable(`${TRADERIE_D2R_URL}/product/ring`), true);
  assert.equal(openable("https://example.com/"), false);
  assert.equal(openable(""), false);
});
