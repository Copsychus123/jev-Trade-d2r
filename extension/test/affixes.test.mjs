import assert from "node:assert/strict";
import test from "node:test";

import { AFFIXES } from "../src/ocr/affix_dictionary.js";
import { parseAffixLines } from "../src/ocr/affixes.js";

// Real OCR output from the earlier Tesseract build for scripts/data/image-41.png (a rare ring) and image-42.png (a
// rare circlet), kept as the fixture text: spaces between Chinese characters, "%" read as 96 / 06, wrong letters in
// the bracket abbreviations.
const RING = [
  "瘟疫 之 圈",
  "戒指 [BR]",
  "需要 等 級 :60",
  "+1096 施法 速度 (FCH)",
  "+111 準確 率 (AB)",
  "+36 生 命 (Life)",
  "冰 寒 抗 性 (CR) +119%",
  "電擊 抗 性 (LR) +179%",
  "火焰 抗 性 (FRj +119",
  "壽 素 抗 性 (PB) +1196 |!",
  "Shift + 左 鍵 點 擊 以 裝備 |",
  "Ctrl+ 左 鍵 點 擊 以 去 下",
  "按 住 .Shift 鍵 進 行 比 較 :",
].join("\n");

const CIRCLET = [
  "出 售 價 格 ,35000",
  "死 証 飾 環",
  "頭 環 【[【 間 通 】",
  "防禦 :30",
  "[目標 : 2SKILL/20FCB/30FRW/SLL/8ML]",
  "[30STBR/30DEX/20BRES/90HP/90MP]",
  "[ 防 :30/15ED:35/ 無 形 :45/TOP:53|MAX:@]",
  "[鑑定 一 發 開 盲 盒 ]",
  "耐久 度 :35/35",
  "需要 等 級 :31",
  "+1 亞 馬 導 技能 等 級",
  "+2006 跑步 / 行 走 速 度 (FRW)",
  "+20096 施法 速度 (FCPB)",
  "+9 力量 (Str)",
  "+35 法 力 (Mana)",
  "所 有 抗 性 (BES) +20",
  "Shift+: 左 鍵 點 擊 以 裝備",
  "Ctrl+ 左 繡 點 擊 以 販 售",
  "按 住 Shift 鍵 進 行 比 較",
].join("\n");

const byKey = (result) => Object.fromEntries(result.conditions.map((c) => [c.key, c]));
const mine = (c) => [c.min, c.confident];

test("a rare ring: a plausible value with a % is trusted, an impossible magnitude and a value whose % was read as digits stay unsure", () => {
  const result = parseAffixLines(RING);
  const c = byKey(result);
  assert.deepEqual(mine(c.fcr), [10, false]); // +1096 -> the "96" is the misread "%"
  assert.deepEqual(mine(c.ar), [111, true]);
  assert.deepEqual(mine(c.life), [36, true]);
  // 119% and 179% single-resist lines are impossible reads of a real card (vanilla single-resist item lines top out
  // around 70); the assertion records reality, not intent.
  assert.deepEqual(mine(c.cold_res), [119, false]);
  assert.deepEqual(mine(c.light_res), [179, false]);
  assert.deepEqual(mine(c.fire_res), [119, false]); // no % and nothing to strip: shown, but unsure
  assert.deepEqual(mine(c.poison_res), [11, false]); // Chinese misread, found by the (PB) abbreviation
  assert.equal(Object.keys(c).length, 7);
});

test("lines that are not affixes (title, base, requirement, hints) are dropped, not listed as unrecognised", () => {
  assert.deepEqual(parseAffixLines(RING).unmapped, []);
});

test("a rare circlet: Chinese name, abbreviation and flat values", () => {
  const result = parseAffixLines(CIRCLET);
  const c = byKey(result);
  assert.deepEqual(mine(c.defense), [30, true]);
  assert.deepEqual(mine(c.frw), [20, false]);
  assert.deepEqual(mine(c.fcr), [20, false]); // "+20096" is a real 20% FCR whose % became 096; the ladder continues to 20
  assert.deepEqual(mine(c.str), [9, true]);
  assert.deepEqual(mine(c.mana), [35, true]);
  assert.deepEqual(mine(c.all_res), [20, true]);
  assert.equal(Object.keys(c).length, 6);
});

test("a circlet's skill line has no entry in the list: it is shown as not recognised, the summary lines are not", () => {
  const { unmapped } = parseAffixLines(CIRCLET);
  assert.equal(unmapped.length, 1);
  assert.ok(unmapped[0].includes("技能"));
});

test("the same affix twice keeps the first, and a longer name wins over the shorter one inside it", () => {
  const result = parseAffixLines("+10% 傷害加成\n+15% 傷害加成\n+20% 防禦加成\n+5 防禦");
  const c = byKey(result);
  assert.deepEqual(mine(c.ed), [10, true]);
  assert.deepEqual(mine(c.edef), [20, true]);
  assert.deepEqual(mine(c.defense), [5, true]);
  assert.equal(result.conditions.length, 3);
});

test("English lines work too, and a yes/no affix has no number", () => {
  const c = byKey(parseAffixLines("+2 to All Skills\n+20% Faster Cast Rate\nEthereal"));
  assert.deepEqual(mine(c.all_skills), [2, true]);
  assert.deepEqual(mine(c.fcr), [20, true]);
  assert.deepEqual(mine(c.ethereal), [null, true]);
});

test("every condition starts switched off and without an upper limit", () => {
  for (const c of parseAffixLines(RING).conditions) {
    assert.equal(c.on, false);
    assert.equal(c.max, null);
  }
});

test("nothing to read gives nothing", () => {
  assert.deepEqual(parseAffixLines(""), { conditions: [], unmapped: [] });
});

test("the dictionary has unique keys and every entry names its Traderie property", () => {
  assert.equal(new Set(AFFIXES.map((a) => a.key)).size, AFFIXES.length);
  for (const a of AFFIXES) {
    assert.ok(a.zh && a.en && ["percent", "plain", "bool"].includes(a.kind), a.key);
    assert.ok(a.traderie instanceof RegExp, a.key);
  }
});
