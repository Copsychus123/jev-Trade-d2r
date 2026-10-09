import assert from "node:assert/strict";
import test from "node:test";

import { AFFIXES } from "../src/ocr/affix_dictionary.js";
import { MAX_CONDITIONS } from "../src/traderie/stats.js";
import {
  addCondition,
  availableToAdd,
  startBlocker,
  NEED_SOMETHING,
  NEED_VALUES,
  FIX_LIMITS,
  emptyStatsForm,
  fillFromScreenshot,
  invalidKeys,
  onCount,
  removeCondition,
  setBase,
  setLimit,
  setOn,
  setQuality,
} from "../src/stats-form-state.js";

const row = (key, extra = {}) => ({ key, label: key, kind: "plain", line: key, min: 5, max: null, confident: false, on: false, ...extra });
const parsed = (...keys) => ({ conditions: keys.map((k) => row(k)), unmapped: ["+1 技能"] });
const rows = (...conditions) => ({ conditions, unmapped: ["+1 技能"] });

test("a screenshot ticks every attribute it read, confident or not", () => {
  const form = fillFromScreenshot(emptyStatsForm(), parsed("fcr", "life"), ["ethereal"]);
  assert.deepEqual(form.conditions.map((c) => [c.key, c.on, c.min, c.max]), [["fcr", true, null, null], ["life", true, null, null]]);
  assert.deepEqual(form.unavailable, ["ethereal"]);
});

test("one confident and one unsure reading are both ticked, every number box left empty", () => {
  const form = fillFromScreenshot(emptyStatsForm(), rows(row("fcr", { min: 7, confident: true }), row("life", { min: 5, confident: false })));
  assert.deepEqual(form.conditions.map((c) => [c.key, c.on]), [["fcr", true], ["life", true]]);
  assert.deepEqual(form.conditions.map((c) => [c.min, c.max]), [[null, null], [null, null]]);
  assert.ok(form.conditions.every((c) => !("confident" in c)));
});

test("a second screenshot keeps what the player switched on and changed, even for an affix it no longer shows", () => {
  let form = fillFromScreenshot(emptyStatsForm(), parsed("fcr", "life"));
  form = setLimit(setOn(form, "fcr", true), "fcr", "min", "25");
  form = setOn(form, "life", true);
  const next = fillFromScreenshot(form, parsed("fcr", "mana"));
  assert.deepEqual(next.conditions.map((c) => [c.key, c.on, c.min]), [["fcr", true, 25], ["mana", true, null], ["life", true, null]]);
});

test("with carryValues the numbers the reader read are filled in and marked as captured", () => {
  const reading = rows(row("fcr", { min: 7 }), row("life", { min: 141 }));
  const filled = fillFromScreenshot(emptyStatsForm(), reading, [], { carryValues: true });
  assert.deepEqual(
    filled.conditions.map((c) => [c.key, c.on, c.min, c.fromCapture]),
    [["fcr", true, 7, true], ["life", true, 141, true]],
  );
});

test("without carryValues nothing is filled and nothing is marked as captured", () => {
  const filled = fillFromScreenshot(emptyStatsForm(), rows(row("fcr", { min: 7 })));
  assert.deepEqual(filled.conditions.map((c) => [c.min, c.fromCapture]), [[null, false]]);
});

test("the player's own number survives a captured one, and stops being marked", () => {
  let form = fillFromScreenshot(emptyStatsForm(), rows(row("fcr", { min: 7 })));
  form = setLimit(setOn(form, "fcr", true), "fcr", "min", "25");
  const next = fillFromScreenshot(form, rows(row("fcr", { min: 7 }), row("life", { min: 141 })), [], { carryValues: true });
  assert.deepEqual(
    next.conditions.map((c) => [c.key, c.min, c.fromCapture ?? null]),
    [["fcr", 25, false], ["life", 141, true]],
  );
});

test("a condition Traderie has no property for is listed but not switched on", () => {
  const form = fillFromScreenshot(emptyStatsForm(), parsed("fcr", "eth"), ["eth"]);
  assert.deepEqual(form.conditions.map((c) => [c.key, c.on]), [["fcr", true], ["eth", false]]);
  assert.equal(setOn(form, "eth", true), form);
});

test("no more than the limit can be on at once", () => {
  let form = fillFromScreenshot(emptyStatsForm(), parsed("a", "b", "c"));
  for (const key of ["a", "b", "c"]) form = setOn(form, key, false);
  form = setOn(setOn(form, "a", true, 2), "b", true, 2);
  assert.equal(setOn(form, "c", true, 2), form);
  assert.equal(onCount(setOn(form, "a", false, 2)), 1);
});

test("no more than the limit is switched on from a screenshot", () => {
  const many = [];
  for (let i = 0; i < 9; i++) many.push(row(`k${i}`));
  const form = fillFromScreenshot(emptyStatsForm(), rows(...many));
  assert.equal(onCount(form), MAX_CONDITIONS);
  assert.equal(form.conditions.find((c) => c.key === `k${MAX_CONDITIONS - 1}`).on, true);
  assert.equal(form.conditions.find((c) => c.key === "k8").on, false);
});

test("limits: empty or invalid means none, and a typed minimum is stored without a confidence flag", () => {
  let form = fillFromScreenshot(emptyStatsForm(), parsed("fcr"));
  assert.deepEqual([form.conditions[0].min, form.conditions[0].max], [null, null]);
  assert.ok(!("confident" in form.conditions[0]));
  form = setLimit(form, "fcr", "min", "20");
  assert.equal(form.conditions[0].min, 20);
  assert.ok(!("confident" in form.conditions[0]));
  assert.equal(setLimit(form, "fcr", "min", "").conditions[0].min, null);
  assert.equal(setLimit(form, "fcr", "min", "-3").conditions[0].min, null);
  assert.equal(setLimit(form, "fcr", "max", "abc").conditions[0].max, null);
  assert.equal(setLimit(form, "fcr", "max", "30").conditions[0].max, 30);
});

test("searching needs a base name, and no upper limit below its lower one", () => {
  let form = setLimit(fillFromScreenshot(emptyStatsForm(), parsed("fcr")), "fcr", "min", "20");
  assert.equal(startBlocker(form), NEED_SOMETHING);
  assert.equal(startBlocker(setBase(form, " Ring ")), "");
  assert.equal(startBlocker(setBase(form, "  ")), NEED_SOMETHING);
  // having a condition on or quality set is still not enough without base
  assert.equal(startBlocker(setOn(form, "fcr", true)), NEED_SOMETHING);
  assert.equal(startBlocker(setQuality(form, "rare")), NEED_SOMETHING);
  form = setLimit(setLimit(setOn(setBase(form, "Ring"), "fcr", true), "fcr", "min", "20"), "fcr", "max", "10");
  assert.deepEqual(invalidKeys(form), ["fcr"]);
  assert.equal(startBlocker(form), FIX_LIMITS);
});

test("a ticked non-bool condition with no number stops the search and is named", () => {
  const form = setBase(rows(row("fcr", { label: "施法速度", min: null, on: true })), "Ring");
  assert.equal(startBlocker(form), NEED_VALUES + "施法速度");
});

test("every ticked non-bool condition without numbers is named, in list order", () => {
  const form = setBase(
    rows(row("fcr", { label: "施法速度", min: null, on: true }), row("life", { label: "生命", min: null, on: true })),
    "Ring",
  );
  assert.equal(startBlocker(form), NEED_VALUES + "施法速度、生命");
});

test("a ticked condition carrying only a minimum or only a maximum is enough, and zero counts", () => {
  assert.equal(startBlocker(setBase(rows(row("fcr", { label: "施法速度", min: 0, max: null, on: true })), "Ring")), "");
  assert.equal(startBlocker(setBase(rows(row("fcr", { label: "施法速度", min: null, max: 30, on: true })), "Ring")), "");
});

test("a ticked bool condition needs no number", () => {
  const form = setBase(rows(row("ethereal", { label: "無形", kind: "bool", min: null, max: null, on: true })), "Ring");
  assert.equal(startBlocker(form), "");
});

test("a maximum below its minimum is reported before the missing values", () => {
  const form = setBase(rows(row("fcr", { label: "施法速度", min: 8, max: 3, on: true })), "Ring");
  assert.equal(startBlocker(form), FIX_LIMITS);
});

test("no ticked condition is fine as long as there is a base", () => {
  const form = setBase(rows(row("fcr", { label: "施法速度", on: false })), "Ring");
  assert.equal(startBlocker(form), "");
});

test("an unticked non-bool condition with no number is never a reason", () => {
  const form = setBase(rows(row("fcr", { label: "施法速度", min: null, max: null, on: false })), "Ring");
  assert.equal(startBlocker(form), "");
});

test("the player can add a condition by hand, once, and remove it again", () => {
  const fcr = AFFIXES.find((a) => a.key === "fcr");
  let form = addCondition(emptyStatsForm(), fcr);
  assert.equal(addCondition(form, fcr), form);
  assert.deepEqual([form.conditions[0].key, form.conditions[0].label, form.conditions[0].on], ["fcr", "施法速度", false]);
  assert.ok(!("confident" in form.conditions[0]));
  assert.ok(!availableToAdd(form, AFFIXES).some((a) => a.key === "fcr"));
  assert.equal(removeCondition(form, "fcr").conditions.length, 0);
  assert.ok(availableToAdd(removeCondition(form, "fcr"), AFFIXES).some((a) => a.key === "fcr"));
});
