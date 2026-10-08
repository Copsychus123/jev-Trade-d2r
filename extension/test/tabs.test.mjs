import assert from "node:assert/strict";
import { test } from "node:test";

import { nextTab } from "../src/tabs.js";

const keys = ["trading", "recent_trades"];

test("arrow keys move between the tabs and wrap around", () => {
  assert.equal(nextTab(keys, "trading", "ArrowRight"), "recent_trades");
  assert.equal(nextTab(keys, "recent_trades", "ArrowRight"), "trading");
  assert.equal(nextTab(keys, "trading", "ArrowLeft"), "recent_trades");
});

test("Home and End jump to the first and last tab", () => {
  assert.equal(nextTab(keys, "recent_trades", "Home"), "trading");
  assert.equal(nextTab(keys, "trading", "End"), "recent_trades");
});

test("other keys, or an unknown tab, change nothing", () => {
  assert.equal(nextTab(keys, "trading", "Enter"), null);
  assert.equal(nextTab(keys, "nope", "ArrowRight"), null);
});
