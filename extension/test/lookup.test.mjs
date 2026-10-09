import assert from "node:assert/strict";
import test from "node:test";

import {
  baseOptions,
  chineseName,
  findProduct,
  indexTables,
  isWellFormed,
  labelWithChinese,
  nameStatus,
  normalizeName,
  productUrlFor,
  resolveBase,
  resolveInput,
  searchFoundNothing,
  searchShowsItem,
  stripToBase,
  suggestNames,
  tableAge,
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

test("resolveBase resolves Chinese and English base names and handles empty/unknown cases", () => {
  const testTables = indexTables({
    generated_at: "2026-01-01T00:00:00+00:00",
    products: [],
    zh: {
      戒指: "Ring",
      頭環: "Circlet",
      非底材裝備: "Non Base Item",
    },
    bases: ["Ring", "Circlet"],
    game_only: [],
  });

  // Chinese base
  assert.equal(resolveBase("戒指", testTables), "Ring");
  assert.equal(resolveBase("  頭環  ", testTables), "Circlet");
  assert.equal(resolveBase("非底材裝備", testTables), "Non Base Item");

  // English base
  assert.equal(resolveBase("ring", testTables), "Ring");
  assert.equal(resolveBase("RING", testTables), "Ring");
  assert.equal(resolveBase("Circlet", testTables), "Circlet");
  assert.equal(resolveBase("unknown base", testTables), "unknown base");

  // Empty or undefined/null
  assert.equal(resolveBase("", testTables), "");
  assert.equal(resolveBase("   ", testTables), "");
  assert.equal(resolveBase(undefined, testTables), "");
  assert.equal(resolveBase(null, testTables), "");

  // Unrecorded Chinese base throws error
  assert.throws(
    () => resolveBase("未知底材", testTables),
    (err) => {
      assert.equal(
        err.message,
        "對照表裡沒有底材「未知底材」的英文名稱，請改輸入英文底材（如 Ring、Circlet）",
      );
      return true;
    },
  );
});

test("indexTables works on a table with only the fields the build ships (no category, no sources)", () => {
  const shipped = indexTables({
    generated_at: "2026-01-01T00:00:00+00:00",
    products: [
      { name: "The Stone of Jordan", slug: "the-stone-of-jordan" },
      { name: "Ring", slug: "ring" },
    ],
    zh: { 哈勒昆之冠: "Harlequin Crest" },
    bases: ["Ring"],
    game_only: ["Cow King's Leathers"],
  });
  assert.equal(productUrlFor(shipped.byKey.get(normalizeName("Ring"))), "https://www.traderie.com/diablo2resurrected/product/ring");
  assert.equal(shipped.zh.get("哈勒昆之冠"), "Harlequin Crest");
  assert.equal(shipped.baseByKey.get("ring"), "Ring");
  assert.equal(shipped.gameOnly.has(normalizeName("Cow King's Leathers")), true);
  assert.equal(shipped.generatedAt, "2026-01-01T00:00:00+00:00");
  assert.equal(findProduct("the stone of jordan", shipped).name, "The Stone of Jordan");
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

test("a name that two products share is never jumped to, and the shipped table has no unlisted duplicates", async () => {
  const shared = indexTables({
    generated_at: "x",
    products: [
      { name: "Crescent Moon", slug: "crescent-moon", category: "runewords" },
      { name: "Crescent Moon", slug: "crescent-moon-amulet", category: "uniques" },
      { name: "Harlequin Crest", slug: "harlequin-crest", category: "uniques" },
    ],
    zh: {},
    bases: [],
    game_only: [],
  });
  assert.equal(findProduct("crescent moon", shared), null);
  assert.equal(nameStatus("Crescent Moon", shared), "traderie");
  assert.equal(findProduct("Harlequin Crest", shared).slug, "harlequin-crest");

  const { readFile } = await import("node:fs/promises");
  const real = JSON.parse(await readFile(new URL("../src/traderie/data/items.json", import.meta.url), "utf8"));
  assert.deepEqual([...indexTables(real).ambiguous].sort(), ["crescent moon", "ward", "wirts leg"]);
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

test("the table age is whole days, and only a table older than 90 days is stale", () => {
  const generated = "2026-01-01T00:00:00+00:00";
  const at = (days, extraMs = 0) => Date.parse(generated) + days * 86_400_000 + extraMs;
  assert.deepEqual(
    [0, 89, 90, 91].map((days) => tableAge(generated, at(days, 3_600_000)).stale),
    [false, false, false, true],
  );
  assert.equal(tableAge(generated, at(30, 3_600_000)).days, 30);
  assert.equal(tableAge(generated, at(30)).date, "2026-01-01");
  assert.match(tableAge(generated, at(30)).text, /2026-01-01.*30 天前/u);
  assert.doesNotMatch(tableAge(generated, at(30)).text, /超過/u);
  assert.match(tableAge(generated, at(120)).text, /超過 90 天/u);
});

test("a table with no usable date is reported as unknown, never as fresh or stale", () => {
  for (const bad of [undefined, null, "", "not a date"]) {
    assert.deepEqual(tableAge(bad, 0), { days: null, date: null, stale: false, text: "名稱表日期不明" });
  }
  assert.equal(tableAge("2030-01-01T00:00:00Z", Date.parse("2026-01-01T00:00:00Z")).days, 0); // a clock set back
});

test("the shipped table carries a date the age helper can read", async () => {
  const { readFile } = await import("node:fs/promises");
  const real = JSON.parse(await readFile(new URL("../src/traderie/data/items.json", import.meta.url), "utf8"));
  assert.notEqual(tableAge(real.generated_at).days, null);
});

test("suggestions come from the tables, best match first, and never repeat what was typed", () => {
  const suggestTables = indexTables({
    generated_at: "2026-01-01T00:00:00+00:00",
    products: [
      { name: "Shako", slug: "shako", category: "uniques" },
      { name: "Shadow Dancer", slug: "shadow-dancer", category: "uniques" },
      { name: "Harlequin Crest", slug: "harlequin-crest", category: "uniques" },
      { name: "Crescent Moon", slug: "crescent-moon", category: "uniques" },
      { name: "Crescent Moon", slug: "crescent-moon-amazon", category: "uniques" }, // duplicate name
    ],
    zh: { "塔.拉夏的守護": "Tal Rasha's Guardianship", 軍帽: "Shako", 戒指: "Ring" },
    bases: [],
    game_only: [],
  });
  // English: "sha" → Shako (starts with), Shadow Dancer (starts with), shorter first
  const sha = suggestNames("sha", suggestTables);
  assert.equal(sha.length, 2);
  assert.equal(sha[0].label, "Shako");
  assert.equal(sha[1].label, "Shadow Dancer");
  assert.equal(sha[0].hint, "");
  // "crest" → contains in "Harlequin Crest" (word starts with)
  const crest = suggestNames("crest", suggestTables);
  assert.equal(crest.length, 1);
  assert.equal(crest[0].label, "Harlequin Crest");
  // single letter: nothing
  assert.equal(suggestNames("s", suggestTables).length, 0);
  // exact typed name: not included
  const shako = suggestNames("Shako", suggestTables);
  assert.ok(!shako.some((s) => s.label === "Shako"));
  // duplicate product names appear once
  const crescent = suggestNames("crescent", suggestTables);
  assert.equal(crescent.length, 1);
  assert.equal(crescent[0].label, "Crescent Moon");
  // limit
  assert.equal(suggestNames("s", suggestTables, 0).length, 0); // single letter anyway
  assert.equal(suggestNames("cr", suggestTables, 1).length, 1);
  // Chinese: typed 塔拉 → 塔.拉夏的守護 with hint
  const tala = suggestNames("塔拉", suggestTables);
  assert.equal(tala.length, 1);
  assert.equal(tala[0].label, "塔.拉夏的守護");
  assert.equal(tala[0].hint, "Tal Rasha's Guardianship");
  // empty: nothing
  assert.equal(suggestNames("", suggestTables).length, 0);
});

test("a candidate label pairs the English name with its Chinese name, and stays plain when there is none", () => {
  const t = indexTables({
    generated_at: "x",
    products: [{ name: "Arachnid Mesh", slug: "arachnid-mesh", category: "uniques" }],
    zh: {
      權冠: "Diadem",
      防禦盾: "Defender",
      戒指: "Ring",
      頭飾: "Circlet",
      頭環: "Circlet", // two Chinese names for one English name: the smallest one wins, whatever the order
      蜘蛛之網: "Arachnid Mesh",
    },
    bases: ["Diadem", "Defender", "Ring", "Circlet", "Kite Shield"],
    game_only: [],
  });
  assert.equal(labelWithChinese("Diadem", t), "Diadem（權冠）");
  assert.equal(labelWithChinese("Defender", t), "Defender（防禦盾）");
  assert.equal(labelWithChinese("Ring", t), "Ring（戒指）");
  assert.equal(labelWithChinese("Arachnid Mesh", t), "Arachnid Mesh（蜘蛛之網）");
  assert.equal(labelWithChinese("Circlet", t), "Circlet（頭環）");
  // No Chinese in the table, an unknown name, and an empty one are shown plain: never "（）".
  assert.equal(labelWithChinese("Kite Shield", t), "Kite Shield");
  assert.equal(labelWithChinese("No Such Thing", t), "No Such Thing");
  assert.equal(labelWithChinese("", t), "");
});

test("a Chinese screenshot's own name is echoed, and anything else falls back to the reverse map", () => {
  const t = indexTables({
    generated_at: "x",
    products: [],
    zh: {
      權冠: "Diadem",
      防禦盾: "Defender",
      戒指: "Ring",
      頭飾: "Circlet",
      頭環: "Circlet",
      統治者大盾: "Monarch",
      君主盾: "Monarch",
    },
    bases: ["Diadem", "Defender", "Ring", "Circlet", "Monarch"],
    game_only: [],
  });
  // The picture spells the alias the reverse map would not pick: echo what the player sees.
  assert.equal(labelWithChinese("Circlet", t, "頭飾"), "Circlet（頭飾）");
  assert.equal(labelWithChinese("Monarch", t, "統治者大盾"), "Monarch（統治者大盾）");
  // English matched text is not a Chinese name: fall back to the reverse map.
  assert.equal(labelWithChinese("Diadem", t, "Diadem"), "Diadem（權冠）");
  // A glued OCR run is not a table key: fall back, never show the raw run.
  assert.equal(labelWithChinese("Ring", t, "芭戒指天要等級"), "Ring（戒指）");
  // A key that belongs to a different name does not win either.
  assert.equal(labelWithChinese("Defender", t, "防禦"), "Defender（防禦盾）");
  assert.equal(labelWithChinese("Diadem", t, "戒指"), "Diadem（權冠）");
  // No matched text at all keeps the reverse-map behaviour.
  assert.equal(labelWithChinese("Circlet", t), "Circlet（頭環）");
  assert.equal(labelWithChinese("Monarch", t), "Monarch（君主盾）");
});

test("the Chinese half of a label comes from the reverse map", () => {
  const t = indexTables({
    generated_at: "x",
    products: [],
    zh: { 權冠: "Diadem", 戒指: "Ring", 蜘蛛之網: "Arachnid Mesh" },
    bases: ["Diadem", "Ring", "Arachnid Mesh"],
    game_only: [],
  });
  assert.equal(chineseName("Diadem", t), "權冠");
  assert.equal(chineseName("Ring", t), "戒指");
  assert.equal(chineseName("Arachnid Mesh", t), "蜘蛛之網");
});

test("a Chinese name the screenshot itself spells wins over the reverse map", () => {
  const t = indexTables({
    generated_at: "x",
    products: [],
    zh: { 頭飾: "Circlet", 頭環: "Circlet", 統治者大盾: "Monarch", 君主盾: "Monarch" },
    bases: ["Circlet", "Monarch"],
    game_only: [],
  });
  // 頭飾 is the alias the reverse map does not pick, but the picture spells it: echo what the player sees.
  assert.equal(chineseName("Circlet", t, "頭飾"), "頭飾");
  assert.equal(chineseName("Monarch", t, "統治者大盾"), "統治者大盾");
  assert.equal(chineseName("Circlet", t), "頭環"); // no matched text: the reverse map
});

test("an unknown or English-only name has no Chinese half", () => {
  const t = indexTables({
    generated_at: "x",
    products: [],
    zh: { 權冠: "Diadem" },
    bases: ["Diadem", "Kite Shield"],
    game_only: [],
  });
  assert.equal(chineseName("Kite Shield", t), ""); // in the tables, but no Chinese name
  assert.equal(chineseName("No Such Thing", t), ""); // unknown
  assert.equal(chineseName("", t), "");
  assert.equal(chineseName("Diadem", t, "Diadem"), "權冠"); // English matched text is not a Chinese name
  assert.equal(chineseName("Diadem", t, "戒指"), "權冠"); // a key that belongs to a different name does not win
});

test("the helper is the Chinese half of the label, so the two cannot drift", () => {
  const t = indexTables({
    generated_at: "x",
    products: [],
    zh: { 權冠: "Diadem", 戒指: "Ring", 頭飾: "Circlet", 頭環: "Circlet", 統治者大盾: "Monarch", 君主盾: "Monarch" },
    bases: ["Diadem", "Ring", "Circlet", "Monarch", "Kite Shield"],
    game_only: [],
  });
  // Parse the display string here, in the test: if the bracket format ever moves, this is what notices.
  const displayChinese = (label) => /（(.*)）$/u.exec(label)?.[1] ?? "";
  const inputs = [
    ["Diadem", ""],
    ["Ring", ""],
    ["Circlet", "頭飾"],
    ["Monarch", "統治者大盾"],
    ["Diadem", "Diadem"],
    ["Ring", "芭戒指天要等級"],
    ["Diadem", "戒指"],
    ["Kite Shield", ""],
    ["", ""],
  ];
  for (const [name, matched] of inputs) {
    const label = labelWithChinese(name, t, matched);
    assert.equal(chineseName(name, t, matched), displayChinese(label), `${name} / ${matched} -> ${label}`);
  }
});

test("baseOptions hands the shipped item types over in the table's own order, without duplicates", () => {
  assert.deepEqual(baseOptions(null), []);
  assert.deepEqual(baseOptions({}), []);
  assert.deepEqual(baseOptions({ bases: ["Ring", "Helm", "Ring", "Grand Charm"] }), ["Ring", "Helm", "Grand Charm"]);
});

test("a search page that lists the item as a link means a blocked verdict was a misjudgement", () => {
  const url = "https://www.traderie.com/diablo2resurrected?search=harlequin+crest";
  const found = {
    url,
    text: "Best Match\nHarlequin Crest",
    actions: [{ kind: "click", role: "link", label: "Harlequin Crest" }],
  };
  assert.equal(searchShowsItem(found, "Harlequin Crest"), true);
  // the address is not a search page
  assert.equal(searchShowsItem({ ...found, url: "https://www.traderie.com/diablo2resurrected" }, "Harlequin Crest"), false);
  // the page itself says nothing matched
  assert.equal(searchShowsItem({ ...found, text: "Best Match\nNo results could be found" }, "Harlequin Crest"), false);
  // the only link names a different item
  assert.equal(searchShowsItem({ ...found, actions: [{ kind: "click", role: "link", label: "Shako" }] }, "Harlequin Crest"), false);
  // a matching label that is not a clickable link does not count
  assert.equal(
    searchShowsItem({ ...found, actions: [{ kind: "click", role: "button", label: "Harlequin Crest" }] }, "Harlequin Crest"),
    false,
  );
});
