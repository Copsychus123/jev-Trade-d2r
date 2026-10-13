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
    { name: "Coronet", slug: "coronet", category: "base" },
    { name: "Alpha Helm", slug: "alpha-helm", category: "base" },
    { name: "Basinet", slug: "basinet", category: "base" },
    { name: "Smoke", slug: "smoke", category: "runewords" },
    { name: "Bloodletter", slug: "bloodletter", category: "uniques" },
    { name: "Jewel", slug: "jewel", category: "base" },
    { name: "Nightwing's Veil", slug: "nightwings-veil", category: "uniques" },
    { name: "Darksight Helm", slug: "darksight-helm", category: "uniques" },
    { name: "War Traveler", slug: "war-traveler", category: "uniques" },
  ],
  zh: {
    蜘蛛之網: "Arachnid Mesh",
    格里斯瓦德的榮耀: "Griswold's Honor",
    榮耀: "Honor",
    力量: "Strength",
    戒指: "Ring",
    特大咒符: "Grand Charm",
    寶冠: "Coronet",
    阿爾發頭盔: "Alpha Helm",
    輕鋼盔: "Basinet",
    煙霧: "Smoke",
    放血者: "Bloodletter",
    珠寶: "Jewel",
    夜翼面紗: "Nightwing's Veil",
    夜視之盔: "Darksight Helm",
    暗視之盔: "Darksight Helm",
    戰爭旅者: "War Traveler",
  },
  bases: ["Axe", "Ring", "Grand Charm", "Coronet", "Alpha Helm", "Basinet", "Jewel"],
  game_only: [],
});
const index = buildMatchIndex(tables);
const names = (text) => matchOcrText(text, index).map((c) => `${c.kind}:${c.name}`);

/** A match index over the given products/zh/bases, with the placeholder `generated_at` the tests use. */
const matchIndex = (products, zh, bases) =>
  buildMatchIndex(indexTables({ generated_at: "x", products, zh, bases, game_only: [] }));

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

test("the type line gives a plain item type: alone, after a random name, or as the alternative button under an item", () => {
  assert.deepEqual(names("『怨靈 轉迴』\n戒指\n需要等級:48"), ["base:Ring"]);
  assert.deepEqual(names("維續之銳利特大咒符[S]\n放在物品欄以獲得其加成效果"), ["base:Grand Charm"]);
  // The item still wins, but the type line under it is kept as an alternative button: a rare or magic item's printed
  // random name can be spelled exactly like a catalogue name (image-34 防禦者的火焰, image-46 蛋白石脈).
  assert.deepEqual(names("蜘蛛之網\n戒指"), ["item:Arachnid Mesh", "base:Ring"]);
});

test("at most three candidates, best first", () => {
  const found = matchOcrText("蜘蛛之網\n格里斯瓦德的榮耀\n榮耀", index);
  assert.ok(found.length <= 3);
  assert.equal(found[0].kind, "item");
});

test("an exact short-name match adds the item as an alternative when a type line is also present; a non-exact short match only gives the type", () => {
  const idx = matchIndex(
    [
      { name: "Sling", slug: "sling", category: "uniques" },
      { name: "Ring", slug: "ring", category: "misc" },
    ],
    { 投索: "Sling", 戒指: "Ring" },
    ["Ring"],
  );
  assert.deepEqual(matchOcrText("投索\n戒指\n需要等級:50", idx).map((c) => `${c.kind}:${c.name}`), ["item:Sling", "base:Ring"]);
  assert.deepEqual(matchOcrText("投索", idx).map((c) => `${c.kind}:${c.name}`), ["item:Sling"]); // alone, still offered
  const withMistake = matchOcrText("投鎖\n戒指\n需要等級:50", idx).map((c) => `${c.kind}:${c.name}`);
  assert.deepEqual(withMistake, ["base:Ring"]); // distance > 0, so still weak → type line wins
});

test("a type word glued to its neighbours by OCR still gives the type, but only in a short run", () => {
  assert.deepEqual(names("K【怨靈轉迴】\n芭戒指天要等級"), ["base:Ring"]);
  assert.deepEqual(names("一二三四五六七八九十戒指一二三四五六七八九十"), []);
});

test("a name matches whether the screenshot writes its separator as a hyphen, a middle dot or not at all", () => {
  const idx = matchIndex(
    [{ name: "Alma Negra", slug: "alma-negra", category: "uniques" }],
    { "阿爾瑪‧尼格拉": "Alma Negra" },
    [],
  );
  for (const text of ["阿爾瑪-尼格拉", "阿爾瑪·尼格拉", "阿爾瑪尼格拉", "阿爾瑪‧尼格拉"]) {
    assert.deepEqual(matchOcrText(text, idx).map((c) => c.name), ["Alma Negra"], text);
  }
});

test("a screenshot name with the period left out still matches a table name that has one", () => {
  const idx = matchIndex(
    [{ name: "Tal Rasha's Guardianship", slug: "tal-rashas-guardianship", category: "sets" }],
    { "塔.拉夏的守護": "Tal Rasha's Guardianship" },
    [],
  );
  assert.deepEqual(matchOcrText("塔拉夏的守護", idx).map((c) => c.name), ["Tal Rasha's Guardianship"]);
  assert.deepEqual(matchOcrText("塔.拉夏的守護", idx).map((c) => c.name), ["Tal Rasha's Guardianship"]);
});

test("CJK OCR font glyph confusions are repaired for base matching", () => {
  assert.deepEqual(names("長虹指走"), ["base:Ring"]);
  assert.deepEqual(names("長虹指"), ["base:Ring"]);
  assert.deepEqual(names("康賣她"), ["base:Coronet"]);
  assert.deepEqual(names("果發頭炙"), ["base:Alpha Helm"]);
  assert.deepEqual(names("全同果發頭炙"), ["base:Alpha Helm"]);
  assert.deepEqual(names("輕鋼葷"), ["base:Basinet"]);
  assert.deepEqual(names("煙宁"), ["item:Smoke"]);
  assert.deepEqual(names("珠喜"), ["base:Jewel"]);
  assert.deepEqual(names("和卻視之有禹只"), ["item:Darksight Helm"]);
});

test("verbatim CJK names with glued stray characters match items even when short", () => {
  assert.deepEqual(names("仿放血者點"), ["item:Bloodletter"]);
  assert.deepEqual(names("煙霧二呈和"), ["item:Smoke"]);
});

test("a name line that merely ends in a stray mark is not a stat line", () => {
  // The line has no value after the mark, so the whole line is a normal line and the name is matched.
  assert.deepEqual(names("ee 戰爭 旅 者 +"), ["item:War Traveler"]);
});

test("a stat word is never an item, whether it is cut from a stat line or sits in OCR noise", () => {
  // Cut from the front of a stat line ("需要 力量 :103" -> "需要力量", "需要的力量:103"): only the base pass may use it.
  assert.ok(!names("需要 力量 :103").includes("item:Strength"));
  assert.ok(!names("需要的力量:103").includes("item:Strength"));
  // OCR noise that happens to contain 力量 is not a stat line, but still must not become the Strength runeword.
  assert.ok(!names("轉圖人久力量").includes("item:Strength"));
  assert.deepEqual(names("轉圖人久力量"), []);
});

test("a stat-line prefix still rescues a glued base type word for the base pass", () => {
  // 戒指 is glued to the type-line front of a stat line: the base pass keeps it, the item pass does not.
  assert.deepEqual(names("戒指需要等級:48"), ["base:Ring"]);
  assert.ok(!names("戒指需要等級:48").includes("item:Ring"));
});

test("bases keep their wider gluing slack: 3-6 noise characters still leave a base match", () => {
  // 寶冠 (Coronet, 2 chars) inside a run of 6 glued noise characters: inside the base slack (6), beyond item slack (3).
  assert.deepEqual(names("甲乙丙丁戊己寶冠"), ["base:Coronet"]);
  // The same run is not trusted as an item.
  assert.ok(!names("甲乙丙丁戊己寶冠").includes("item:Coronet"));
  // 4 noise characters around 戒指 (Ring): still a base match.
  assert.deepEqual(names("甲乙丙丁戒指"), ["base:Ring"]);
});

// The four tests below use the real item table and OCR lines copied verbatim from the corpus reader's output
// (artifacts/ocr-bench/ppocr.json, file by file), so they pin the behaviour measured against the corpus instead of a
// small fixture whose entry order could hide it.
let realIndexPromise;
const realIndex = () =>
  (realIndexPromise ??= (async () => {
    const { readFile } = await import("node:fs/promises");
    const data = JSON.parse(await readFile(new URL("../src/traderie/data/items.json", import.meta.url), "utf8"));
    return buildMatchIndex(indexTables(data));
  })());
const candidatesOf = (text, idx) => matchOcrText(text, idx).map((c) => `${c.kind}:${c.name}`);

test("among equally scored candidates the earliest line wins (image-1: Griswold's Honor)", async () => {
  const idx = await realIndex();
  // image-1's name lines and type line, verbatim. 格里斯瓦德的榮耀 is the item's own line and comes first, but the
  // other set pieces all match it fuzzily at distance 2 before their own exact lines are read; that insertion order
  // used to decide the tie, so the exact match on the first line fell out of the three candidates.
  const text = [
    "格里斯瓦德的榮耀",
    "渦旋盾★★",
    "格里斯瓦德的傳奇",
    "格里斯瓦德的救贖",
    "格里斯瓦德之心",
    "格里斯瓦德的勇氣",
  ].join("\n");
  assert.deepEqual(candidatesOf(text, idx), [
    "item:Griswold's Honor",
    "item:Griswold's Legacy",
    "item:Griswold's Redemption",
  ]);
});

test("a strong item no longer deletes the type line (image-34 still offers base:Jewel)", async () => {
  const idx = await realIndex();
  // 防禦者的火焰 is the printed random name of a rare jewel and is also a catalogue name (Defender's Fire), and the
  // line under it is the type line 珠寶 -> Jewel.
  const found = matchOcrText(["防禦者的火焰", "珠寶"].join("\n"), idx);
  assert.deepEqual(
    found.map((c) => `${c.kind}:${c.name}`),
    ["item:Defender's Fire", "item:Defender's Bile", "base:Jewel"],
  );
  assert.ok(found.slice(0, 3).some((c) => c.kind === "base" && c.name === "Jewel"));
});

test("three strong items fill the candidate list, so no base is appended", async () => {
  const idx = await realIndex();
  // image-1's lines again: 渦旋盾 -> Vortex Shield is in the text, but the three item candidates already fill all
  // three slots, so the base pass is skipped instead of pushing an item out.
  const candidates = matchOcrText(
    ["格里斯瓦德的榮耀", "格里斯瓦德的傳奇", "格里斯瓦德的救贖", "渦旋盾★★"].join("\n"),
    idx,
  );
  assert.equal(candidates.length, 3);
  assert.deepEqual(candidates.map((c) => `${c.kind}:${c.name}`), [
    "item:Griswold's Honor",
    "item:Griswold's Legacy",
    "item:Griswold's Redemption",
  ]);
  assert.ok(!candidates.some((c) => c.kind === "base"));
  // A shorter item list leaves a slot free, and the same kind of type line is then offered: image-8's lines.
  assert.deepEqual(candidatesOf(["彩虹刻面", "珠寶"].join("\n"), idx), ["item:Rainbow Facet", "base:Jewel"]);
});

test("the combined item+base list is capped at three: the extra base is dropped", async () => {
  const idx = await realIndex();
  // Two strong items (蜘蛛之網 -> Arachnid Mesh, 彩虹刻面 -> Rainbow Facet) and two type lines (戒指 -> Ring,
  // 珠寶 -> Jewel) make four candidates before the cap; only the first three may survive, so base:Jewel is dropped.
  const candidates = candidatesOf(["蜘蛛之網", "彩虹刻面", "戒指", "珠寶"].join("\n"), idx);
  assert.deepEqual(candidates, ["item:Arachnid Mesh", "item:Rainbow Facet", "base:Ring"]);
  assert.equal(candidates.length, 3);
  assert.ok(!candidates.includes("base:Jewel"));
});

test("the tuned shapes are unchanged: the item stays first, ahead of the type line", async () => {
  const idx = await realIndex();
  // image-10's lines (投索 -> Sling, 戒指 -> Ring) and image-2's lines (煙霧 -> Smoke; the rune line contains
  // 那夫 -> Nef Rune and 盧姆 -> Lum Rune), verbatim from the corpus.
  assert.deepEqual(candidatesOf(["投索", "戒指", "需要等級:50"].join("\n"), idx), ["item:Sling", "base:Ring"]);
  assert.deepEqual(candidatesOf(["煙霧", "'那夫(#4)盧姆(#17)"].join("\n"), idx), [
    "item:Smoke",
    "item:Nef Rune",
    "item:Lum Rune",
  ]);
});
