import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_POSSIBLE,
  allowedEdits,
  buildMatchIndex,
  decideCandidates,
  extendCandidates,
  levenshtein,
  matchOcrText,
  nameKeys,
} from "../src/ocr/match.js";
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
  // random name can be spelled exactly like a catalogue name.
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
  // 防禦者的火焰 is the unique jewel Defender's Fire, and the line under it is the type line 珠寶 -> Jewel: the same
  // shape a rare jewel with a random name spelled like a catalogue name would print, so the type line stays offered.
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

// --- when the best candidate may be filled in without asking (decideCandidates) -------------------------------------
// The lines below are verbatim from the 54 truth pictures' OCR text, first lines only (see docs/design.md for the
// measurement); the table is the real one, so these are the candidate lists the panel really gets.

/** Whether the best candidate of `text` may be filled in by itself, with the candidates it was decided on. */
async function decide(text, tones = null) {
  const found = matchOcrText(text, await realIndex(), tones);
  return { confident: decideCandidates(found).confident, names: found.map((c) => `${c.kind}:${c.name}`) };
}

test("a read is sure for a long item name with no type line, and for one or two type names", async () => {
  // image-1: the set piece's own line (the others match fuzzily and only fill the list).
  const set = await decide(["格里斯瓦德的榮耀", "渦旋盾★★", "防禦：325"].join("\n"));
  assert.equal(set.names[0], "item:Griswold's Honor");
  assert.equal(set.confident, true);
  // image-7: a plain ring, one type name. image-13: Alpha Helm and its generic Helm, two type names.
  assert.deepEqual(await decide(["蛇魔之箍", "★戒指★", "需要等級：46"].join("\n")), { confident: true, names: ["base:Ring"] });
  assert.deepEqual(await decide("阿爾發頭盔I擴"), { confident: true, names: ["base:Alpha Helm", "base:Helm"] });
});

test("without a lettering colour a read is not sure when an item has its type line under it", async () => {
  // image-46 (the unique ring Opalvein) and image-34 (the unique jewel Defender's Fire): the item is first at distance 0
  // and the type line follows. A rare or magic item whose random name is spelled like a catalogue name prints exactly
  // that, so the text alone cannot tell them apart; the colour can (see the tests on the lettering colour below).
  assert.deepEqual(await decide(["蛋白石脈", "戒指RING", "需要等級：50"].join("\n")), {
    confident: false,
    names: ["item:Opalvein", "base:Ring"],
  });
  const jewel = await decide(["防禦者的火焰", "珠寶"].join("\n"));
  assert.equal(jewel.confident, false);
  assert.equal(jewel.names.at(-1), "base:Jewel");
  // image-15 is a true unique, and its read looks exactly the same (name line, then the type line): it is asked too.
  assert.equal((await decide(["蜘蛛之網[120ED]", "蛛網束帶【精英】"].join("\n"))).confident, false);
});

test("a short item name is not sure without a colour that says it is a unique, with a type line (image-10) or alone", async () => {
  // image-10 is a real unique Sling; with no lettering colour a three-character name or less cannot be told from a
  // rare's, so it asks.
  assert.equal((await decide(["投索", "戒指"].join("\n"))).confident, false);
  assert.deepEqual(await decide("投索"), { confident: false, names: ["item:Sling"] });
  assert.deepEqual(await decide(["投索", "戒指"].join("\n"), [[251, 246, 182], [254, 251, 191]]), {
    confident: true,
    names: ["item:Sling", "base:Ring"],
  }, "image-10's own colours: the name line is unique gold, so the type line under it no longer matters");
  assert.deepEqual(await decide("投索", [[254, 251, 191]]), { confident: false, names: ["item:Sling"] },
    "a gold short name alone is still asked: only the type line under it rules out a stat word");
});

test("a short name glued into a longer run is not an item when the type line explains that text (image-41, image-20)", async () => {
  // 瘟疫之圈 is a rare ring's random name; 瘟疫 (the Plague runeword) is only a piece of it. 燦爛戒指 is the type line
  // 戒指 with 燦爛 (the Splendor runeword) glued in front of it by a magic ring's name.
  assert.deepEqual(await decide(["瘟疫之圈", "戒指[R]", "需要等級：60"].join("\n")), { confident: true, names: ["base:Ring"] });
  assert.deepEqual(await decide(["學徒之★燦爛戒指[R]", "需要等級：59"].join("\n")), { confident: true, names: ["base:Ring"] });
  // Without a type line there is nothing to explain the run, and the old guess stays (and is asked).
  assert.deepEqual(await decide("瘟疫之圈"), { confident: false, names: ["item:Plague"] });
});

test("a stat word cut from a stat line or an item's long line is not an item beside a type line (image-43, image-52)", async () => {
  // 需要力量 (the Strength runeword's 力量 inside "需要力量：") and 寒冰彈 (the Ice runeword's 寒冰 inside a longer run)
  // both used to come first, ahead of the type line that names the item.
  const boots = ["出售價格：11828", "石岩尖鑽", "Y'輕鎧靴", "防禦：14", "X", "物品欄BD:9-111", "[PVG:★R*/☆U", "耐久度（DUR):18/18", "需要力量："];
  assert.deepEqual(await decide(boots.join("\n")), { confident: true, names: ["base:Light Plated Boots"] });
  const sphere = ["出售價格：35000", "怨靈之歌", "物品欄", "攏煙之球", "單手傷害：4-10點", "耐久度：17/35", "(只限魔法使)", "寒冰彈"];
  assert.deepEqual(await decide(sphere.join("\n")), { confident: true, names: ["base:Smoked Sphere"] });
});

test("a line that is exactly a type word is the type line, not a misspelt item name (image-37)", async () => {
  // 護身符 is Amulet; it also sits two characters from the unique Amulet Of The Viper's name, which used to come first.
  assert.deepEqual(await decide(["物品欄", "野獸標記", "護身符", "需要等級：89"].join("\n")), {
    confident: true,
    names: ["base:Amulet"],
  });
});

test("the colour of the name line settles a type line under it: gold or green is a unique or set, yellow or blue is not", async () => {
  const lines = ["蜘蛛之網[120ED]", "蛛網束帶【精英】", "防禦：129"].join("\n");
  const tan = [203, 184, 124];
  const gold = [253, 249, 187]; // a paler unique gold, as some captures print it
  const green = [0, 251, 0];
  const yellow = [248, 248, 100]; // rare
  const blue = [133, 133, 246]; // magic
  const other = [199, 199, 199];
  const asks = [];
  for (const [colour, want] of [[tan, true], [gold, true], [green, true], [yellow, false], [blue, false], [other, false]]) {
    asks.push([colour.join(","), (await decide(lines, [colour, colour, other])).confident, want]);
  }
  assert.deepEqual(asks.map(([c, got]) => [c, got]), asks.map(([c, , want]) => [c, want]));
  // The colour that counts is the colour of the line the name was read from (line 0), not of the type line under it.
  assert.equal((await decide(lines, [yellow, gold, gold])).confident, false);
  assert.equal((await decide(lines, [gold, yellow, yellow])).confident, true);
  // No colour at all (an engine that sent none) is the old behaviour: ask.
  assert.equal((await decide(lines, [])).confident, false);
  assert.equal((await decide(lines)).confident, false);
  // A phone photo can wash a gold name out to white: that is not enough to fill it in.
  assert.equal((await decide(["蛋白石脈", "戒指RING", "需要等級：50"].join("\n"), [[242, 238, 222], [238, 234, 217]])).confident, false);
});

test("a candidate carries the quality of its own line's colour, and none without colours", async () => {
  const idx = await realIndex();
  const [best] = matchOcrText(["防禦者的火焰", "珠寶"].join("\n"), idx, [[192, 172, 112], [250, 250, 250]]);
  assert.equal(best.name, "Defender's Fire");
  assert.equal(best.quality, "gold");
  assert.equal(matchOcrText("防禦者的火焰", idx)[0].quality, undefined);
});

test("simplified glyphs the engine prints for traditional ones still read the name (IMG_0401: 盗贼皇冠 for 盜賊皇冠)", async () => {
  const idx = await realIndex();
  const lines = ["盗贼皇冠[12LL|200ED|100EG]", "莊嚴王冠【卓越】", "防禦：342"].join("\n");
  assert.deepEqual(candidatesOf(lines, idx).slice(0, 2), ["item:Crown Of Thieves", "base:Grand Crown"]);
  // And it is a unique read by its colour (the cream gold of this photo), so it fills itself in.
  const found = matchOcrText(lines, idx, [[236, 227, 189], [234, 229, 188], [235, 235, 230]]);
  assert.equal(decideCandidates(found).confident, true);
  assert.deepEqual(candidatesOf("殺手护盔[扩]", idx)[0], "base:Slayer Guard");
});

test("a game-side variant glyph or translation is aliased to the table's form (image-12 賭註, image-31 面*容)", async () => {
  // The two measured cases, verbatim from the corpus reader's output (artifacts/ocr-e2e/report.json, image-12 and
  // image-31): the game prints 基德的賭註 (言部) and 安達莉爾的面容 (a 貌 glyph the OCR reads as 容) where the table
  // lists 基德的賭注 and 安達莉爾的面貌. Both lines are cream gold (the corpus tones), so with the alias they are
  // sure unique reads; without it they were the flip-floppers between sure and unsure.
  const idx = await realIndex();
  for (const [line, tone, want] of [
    ["基德的賭註", [248, 245, 189], "item:Gheed's Wager"],
    ["安達莉爾的面容", [252, 247, 183], "item:Andariel's Visage"],
  ]) {
    const found = matchOcrText(line, idx, [tone]);
    assert.equal(`${found[0].kind}:${found[0].name}`, want, line);
    assert.equal(decideCandidates(found).confident, true, `${line} is a sure read`);
  }
  // The alias is a word pair, not a glyph rewrite: the table's own 面…容 names (image-51/IMG_0379, Arreat's Face)
  // still match, and still match when the OCR keeps the table's 貌.
  assert.deepEqual(candidatesOf("亞瑞特的面容[200ED|6LL]", idx)[0], "item:Arreat's Face");
  assert.deepEqual(candidatesOf("亞瑞特的面貌", idx)[0], "item:Arreat's Face");
  // A gold-lettered alias is still refused when the colour says it is not a fixed name: a rare whose random name
  // collides (yellow, with the type line under it) still asks the player.
  const rare = matchOcrText(["安達莉爾的面容", "惡魔頭蓋骨面具"].join("\n"), idx, [[253, 253, 149], [250, 250, 250]]);
  assert.equal(decideCandidates(rare).confident, false);
  // An unlisted variant is left alone: the map does not learn. The correction memory's key for the unlisted
  // 賭贍 keeps the raw glyph (no rewrite to 注), so it never meets the table form's key and is never learned
  // from; only the two measured pairs rewrite anything.
  assert.notEqual(nameKeys("基德的賭贍")[0].key, nameKeys("基德的賭注")[0].key);
  assert.equal(nameKeys("基德的賭贍")[0].key, "基德的賭贍");
});

test("the alias map normalises the correction memory's keys the same way as the matcher", async () => {
  // normalizeKey keys what the player chose for a name line; the variant form must land on the same key as the
  // table's form, so a choice made on one read is remembered for the other.
  const idx = await realIndex();
  const tableForm = nameKeys("基德的賭注")[0].key;
  assert.equal(nameKeys("基德的賭註")[0].key, tableForm);
  assert.equal(nameKeys("安達莉爾的面容")[0].key, nameKeys("安達莉爾的面貌")[0].key);
  assert.ok(tableForm.length > 0, `index over ${idx.items.length} items built`);
});

test("three type names for one line are not sure, the image-58 miss: the unique's own name line was never read", async () => {
  // image-58 is Ars Dul'Mephistos, whose name line the reader lost; only the type line 神秘秘典 came out, and it
  // fits three base names. The right answer is in none of them, so the player must be able to type it instead.
  assert.deepEqual(await decide(["0-", "神秘秘典【精英】", "防禦：362"].join("\n")), {
    confident: false,
    names: ["base:Occult Tome", "base:Tome", "base:Occult Codex"],
  });
});

test("nothing matched is never sure, whatever the caller passes", () => {
  assert.deepEqual(decideCandidates([]), { confident: false });
  assert.deepEqual(decideCandidates(undefined), { confident: false });
});

// --- the possible names of a read that is not sure ---------------------------------------------------------------------

test("a name the matcher gives up on is still offered by the wider tolerance, after the matcher's own candidates", () => {
  // "夜翼面紗" with two wrong characters and a long name with three: the matcher allows one and two.
  const four = "夜好面他";
  const eight = "格里斯好德的好好";
  assert.deepEqual(names(four), [], "the matcher itself finds nothing");
  assert.deepEqual(extendCandidates(matchOcrText(four, index), four, index).map((c) => `${c.kind}:${c.name}`), ["item:Nightwing's Veil"]);
  assert.deepEqual(names(eight), []);
  assert.deepEqual(
    extendCandidates(matchOcrText(eight, index), eight, index).map((c) => c.name),
    ["Griswold's Honor"],
  );
});

test("the matcher's own candidates stay first and in order, and the list never passes five", () => {
  const text = "夜好面他\n戒指\nArachnid Mesh Coronet";
  const first = matchOcrText(text, index);
  const extended = extendCandidates(first, text, index);

  assert.deepEqual(extended.slice(0, first.length), first);
  assert.equal(extended.length <= MAX_POSSIBLE, true);
  assert.equal(new Set(extended.map((c) => c.name)).size, extended.length, "no name twice");
  assert.equal(MAX_POSSIBLE, 5);
});

test("a short item name is never offered from a near miss, and unrelated text offers nothing", () => {
  // The matcher itself answers a lone near miss of a three-character name; beside a type line it does not, and the
  // possible names must not bring that stat-word-sized name back.
  const short = matchIndex(
    [{ name: "Ripsaw", slug: "ripsaw", category: "uniques" }, { name: "Ring Mail", slug: "ring-mail", category: "base" }],
    { 瑞普煞: "Ripsaw", 鎖子甲: "Ring Mail" },
    ["Ring Mail"],
  );
  const text = "瑞普好\n鎖子甲";
  const first = matchOcrText(text, short);
  assert.deepEqual(first.map((c) => c.name), ["Ring Mail"]);
  assert.deepEqual(extendCandidates(first, text, short).map((c) => c.name), ["Ring Mail"]);
  assert.deepEqual(extendCandidates([], "完全不相關的一行文字", index), []);
  assert.deepEqual(extendCandidates([], "", index), []);
});

test("many near names are cut to five, the matcher's three first", () => {
  const suffixes = ["甲", "乙", "丙", "丁", "戊", "己", "庚", "辛"];
  const crowd = matchIndex(
    suffixes.map((s, i) => ({ name: `Crowd ${i}`, slug: `crowd-${i}`, category: "uniques" })),
    Object.fromEntries(suffixes.map((s, i) => [`格里斯瓦德的榮${s}`, `Crowd ${i}`])),
    [],
  );
  const text = "格里斯瓦德的榮好好";
  const first = matchOcrText(text, crowd);
  const extended = extendCandidates(first, text, crowd);

  assert.equal(first.length, 3);
  assert.equal(extended.length, MAX_POSSIBLE);
  assert.deepEqual(extended.slice(0, 3), first);
});

test("a full list is returned untouched", () => {
  const full = Array.from({ length: MAX_POSSIBLE }, (_, i) => ({ kind: "item", name: `N${i}` }));
  assert.equal(extendCandidates(full, "夜好面他", index), full);
});

test("a match found only through the base pass's wide tolerance is offered as a type, not as an item", () => {
  // "Coronxt" is two letters off "Coronet" in the plain sense; as a type name it is offered with kind base.
  const text = "Alpxa Hxlm";
  const extended = extendCandidates(matchOcrText(text, index), text, index);
  assert.equal(extended.some((c) => c.kind === "base" && c.name === "Alpha Helm"), true);
});
