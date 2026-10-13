import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RECENT_COLUMNS,
  STATS_COLUMNS,
  TRADING_COLUMNS,
  recentCells,
  statsCells,
  tradingCells,
} from "../src/traderie/controller.js";
import {
  LISTING_LAYOUT,
  RECENT_LAYOUT,
  STATS_LAYOUT,
  dash,
  filterLine,
  filteredAway,
  listingRow,
  recentRow,
  statsRow,
  tabCount,
  viewNote,
} from "../src/rows.js";

const full = {
  seller: "Dave",
  ask: "2 X Ist Rune",
  high_rune_value: "High Rune Value: 3.5",
  posted_time: "2 hours ago",
  platform: "PC",
  mode: "Softcore",
  ladder: "Ladder",
  defense: "Defense: 410",
  game_version: "Reign of the Warlock",
};

/** One view of the market, as viewNote/filteredAway/tabCount read it. */
const viewOf = (status, rows, reason = null) => ({ status, rows, reason });

/** Every cell of the parsed row is somewhere in the two-line row the table draws. */
function assertEveryCellReachesTheRow(cells, onScreen) {
  for (const cell of cells) assert.ok(onScreen.includes(String(cell)), `${cell} is missing from the row`);
}

test("the listing layout uses every column of the table, so a new column cannot be left off the screen", () => {
  const used = [LISTING_LAYOUT.price, LISTING_LAYOUT.seller, ...LISTING_LAYOUT.details];
  assert.deepEqual([...used].sort(), [...TRADING_COLUMNS].sort());
});

test("every cell the CSV gets also reaches the two-line row", () => {
  const cells = tradingCells(full);
  const row = listingRow(TRADING_COLUMNS, cells);
  assertEveryCellReachesTheRow(cells, [row.price, row.seller, ...row.details]);
  assert.equal(row.price, "2 X Ist Rune");
  assert.equal(row.seller, "Dave");
});

test("empty details are left out, empty price or seller show a dash", () => {
  const row = listingRow(TRADING_COLUMNS, tradingCells({ posted_time: "now", platform: "PC" }));
  assert.deepEqual(row.details, ["now", "PC"]);
  assert.equal(row.price, "—");
  assert.equal(row.seller, "—");
});

test("a missing column is an error instead of a silently empty row", () => {
  assert.throws(() => listingRow(RECENT_COLUMNS, ["a", "b", "c"]), /要價/);
});

test("dash replaces only a missing value, not zero", () => {
  assert.equal(dash(null), "—");
  assert.equal(dash(""), "—");
  assert.equal(dash(0), "0");
});

test("a tab with rows needs no note; an empty or failed one says why", () => {
  assert.equal(viewNote(viewOf("PASSED", [{}], null)), "");
  assert.equal(viewNote(viewOf("PASSED", [{}], "stale reason")), "");
  assert.equal(viewNote(viewOf("PASSED", [], "目前沒有掛單")), "目前沒有掛單");
  assert.equal(viewNote(viewOf("BLOCKED", [], "需要登入")), "需要登入");
  assert.equal(viewNote(viewOf("FAILED", [], null)), "讀取失敗");
  assert.equal(viewNote(viewOf("NOT_RUN", [], null)), "尚未讀取。");
});

const trade = {
  buyer_or_seller: "Shako",
  price: "1 X Ist Rune",
  trade_time: "2 days ago",
  platform: "PC",
  mode: "Softcore",
  ladder: "Ladder",
  game_version: "Reign of the Warlock",
};

test("both lists describe the environment with the same join and end with the game version", () => {
  assert.equal(TRADING_COLUMNS.at(-1), "遊戲版本");
  assert.equal(RECENT_COLUMNS.at(-1), "遊戲版本");
  assert.equal(tradingCells({ ...trade }).at(4), recentCells(trade).at(3));
  assert.equal(recentCells(trade).at(3), "PC / Softcore / Ladder");
  assert.equal(recentCells(trade).at(-1), "Reign of the Warlock");
});

test("the recent layout uses every recent column and every cell reaches the row", () => {
  assert.deepEqual([...[RECENT_LAYOUT.title, RECENT_LAYOUT.price, ...RECENT_LAYOUT.details]].sort(), [...RECENT_COLUMNS].sort());
  const cells = recentCells(trade);
  const row = recentRow(RECENT_COLUMNS, cells);
  assertEveryCellReachesTheRow(cells, [row.title, row.price, ...row.details]);
});

test("a recent row leaves out empty details and dashes an empty title or price", () => {
  const row = recentRow(RECENT_COLUMNS, recentCells({ trade_time: "now" }));
  assert.deepEqual(row.details, ["now"]);
  assert.equal(row.title, "—");
  assert.equal(row.price, "—");
});

test("a listing row puts the game version after the environment", () => {
  const row = listingRow(TRADING_COLUMNS, tradingCells({ posted_time: "now", platform: "PC", game_version: "LoD", defense: "D1" }));
  assert.deepEqual(row.details, ["now", "PC", "LoD", "D1"]);
});

test("a view that the filter empties says so, with how many rows were read", () => {
  const view = viewOf("PASSED", [{}, {}, {}]);
  assert.equal(viewNote(view, 0), "篩選後沒有符合的資料（原本讀到 3 筆）");
  assert.equal(viewNote(view, 2), "");
  assert.ok(filteredAway(view, 0));
  assert.ok(!filteredAway(view, 2));
});

test("a view that read zero rows keeps its own reason, filter or not", () => {
  const view = viewOf("PASSED", [], "目前沒有掛單");
  assert.equal(viewNote(view, 0), "目前沒有掛單");
  assert.ok(!filteredAway(view, 0));
});

test("the tab count is kept/read only while a filter is active", () => {
  const view = viewOf("PASSED", new Array(50).fill({}));
  assert.equal(tabCount(view, 50, false), "50");
  assert.equal(tabCount(view, 12, true), "12/50");
  assert.equal(tabCount(viewOf("NOT_RUN", []), 0, true), "");
});

test("the filter line names the filter, the hidden rows and the unlabelled ones", () => {
  const base = { description: "PC · Softcore", hidden: 38, unknown: 0, kept: 40, hasMore: true };
  assert.equal(filterLine(base), "篩選中：PC · Softcore　隱藏 38 筆");
  assert.match(filterLine({ ...base, unknown: 4 }), /（其中 4 筆網站沒標示）/);
});

test("the read-more hint needs few kept rows and more rows on the site", () => {
  const base = { description: "PC", hidden: 5, unknown: 0, kept: 9, hasMore: true };
  assert.match(filterLine(base), /多讀幾批/);
  assert.doesNotMatch(filterLine({ ...base, hasMore: false }), /多讀幾批/);
  assert.doesNotMatch(filterLine({ ...base, kept: 10 }), /多讀幾批/);
});

test("the stats layout uses every column of its table, and a row puts the item with the price and the seller beside it", () => {
  const used = [STATS_LAYOUT.title, STATS_LAYOUT.price, STATS_LAYOUT.seller, ...STATS_LAYOUT.details];
  assert.deepEqual([...used].sort(), [...STATS_COLUMNS].sort());
  const row = statsRow(STATS_COLUMNS, statsCells({ ...full, item_name: "Ring" }));
  assert.deepEqual([row.title, row.price, row.seller], ["Ring", "2 X Ist Rune", "Dave"]);
  assert.ok(row.details.includes("PC / Softcore / Ladder"));
  assert.equal(statsRow(STATS_COLUMNS, statsCells({})).title, "—");
});
