import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { DEFAULT_LISTING } from "../src/listing-defaults.js";
import {
  buildListingBody,
  captchaRequired,
  addListingCondition,
  emptyListingForm,
  itemPath,
  listedInOwn,
  listingBlocker,
  missingRequired,
  listingIdFrom,
  listingProperties,
  listingReason,
  newestOwnListingId,
  normalizeItemInfo,
  priceItems,
  runeProducts,
} from "../src/traderie/listing.js";
import { indexTables } from "../src/traderie/lookup.js";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const HARLEQUIN = normalizeItemInfo({ status: 200, body: fixture("item_harlequin_crest.json") });
const RING = normalizeItemInfo({ status: 200, body: fixture("item_ring.json") });
const BER = normalizeItemInfo({ status: 200, body: fixture("item_ber_rune.json") });

const tables = {
  ...indexTables({
    products: [
      { name: "Harlequin Crest", slug: "harlequin-crest", category: "uniques" },
      { name: "Ring", slug: "ring", category: "base" },
      { name: "Ber Rune", slug: "ber-rune", category: "runes" },
      { name: "Jah Rune", slug: "jah-rune", category: "runes" },
    ],
    zh: { 諧角之冠: "Harlequin Crest" },
    bases: ["Ring"],
    game_only: [],
    generated_at: "2026-01-01",
  }),
  products: [
    { name: "Harlequin Crest", slug: "harlequin-crest", category: "uniques" },
    { name: "Ring", slug: "ring", category: "base" },
    { name: "Ber Rune", slug: "ber-rune", category: "runes" },
    { name: "Jah Rune", slug: "jah-rune", category: "runes" },
  ],
};

const condition = (key, label, kind, min) => ({ key, label, kind, line: "", min, max: null, on: false, confident: true });
const shako = () => ({
  id: 1,
  name: "Harlequin Crest",
  kind: "item",
  quality: "gold",
  conditions: [condition("all_skills", "所有技能", "plain", 2), condition("mf", "魔法裝備掉落", "percent", 50), condition("fcr", "施法速度", "percent", null)],
});
const ring = () => ({ id: 2, name: "Ring", kind: "base", quality: "yellow", conditions: [condition("fcr", "施法速度", "percent", 10)] });

test("the item record is read from the measured reply shape: id as a string, the type and the property list", () => {
  assert.equal(HARLEQUIN.id, "2487112490");
  assert.equal(HARLEQUIN.type, "uniques");
  assert.equal(RING.type, "misc");
  assert.ok(HARLEQUIN.properties.find((p) => p.name === "Platform" && p.required));
  assert.equal(normalizeItemInfo({ status: 404, body: "" }), null);
  assert.equal(normalizeItemInfo({ status: 200, body: { items: [] } }), null);
  assert.equal(itemPath("harlequin-crest"), "/api/diablo2resurrected/items?id=harlequin-crest&variants=&tags=&properties=&adding=true");
});

test("a unique record becomes a form with every read affix ticked and marked from the capture, env from the defaults", () => {
  const form = emptyListingForm(shako(), tables, DEFAULT_LISTING);
  assert.deepEqual(form.product, { name: "Harlequin Crest", slug: "harlequin-crest", category: "uniques" });
  assert.equal(form.rarity, null, "a unique has no Rarity to choose");
  assert.deepEqual(
    form.conditions.map((c) => [c.key, c.on, c.value, c.fromCapture]),
    [["all_skills", true, 2, true], ["mf", true, 50, true], ["fcr", true, null, false]],
  );
  assert.deepEqual(form.env, DEFAULT_LISTING);
  assert.deepEqual(form.prices, [{ rune: "", quantity: 1 }]);
  assert.equal(emptyListingForm({ name: "Nowhere Item", kind: "item", conditions: [] }, tables, DEFAULT_LISTING).product, null);
});

test("a base record with a yellow name line prefills Rarity rare from the capture; gold or no colour leaves it empty", () => {
  const form = emptyListingForm(ring(), tables, DEFAULT_LISTING);
  assert.deepEqual([form.rarity, form.rarityFromCapture], ["rare", true]);
  const plain = emptyListingForm({ ...ring(), quality: null }, tables, DEFAULT_LISTING);
  assert.deepEqual([plain.rarity, plain.rarityFromCapture], ["", false]);
});

test("the blockers come in order: product, item record, rarity, values, price, groups", () => {
  const unknown = emptyListingForm({ name: "Nowhere Item", kind: "item", conditions: [] }, tables, DEFAULT_LISTING);
  assert.equal(listingBlocker(unknown, undefined), "「Nowhere Item」不在 Traderie 的物品表裡，無法上架");
  const form = emptyListingForm(shako(), tables, DEFAULT_LISTING);
  assert.equal(listingBlocker(form, null), "Traderie 沒有這件物品的資料");
  assert.equal(listingBlocker(form, undefined), "這些條件還沒有數值：施法速度", "a ticked condition without a number comes before the price");
  form.conditions[2].on = false;
  assert.equal(listingBlocker(form, undefined), "請選擇想換的符文和數量，或勾「接受出價」");
  form.makeOffer = true;
  assert.equal(listingBlocker(form, undefined), "");
  form.makeOffer = false;
  form.prices = [{ rune: "Ber Rune", quantity: 2 }];
  assert.equal(listingBlocker(form, HARLEQUIN), "");
  form.prices = [{ rune: "Ber Rune", quantity: 2 }, { rune: "Jah Rune", quantity: 1 }, { rune: "Ber Rune", quantity: 1 }, { rune: "Ber Rune", quantity: 1 }];
  assert.equal(listingBlocker(form, HARLEQUIN), "最多 3 組");

  const base = emptyListingForm({ ...ring(), quality: null }, tables, DEFAULT_LISTING);
  base.makeOffer = true;
  assert.equal(listingBlocker(base, undefined), "請選擇品質（黃裝／藍裝／白裝）");
});

test("every 「或」 group must be complete and different: an incomplete one is refused, never silently dropped from the posted price", () => {
  const form = emptyListingForm(shako(), tables, DEFAULT_LISTING);
  form.conditions[2].on = false;
  const blocker = (prices) => listingBlocker({ ...form, prices }, undefined);
  assert.equal(blocker([{ rune: "Ber Rune", quantity: 1 }, { rune: "Jah Rune", quantity: 0 }]), "第 2 組的數量要是 1 以上的整數");
  assert.equal(blocker([{ rune: "Ber Rune", quantity: 1 }, { rune: "Jah Rune", quantity: "" }]), "第 2 組的數量要是 1 以上的整數");
  assert.equal(blocker([{ rune: "Ber Rune", quantity: 1 }, { rune: "Jah Rune", quantity: 2.5 }]), "第 2 組的數量要是 1 以上的整數");
  assert.equal(blocker([{ rune: "Ber Rune", quantity: 1 }, { rune: "", quantity: 1 }]), "第 2 組還沒選符文（不要的話按 ✕ 刪除）");
  assert.equal(blocker([{ rune: "Ber Rune", quantity: 1 }, { rune: "Ber Rune", quantity: 2 }]), "第 2 組和前面的組選了同一個符文");
  assert.equal(blocker([{ rune: "Ber Rune", quantity: 1 }, { rune: "Jah Rune", quantity: 2 }]), "");
});

test("the item's required properties the form did not fill are named; syncOnly ones are the site's own business", () => {
  const form = emptyListingForm({ id: 9, name: "Ring", kind: "item", quality: null, conditions: [] }, tables, DEFAULT_LISTING);
  const { properties } = listingProperties(form, RING); // not a base record: no Rarity chosen
  assert.deepEqual(missingRequired(RING, properties), ["Rarity"]);
  const withRarity = emptyListingForm({ id: 9, name: "Ring", kind: "base", quality: "yellow", conditions: [] }, tables, DEFAULT_LISTING);
  assert.deepEqual(missingRequired(RING, listingProperties(withRarity, RING).properties), []);
  const synced = { properties: [{ id: 1, name: "Synced", required: true, ...{} }] };
  assert.deepEqual(missingRequired(synced, []), ["Synced"]);
  const raw = normalizeItemInfo({ status: 200, body: { items: [{ id: 1, type: "x", properties: [{ id: 5, name: "S", type: "string", required: true, format: { syncOnly: true } }] }] } });
  assert.deepEqual(missingRequired(raw, []), []);
});

test("the body carries every key the site's client sends: env, rarity and affixes by the item's own property ids, one price group", () => {
  const form = emptyListingForm(shako(), tables, { ...DEFAULT_LISTING, platform: "xbox", ladder: "nonladder" });
  form.conditions[2].on = false;
  form.prices = [{ rune: "Ber Rune", quantity: 2 }];
  const { properties, unavailable } = listingProperties(form, HARLEQUIN);
  assert.deepEqual(unavailable, []);
  assert.deepEqual(properties, [
    { id: 798, name: "Platform", type: "string", string: "xbox" },
    { id: 799, name: "Mode", type: "string", string: "softcore" },
    { id: 800, name: "Ladder", type: "bool", bool: false },
    { id: 1854, name: "Game version", type: "string", string: "reign of the warlock" },
    { id: 587, name: "+{{value}} to All Skills", type: "number", number: 2 },
    { id: 461, name: "{{value}}% Better Chance of Getting Magic Items", type: "number", number: 50 },
  ]);
  const items = priceItems(form, { "Ber Rune": "4149485449" });
  assert.deepEqual(items, [{ id: "4149485449", value: "4149485449", item_id: "4149485449", quantity: "2", group: 0, diy: false, offerProps: [] }]);
  const body = buildListingBody({ itemInfo: HARLEQUIN, form, properties, items });
  assert.deepEqual(Object.keys(body).sort(), [
    "acceptListingPrice", "all", "amount", "captcha", "captchaManaged", "currencyGroupPrices", "diy", "endTime", "free", "item",
    "itemMode", "itemType", "items", "makeOffer", "needMaterials", "offerBells", "offerNmt", "offerWishlist", "offerWishlistId",
    "properties", "selling", "standingListing", "stockListing", "touchTrading", "wishlist",
  ]);
  assert.deepEqual([body.item, body.itemType, body.itemMode, body.amount, body.selling, body.makeOffer, body.captcha], ["2487112490", "uniques", null, "1", true, false, ""]);
});

test("a base sends its Rarity, a condition the item does not declare is reported unavailable and not sent, 接受出價 sends no items", () => {
  const form = emptyListingForm({ ...ring(), conditions: [condition("fcr", "施法速度", "percent", 10), condition("all_skills", "所有技能", "plain", 1)] }, tables, DEFAULT_LISTING);
  form.makeOffer = true;
  const { properties, unavailable } = listingProperties(form, RING);
  assert.ok(properties.find((p) => p.name === "Rarity" && p.string === "rare"));
  assert.ok(properties.find((p) => p.type === "number" && p.number === 10 && /Faster Cast Rate/u.test(p.name)));
  assert.deepEqual(unavailable, ["all_skills"], "a ring has no +All Skills property");
  assert.deepEqual(priceItems(form, {}), []);
  assert.equal(buildListingBody({ itemInfo: RING, form, properties, items: [] }).makeOffer, true);
  // A rune carries no Rarity and no affixes: only the four environment properties.
  const rune = emptyListingForm({ id: 3, name: "Ber Rune", kind: "item", quality: "gold", conditions: [] }, tables, DEFAULT_LISTING);
  assert.deepEqual(listingProperties(rune, BER).properties.map((p) => p.name), ["Platform", "Mode", "Ladder", "Game version"]);
});

test("two 「或」 groups number their rows 0 and 1, and an empty group is skipped", () => {
  const form = emptyListingForm(shako(), tables, DEFAULT_LISTING);
  form.prices = [{ rune: "Ber Rune", quantity: 2 }, { rune: "", quantity: 1 }, { rune: "Jah Rune", quantity: "1" }];
  assert.deepEqual(priceItems(form, { "Ber Rune": "1", "Jah Rune": "2" }).map((r) => [r.id, r.quantity, r.group]), [["1", "2", 0], ["2", "1", 1]]);
  assert.deepEqual(runeProducts(tables).map((r) => r.slug), ["ber-rune", "jah-rune"]);
  // The picker lists runes in game order (El … Zod), whatever order the table has them in; an unknown name goes last.
  const unordered = { products: [{ name: "Zod Rune", slug: "zod-rune", category: "runes" }, { name: "Odd Rune", slug: "odd", category: "runes" }, { name: "El Rune", slug: "el-rune", category: "runes" }, { name: "Ber Rune", slug: "ber-rune", category: "runes" }] };
  assert.deepEqual(runeProducts(unordered).map((r) => r.name), ["El Rune", "Ber Rune", "Zod Rune", "Odd Rune"]);
});

test("the newest own listing is the numerically largest id, and a row without a numeric id is ignored", () => {
  const rows = [{ id: "999", item_id: "1" }, { id: "1000", item_id: "1" }, { item_id: "1" }, { id: "x", item_id: "1" }, { id: "5000", item_id: "2" }];
  assert.equal(newestOwnListingId({ body: { listings: rows } }, "1"), "1000");
  assert.equal(newestOwnListingId({ body: { listings: [{ item_id: "1" }] } }, "1"), null);
});

test("the reply's reason: none, login, captcha, other status, a 200 carrying an error", () => {
  assert.equal(listingReason(undefined), "Traderie 沒有回應");
  assert.equal(listingReason({ status: 403, body: "" }), "Traderie 要求登入或拒絕了這次上架（HTTP 403）：請在 Traderie 登入後再試");
  assert.equal(listingReason({ status: 400, body: { error: "Captcha verification failed" } }), "Traderie 要求驗證碼，無法代為上架");
  assert.equal(listingReason({ status: 500, body: "<html>boom" }), "Traderie 回覆 HTTP 500：<html>boom");
  assert.equal(listingReason({ status: 200, body: { error: "Please review" } }), "Traderie 拒絕了這次上架：Please review");
  assert.equal(listingReason({ status: 200, body: { id: "9" } }), "");
});

test("the listing id, the captcha rule and the own-listings check follow the measured shapes", () => {
  assert.equal(listingIdFrom({ status: 200, body: { id: 42 } }), "42");
  assert.equal(listingIdFrom({ status: 200, body: { listing: { id: "7" } } }), "7");
  assert.equal(listingIdFrom({ status: 200, body: { listing: "8" } }), "8");
  assert.equal(listingIdFrom({ status: 200, body: { success: true } }), null);
  const games = (features) => ({ status: 200, body: { games: { features } } });
  const details = (skip) => ({ status: 200, body: { details: { skip_captcha: skip } } });
  assert.equal(captchaRequired(games([]), details(false)), false);
  assert.equal(captchaRequired(games(["LISTINGS:CAPTCHA"]), details(true)), false);
  assert.equal(captchaRequired(games(["LISTINGS:CAPTCHA"]), details(false)), true);
  const own = { status: 200, body: { listings: [{ id: "100", item_id: "2487112490" }] } };
  assert.equal(listedInOwn(own, "2487112490"), true);
  assert.equal(listedInOwn(own, "2487112490", "100"), true);
  assert.equal(listedInOwn(own, "2487112490", "101"), false);
  assert.equal(listedInOwn(own, "1"), false);
});

test("a listing row keeps the line it was read from and the number it started with, and a remembered number is not marked as a guess", () => {
  const record = ring();
  record.conditions = [
    { ...condition("fcr", "施法速度", "percent", 10), line: "+10% Faster Cast Rate" },
    { ...condition("life", "生命", "plain", 30), line: "+30 to Life", learned: true },
    condition("ethereal", "無形", "bool", null),
  ];
  const [fcr, life, bool] = emptyListingForm(record, tables, DEFAULT_LISTING).conditions;
  assert.deepEqual([fcr.line, fcr.readValue, fcr.learned, fcr.fromCapture], ["+10% Faster Cast Rate", 10, false, true]);
  assert.deepEqual([life.readValue, life.learned, life.fromCapture], [30, true, false]);
  assert.deepEqual([bool.readValue, bool.fromCapture], [null, false]);
});

test("an attribute the player adds is ticked with no number, blocks 上架 until it has one, and is added once", () => {
  const form = emptyListingForm(ring(), tables, DEFAULT_LISTING);
  assert.equal(addListingCondition(form, { key: "life", zh: "生命", kind: "plain" }), true);
  assert.equal(addListingCondition(form, { key: "life", zh: "生命", kind: "plain" }), false, "the same attribute twice");
  assert.equal(addListingCondition(form, { key: "fcr", zh: "施法速度", kind: "percent" }), false, "one the record already has");
  assert.equal(addListingCondition(form, null), false);
  const added = form.conditions.at(-1);
  assert.deepEqual([added.key, added.on, added.value, added.line, added.fromCapture, added.added], ["life", true, null, "", false, true]);
  form.makeOffer = true;
  assert.match(listingBlocker(form, RING), /生命/);
  added.value = "20";
  assert.equal(listingBlocker(form, RING), "");
});
