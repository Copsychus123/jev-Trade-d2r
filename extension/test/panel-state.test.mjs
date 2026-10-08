import assert from "node:assert/strict";
import { test } from "node:test";

import { VIEWS, deriveView, visibleSections } from "../src/panel-state.js";

const base = { settingsOpen: false, hasInvite: true, running: false, after: null, mode: "name" };

test("settings win over everything, then the missing invite, then a running query", () => {
  assert.equal(deriveView({ ...base, settingsOpen: true, running: true }), "settings");
  assert.equal(deriveView({ ...base, hasInvite: false, running: true }), "welcome");
  assert.equal(deriveView({ ...base, running: true, after: "done" }), "running");
});

test("with no search kind chosen the idle panel asks first, but settings, welcome, running and a finished query win", () => {
  assert.equal(deriveView({ ...base, mode: null }), "choose");
  assert.equal(deriveView({ ...base, mode: null, settingsOpen: true }), "settings");
  assert.equal(deriveView({ ...base, mode: null, hasInvite: false }), "welcome");
  assert.equal(deriveView({ ...base, mode: null, running: true }), "running");
  assert.equal(deriveView({ ...base, mode: null, after: "done" }), "done");
});

test("the scan screen shows only itself and loses to settings, welcome, running and a finished query", () => {
  assert.equal(deriveView({ ...base, mode: "scan" }), "scan");
  assert.equal(deriveView({ ...base, mode: "scan", settingsOpen: true }), "settings");
  assert.equal(deriveView({ ...base, mode: "scan", hasInvite: false }), "welcome");
  assert.equal(deriveView({ ...base, mode: "scan", running: true }), "running");
  assert.equal(deriveView({ ...base, mode: "scan", after: "done" }), "done");
  assert.deepEqual([...visibleSections("scan", true)], ["scan"]);
});

test("the choose screen shows itself and the results, but not the form or the run slot", () => {
  assert.ok(visibleSections("choose", true).has("choose"));
  assert.ok(!visibleSections("choose", true).has("form"));
  assert.ok(!visibleSections("choose", true).has("run"));
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
