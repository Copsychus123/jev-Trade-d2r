import assert from "node:assert/strict";
import test from "node:test";

import { allowedEdits, buildMatchIndex, levenshtein, matchOcrText } from "../src/ocr/match.js";
import { indexTables } from "../src/traderie/lookup.js";

const tables = indexTables({
  generated_at: "x",
  products: [
    { name: "Arachnid Mesh", slug: "arachnid-mesh", category: "uniques" },
    { name: "Griswold's Honor", slug: "griswolds-honor", category: "sets" },
    { name: "Honor", slug: "honor", category: "runewords" },
    { name: "Strength", slug: "strength", category: "runewords" },
    { name: "Axe", slug: "axe", category: "base" },
    { name: "Ring", slug: "ring", category: "misc" },
    { name: "Grand Charm", slug: "grand-charm", category: "charms" },
    { name: "Mara's Kaleidoscope", slug: "maras-kaleidoscope", category: "uniques" },
  ],
  zh: {
    蜘蛛之網: "Arachnid Mesh",
    格里斯瓦德的榮耀: "Griswold's Honor",
    榮耀: "Honor",
    力量: "Strength",
    戒指: "Ring",
    特大咒符: "Grand Charm",
  },
  bases: ["Axe", "Ring", "Grand Charm"],
  game_only: [],
});
const index = buildMatchIndex(tables);
const names = (text) => matchOcrText(text, index).map((c) => `${c.kind}:${c.name}`);

test("a Chinese unique name is found even when the name line carries a mod tag with a misread bracket", () => {
  assert.deepEqual(names("蜘蛛之網[120EDI\n蛛網束帶[精英】\n防禦:129"), ["item:Arachnid Mesh"]);
});

test("one wrong character is tolerated in a long name, none in a two-character name", () => {
  assert.equal(names("格里斯瓦德的榮燿")[0], "item:Griswold's Honor");
  assert.deepEqual(names("榮燿"), []);
  assert.equal(allowedEdits(2, { cjk: true }), 0);
  assert.equal(allowedEdits(3, { cjk: true }), 1);
  assert.equal(allowedEdits(8, { cjk: true }), 2);
  assert.equal(levenshtein("kitten", "sitting"), 3);
});

test("stat lines never produce a name: 力量 on a strength requirement is not the Strength runeword", () => {
  assert.deepEqual(names("需要力量:148\n+9 力量(STR)\n力量 +20%"), []);
});

test("a two-character name inside a long noisy run is not trusted", () => {
  assert.deepEqual(names("一二三四五六榮耀七八九"), []);
});

test("short English words in noise do not match; a clean long English name does", () => {
  assert.deepEqual(names("Axe Ice ear"), []);
  assert.deepEqual(names("MARA'S KALEIDOSCOPE"), ["item:Mara's Kaleidoscope"]);
  assert.equal(names("MARA'S KALEID@SCQPE~")[0], "item:Mara's Kaleidoscope"); // two characters off in a long name
});

test("only when no item matches, the type line gives a plain item type, also after a random name", () => {
  assert.deepEqual(names("『怨靈 轉迴』\n戒指\n需要等級:48"), ["base:Ring"]);
  assert.deepEqual(names("維續之銳利特大咒符[S]\n放在物品欄以獲得其加成效果"), ["base:Grand Charm"]);
  assert.deepEqual(names("蜘蛛之網\n戒指"), ["item:Arachnid Mesh"]); // an item wins over a type
});

test("at most three candidates, best first", () => {
  const found = matchOcrText("蜘蛛之網\n格里斯瓦德的榮耀\n榮耀", index);
  assert.ok(found.length <= 3);
  assert.equal(found[0].kind, "item");
});

test("a random item name that equals a short real name does not beat a clear type line", () => {
  const withSling = indexTables({
    generated_at: "x",
    products: [
      { name: "Sling", slug: "sling", category: "uniques" },
      { name: "Ring", slug: "ring", category: "misc" },
    ],
    zh: { 投索: "Sling", 戒指: "Ring" },
    bases: ["Ring"],
    game_only: [],
  });
  const idx = buildMatchIndex(withSling);
  assert.deepEqual(matchOcrText("投索\n戒指\n需要等級:50", idx).map((c) => `${c.kind}:${c.name}`), ["base:Ring"]);
  assert.deepEqual(matchOcrText("投索", idx).map((c) => `${c.kind}:${c.name}`), ["item:Sling"]); // alone, still offered
});

test("a type word glued to its neighbours by OCR still gives the type, but only in a short run", () => {
  assert.deepEqual(names("K【怨靈轉迴】\n芭戒指天要等級"), ["base:Ring"]);
  assert.deepEqual(names("一二三四五六七八九十戒指一二三四五六七八九十"), []);
});

test("a name matches whether the screenshot writes its separator as a hyphen, a middle dot or not at all", () => {
  const t = indexTables({
    generated_at: "x",
    products: [{ name: "Alma Negra", slug: "alma-negra", category: "uniques" }],
    zh: { "阿爾瑪‧尼格拉": "Alma Negra" },
    bases: [],
    game_only: [],
  });
  const idx = buildMatchIndex(t);
  for (const text of ["阿爾瑪-尼格拉", "阿爾瑪·尼格拉", "阿爾瑪尼格拉", "阿爾瑪‧尼格拉"]) {
    assert.deepEqual(matchOcrText(text, idx).map((c) => c.name), ["Alma Negra"], text);
  }
});

test("a screenshot name with the period left out still matches a table name that has one", () => {
  const t = indexTables({
    generated_at: "x",
    products: [{ name: "Tal Rasha's Guardianship", slug: "tal-rashas-guardianship", category: "sets" }],
    zh: { "塔.拉夏的守護": "Tal Rasha's Guardianship" },
    bases: [],
    game_only: [],
  });
  assert.deepEqual(matchOcrText("塔拉夏的守護", buildMatchIndex(t)).map((c) => c.name), ["Tal Rasha's Guardianship"]);
  assert.deepEqual(matchOcrText("塔.拉夏的守護", buildMatchIndex(t)).map((c) => c.name), ["Tal Rasha's Guardianship"]);
});
