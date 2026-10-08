import assert from "node:assert/strict";
import test from "node:test";

import { AFFIXES } from "../src/ocr/affix_dictionary.js";
import { parseAffixLines } from "../src/ocr/affixes.js";

const byKey = (result) => Object.fromEntries(result.conditions.map((c) => [c.key, c]));
const mine = (c) => [c.min, c.confident];

test("擊中竊取 7% 法力 parses as ml with value 7", () => {
  const result = parseAffixLines("擊中竊取 7% 法力");
  const c = byKey(result);
  assert.ok(c.ml, "Expected ml affix to be matched");
  assert.equal(c.mana, undefined, "Should not match generic mana");
  assert.deepEqual(mine(c.ml), [7, true]);
});

test("擊中竊取 7% 生命 parses as ll with value 7", () => {
  const result = parseAffixLines("擊中竊取 7% 生命");
  const c = byKey(result);
  assert.ok(c.ll, "Expected ll affix to be matched");
  assert.equal(c.life, undefined, "Should not match generic life");
  assert.deepEqual(mine(c.ll), [7, true]);
});

test("2x 火焰抗性 (FB) +12% extracts value 12 (not 2)", () => {
  const result = parseAffixLines("2x 火焰抗性 (FB) +12%");
  const c = byKey(result);
  assert.ok(c.fire_res, "Expected fire_res affix to be matched");
  assert.deepEqual(mine(c.fire_res), [12, true]);
});

test("毒素抗性(88) +29% extracts value 29 (not 88)", () => {
  const result = parseAffixLines("毒素抗性(88) +29%");
  const c = byKey(result);
  assert.ok(c.poison_res, "Expected poison_res affix to be matched");
  assert.deepEqual(mine(c.poison_res), [29, true]);
});

test("火焰抗性 +909 repairs to 9", () => {
  const result = parseAffixLines("火焰抗性 +909");
  const c = byKey(result);
  assert.ok(c.fire_res, "Expected fire_res affix to be matched");
  assert.deepEqual(mine(c.fire_res), [9, false]);
});

test("percent misread repairs: 406 -> 40", () => {
  const result = parseAffixLines("火焰抗性 +406");
  const c = byKey(result);
  assert.ok(c.fire_res, "Expected fire_res affix to be matched");
  assert.deepEqual(mine(c.fire_res), [40, false]);
});

test("+2 德魯伊技能等級 (DU) matches dru_skills with min: 2, confident: true", () => {
  const result = parseAffixLines("+2 德魯伊技能等級 (DU)");
  const c = byKey(result);
  assert.ok(c.dru_skills, "Expected dru_skills affix to be matched");
  assert.deepEqual(mine(c.dru_skills), [2, true]);
});

test("+2 亞馬遜技能 matches ama_skills with min: 2, confident: true", () => {
  const result = parseAffixLines("+2 亞馬遜技能");
  const c = byKey(result);
  assert.ok(c.ama_skills, "Expected ama_skills affix to be matched");
  assert.deepEqual(mine(c.ama_skills), [2, true]);
});

test("中毒的時效縮短 (PU8) 25% matches plr with min: 25, confident: true", () => {
  const result = parseAffixLines("中毒的時效縮短 (PU8) 25%");
  const c = byKey(result);
  assert.ok(c.plr, "Expected plr affix to be matched");
  assert.deepEqual(mine(c.plr), [25, true]);
});

test("無法凍結 (CBF) matches cbf (bool, min: null, confident: true)", () => {
  const result = parseAffixLines("無法凍結 (CBF)");
  const c = byKey(result);
  assert.ok(c.cbf, "Expected cbf affix to be matched");
  assert.deepEqual(mine(c.cbf), [null, true]);
  assert.equal(c.cbf.kind, "bool");
});

test("生命回復 (LifeRep) +13 matches replenish_life with min: 13, confident: true", () => {
  const result = parseAffixLines("生命回復 (LifeRep) +13");
  const c = byKey(result);
  assert.ok(c.replenish_life, "Expected replenish_life affix to be matched");
  assert.deepEqual(mine(c.replenish_life), [13, true]);
});

test("+30% 跑步 / 衍走速度 matches frw with min: 30, confident: true", () => {
  const result = parseAffixLines("+30% 跑步 / 衍走速度");
  const c = byKey(result);
  assert.ok(c.frw, "Expected frw affix to be matched");
  assert.deepEqual(mine(c.frw), [30, true]);
});

test("+43% 防答強化 matches edef with min: 43, confident: true", () => {
  const result = parseAffixLines("+43% 防答強化");
  const c = byKey(result);
  assert.ok(c.edef, "Expected edef affix to be matched");
  assert.deepEqual(mine(c.edef), [43, true]);
});

test("肉電抗性 +32% matches light_res with min: 32, confident: true", () => {
  const result = parseAffixLines("肉電抗性 +32%");
  const c = byKey(result);
  assert.ok(c.light_res, "Expected light_res affix to be matched");
  assert.deepEqual(mine(c.light_res), [32, true]);
});

test("使目標減慢 (Slow) 10% matches slow with min: 10, confident: true", () => {
  const result = parseAffixLines("使目標減慢 (Slow) 10%");
  const c = byKey(result);
  assert.ok(c.slow, "Expected slow affix to be matched");
  assert.deepEqual(mine(c.slow), [10, true]);
});

// --- Requirement lines must never become affixes (measured: 21 conditions came from them) ---

for (const line of [
  "需要 力量 :148",
  "南 要 力量 : 148",
  "加 | | 需要 力量 :95 by",
  "劑 加 要 力量 : 1S6 1",
  "品 需要 力量 : 160 |: 圖 自生",
  "一 需要 力量 : 欠 ) G2 吧 仿",
  "則 一 一 還 謂語 需要 力量 : 124",
]) {
  test(`requirement line ${JSON.stringify(line)} yields no str condition`, () => {
    const c = byKey(parseAffixLines(line));
    assert.equal(c.str, undefined, "a required-strength line is not a +to Strength affix");
  });
}

for (const line of ["需要 敏捷 :103", "需要 敏捷 : 94"]) {
  test(`requirement line ${JSON.stringify(line)} yields no dex condition`, () => {
    const c = byKey(parseAffixLines(line));
    assert.equal(c.dex, undefined, "a required-dexterity line is not a +to Dexterity affix");
  });
}

test("+27 力量 (STN) is still a real affix with min: 27, confident: true", () => {
  const c = byKey(parseAffixLines("+27 力量 (STN)"));
  assert.ok(c.str, "Expected str affix to be matched");
  assert.deepEqual(mine(c.str), [27, true]);
});

// --- Ordered repair ladder for percent lines whose "%" the reader turned into digits ---
// confidence is always false on this path: a repaired number is never trusted.

test("+2096 打擊恢復 repairs to 20 (two-digit 96 misread)", () => {
  assert.deepEqual(mine(byKey(parseAffixLines("+2096 打擊恢復")).fhr), [20, false]);
});

test("+7596 防禦強化 repairs to 75 (two-digit 96 misread)", () => {
  // The image-2 artifact prints 御 for one frame; the dictionary word is 禦. The numeric repair is what is pinned.
  assert.deepEqual(mine(byKey(parseAffixLines("+7596 防禦強化")).edef), [75, false]);
});

test("+2009 施法速度 repairs to 20 (two-digit 09 misread)", () => {
  assert.deepEqual(mine(byKey(parseAffixLines("+2009 施法速度")).fcr), [20, false]);
});

test("+10509 防禦強化 repairs to 105 (two-digit 09 misread)", () => {
  assert.deepEqual(mine(byKey(parseAffixLines("+10509 防禦強化")).edef), [105, false]);
});

test("+1096 打擊恢復 repairs to 10 (two-digit 96 misread)", () => {
  assert.deepEqual(mine(byKey(parseAffixLines("+1096 打擊恢復")).fhr), [10, false]);
});

test("火焰抗性 +596 repairs to 59 (3-digit trailing 6)", () => {
  assert.deepEqual(mine(byKey(parseAffixLines("火焰抗性 +596")).fire_res), [59, false]);
});

test("+205 跑步 / 行走速度 repairs to 20 (single trailing 5)", () => {
  assert.deepEqual(mine(byKey(parseAffixLines("+205 跑步 / 行走速度")).frw), [20, false]);
});

test("冰寒抗性(CR) +110 repairs to 11 (single trailing 0)", () => {
  assert.deepEqual(mine(byKey(parseAffixLines("冰寒抗性(CR) +110")).cold_res), [11, false]);
});

test("“+1659 防禦 強化 (EDef) repairs to 165 (single trailing 9)", () => {
  assert.deepEqual(mine(byKey(parseAffixLines("“+1659 防禦 強化 (EDef)")).edef), [165, false]);
});

test("+34060 打擊恢復 continues to 34 (single trailing 0 then the ceiling strip)", () => {
  assert.deepEqual(mine(byKey(parseAffixLines("+34060 打擊恢復")).fhr), [34, false]);
});

// --- A present "%" is never repaired, and abbreviations keep matching ---

test("+30% 跑步 / 行走速度 keeps 30 confident: true (the % is present)", () => {
  assert.deepEqual(mine(byKey(parseAffixLines("+30% 跑步 / 行走速度")).frw), [30, true]);
});

test("+20% 施法速度 (FCR) matches fcr by abbreviation with 20, confident: true", () => {
  const c = byKey(parseAffixLines("+20% 施法速度 (FCR)"));
  assert.ok(c.fcr, "Expected fcr affix to be matched");
  assert.deepEqual(mine(c.fcr), [20, true]);
});

// --- "(Def)" is the client's flat-Defense token, "(EDef)" its Enhanced Defense token; neither may fall through
// to Dex, which is a single letter away from the abbreviation tolerance. These are the real corpus lines of
// image-17 (Alma Negra), image-53 and image-55 (artifacts/ocr-e2e/all_54_results.json).

test("+191% 防握強化 (Def) from image-17 is Enhanced Defense (edef), not dexterity", () => {
  const line = "+191% 防 握 強 化 (Def)"; // 防握強化 misreads 防禦強化, the edef word
  const c = byKey(parseAffixLines(line));
  assert.ok(c.edef, "Expected edef affix to be matched");
  assert.equal(c.dex, undefined, "a (Def) token must not resolve to dex");
  assert.deepEqual(mine(c.edef), [191, true]);
});

test("+300 防帛 (Def) from image-53 is a flat defense roll, not dexterity", () => {
  const line = "+300 防 帛 (Def) es 人 人";
  const c = byKey(parseAffixLines(line));
  assert.ok(c.defense, "the (Def) token is the flat Defense abbreviation");
  assert.equal(c.dex, undefined, "a (Def) token must not resolve to dex");
  assert.deepEqual(mine(c.defense), [300, true]);
});

test("+605 防帛強化 (EDef) from image-55 is edef by its client abbreviation, not flat defense", () => {
  const line = "+605 防 帛 強化 (EDef)";
  const c = byKey(parseAffixLines(line));
  assert.ok(c.edef, "the (EDef) token is the Enhanced Defense abbreviation");
  assert.equal(c.defense, undefined, "an (EDef) token must not resolve to flat defense");
  assert.deepEqual(mine(c.edef), [60, false]); // 605 repaired: the "%" was read as a trailing 5
});

test("+20 敏捷 (Dex) still matches dex by its exact abbreviation", () => {
  const c = byKey(parseAffixLines("+20 敏捷 (Dex)"));
  assert.ok(c.dex, "Expected dex affix to be matched");
  assert.equal(c.defense, undefined, "a real Dexterity line must not become a defense line");
  assert.deepEqual(mine(c.dex), [20, true]);
});

// --- Sanity ceilings: a value above the affix's generous ceiling is kept but marked unsure ---

test("a plain value that cannot be a roll is kept but marked unsure (320 Strength)", () => {
  const c = byKey(parseAffixLines("人 320 力量 (St 5 |"));
  assert.ok(c.str, "Expected str affix to be matched");
  assert.deepEqual(mine(c.str), [320, false]); // the value is unchanged, only confidence is downgraded
});

test("a plausible attribute roll is untouched by the ceiling", () => {
  assert.deepEqual(mine(byKey(parseAffixLines("+30 力量 (STR)")).str), [30, true]);
});

test("a large but legitimate percent roll stays trusted (305% EDef)", () => {
  assert.deepEqual(mine(byKey(parseAffixLines("+305% 防禦強化 (EDef)")).edef), [305, true]);
});

test("a keyword match with no number is dropped, not reported as unrecognised (生命之寶藍)", () => {
  const line = "『 生 命 之 寶藍 J";
  const { conditions, unmapped } = parseAffixLines(line);
  assert.equal(byKey({ conditions }).life, undefined, "a title line is not a life affix");
  assert.ok(!unmapped.includes(line), "a title line is not an unrecognised affix either");
});

// --- One boundary test per ceiling group: the ceiling itself is trusted, one above is not ---

test("resist ceiling is 100 (100% trusted, 101% unsure)", () => {
  assert.deepEqual(mine(byKey(parseAffixLines("毒素抗性 +100%")).poison_res), [100, true]);
  assert.deepEqual(mine(byKey(parseAffixLines("毒素抗性 +101%")).poison_res), [101, false]);
});

test("attribute ceiling is 99 (99 trusted, 100 unsure)", () => {
  assert.deepEqual(mine(byKey(parseAffixLines("+99 力量")).str), [99, true]);
  assert.deepEqual(mine(byKey(parseAffixLines("+100 力量")).str), [100, false]);
});

test("skill ceiling is 9 (9 trusted, 10 unsure)", () => {
  assert.deepEqual(mine(byKey(parseAffixLines("+9 to All Skills")).all_skills), [9, true]);
  assert.deepEqual(mine(byKey(parseAffixLines("+10 to All Skills")).all_skills), [10, false]);
});

test("enhanced ceiling is 600 (600% trusted, 601% unsure)", () => {
  assert.deepEqual(mine(byKey(parseAffixLines("+600% 防禦強化")).edef), [600, true]);
  assert.deepEqual(mine(byKey(parseAffixLines("+601% 防禦強化")).edef), [601, false]);
});

test("defense ceiling is 5000 (5000 trusted, 5001 unsure)", () => {
  assert.deepEqual(mine(byKey(parseAffixLines("+5000 防禦")).defense), [5000, true]);
  assert.deepEqual(mine(byKey(parseAffixLines("+5001 防禦")).defense), [5001, false]);
});

test("attack-rating ceiling is 2000 (2000 trusted, 2001 unsure)", () => {
  assert.deepEqual(mine(byKey(parseAffixLines("+2000 準確率")).ar), [2000, true]);
  assert.deepEqual(mine(byKey(parseAffixLines("+2001 準確率")).ar), [2001, false]);
});

test("life/mana ceiling is 500 (500 trusted, 501 unsure)", () => {
  assert.deepEqual(mine(byKey(parseAffixLines("+500 生命")).life), [500, true]);
  assert.deepEqual(mine(byKey(parseAffixLines("+501 生命")).life), [501, false]);
});

test("small-affix ceiling is 100 (100% trusted, 101% unsure)", () => {
  assert.deepEqual(mine(byKey(parseAffixLines("+100% 施法速度")).fcr), [100, true]);
  assert.deepEqual(mine(byKey(parseAffixLines("+101% 施法速度")).fcr), [101, false]);
});

test("mf ceiling is 150 (150% trusted, 151% unsure)", () => {
  assert.deepEqual(mine(byKey(parseAffixLines("+150% 魔法裝備掉落")).mf), [150, true]);
  assert.deepEqual(mine(byKey(parseAffixLines("+151% 魔法裝備掉落")).mf), [151, false]);
});

test("eg ceiling is 250 (250% trusted, 251% unsure)", () => {
  assert.deepEqual(mine(byKey(parseAffixLines("+250% 額外金幣")).eg), [250, true]);
  assert.deepEqual(mine(byKey(parseAffixLines("+251% 額外金幣")).eg), [251, false]);
});

test("leech ceiling is 25 (25% trusted, 26% unsure)", () => {
  assert.deepEqual(mine(byKey(parseAffixLines("擊中竊取 25% 生命")).ll), [25, true]);
  assert.deepEqual(mine(byKey(parseAffixLines("擊中竊取 26% 生命")).ll), [26, false]);
});

// --- Ceiling-aware continuation: a ladder repair still above the ceiling strips one more digit (no-% path only) ---

test("+20096 施法速度 continues the repair to 20 (a real 20% whose % became 096)", () => {
  assert.deepEqual(mine(byKey(parseAffixLines("+20096 施法速度")).fcr), [20, false]);
});

for (const [line, key, value] of [
  ["電擊抗性 +4990", "light_res", 49],
  ["電擊抗性 +1936", "light_res", 19],
  ["冰寒抗性 +2090", "cold_res", 20],
  ["冰寒抗性 +1790", "cold_res", 17],
]) {
  test(`${JSON.stringify(line)} continues to ${value}`, () => {
    assert.deepEqual(mine(byKey(parseAffixLines(line))[key]), [value, false]);
  });
}

test("a raw read with no applying rung is left alone (1332 stays 1332, unsure)", () => {
  assert.deepEqual(mine(byKey(parseAffixLines("電擊抗性 +1332")).light_res), [1332, false]);
});

test("a value read with a literal % is never stripped (855% stays, unsure)", () => {
  assert.deepEqual(mine(byKey(parseAffixLines("冰寒抗性 +855%")).cold_res), [855, false]);
});

test("every non-bool affix carries a numeric ceiling, every bool affix none", () => {
  for (const a of AFFIXES) {
    if (a.kind === "bool") assert.equal(a.ceiling, null, a.key);
    else assert.ok(Number.isFinite(a.ceiling), `${a.key} needs a ceiling`);
  }
});
