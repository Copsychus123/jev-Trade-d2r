import assert from "node:assert/strict";
import { test } from "node:test";

import { PAGE_SIZE, clampPage, pageCount, pageRows } from "../src/paginate.js";

const rows = Array.from({ length: 25 }, (_, i) => i + 1);

test("10 rows fit one page, the 11th starts a second one", () => {
  assert.equal(PAGE_SIZE, 10);
  assert.equal(pageCount(0), 1);
  assert.equal(pageCount(10), 1);
  assert.equal(pageCount(11), 2);
  assert.equal(pageCount(150), 15);
});

test("each page holds the next ten rows and the last page holds the rest", () => {
  assert.deepEqual(pageRows(rows, 1), rows.slice(0, 10));
  assert.deepEqual(pageRows(rows, 2), rows.slice(10, 20));
  assert.deepEqual(pageRows(rows, 3), [21, 22, 23, 24, 25]);
});

test("a page outside the range is pulled back instead of showing an empty table", () => {
  assert.equal(clampPage(0, 25), 1);
  assert.equal(clampPage(9, 25), 3);
  assert.equal(clampPage(Number.NaN, 25), 1);
  assert.deepEqual(pageRows(rows, 99), [21, 22, 23, 24, 25]);
  assert.deepEqual(pageRows([], 3), []);
});
