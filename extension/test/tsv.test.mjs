import assert from "node:assert/strict";
import { test } from "node:test";

import { installStubResolver } from "./support/stubs.mjs";

// tsv.js imports "./csv.js", which ships only into extension/dist (extension/build.py copies it from
// src/jev_ultrafast/static/csv.js); the hook points that specifier at the real source file.
installStubResolver();

const { toTsv, tsvCell } = await import("../src/tsv.js");

test("a cell can never split into extra columns or rows", () => {
  assert.equal(tsvCell("a\tb\nc"), "a b c");
  assert.equal(tsvCell(null), "");
  assert.equal(tsvCell(112), "112");
});

test("cells a spreadsheet would run as formulas get a leading apostrophe", () => {
  assert.deepEqual(["=SUM(1)", "+1", "-1", "@x", "1 X Mal Rune"].map(tsvCell), ["'=SUM(1)", "'+1", "'-1", "'@x", "1 X Mal Rune"]);
});

test("the table is a header line and one line per row, tab separated", () => {
  assert.equal(toTsv(["賣家", "要價"], [["a,b", "1 X Ist Rune"], ["c", null]]), "賣家\t要價\na,b\t1 X Ist Rune\nc\t\n");
});
