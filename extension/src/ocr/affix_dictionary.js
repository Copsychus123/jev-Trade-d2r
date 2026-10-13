// The affixes the screenshot reader knows, in the words the game prints (Traditional Chinese client, English) and the
// property of Traderie each one is looked up under. No property id is written here: `traderie` is matched against
// the names Traderie itself provides (traderie/properties.js), where "{{value}}" is shown as "X", for example
// "+X% Faster Cast Rate". An entry whose pattern matches no property, or more than one, is left out of the search
// (the player sees "Traderie has no such property"), see traderie/stats.js.
//
//   zh / zhAlt  Chinese words to find in the line (spaces between Chinese characters are ignored)
//   en          English words to find in the line (any case)
//   abbr        the bracket abbreviation the client appends, "(FCR)"; compared allowing one wrong letter
//   kind        percent: the number is a percentage | plain: a flat number | bool: a yes/no affix without a number
// Sanity ceiling per affix, carried on the entry as `ceiling` (null for `bool`, which has no number). It is not a
// game cap: a generously high bound that only exists to catch OCR reads which cannot be a real in-game roll. A value
// above the ceiling is still filled into the form unchanged; only `confident` is downgraded to false (see readNumber
// in affixes.js). Adjust only the numbers in CEILINGS when the measured corpus table arrives; the groups are:
//   resists      single-resist and all-res item lines top out around 70, so 100 is already beyond any real roll.
//   attributes   str/dex/vit/ene realistically peak around +40, so 99 is generous.
//   skills       +1..+3 per item, so 9 is generous.
//   enhanced     ed/edef legitimately reach 300%+, so their bound (600) is far above a resist's.
//   defense/ar   large by nature (elite armour totals, clvl-scaled AR), so 5000 / 2000 are generous.
//   life/mana    flat rolls stay well under 500.
//   utility      fcr/frw/fhr/ias/plr/slow/dr/mdr/sockets/replenish_life/maek all stay under 100.
//   mf           the highest real MF line is Skulder's Ire at ~123%, so 150 is generous.
//   eg           Gheed's Fortune reaches ~160%, so 250 is generous.
//   leech        ll/ml are capped around 8-12% per item line, so 25 is generous.
const CEILINGS = {
  all_skills: 9,
  ama_skills: 9,
  asn_skills: 9,
  bar_skills: 9,
  dru_skills: 9,
  nec_skills: 9,
  pal_skills: 9,
  sor_skills: 9,
  str: 99,
  dex: 99,
  vit: 99,
  ene: 99,
  all_res: 100,
  fire_res: 100,
  cold_res: 100,
  light_res: 100,
  poison_res: 100,
  ed: 600,
  edef: 600,
  defense: 5000,
  ar: 2000,
  life: 500,
  mana: 500,
  fcr: 100,
  frw: 100,
  fhr: 100,
  ias: 100,
  plr: 100,
  slow: 100,
  dr: 100,
  mdr: 100,
  sockets: 100,
  replenish_life: 100,
  maek: 100,
  mf: 150,
  eg: 250,
  ll: 25,
  ml: 25,
  ethereal: null,
  cbf: null,
};

const affix = (key, zh, en, abbr, kind, traderie, zhAlt = []) => ({
  key,
  zh,
  zhAlt,
  en,
  abbr,
  kind,
  traderie,
  ceiling: CEILINGS[key] ?? null,
});

export const AFFIXES = [
  affix("all_skills", "所有技能", "All Skills", "", "plain", /^\+X to All Skills$/iu),
  affix("fcr", "施法速度", "Faster Cast", "FCR", "percent", /^\+X% Faster Cast Rate$/iu),
  affix("frw", "跑步／行走速度", "Faster Run", "FRW", "percent", /^\+X% Faster Run\/Walk$/iu, [
    "行走速度",
    "跑步",
    "衍走速度",
    "跑步速度",
  ]),
  affix("fhr", "打擊恢復", "Faster Hit", "FHR", "percent", /^\+X% Faster Hit Recovery$/iu),
  affix("ias", "攻擊速度", "Increased Attack Speed", "IAS", "percent", /^\+X% Increased Attack Speed$/iu),
  affix("life", "生命", "to Life", "Life", "plain", /^\+X to Life$/iu),
  affix("mana", "法力", "to Mana", "Mana", "plain", /^\+X to Mana$/iu),
  affix("str", "力量", "to Strength", "Str", "plain", /^\+X to Strength$/iu),
  affix("dex", "敏捷", "to Dexterity", "Dex", "plain", /^\+X to Dexterity$/iu),
  affix("vit", "體力", "to Vitality", "Vit", "plain", /^\+X to Vitality$/iu),
  affix("ene", "精力", "to Energy", "Ene", "plain", /^\+X to Energy$/iu),
  affix("all_res", "所有抗性", "All Resistances", "RES", "plain", /^\+X to All Resistances$/iu),
  affix("fire_res", "火焰抗性", "Fire Resist", "FR", "percent", /^Fire Resist \+X%$/iu),
  affix("cold_res", "冰寒抗性", "Cold Resist", "CR", "percent", /^Cold Resist \+X%$/iu),
  affix("light_res", "電擊抗性", "Lightning Resist", "LR", "percent", /^Lightning Resist \+X%$/iu, [
    "肉電抗性",
    "閃電抗性",
  ]),
  affix("poison_res", "毒素抗性", "Poison Resist", "PR", "percent", /^Poison Resist \+X%$/iu),
  affix("ar", "準確率", "to Attack Rating", "AR", "plain", /^\+X to Attack Rating$/iu, [
    "崔信人主",
    "準確率加成",
  ]),
  affix("mf", "魔法裝備掉落", "Getting Magic", "MF", "percent", /^X% Better Chance of Getting Magic Items$/iu, [
    "魔法物品",
    "魔法裝備",
  ]),
  affix("ed", "傷害加成", "Enhanced Damage", "ED", "percent", /^\+X% Enhanced Damage$/iu, ["傷害增強"]),
  affix("edef", "防禦加成", "Enhanced Defense", "EDef", "percent", /^\+X% Enhanced Defense$/iu, [
    "防禦增強",
    "防答強化",
    "防握強化",
    "防答",
    "防禦強化",
  ]),
  // The client prints "(Def)" for a flat Defense line (measured: image-53 "+300 防禦 (Def)", image-55 "+10 防禦
  // (Defj)"). Without this the token is one letter from "Dex" and an enhanced/flat defense line is read as a
  // dexterity condition (image-17, image-53).
  affix("defense", "防禦", "Defense", "Def", "plain", /^\+X Defense$/iu),
  affix("ll", "生命偷取", "Life Stolen", "LL", "percent", /^X% Life stolen per hit$/iu, [
    "生命竊取",
    "擊中竊取生命",
    "竊取生命",
  ]),
  affix("ml", "法力偷取", "Mana Stolen", "ML", "percent", /^X% Mana stolen per hit$/iu, [
    "法力竊取",
    "擊中竊取法力",
    "竊取法力",
  ]),
  affix("sockets", "孔數", "Socketed", "", "plain", /^Socketed \(X\)$/iu, ["凹槽", "插槽"]),
  affix("ethereal", "無形", "Ethereal", "", "bool", /^Ethereal$/iu),
  // Class skills:
  affix("ama_skills", "亞馬遜技能", "Amazon Skill Levels", "", "plain", /^\+X to Amazon Skill Levels$/iu, ["亞馬遜技能等級", "亞馬遜所有技能"]),
  affix("asn_skills", "刺客技能", "Assassin Skill Levels", "", "plain", /^\+X to Assassin Skill Levels$/iu, ["刺客技能等級", "刺客所有技能"]),
  affix("bar_skills", "野蠻人技能", "Barbarian Skill Levels", "", "plain", /^\+X to Barbarian Skill Levels$/iu, ["野蠻人技能等級", "野蠻人所有技能"]),
  affix("dru_skills", "德魯伊技能", "Druid Skill Levels", "", "plain", /^\+X to Druid Skill Levels$/iu, ["德魯伊技能等級", "德魯伊所有技能"]),
  affix("nec_skills", "死靈法師技能", "Necromancer Skill Levels", "", "plain", /^\+X to Necromancer Skill Levels$/iu, ["死靈法師技能等級", "死靈法師所有技能", "死靈法師"]),
  affix("pal_skills", "聖騎士技能", "Paladin Skill Levels", "", "plain", /^\+X to Paladin Skill Levels$/iu, ["聖騎士技能等級", "聖騎士所有技能", "聖騎士"]),
  affix("sor_skills", "魔法使技能", "Sorceress Skill Levels", "", "plain", /^\+X to Sorceress Skill Levels$/iu, ["魔法使技能等級", "魔法使所有技能", "巫師技能"]),
  // High-value yellow/rare stats:
  affix("plr", "中毒時效縮短", "Poison Length", "PLR", "percent", /^Poison Length Reduced by X%$/iu, ["中毒時間縮短", "中毒的時效縮短"]),
  affix("replenish_life", "生命回復", "Replenish Life", "", "plain", /^Replenish Life \+X$/iu, ["生命補給", "回復生命"]),
  affix("cbf", "無法凍結", "Cannot Be Frozen", "CBF", "bool", /^Cannot Be Frozen$/iu),
  affix("maek", "殺怪獲取法力", "Mana after each Kill", "EK", "plain", /^\+X to Mana after each Kill$/iu, ["每殺死一個敵人獲得法力", "殺死敵人獲得法力", "擊殺獲得法力"]),
  affix("eg", "額外金幣", "Extra Gold", "EG", "percent", /^X% Extra Gold from Monsters$/iu, ["金幣掉落", "怪物金幣掉落", "尋獲金幣"]),
  affix("dr", "物理傷害減免", "Damage Reduced", "PDR", "plain", /^Damage Reduced by X$/iu, ["物理傷害降低", "受到物理傷害降低", "傷害降低", "受到的物理傷害降低"]),
  affix("mdr", "魔法傷害減少", "Magic Damage Reduced", "MDR", "plain", /^Magic Damage Reduced by X$/iu, ["魔法傷害降低", "受到魔法傷害降低"]),
  affix("slow", "使目標減慢", "Slows Target", "Slow", "percent", /^Slows Target by X%$/iu, ["目標減慢", "減慢目標", "使目標減速"]),
];
