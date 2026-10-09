import assert from "node:assert/strict";
import test from "node:test";

import { priceSummary } from "../src/traderie/price-summary.js";

const row = (highRuneValue) => ({ highRuneValue });

test("an empty batch has nothing to summarize", () => {
  assert.deepEqual(priceSummary([]), {
    count: 0,
    priced: 0,
    unpriced: 0,
    min: null,
    median: null,
    q1: null,
    q3: null,
    unit: "HRV",
  });
});

test("a single priced row is its own minimum and median but has no quartiles", () => {
  const summary = priceSummary([row("High Rune Value: 36")]);
  assert.equal(summary.count, 1);
  assert.equal(summary.priced, 1);
  assert.equal(summary.min, 36);
  assert.equal(summary.median, 36);
  assert.equal(summary.q1, null);
  assert.equal(summary.q3, null);
});

test("three rows are still too few a sample for quartiles", () => {
  const summary = priceSummary([row("High Rune Value: 1"), row("High Rune Value: 2"), row("High Rune Value: 3")]);
  assert.equal(summary.priced, 3);
  assert.equal(summary.min, 1);
  assert.equal(summary.median, 2);
  assert.equal(summary.q1, null);
  assert.equal(summary.q3, null);
});

test("four rows give nearest-rank quartiles over the sorted values", () => {
  const summary = priceSummary([
    row("High Rune Value: 4"),
    row("High Rune Value: 1"),
    row("High Rune Value: 3"),
    row("High Rune Value: 2"),
  ]);
  assert.equal(summary.priced, 4);
  assert.equal(summary.min, 1);
  assert.equal(summary.q1, 1);
  assert.equal(summary.median, 2);
  assert.equal(summary.q3, 3);
});

test("priced and unpriced rows are counted and only the priced ones are summarized", () => {
  const summary = priceSummary([
    row("High Rune Value: 36"),
    row("High Rune Value: 0.06"),
    row(null),
    row(""),
    row("Unknown"),
    row(3),
    row("High Rune Value: 0"),
  ]);
  assert.equal(summary.count, 7);
  assert.equal(summary.priced, 4);
  assert.equal(summary.unpriced, 3);
  assert.equal(summary.min, 0);
  assert.equal(summary.q1, 0);
  assert.equal(summary.median, 0.06);
  assert.equal(summary.q3, 3);
});

test("a zero High Rune Value counts as priced", () => {
  const summary = priceSummary([row("High Rune Value: 0")]);
  assert.equal(summary.priced, 1);
  assert.equal(summary.unpriced, 0);
  assert.equal(summary.median, 0);
});

test("rows keep their order, so summarizing does not sort the caller's batch", () => {
  const rows = [row("High Rune Value: 3"), row("High Rune Value: 1"), row("High Rune Value: 2")];
  const before = rows.map((r) => r.highRuneValue);
  priceSummary(rows);
  assert.deepEqual(
    rows.map((r) => r.highRuneValue),
    before,
  );
});

test("the parser's high_rune_value key is read as well", () => {
  const summary = priceSummary([{ high_rune_value: "High Rune Value: 5" }, { high_rune_value: null }]);
  assert.equal(summary.priced, 1);
  assert.equal(summary.median, 5);
});
