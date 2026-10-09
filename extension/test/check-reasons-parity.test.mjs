// The sentences a failed check is shown with exist twice: the panel takes them from `extension/src/labels.js`
// (CHECK_REASONS) and the demo page (`src/jev_ultrafast/static/app.js`) carries its own copy, because the page is a
// script the Python package serves while the panel is an ES module the extension loads. The repo keeps that kind of
// cross-file fact in step with a test (see `tests/test_run_budgets.py` for numbers and
// `extension/test/columns-parity.test.mjs` for the table columns); this is the same guard, and it exists because the
// player must never be shown a raw identifier like `same_product`.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CHECK_REASONS } from "../src/labels.js";

const DEMO = readFileSync(fileURLToPath(new URL("../../src/jev_ultrafast/static/app.js", import.meta.url)), "utf8");

/** The demo's own copy, read as the pairs it declares. */
function demoCheckReasons() {
  const block = /const CHECK_REASONS = \{([\s\S]*?)\n\};/.exec(DEMO);
  assert.ok(block, "the demo page no longer declares CHECK_REASONS");
  return Object.fromEntries([...block[1].matchAll(/(\w+): "([^"]+)"/g)].map((match) => [match[1], match[2]]));
}

test("the demo page explains a failed check with the same words as the panel", () => {
  assert.deepEqual(demoCheckReasons(), CHECK_REASONS);
});
