// One run's market.json is rendered by two UIs: the extension's panel (`src/traderie/controller.js`) and the demo page
// (`src/jev_ultrafast/static/app.js`, served by the Python package). They cannot share code - the demo is a page script
// the backend serves, the panel is an ES module the extension loads - so this test keeps them in step, the same way
// `tests/test_run_budgets.py` holds numbers that live in three files. It matters for the player: the CSV the demo writes
// and the CSV the panel writes come from the same rows, and must not differ because of which UI was open.
//
// The labels and their order are what is compared (the demo's cells are inline lambdas); a column meaning change on one
// side without the other shows up here as a missing or renamed column.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { RECENT_COLUMNS, TRADING_COLUMNS } from "../src/traderie/controller.js";

const DEMO = readFileSync(fileURLToPath(new URL("../../src/jev_ultrafast/static/app.js", import.meta.url)), "utf8");

/** The `head: [...]` of one view in the demo's `marketViews`, as the labels it hands the table and the CSV. */
function demoHead(view) {
  const block = new RegExp(`${view}: \\{[\\s\\S]*?head: \\[([^\\]]+)\\]`).exec(DEMO);
  assert.ok(block, `the demo no longer declares a head for ${view}`);
  return [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

test("the demo page shows and exports the same columns as the panel", () => {
  assert.deepEqual(demoHead("trading"), TRADING_COLUMNS);
  assert.deepEqual(demoHead("recent_trades"), RECENT_COLUMNS);
});
