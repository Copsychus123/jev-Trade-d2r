import assert from "node:assert/strict";
import test from "node:test";

import { ITEM_TYPES_KEY, ITEM_TYPES_TTL_MS, cachedItemTypes, loadItemTypes } from "../src/traderie/item-types.js";

const DAY = 24 * 3600 * 1000;
const NOW = Date.parse("2026-10-05T12:00:00Z");

class FakeStore {
  constructor(data = {}) {
    this.data = data;
    this.writes = 0;
  }
  async get(key) {
    return key in this.data ? { [key]: this.data[key] } : {};
  }
  async set(values) {
    this.writes += 1;
    Object.assign(this.data, values);
  }
}

const save = (fetchedAt, itemTypes) => ({ [ITEM_TYPES_KEY]: { fetchedAt, itemTypes } });

test("a copy younger than a week is used without reading the home page", async () => {
  const itemTypes = ["Amulet", "Ring"];
  let reads = 0;
  const read = async () => {
    reads += 1;
    return { itemTypes: ["Never"] };
  };
  assert.deepEqual(await loadItemTypes({ read, store: new FakeStore(save(NOW - 3 * DAY, itemTypes)), now: NOW }), {
    itemTypes,
    cacheHit: true,
  });
  assert.equal(reads, 0);
});

test("an old or missing copy is read once and stored with its time", async () => {
  const store = new FakeStore(save(NOW - ITEM_TYPES_TTL_MS - 1, ["Old"]));
  const { itemTypes, cacheHit } = await loadItemTypes({ read: async () => ({ itemTypes: ["Amulet", "Ring"] }), store, now: NOW });
  assert.deepEqual(itemTypes, ["Amulet", "Ring"]);
  assert.equal(cacheHit, false);
  assert.deepEqual(store.data[ITEM_TYPES_KEY], { fetchedAt: NOW, itemTypes: ["Amulet", "Ring"] });
  assert.equal(store.writes, 1);
  const missing = new FakeStore();
  assert.deepEqual(await loadItemTypes({ read: async () => ({ itemTypes: ["Ring"] }), store: missing, now: NOW }), {
    itemTypes: ["Ring"],
    cacheHit: false,
  });
  assert.equal(missing.writes, 1);
});

test("a failed read with no copy is an error and nothing is stored", async () => {
  const store = new FakeStore();
  await assert.rejects(
    loadItemTypes({ read: async () => { throw new Error("Traderie 首頁一直沒有載入完成"); }, store, now: NOW }),
    /^Error: Traderie 首頁一直沒有載入完成$/u,
  );
  assert.equal(store.writes, 0);
});

test("a failed read with an expired copy is an error that names it, and the stale copy is not used", async () => {
  const store = new FakeStore(save(NOW - 9 * DAY, ["Old"]));
  await assert.rejects(
    loadItemTypes({ read: async () => { throw new Error("Traderie 首頁一直沒有載入完成"); }, store, now: NOW }),
    /^Error: Traderie 首頁一直沒有載入完成（上次取得：2026-09-26）$/u,
  );
  assert.equal(store.writes, 0);
});

test("a site challenge is not a list and is never stored", async () => {
  const store = new FakeStore();
  assert.deepEqual(await loadItemTypes({ read: async () => ({ guard: true }), store, now: NOW }), { guard: true });
  assert.equal(store.writes, 0);
});

test("an empty read is not stored, so a week of 'no type' never keeps a base out of the filter", async () => {
  const store = new FakeStore();
  assert.deepEqual(await loadItemTypes({ read: async () => ({ itemTypes: [] }), store, now: NOW }), {
    itemTypes: [],
    cacheHit: false,
  });
  assert.equal(store.writes, 0);
});

test("a copy exactly at the week boundary counts as expired", async () => {
  let reads = 0;
  const store = new FakeStore(save(NOW - ITEM_TYPES_TTL_MS, ["Ring"]));
  await loadItemTypes({ read: async () => { reads += 1; return { itemTypes: ["Ring", "Amulet"] }; }, store, now: NOW });
  assert.equal(reads, 1);
});

test("a damaged stored value counts as no copy", async () => {
  assert.equal(await cachedItemTypes(new FakeStore(save("yesterday", []))), null);
  assert.equal(await cachedItemTypes(new FakeStore({ [ITEM_TYPES_KEY]: "garbage" })), null);
  assert.equal(await cachedItemTypes(new FakeStore()), null);
});
