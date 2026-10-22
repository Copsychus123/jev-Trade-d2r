import assert from "node:assert/strict";
import { test } from "node:test";

import { VIEWS, affixHandoff, deriveView, visibleSections } from "../src/panel-state.js";

const base = { settingsOpen: false, hasInvite: true, running: false, after: null, mode: "name" };

test("settings win over everything, then the missing invite, then a running query", () => {
  assert.equal(deriveView({ ...base, settingsOpen: true, running: true }), "settings");
  assert.equal(deriveView({ ...base, hasInvite: false, running: true }), "welcome");
  assert.equal(deriveView({ ...base, running: true, after: "done" }), "running");
});

test("with no screen asked for the idle panel is on the scan screen, but settings, welcome, running and a finished query win", () => {
  assert.equal(deriveView({ ...base, mode: null }), "scan");
  assert.equal(deriveView({ ...base, mode: null, settingsOpen: true }), "settings");
  assert.equal(deriveView({ ...base, mode: null, hasInvite: false }), "welcome");
  assert.equal(deriveView({ ...base, mode: null, running: true }), "running");
  assert.equal(deriveView({ ...base, mode: null, after: "done" }), "done");
  assert.equal(VIEWS.includes("choose"), false, "there is no first-choice screen any more");
});

test("the scan screen shows only itself and loses to settings, welcome, running and a finished query", () => {
  assert.equal(deriveView({ ...base, mode: "scan" }), "scan");
  assert.equal(deriveView({ ...base, mode: "scan", settingsOpen: true }), "settings");
  assert.equal(deriveView({ ...base, mode: "scan", hasInvite: false }), "welcome");
  assert.equal(deriveView({ ...base, mode: "scan", running: true }), "running");
  assert.equal(deriveView({ ...base, mode: "scan", after: "done" }), "done");
  assert.deepEqual([...visibleSections("scan", true)], ["scan"]);
});

test("the listing screen shows only itself, like the scan screen", () => {
  assert.equal(deriveView({ ...base, mode: "listing" }), "listing");
  assert.equal(deriveView({ ...base, mode: "listing", settingsOpen: true }), "settings");
  assert.equal(deriveView({ ...base, mode: "listing", running: true }), "running");
  assert.deepEqual([...visibleSections("listing", true)], ["listing"]);
});

test("with nothing running the screen follows how the last query ended", () => {
  assert.equal(deriveView(base), "ready");
  for (const after of ["done", "problem", "stopped"]) assert.equal(deriveView({ ...base, after }), after);
});

test("the query form and the results show together only on the form screen", () => {
  assert.ok(visibleSections("ready", true).has("form"));
  assert.ok(!visibleSections("running", true).has("form"));
  assert.ok(!visibleSections("done", true).has("form"));
});

test("the results stay hidden until a table has rows", () => {
  for (const view of ["ready", "running", "done", "problem", "stopped"]) {
    assert.ok(visibleSections(view, true).has("results"), view);
    assert.ok(!visibleSections(view, false).has("results"), view);
  }
});

test("welcome and settings show nothing else", () => {
  assert.deepEqual([...visibleSections("welcome", true)], ["welcome"]);
  assert.deepEqual([...visibleSections("settings", true)], ["settings"]);
});

test("the trust line belongs to the finished screen only", () => {
  assert.deepEqual(
    VIEWS.filter((view) => visibleSections(view, false).has("trust")),
    ["done"],
  );
});

test("the affix hand-off says what it does: a way out of a failed name search, a way to narrow a finished affix search", () => {
  const scan = { kind: "scan", record: { name: "Alma Negra" } };
  const handoff = (view, source, ended, mode) => affixHandoff(visibleSections(view, true), source, ended, mode);
  assert.equal(handoff("problem", scan, "problem", "name"), "用詞綴找同類");
  assert.equal(handoff("stopped", scan, "stopped", "name"), "用詞綴找同類");
  // A finished name search already gave its answer, and the form screen has no query behind it.
  assert.equal(handoff("done", scan, "done", "name"), "");
  assert.equal(handoff("ready", scan, null, "name"), "");
  // An affix search ran with the base only: the read lines can narrow it, finished or not.
  assert.equal(handoff("done", scan, "done", "stats"), "加詞綴條件縮小範圍");
  assert.equal(handoff("problem", scan, "problem", "stats"), "加詞綴條件縮小範圍");
  // Nothing to hand over when the player typed the name or read a picture.
  assert.equal(handoff("problem", { kind: "picture" }, "problem", "name"), "");
  assert.equal(handoff("done", { kind: "picture" }, "done", "stats"), "");
  assert.equal(handoff("problem", null, "problem", "name"), "");
  // A scan source without the record itself cannot be re-entered.
  assert.equal(handoff("problem", { kind: "scan" }, "problem", "name"), "");
});
