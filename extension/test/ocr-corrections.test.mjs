// The correction memory (ocr/corrections.js): what the player chose for a name line the reader could not settle, kept
// under the normalised text of that name line. These are the rules the player's wrong auto-fill depends on: one choice
// never fills anything by itself, two identical choices in a row do, a different choice starts again, only table names
// are kept, the store stays small and a broken store never breaks a read.
import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_ENTRIES,
  MAX_KEY,
  STORE_KEY,
  STORE_VERSION,
  applyLearned,
  createCorrections,
} from "../src/ocr/corrections.js";
import { LEARNED_SURE, buildMatchIndex, decideCandidates, matchOcrText, nameKeys } from "../src/ocr/match.js";
import { indexTables } from "../src/traderie/lookup.js";

const tables = indexTables({
  generated_at: "x",
  products: [
    { name: "Arachnid Mesh", slug: "arachnid-mesh", category: "uniques" },
    { name: "Griswold's Honor", slug: "griswolds-honor", category: "sets" },
    { name: "Ring", slug: "ring", category: "misc" },
    { name: "Ring Mail", slug: "ring-mail", category: "base" },
    { name: "Coronet", slug: "coronet", category: "base" },
  ],
  zh: { 蜘蛛之網: "Arachnid Mesh", 格里斯瓦德的榮耀: "Griswold's Honor", 戒指: "Ring", 鎖子甲: "Ring Mail", 寶冠: "Coronet" },
  bases: ["Ring", "Ring Mail", "Coronet"],
  game_only: [],
});
const index = buildMatchIndex(tables);

/** A storage whose content and failures a test controls; `writes` counts what reached it. */
function fakeStorage({ stored, failGet = false, failSet = false } = {}) {
  const storage = {
    stored,
    writes: 0,
    failGet,
    failSet,
    get: async () => {
      if (storage.failGet) throw new Error("no storage");
      return storage.stored;
    },
    set: async (value) => {
      if (storage.failSet) throw new Error("quota");
      storage.writes += 1;
      storage.stored = JSON.parse(JSON.stringify(value)); // what chrome.storage keeps is a copy
    },
  };
  return storage;
}

/** Timers the test fires by hand, so "debounced" is observable without waiting. */
function fakeTimers() {
  const timers = { pending: [], set: (fn) => timers.pending.push(fn) - 1, clear: (id) => (timers.pending[id] = null) };
  timers.fire = async () => {
    const due = timers.pending.splice(0).filter(Boolean);
    for (const fn of due) await fn();
  };
  return timers;
}

async function memory(options = {}) {
  const storage = fakeStorage(options);
  const timers = fakeTimers();
  let clock = 1000;
  const corrections = createCorrections({
    storage,
    now: () => (clock += 1),
    setTimer: timers.set,
    clearTimer: timers.clear,
  });
  await corrections.load();
  corrections.attach(tables);
  return { corrections, storage, timers };
}

test("a Chinese or an English choice is stored as the table's English name with its kind", async () => {
  const { corrections } = await memory();

  assert.deepEqual(corrections.learn("蜘蛛之網x", "蜘蛛之網"), { key: "蜘蛛之網x", name: "Arachnid Mesh", kind: "item", count: 1, used: 1001 });
  corrections.learn("ring mall", "ring mail");

  assert.deepEqual(
    corrections.list().map(({ key, name, kind, count }) => [key, name, kind, count]),
    [
      ["ring mall", "Ring Mail", "base", 1],
      ["蜘蛛之網x", "Arachnid Mesh", "item", 1],
    ],
    "the English spelling is the table's own, whatever case was typed; newest first",
  );
});

test("a name the tables do not list is never stored, and neither is a key that is not a short name line", async () => {
  const { corrections, timers, storage } = await memory();

  assert.equal(corrections.learn("蜘蛛之網x", "Not An Item"), null);
  assert.equal(corrections.learn("蜘蛛之網x", "不存在的名字"), null);
  assert.equal(corrections.learn("蜘蛛之網x", ""), null);
  assert.equal(corrections.learn("", "Ring"), null, "no key, nothing to remember it under");
  assert.equal(corrections.learn("戒", "Ring"), null, "one character is not a name line");
  assert.equal(corrections.learn("戒".repeat(MAX_KEY + 1), "Ring"), null, "a whole paragraph is not a name line");
  assert.equal(corrections.size, 0);
  await timers.fire();
  assert.equal(storage.writes, 0, "and nothing was written");
});

test("the same choice twice counts two, and a different choice for the same text starts again at one", async () => {
  const { corrections } = await memory();

  assert.equal(corrections.learn("格里斯瓦德的榮躍", "Griswold's Honor").count, 1);
  assert.equal(corrections.learn("格里斯瓦德的榮躍", "格里斯瓦德的榮耀").count, 2, "Chinese and English are the same name");
  assert.equal(corrections.learn("格里斯瓦德的榮躍", "Arachnid Mesh").count, 1, "a conflicting choice resets the count");
  assert.equal(corrections.lookup(["格里斯瓦德的榮躍"]).name, "Arachnid Mesh", "and the newer choice is the one remembered");
  assert.equal(corrections.learn("格里斯瓦德的榮躍", "Griswold's Honor").count, 1, "going back is not a streak either");
});

test("a key is normalised like the matcher reads text: spaces, separators, simplified letters and case", async () => {
  const { corrections } = await memory();

  corrections.learn("格 里斯瓦德‧的榮躍", "Griswold's Honor");
  assert.equal(corrections.lookup(["格里斯瓦德的榮躍"]).name, "Griswold's Honor");
  corrections.learn("Arachnid  MESH", "Arachnid Mesh");
  assert.equal(corrections.lookup(["arachnid mesh"]).name, "Arachnid Mesh", "the Latin key is the matcher's normalizeName");
  corrections.learn("蜘蛛之网", "Arachnid Mesh");
  assert.equal(corrections.lookup(["蜘蛛之網"]).name, "Arachnid Mesh", "a simplified glyph the engine printed is stored as the traditional one");
});

test("only an exact key finds an entry: a text one character off finds nothing", async () => {
  const { corrections } = await memory();
  corrections.learn("格里斯瓦德的榮躍", "Griswold's Honor");

  assert.equal(corrections.lookup(["格里斯瓦德的榮耀"]), null);
  assert.equal(corrections.lookup(["格里斯瓦德的榮"]), null);
  assert.equal(corrections.lookup([]), null);
  assert.notEqual(corrections.lookup([{ key: "格里斯瓦德的榮躍", at: 3 }]), null, "a nameKeys entry is accepted, with its line");
});

test("of several name lines that were learned, the most repeated choice wins, then the first line", async () => {
  const { corrections } = await memory();
  corrections.learn("蜘蛛之網x", "Arachnid Mesh");
  corrections.learn("鎖子甲x", "Ring Mail");
  corrections.learn("鎖子甲x", "Ring Mail");

  assert.equal(corrections.lookup([{ key: "蜘蛛之網x", at: 0 }, { key: "鎖子甲x", at: 1 }]).name, "Ring Mail");
  corrections.learn("戒指x", "Ring");
  corrections.learn("戒指x", "Ring");
  assert.equal(corrections.lookup([{ key: "鎖子甲x", at: 0 }, { key: "戒指x", at: 1 }]).name, "Ring Mail", "equal counts: the earlier line");
});

test("the memory holds at most MAX_ENTRIES keys: the least recently used goes first, and using one keeps it", async () => {
  const { corrections } = await memory();
  for (let i = 0; i < MAX_ENTRIES; i += 1) corrections.learn(`蜘蛛之網${i}`, "Arachnid Mesh");
  assert.equal(corrections.size, MAX_ENTRIES);

  corrections.lookup(["蜘蛛之網0"]); // the oldest entry is used again: it is now the newest
  corrections.learn("鎖子甲新", "Ring Mail");

  assert.equal(corrections.size, MAX_ENTRIES, "one in, one out");
  assert.notEqual(corrections.lookup(["蜘蛛之網0"]), null, "the one that was just used stays");
  assert.equal(corrections.lookup(["蜘蛛之網1"]), null, "the least recently used went");
  assert.notEqual(corrections.lookup(["鎖子甲新"]), null);
});

test("writes are batched: a burst of choices is one write of one versioned key holding short strings only", async () => {
  const { corrections, storage, timers } = await memory();
  corrections.learn("蜘蛛之網x", "Arachnid Mesh");
  corrections.learn("鎖子甲x", "Ring Mail");
  corrections.lookup(["蜘蛛之網x"]);
  assert.equal(storage.writes, 0, "nothing is written while the timer waits");

  await timers.fire();

  assert.equal(storage.writes, 1);
  assert.equal(STORE_KEY, "jevCorrections");
  assert.equal(storage.stored.v, STORE_VERSION);
  assert.deepEqual(
    storage.stored.e.map(([key, value]) => [key, Object.keys(value).sort().join("")]),
    [
      ["鎖子甲x", "cknu"],
      ["蜘蛛之網x", "cknu"],
    ],
    "oldest first: a key and four short fields, and no text, no picture, no page data",
  );
  assert.equal(storage.stored.e.every(([key, value]) => key.length <= MAX_KEY && value.n.length < 100), true);
});

test("flush writes what the timer was still holding", async () => {
  const { corrections, storage } = await memory();
  corrections.learn("蜘蛛之網x", "Arachnid Mesh");
  await corrections.flush();
  assert.equal(storage.writes, 1);
  await corrections.flush();
  assert.equal(storage.writes, 1, "and nothing is written twice");
});

test("a second panel start finds what the first one stored", async () => {
  const first = await memory();
  first.corrections.learn("蜘蛛之網x", "Arachnid Mesh");
  first.corrections.learn("蜘蛛之網x", "Arachnid Mesh");
  await first.corrections.flush();

  const second = await memory({ stored: first.storage.stored });

  assert.deepEqual(second.corrections.lookup(["蜘蛛之網x"]), { key: "蜘蛛之網x", name: "Arachnid Mesh", kind: "item", count: 2, used: 1002, at: 0 });
});

test("a store that cannot be read is an empty memory that is never written over", async () => {
  const { corrections, storage, timers } = await memory({ failGet: true, stored: { v: 1, e: [["蜘蛛之網x", { n: "Arachnid Mesh", k: "item", c: 2, u: 5 }]] } });

  assert.equal(corrections.size, 0);
  assert.equal(corrections.lookup(["蜘蛛之網x"]), null, "a read still works, with nothing to show");
  corrections.learn("鎖子甲x", "Ring Mail");
  await timers.fire();
  assert.equal(storage.writes, 0, "what could not be read is not overwritten by a guess");
});

test("a failed write is not an error: the choice stays in memory and the next flush tries again", async () => {
  const { corrections, storage } = await memory({ failSet: true });
  corrections.learn("蜘蛛之網x", "Arachnid Mesh");

  await corrections.flush(); // does not throw
  assert.equal(storage.writes, 0);
  assert.equal(corrections.list()[0].name, "Arachnid Mesh", "it is still remembered for this session");

  storage.failSet = false;
  await corrections.flush();
  assert.equal(storage.writes, 1);
});

test("damaged, unknown-version and foreign values load as an empty memory, and bad entries are skipped one by one", async () => {
  for (const stored of [undefined, null, "text", 5, [], { v: 2, e: [] }, { v: 1 }, { v: 1, e: "x" }]) {
    assert.equal((await memory({ stored })).corrections.size, 0, JSON.stringify(stored));
  }
  const mixed = {
    v: 1,
    e: [
      ["蜘蛛之網x", { n: "Arachnid Mesh", k: "item", c: 2, u: 5 }],
      ["短", { n: "Ring", k: "base", c: 1, u: 5 }],
      ["鎖子甲x", { n: "Ring Mail", k: "weapon", c: 1, u: 5 }],
      ["戒指x", { n: "Ring", k: "base", c: 0, u: 5 }],
      ["寶冠x", { n: "Coronet", k: "base", c: 1 }],
      ["x".repeat(MAX_KEY + 1), { n: "Ring", k: "base", c: 1, u: 5 }],
      "junk",
      ["格里斯瓦德x", null],
    ],
  };
  const { corrections } = await memory({ stored: mixed });
  assert.deepEqual(corrections.list().map((entry) => entry.key), ["蜘蛛之網x"]);
});

test("names the tables no longer list are dropped when the tables arrive, and the rest are re-spelled the table's way", async () => {
  const storage = fakeStorage({
    stored: {
      v: 1,
      e: [
        ["蜘蛛之網x", { n: "arachnid mesh", k: "item", c: 2, u: 5 }],
        ["鎖子甲x", { n: "Retired Item", k: "item", c: 2, u: 6 }],
      ],
    },
  });
  const corrections = createCorrections({ storage, setTimer: () => 0, clearTimer: () => {} });
  await corrections.load();
  assert.equal(corrections.lookup(["蜘蛛之網x"]), null, "nothing is looked up before the tables are known");

  corrections.attach(tables);

  assert.deepEqual(corrections.list().map((entry) => [entry.key, entry.name]), [["蜘蛛之網x", "Arachnid Mesh"]]);
});

test("forget removes one pair and clear removes all, each telling whether anything changed", async () => {
  const { corrections } = await memory();
  corrections.learn("蜘蛛之網x", "Arachnid Mesh");
  corrections.learn("鎖子甲x", "Ring Mail");
  let changes = 0;
  corrections.onChange(() => (changes += 1));

  assert.equal(corrections.forget("不存在"), false);
  assert.equal(corrections.forget("蜘蛛之網x"), true);
  assert.equal(corrections.size, 1);
  assert.equal(corrections.clear(), true);
  assert.equal(corrections.clear(), false);
  assert.equal(corrections.size, 0);
  assert.equal(changes, 2, "the settings list is told about each real change");
});

// --- the rule that decides whether a remembered name may fill the field ------------------------------------------------

const read = (text, hit) => {
  const candidates = applyLearned(matchOcrText(text, index), hit);
  return { candidates, ...decideCandidates(candidates) };
};
const hitFor = (name, kind, count, key = "鎖子甲x") => ({ key, name, kind, count, at: 0 });

test("one earlier choice puts the name first and still asks, even when the matcher alone would have filled another name", async () => {
  // "蜘蛛之網" with no type line is a sure read of Arachnid Mesh on its own.
  assert.equal(read("蜘蛛之網").confident, true);

  const once = read("蜘蛛之網", hitFor("Ring Mail", "base", 1));

  assert.deepEqual(once.candidates.map((c) => c.name), ["Ring Mail", "Arachnid Mesh"], "the remembered name leads, the matcher's follow");
  assert.equal(once.candidates[0].promoted, true);
  assert.equal(once.confident, false, "one choice is never enough to fill by itself");
});

test("LEARNED_SURE identical choices make the remembered name sure, and fewer do not", async () => {
  assert.equal(LEARNED_SURE, 2);
  for (let count = 1; count < LEARNED_SURE; count += 1) {
    assert.equal(read("蜘蛛之網", hitFor("Ring Mail", "base", count)).confident, false, `${count} choice(s) ask`);
  }
  const sure = read("蜘蛛之網", hitFor("Ring Mail", "base", LEARNED_SURE));
  assert.equal(sure.confident, true);
  assert.equal(sure.candidates[0].name, "Ring Mail");
});

test("a remembered name the matcher never listed is added as a candidate of its own, with the text it was learned under", async () => {
  const result = read("ZZZZZZ", hitFor("Coronet", "base", 1, "zzzzzz"));
  assert.deepEqual(result.candidates.map((c) => [c.kind, c.name, c.matched, c.learned]), [["base", "Coronet", "zzzzzz", 1]]);
  assert.equal(result.confident, false);
  assert.equal(read("ZZZZZZ", hitFor("Coronet", "base", 2, "zzzzzz")).confident, true);
});

test("a remembered name that is already the matcher's first keeps the matcher's own decision until it was chosen twice", async () => {
  // A rare item with its type line under a yellow name asks; one earlier choice of the same name does not change that,
  // two do (the player has now said it twice).
  const text = "蜘蛛之網\n戒指";
  const tones = [[248, 248, 100], [250, 250, 250]];
  const asked = (hit) => {
    const candidates = applyLearned(matchOcrText(text, index, tones), hit);
    return { candidates, ...decideCandidates(candidates) };
  };
  assert.equal(asked(null).confident, false);

  const once = asked(hitFor("Arachnid Mesh", "item", 1));
  assert.equal(once.candidates[0].promoted, undefined, "it was first anyway: not a promotion");
  assert.equal(once.confident, false);
  assert.equal(asked(hitFor("Arachnid Mesh", "item", 2)).confident, true);

  // And a sure read stays sure when the player's single earlier choice agrees with it.
  assert.equal(read("蜘蛛之網", hitFor("Arachnid Mesh", "item", 1)).confident, true);
});

test("a read with no remembered choice is returned as it is", async () => {
  const candidates = matchOcrText("蜘蛛之網", index);
  assert.equal(applyLearned(candidates, null), candidates);
});

test("the keys a read offers to the memory are its name lines, never a stat line", async () => {
  assert.deepEqual(nameKeys("蜘蛛之網\n+27 力量 (STN)\nArachnid Mesh Of Doom").map((k) => k.key), ["蜘蛛之網", "arachnid mesh of doom"]);
  assert.deepEqual(nameKeys("需要等級:46"), []);
});
