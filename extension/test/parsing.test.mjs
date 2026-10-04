import assert from "node:assert/strict";
import test from "node:test";

import { parseRecentTrades, parseTradingTxt } from "../src/traderie/parsing.js";

const trade = (give, time) => `They Give\n1 X ${give}\nI Give\n1 X Pul Rune\nHigh Rune Value: 0\n${time}`;

test("recent trades keep old entries that show a date instead of 'N days ago'", () => {
  const text = [
    trade("Shako", "1 天前"),
    trade("Shako", "2026年10月1日"),
    trade("Shako", "2026年9月30日"),
    trade("Shako", "3 days ago"),
    "Load More",
  ].join("\n");
  const parsed = parseRecentTrades(text);
  assert.equal(parsed.trades.length, 4);
  assert.deepEqual(
    parsed.trades.map((t) => t.trade_time),
    ["1 天前", "2026年10月1日", "2026年9月30日", "3 days ago"],
  );
});

test("listings keep old entries that show a date, and a date inside a line does not end a listing", () => {
  const card = (seller, time) =>
    [seller, "1 X Axe", "PC •", "Softcore •", "Trading For", "1 X Pul Rune", time].join("\n");
  const text = ["Apply this search for all", card("alpha", "21 小時前"), card("beta", "2026年9月27日"),
    card("gamma", "2026年4月6日"), "HELP"].join("\n");
  const rows = parseTradingTxt(text, { itemName: "Axe" });
  assert.deepEqual(rows.map((r) => [r.seller, r.posted_time]),
    [["alpha", "21 小時前"], ["beta", "2026年9月27日"], ["gamma", "2026年4月6日"]]);
});
