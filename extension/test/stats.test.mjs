import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { AFFIXES } from "../src/ocr/affix_dictionary.js";
import { normalizeProperties } from "../src/traderie/properties.js";
import {
  buildStatsUrl,
  conditionPattern,
  describeConditions,
  mapConditions,
  mapQuality,
  parseItemTypes,
  rowsMissingConditions,
  typeForBase,
  unmappedKeys,
  urlKeepsParams,
} from "../src/traderie/stats.js";

// Traderie's real property list (742 entries, saved by scripts/probe_stats.py) and a saved home page.
const properties = normalizeProperties(JSON.parse(readFileSync(new URL("./fixtures/properties.json", import.meta.url), "utf8")));
const homePage = readFileSync(new URL("../../tests/fixtures/home_stats.txt", import.meta.url), "utf8");

// Traderie's own list with the Faster Cast Rate property removed: what "Traderie has no property for it" looks like.
const WITHOUT_FCR = properties.filter((p) => p.id !== 520);

const on = (key, min, max = null) => ({ key, label: AFFIXES.find((a) => a.key === key).zh, on: true, min, max });

test("every affix the reader knows is exactly one property of Traderie's real list", () => {
  assert.ok(properties.length > 500);
  assert.deepEqual(unmappedKeys(properties), []);
});

test("conditions map to the ids of the real list, a number condition by id and a yes/no one by name", () => {
  const { mapped, unmapped } = mapConditions([on("fcr", 10), on("all_res", 20), on("ethereal", null)], properties);
  assert.deepEqual(unmapped, []);
  assert.deepEqual(
    mapped.map((m) => [m.key, m.id, m.name, m.type]),
    [
      ["fcr", 520, "+{{value}}% Faster Cast Rate", "number"],
      ["all_res", 441, "+{{value}} to All Resistances", "number"],
      ["ethereal", 738, "Ethereal", "bool"],
    ],
  );
});

test("a condition that is switched off is not searched", () => {
  assert.equal(mapConditions([{ ...on("fcr", 10), on: false }], properties).mapped.length, 0);
});

test("a condition Traderie has no property for is reported, not guessed", () => {
  const { mapped, unmapped } = mapConditions([on("fcr", 10), on("life", 36)], WITHOUT_FCR);
  assert.deepEqual(unmapped, ["fcr"]);
  assert.deepEqual(mapped.map((m) => m.key), ["life"]);
  const twice = [...properties, { ...properties.find((p) => p.id === 418), id: 99999 }];
  assert.deepEqual(mapConditions([on("life", 36)], twice).unmapped, ["life"]);
});

test("a ticked number condition with no value yet is not a filter, and never guessed as unmapped", () => {
  const { mapped, unmapped } = mapConditions([on("fcr", null, null)], properties);
  assert.deepEqual(mapped, []);
  assert.deepEqual(unmapped, []);
});

test("a ticked number condition with a value is still mapped, a max alone included", () => {
  const min = mapConditions([on("fcr", 10)], properties).mapped[0];
  assert.equal(min.min, 10);
  const max = mapConditions([on("all_res", null, 30)], properties).mapped[0];
  assert.equal(max.max, 30);
});

test("a ticked yes/no condition has no value to have, so it is still mapped", () => {
  const { mapped, unmapped } = mapConditions([on("ethereal", null)], properties);
  assert.deepEqual(unmapped, []);
  assert.deepEqual(mapped.map((m) => [m.key, m.type]), [["ethereal", "bool"]]);
});

test("a ticked condition with no property is unmapped even when it has no value", () => {
  assert.deepEqual(mapConditions([on("fcr", null, null)], WITHOUT_FCR).unmapped, ["fcr"]);
});

test("the address carries the numbers, the quality and the type exactly as the site writes them", () => {
  const { mapped } = mapConditions([on("fcr", 10), on("all_res", 20, 30), on("ethereal", null)], properties);
  const url = buildStatsUrl({ mapped, quality: mapQuality("rare", properties), type: "Ring" });
  assert.equal(
    url,
    "https://www.traderie.com/diablo2resurrected?prop_520Min=10&prop_441Min=20&prop_441Max=30&prop_Ethereal=true" +
      "&prop_Rarity=rare&tags[]=Ring",
  );
});

test("white means normal and superior; magic and rare are single values; any is no filter", () => {
  assert.deepEqual(mapQuality("normal", properties), { name: "Rarity", value: "normal,superior" });
  assert.deepEqual(mapQuality("magic", properties), { name: "Rarity", value: "magic" });
  assert.equal(mapQuality("any", properties), null);
  assert.equal(mapQuality("rare", properties.filter((p) => p.name !== "Rarity")), null);
  const url = buildStatsUrl({ mapped: [], quality: mapQuality("normal", properties) });
  assert.ok(url.endsWith("?prop_Rarity=normal,superior"));
});

test("only digits are allowed into the address, and an empty search is refused", () => {
  const mapped = [{ type: "number", id: 520, min: "1; DROP", max: null }];
  assert.throws(() => buildStatsUrl({ mapped }), /只能是數字/);
  assert.throws(() => buildStatsUrl({ mapped: [{ type: "number", id: 520, min: -5, max: null }] }), /只能是數字/);
  assert.throws(() => buildStatsUrl({ mapped: [] }), /至少要有一個條件/);
  assert.ok(buildStatsUrl({ mapped: [{ type: "number", id: 520, min: 1.5, max: null }] }).endsWith("prop_520Min=1.5"));
});

test("the Item Type names are read from the home page text, and a base is a type only when it is the same word", () => {
  const types = parseItemTypes(homePage);
  assert.ok(types.includes("Ring") && types.includes("Amulet") && types.length > 10);
  assert.ok(!types.includes("Skills") && !types.includes("Item Type"));
  assert.equal(typeForBase("ring", types), "Ring");
  assert.equal(typeForBase("Coronet", types), null);
  assert.equal(typeForBase("", types), null);
  assert.deepEqual(parseItemTypes("nothing here"), []);
});

test("the conditions are described in the player's words", () => {
  const { mapped } = mapConditions([on("fcr", 10), on("all_res", 20, 30), on("life", null, 50), on("ethereal", null)], properties);
  assert.equal(describeConditions(mapped), "施法速度 ≥10、所有抗性 20–30、生命 ≤50、無形");
});

test("a condition ticked but without a value is not described, and never as null", () => {
  assert.equal(describeConditions([{ type: "number", label: "施法速度", min: null, max: null }]), "");
  const { mapped } = mapConditions([on("fcr", 10), on("life", null, null)], properties);
  const text = describeConditions(mapped);
  assert.equal(text, "施法速度 ≥10");
  assert.ok(!text.includes("null"));
  assert.equal(describeConditions([]), "");
});

test("a yes/no condition alone is described by its label", () => {
  const { mapped } = mapConditions([on("ethereal", null)], properties);
  assert.equal(describeConditions(mapped), "無形");
});

test("the page kept the filters when every parameter we sent is still in its address", () => {
  const sent = "https://www.traderie.com/diablo2resurrected?prop_520Min=10&prop_Rarity=normal,superior&tags[]=Ring";
  assert.equal(urlKeepsParams("https://traderie.com/diablo2resurrected?tags%5B%5D=Ring&prop_520Min=10&prop_Rarity=normal%2Csuperior&x=1", sent), true);
  assert.equal(urlKeepsParams("https://traderie.com/diablo2resurrected?prop_520Min=10", sent), false);
  assert.equal(urlKeepsParams("https://traderie.com/diablo2resurrected?prop_520Min=11&prop_Rarity=normal,superior&tags[]=Ring", sent), false);
  assert.equal(urlKeepsParams("not a url", sent), false);
});

test("a condition pattern matches the card line of a number property, whole line, any case", () => {
  const pattern = conditionPattern("+{{value}}% Faster Cast Rate");
  assert.equal(pattern.test("+8% Faster Cast Rate"), true);
  assert.equal(pattern.test("+20% faster cast rate"), true);
  assert.equal(pattern.test("+8% Faster Cast Rate (Based on Character Level)"), false);
  assert.equal(pattern.test("Faster Cast Rate"), false);
});

test("listings without a card line for a number condition are counted; yes/no conditions are not looked for", () => {
  const fcr = [{ type: "number", name: "+{{value}}% Faster Cast Rate" }];
  const rows = [{ affixes: ["+8% Faster Cast Rate", "+18 To Mana"] }, { affixes: ["+18 To Mana"] }];
  assert.equal(rowsMissingConditions(rows, fcr), 1);
  assert.equal(rowsMissingConditions(rows, [{ type: "bool", name: "Ethereal" }]), 0);
  assert.equal(rowsMissingConditions([{}], fcr), 1);
});
