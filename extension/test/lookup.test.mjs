import assert from "node:assert/strict";
import test from "node:test";

import {
  findProduct,
  indexTables,
  isWellFormed,
  nameStatus,
  resolveInput,
  searchFoundNothing,
  stripToBase,
  titleIsItem,
} from "../src/traderie/lookup.js";

const tables = indexTables({
  generated_at: "2026-01-01T00:00:00+00:00",
  products: [
    { name: "The Stone of Jordan", slug: "the-stone-of-jordan", category: "uniques" },
    { name: "Harlequin Crest", slug: "harlequin-crest", category: "uniques" },
    { name: "Tal Rasha's Adjudication", slug: "tal-rashas-adjudication", category: "sets" },
    { name: "Ring", slug: "ring", category: "base" },
  ],
  zh: { 哈勒昆之冠: "Harlequin Crest" },
  bases: ["Ring"],
  game_only: ["Cow King's Leathers"],
});

test("a messy English name resolves to the spelling Traderie uses", () => {
  assert.equal(resolveInput("  stone   OF jordan ", tables).query, "The Stone of Jordan");
  assert.equal(resolveInput("ＨＡＲＬＥＱＵＩＮ Crest", tables).query, "Harlequin Crest");
  assert.equal(resolveInput("tal rashas adjudication", tables).query, "Tal Rasha's Adjudication");
});

test("a Chinese name is translated through the table, and an unknown one stops before anything is used up", () => {
  const found = resolveInput(" 哈勒昆 之冠", tables);
  assert.deepEqual([found.query, found.translated], ["Harlequin Crest", true]);
  assert.throws(() => resolveInput("不存在的裝備", tables), /對照表裡沒有/);
});

test("characters that cannot be in an item name are not typed into the search box", () => {
  assert.equal(resolveInput("Rare <Ring>!!", tables).query, "Rare Ring");
  assert.throws(() => resolveInput("!!!", tables), /英文字母/);
  assert.throws(() => resolveInput("   ", tables), /請輸入/);
});

test("a name is well-formed only when it is plain words", () => {
  assert.equal(isWellFormed("Rare Ring"), true);
  assert.equal(isWellFormed("Rare  Ring"), false);
  assert.equal(isWellFormed("Rare 戒指"), false);
  assert.equal(isWellFormed(""), false);
});

test("name status tells a catalog item from a game-only item and from an unknown name", () => {
  assert.equal(nameStatus("harlequin crest", tables), "traderie");
  assert.equal(nameStatus("Cow King's Leathers", tables), "game_only");
  assert.equal(nameStatus("Zzzz Qqqq", tables), "unknown");
  assert.equal(findProduct("Rare Ring", tables), null);
});

test("the page title must contain the whole item name, not just letters of it", () => {
  const title = (name) => `${name} - Diablo II: Resurrected (D2R) Trade | Traderie`;
  assert.equal(titleIsItem("Ring", title("Ring")), true);
  assert.equal(titleIsItem("Ring", title("Earring")), false);
  assert.equal(titleIsItem("Stone of Jordan", title("The Stone of Jordan")), true);
  assert.equal(titleIsItem("Harlequin Crest", title("Shako")), false);
});

test("the empty search page is recognised", () => {
  assert.equal(searchFoundNothing({ text: "Best Match\nNo results could be found\nHELP" }), true);
  assert.equal(searchFoundNothing({ text: "Best Match\nSmall Charm\nAdd to wishlist" }), false);
});

test("leading words are dropped until the rest is a plain item type, longest rest first", () => {
  const withBases = indexTables({
    generated_at: "x", products: [], zh: {}, game_only: [],
    bases: ["Ring", "Grand Charm", "Charm", "Archon Plate"],
  });
  assert.equal(stripToBase("Rare Ring", withBases), "Ring");
  assert.equal(stripToBase("Magic Grand Charm", withBases), "Grand Charm");
  assert.equal(stripToBase("Ethereal  white archon plate", withBases), "Archon Plate");
  assert.equal(stripToBase("Ring", withBases), null); // nothing in front of it: that is the name itself
  assert.equal(stripToBase("Zzzz Qqqq", withBases), null);
});

test("a typed Chinese name finds its English name whether or not the source wrote a period, dot or hyphen in it", () => {
  const t = indexTables({
    generated_at: "x",
    products: [{ name: "Tal Rasha's Guardianship", slug: "tal-rashas-guardianship", category: "sets" }],
    zh: { "塔.拉夏的守護": "Tal Rasha's Guardianship" },
    bases: [],
    game_only: [],
  });
  for (const typed of ["塔拉夏的守護", "塔.拉夏的守護", "塔·拉夏的守護", "塔-拉夏的守護"]) {
    assert.equal(resolveInput(typed, t).query, "Tal Rasha's Guardianship", typed);
  }
});
