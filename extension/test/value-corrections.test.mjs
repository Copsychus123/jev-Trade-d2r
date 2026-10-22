// The affix-number memory (ocr/value-corrections.js): the number the player typed over a read one, kept under the
// normalised text of the affix line and the affix it was read as. One correction is enough to fill the next read; the
// store stays small and a broken store never breaks a read.
import assert from "node:assert/strict";
import test from "node:test";

import { normalizeKey } from "../src/ocr/match.js";
import { MAX_ENTRIES, MAX_LINE, STORE_VERSION, applyValues, createValueCorrections } from "../src/ocr/value-corrections.js";

function fakeStorage({ stored, failGet = false } = {}) {
  const storage = {
    stored,
    writes: 0,
    get: async () => {
      if (failGet) throw new Error("no storage");
      return storage.stored;
    },
    set: async (value) => {
      storage.writes += 1;
      storage.stored = JSON.parse(JSON.stringify(value));
    },
  };
  return storage;
}

function fakeTimers() {
  const timers = { pending: [], set: (fn) => timers.pending.push(fn) - 1, clear: (id) => (timers.pending[id] = null) };
  timers.fire = async () => {
    for (const fn of timers.pending.splice(0).filter(Boolean)) await fn();
  };
  return timers;
}

async function memory(options = {}) {
  const timers = fakeTimers();
  const storage = fakeStorage(options);
  let t = 1000;
  const mem = createValueCorrections({ storage, now: () => (t += 1), setTimer: timers.set, clearTimer: timers.clear });
  await mem.load();
  return { mem, storage, timers };
}

const LINE = "+7% Faster Cast Rate";

test("a corrected number is found again for the same line read as the same affix", async () => {
  const { mem } = await memory();
  assert.equal(mem.learn(LINE, "fcr", 8).min, 8);
  assert.equal(mem.lookup("+7%  faster cast rate", "fcr").min, 8, "the same text spelled with other spacing and case");
  assert.equal(mem.lookup(LINE, "fhr"), null, "the same text read as another affix finds nothing");
  assert.equal(mem.lookup("+9% Faster Cast Rate", "fcr"), null, "another text finds nothing");
});

test("a second correction with another number replaces the first, the same number counts up", async () => {
  const { mem } = await memory();
  mem.learn(LINE, "fcr", 8);
  assert.equal(mem.learn(LINE, "fcr", 8).count, 2);
  const changed = mem.learn(LINE, "fcr", 9);
  assert.equal(changed.min, 9);
  assert.equal(changed.count, 1);
  assert.equal(mem.size, 1);
});

test("what is not a short line or a whole number is never learned", async () => {
  const { mem } = await memory();
  assert.equal(mem.learn("", "fcr", 8), null);
  assert.equal(mem.learn("x".repeat(MAX_LINE + 1), "fcr", 8), null);
  assert.equal(mem.learn(LINE, "fcr", 8.5), null);
  assert.equal(mem.learn(LINE, "fcr", -1), null);
  assert.equal(mem.learn(LINE, "fcr", 1000000), null);
  assert.equal(mem.learn(LINE, "", 8), null);
  assert.equal(mem.size, 0);
});

test("the 501st entry evicts the least recently used one", async () => {
  const { mem } = await memory();
  for (let i = 0; i < MAX_ENTRIES; i += 1) mem.learn(`+${i} Faster Cast Rate`, "fcr", 1);
  mem.lookup("+0 Faster Cast Rate", "fcr"); // in use: now the newest
  mem.learn("+9999 Faster Cast Rate", "fcr", 1);
  assert.equal(mem.size, MAX_ENTRIES);
  assert.ok(mem.lookup("+0 Faster Cast Rate", "fcr"));
  assert.equal(mem.lookup("+1 Faster Cast Rate", "fcr"), null);
});

test("writes are batched, and a store that cannot be read is an empty memory that is never written", async () => {
  const { mem, storage, timers } = await memory();
  mem.learn(LINE, "fcr", 8);
  mem.learn("Cold Resist +11%", "cold_res", 12);
  assert.equal(storage.writes, 0);
  await timers.fire();
  assert.equal(storage.writes, 1);
  assert.equal(storage.stored.v, STORE_VERSION);
  assert.deepEqual(storage.stored.e[0], [normalizeKey(LINE), { k: "fcr", m: 8, c: 1, u: storage.stored.e[0][1].u }]);

  const broken = await memory({ failGet: true });
  broken.mem.learn(LINE, "fcr", 8);
  await broken.mem.flush();
  assert.equal(broken.storage.writes, 0);
});

test("a damaged store keeps only its good entries", async () => {
  const stored = {
    v: STORE_VERSION,
    e: [
      ["good line", { k: "fcr", m: 8, c: 1, u: 1 }],
      ["bad number", { k: "fcr", m: -3, c: 1, u: 1 }],
      ["bad count", { k: "fcr", m: 3, c: 0, u: 1 }],
      [5, {}],
    ],
  };
  const { mem } = await memory({ stored });
  assert.deepEqual(mem.list().map((e) => e.key), ["good line"]);
});

test("applyValues fills a known number line and leaves a bool, an unknown line and a missing memory alone", async () => {
  const { mem } = await memory();
  mem.learn(LINE, "fcr", 8);
  const conditions = [
    { key: "fcr", kind: "percent", line: LINE, min: 7, confident: false, on: false },
    { key: "fcr", kind: "percent", line: "+9% Faster Cast Rate", min: 9, confident: false, on: false },
    { key: "fcr", kind: "bool", line: LINE, min: null, confident: false, on: false },
  ];
  const [hit, miss, bool] = applyValues(conditions, mem);
  assert.deepEqual([hit.min, hit.confident, hit.learned], [8, true, true]);
  assert.equal(miss, conditions[1]);
  assert.equal(bool, conditions[2]);
  assert.equal(applyValues(conditions, null), conditions);
});
