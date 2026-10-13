import assert from "node:assert/strict";
import test from "node:test";

import { readFileSync } from "node:fs";

import { parseRecentTrades, parseTradingTxt } from "../src/traderie/parsing.js";

const homeStats = readFileSync(new URL("../../tests/fixtures/home_stats.txt", import.meta.url), "utf8");

const trade = (give, time) => `They Give\n1 X ${give}\nI Give\n1 X Pul Rune\nHigh Rune Value: 0\n${time}`;

const DATED_TRADES = [
  trade("Shako", "1 天前"),
  trade("Shako", "2026年10月1日"),
  trade("Shako", "2026年9月30日"),
  trade("Shako", "3 days ago"),
  "Load More",
].join("\n");

const TAGGED_TRADES = [
  "They Give", "1 X Shako", "Nintendo Switch • ", "Hardcore • ", "Non Ladder • ", "Lord Of Destruction",
  "I Give", "1 X Pul Rune", "PC • ", "1 天前",
  "They Give", "1 X Shako", "I Give", "1 X Pul Rune", "2 days ago",
].join("\n");

const datedListing = (seller, time) =>
  [seller, "1 X Axe", "PC •", "Softcore •", "Trading For", "1 X Pul Rune", time].join("\n");

const DATED_LISTINGS = [
  "Apply this search for all", datedListing("alpha", "21 小時前"), datedListing("beta", "2026年9月27日"),
  datedListing("gamma", "2026年4月6日"), "HELP",
].join("\n");

const HOME_LISTING_CARDS = [
  "Marketplace", "Community", "Add Listing", "Stats", "Apply FiltersClear Filters",
  "Bsg2026", " (261)", "English", "1 X Caster Amulet", "Reign Of The Warlock • ", "Softcore • ", "PC • ", "Non Ladder",
  "+8% Faster Cast Rate", "+18 To Mana", "", "Trading For", "", "1 X Vex Rune", "High Rune Value: 0.5", "1 秒前",
  "Pro", "z_Diablo", " (12)", "1 X Ring", "PC •", "+10% Faster Cast Rate", "Make an Offer", "2 秒前",
  "Is trading items safe on Traderie?", "HELP", "Contact Us",
].join("\n");

const AFFIX_CARD = [
  "Apply this search for all",
  "Kenz11757", " (288)", "1 X Caster Amulet", "Reign Of The Warlock • ", "Softcore • ", "PC • ", "Non Ladder • ",
  "Rare • ", "Classic • ", "Penta",
  "+2 To Warlock Skills", "+8% Faster Cast Rate", "+116 Defense", "Ethereal", "Make an Offer", "0 秒前",
].join("\n");

test("recent trades keep old entries that show a date instead of 'N days ago'", () => {
  const parsed = parseRecentTrades(DATED_TRADES);
  assert.equal(parsed.trades.length, 4);
  assert.deepEqual(
    parsed.trades.map((t) => t.trade_time),
    ["1 天前", "2026年10月1日", "2026年9月30日", "3 days ago"],
  );
});

test("recent trades keep platform, mode, ladder and game version from the They Give side only", () => {
  const [a, b] = parseRecentTrades(TAGGED_TRADES).trades;
  assert.deepEqual([a.platform, a.mode, a.ladder, a.game_version],
    ["Switch", "Hardcore", "Non Ladder", "Lord of Destruction"]);
  assert.equal(a.buyer_or_seller, "1 X Shako");
  assert.deepEqual([b.platform, b.mode, b.ladder, b.game_version], [null, null, null, null]);
});

test("an empty item name means no known name, as in the Python reader", () => {
  // `itemName ? ... : null` already reads an empty name as "no known name" here; the Python twin used to treat it as a
  // name, which made `"" in line` pick the seller as the item. Pinned on both sides so they cannot drift again.
  const card = (seller) =>
    [seller, " (11)", "1 X Shako", "Softcore •", "PC •", "Ladder", "Trading For", "1 X Pul Rune", "1 分鐘前"].join("\n");
  for (const empty of ["", null]) {
    const rows = parseTradingTxt(card("seller"), { itemName: empty });
    assert.deepEqual(rows.map((r) => r.item_name), ["Shako"], String(empty));
  }
});


test("only ASCII digits make a time line, here and in the Python reader", () => {
  // Python's `\d` matches every Unicode digit while JavaScript's is ASCII, so a card whose time shows full-width digits
  // was kept by the Python reader and dropped here. Both patterns now say `[0-9]`; this is the case that differed.
  const card = (time) =>
    ["seller", "1 X Axe", "PC •", "Softcore •", "Trading For", "1 X Pul Rune", time].join("\n");
  assert.equal(parseTradingTxt(card("123 小時前"), { itemName: "Axe" })[0].posted_time, "123 小時前");
  assert.deepEqual(parseTradingTxt(card("１２３ 小時前"), { itemName: "Axe" }), []);
});


test("a seller name that starts with HELP does not end the listings early", () => {
  // The page's end-of-listings line is exactly "HELP" (measured: one line, between "Load More" and "Getting Started").
  // Reading it as a prefix cut the list at a seller called "HELPfulTrader", so the rows no longer matched the markers
  // and the whole trading read failed.
  const page = [
    "Apply this search for all", datedListing("alpha", "21 小時前"), datedListing("HELPfulTrader", "20 小時前"),
    datedListing("gamma", "19 小時前"), "HELP",
  ].join("\n");
  const rows = parseTradingTxt(page, { itemName: "Axe" });
  assert.deepEqual(rows.map((r) => r.seller), ["alpha", "HELPfulTrader", "gamma"]);
});

test("listings keep old entries that show a date, and a date inside a line does not end a listing", () => {
  const rows = parseTradingTxt(DATED_LISTINGS, { itemName: "Axe" });
  assert.deepEqual(rows.map((r) => [r.seller, r.posted_time]),
    [["alpha", "21 小時前"], ["beta", "2026年9月27日"], ["gamma", "2026年4月6日"]]);
});

// Real card lines from a Traderie listing of the original game: the tag reads "Classic (Base Game)".
const CLASSIC_CARD = [
  "koreaPOP", " (84)", "1 X Harlequin Crest", "Classic (Base Game) \u2022", "Softcore \u2022", "PC \u2022", "Ladder",
  "+139 Defense", "Trading For", "1 X Ist Rune", "OR", "2 X Mal Rune", "High Rune Value: 0.16 or 0.2", "1 \u5c0f\u6642\u524d",
];

test("a listing of the original game reads its version tag", () => {
  const [row] = parseTradingTxt(CLASSIC_CARD.join("\n"), { itemName: "Harlequin Crest" });
  assert.equal(row.seller, "koreaPOP");
  assert.deepEqual([row.platform, row.mode, row.ladder, row.game_version], ["PC", "Softcore", "Ladder", "Classic (Base Game)"]);
});

test("a recent trade of the original game reads its version tag and keeps it out of the item name", () => {
  const text = ["They Give", "1 X Shako", "Classic (Base Game) \u2022 ", "PC \u2022 ", "I Give", "1 X Pul Rune", "1 \u5929\u524d"].join("\n");
  const [trade] = parseRecentTrades(text).trades;
  assert.equal(trade.game_version, "Classic (Base Game)");
  assert.equal(trade.buyer_or_seller, "1 X Shako");
});

test("home page listings: the item, seller and ask of a card are found without a known item name", () => {
  const [a, b, ...rest] = parseTradingTxt(HOME_LISTING_CARDS, { itemName: null });
  assert.equal(rest.length, 0);
  assert.deepEqual([a.seller, a.rating, a.item_name, a.ask, a.posted_time], ["Bsg2026", "(261)", "Caster Amulet", "1 X Vex Rune", "1 秒前"]);
  assert.deepEqual([a.platform, a.mode, a.ladder], ["PC", "Softcore", "Non Ladder"]);
  assert.deepEqual([b.seller, b.rating, b.item_name, b.ask], ["z_Diablo", "(12)", "Ring", "Make an Offer"]);
  assert.deepEqual(a.affixes, ["+8% Faster Cast Rate", "+18 To Mana"]);
  assert.deepEqual(b.affixes, ["+10% Faster Cast Rate"]);
});

test("home page listings: affixes keep every affix line and drop the environment tags and variant words", () => {
  const [card] = parseTradingTxt(AFFIX_CARD, { itemName: null });
  assert.deepEqual(card.affixes, ["+2 To Warlock Skills", "+8% Faster Cast Rate", "+116 Defense", "Ethereal"]);
});

test("home page listings: a saved real page gives one row per listing marker, each with its own seller and item", () => {
  const rows = parseTradingTxt(homeStats, { itemName: null });
  const markers = homeStats.split("\n").filter((l) => ["Trading For", "Make an Offer"].includes(l.trim())).length;
  assert.ok(markers > 0);
  assert.equal(rows.length, markers);
  for (const row of rows) {
    assert.ok(row.item_name && !/^\d+\s*X\s/iu.test(row.item_name), row.item_name);
    assert.ok(row.seller && !["Marketplace", "Community", "Add Listing"].includes(row.seller), row.seller);
    assert.match(row.rating, /^\(\d[\d,]*\)$/u);
  }
});

test("home page text with no listing cards gives no rows", () => {
  assert.deepEqual(parseTradingTxt("Marketplace\nCommunity\nThere are no listings", { itemName: null }), []);
});
