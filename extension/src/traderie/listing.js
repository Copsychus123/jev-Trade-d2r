// Putting a scanned item on Traderie (「TR交易」, 上架): the form a record becomes, what blocks it, and the listing body
// the site's own client would send. Pure logic: no DOM, no chrome.*, no network (tested under node against the
// fixtures `extension/test/fixtures/item_*.json`). Every fact about the wire format is measured in docs/design.md
// ("Listing on Traderie"): the item record, the required properties, the create body, the own-listings check.
import { LISTING_FIELDS, propertyValue } from "../listing-defaults.js";
import { findProduct } from "./lookup.js";
import { normalizeProperties } from "./properties.js";
import { mapConditions } from "./stats.js";

export const LISTING_CREATE_PATH = "/api/diablo2resurrected/listings/create";
export const USER_PATH = "/api/diablo2resurrected/user?";
export const DETAILS_PATH = "/api/diablo2resurrected/users/details?";
export const GAMES_PATH = "/api/games?game=diablo2resurrected";
export const CAPTCHA_FEATURE = "LISTINGS:CAPTCHA";
export const MAX_PRICE_GROUPS = 3;
export const RARITY_PROPERTY = "Rarity";
export const RARITY_OPTIONS = [
  { value: "rare", label: "黃裝（稀有）" },
  { value: "magic", label: "藍裝（魔法）" },
  { value: "normal", label: "白裝（普通）" },
  { value: "superior", label: "白裝（超強）" },
];
/** The name line's colour class (ocr/tone.js) -> the Rarity Traderie asks for a base; gold/green/null prefill nothing. */
export const RARITY_BY_QUALITY = { yellow: "rare", blue: "magic", white: "normal" };
const DIGITS = /^\d+$/u;

/** The item record's own address (one GET, read-only): the same record the product page reads for its Add Listing form. */
export const itemPath = (slug) => `/api/diablo2resurrected/items?id=${encodeURIComponent(slug)}&variants=&tags=&properties=&adding=true`;

/** The player's own open listings, the page the profile reads: the independent check after a create. */
export const ownListingsPath = (userId) =>
  `/api/diablo2resurrected/listings?itemTags=true&selling=true&auction=false&page=0&seller=${encodeURIComponent(userId)}&completed=false&active=all`;

/** The player's own listings page on the site (the address the profile's 掛單 tab uses). */
export const profileListingsUrl = (userId) =>
  `https://traderie.com/diablo2resurrected/profile/${encodeURIComponent(userId)}/listings`;

export const listingUrl = (id) => `https://traderie.com/diablo2resurrected/listing/${encodeURIComponent(id)}`;

/** The game's rune order (El … Zod): the display order of the price picker only, never a filter of anything. */
export const RUNE_ORDER = [
  "El", "Eld", "Tir", "Nef", "Eth", "Ith", "Tal", "Ral", "Ort", "Thul", "Amn", "Sol", "Shael", "Dol", "Hel", "Io", "Lum",
  "Ko", "Fal", "Lem", "Pul", "Um", "Mal", "Ist", "Gul", "Vex", "Ohm", "Lo", "Sur", "Ber", "Jah", "Cham", "Zod",
];
const runeRank = (name) => {
  const at = RUNE_ORDER.indexOf(name.replace(/ Rune$/u, ""));
  return at < 0 ? RUNE_ORDER.length : at;
};

/** The runes the shipped table lists, for the price selects: `{ name, slug }` in game order, unknown ones last. */
export function runeProducts(tables) {
  return (tables?.products ?? [])
    .filter((p) => p.category === "runes")
    .map(({ name, slug }) => ({ name, slug }))
    .sort((a, b) => runeRank(a.name) - runeRank(b.name));
}

/**
 * The listing form a scan record starts from. `product` is the table entry for the record's name (null when the
 * tables have no such product: the blocker says so). Every condition the read found is ticked with the number it
 * read, marked as coming from the capture so the player confirms it; a base record's Rarity comes from the name
 * line's colour the same way. `defaults` are the saved listing defaults (settings screen).
 */
export function emptyListingForm(record, tables, defaults) {
  const product = record?.name && tables ? findProduct(record.name, tables) : null;
  const isBase = record?.kind === "base";
  const rarity = isBase ? (RARITY_BY_QUALITY[record.quality] ?? "") : null;
  return {
    record,
    product: product ? { name: product.name, slug: product.slug, category: product.category } : null,
    rarity,
    rarityFromCapture: Boolean(rarity),
    conditions: (record?.conditions ?? []).map((c) => ({
      key: c.key,
      label: c.label,
      kind: c.kind,
      line: c.line ?? "", // the affix line as read: what a corrected number is remembered under
      on: true,
      value: c.kind === "bool" ? null : (c.min ?? null),
      readValue: c.kind === "bool" ? null : (c.min ?? null), // what the form started from: a later edit is a correction of it
      learned: Boolean(c.learned), // the number is the player's own earlier correction
      fromCapture: c.kind !== "bool" && c.min != null && !c.learned,
      available: true,
    })),
    amount: 1,
    makeOffer: false,
    prices: [{ rune: "", quantity: 1 }],
    env: Object.fromEntries(LISTING_FIELDS.map(({ key }) => [key, defaults?.[key]])),
  };
}

/**
 * The player adds an attribute of their own to the listing, from the affix dictionary the affix search uses (`entry`:
 * `{ key, zh, kind }`). The row is ticked and has no number yet (a number attribute blocks 上架 until it has one); it
 * has no line it was read as, so a number typed there is never remembered. False, and nothing changes, when the form
 * already has that attribute. Whether the item has such a property is judged at posting, as for every ticked row.
 */
export function addListingCondition(form, entry) {
  if (!entry || form.conditions.some((c) => c.key === entry.key)) return false;
  form.conditions.push({
    key: entry.key,
    label: entry.zh,
    kind: entry.kind,
    line: "",
    on: true,
    value: null,
    readValue: null,
    learned: false,
    fromCapture: false,
    available: true,
    added: true,
  });
  return true;
}

/** The item record as the flow keeps it: `{ id, type, mode, properties }` from the fetch reply, or null. */
export function normalizeItemInfo(reply) {
  const item = Array.isArray(reply?.body?.items) ? reply.body.items[0] : null;
  if (reply?.status !== 200 || !item || item.id == null) return null;
  return {
    id: String(item.id),
    type: item.type ?? null,
    mode: item.mode ?? null,
    properties: normalizeProperties(item.properties).map((p) => {
      const raw = item.properties.find((r) => r.id === p.id);
      // `syncOnly` properties are filled by the site itself: its own client does not ask for them either.
      return { ...p, required: Boolean(raw?.required) && !raw?.format?.syncOnly };
    }),
  };
}

const validQuantity = (quantity) => Number.isInteger(Number(quantity)) && Number(quantity) >= 1;
const validGroups = (form) => form.prices.filter((g) => g.rune && validQuantity(g.quantity));

/**
 * What is wrong with the asked price, or "": every 「或」 group must be complete and different, because the posted
 * price is exactly the groups shown (an incomplete group would silently vanish from a listing that cannot be undone).
 */
function priceProblem(form) {
  if (form.makeOffer) return "";
  if (validGroups(form).length === 0) return "請選擇想換的符文和數量，或勾「接受出價」";
  const seen = new Set();
  for (const [at, group] of form.prices.entries()) {
    const label = `第 ${at + 1} 組`;
    if (!group.rune) return `${label}還沒選符文（不要的話按 ✕ 刪除）`;
    if (!validQuantity(group.quantity)) return `${label}的數量要是 1 以上的整數`;
    if (seen.has(group.rune)) return `${label}和前面的組選了同一個符文`;
    seen.add(group.rune);
  }
  return "";
}

/** The names of the item's required properties that the built `properties` do not carry (the site refuses those). */
export function missingRequired(itemInfo, properties) {
  const sent = new Set(properties.map((p) => p.id));
  return itemInfo.properties.filter((p) => p.required && !sent.has(p.id)).map((p) => p.name);
}
/**
 * "" when the form can be posted, else the first reason in this order: no table product; no item record (after the
 * flow fetched it: `itemInfo === null`, `undefined` means not fetched yet); a base without a Rarity; a ticked number
 * condition without digits; no price and no 接受出價; too many 「或」 groups; a bad amount.
 */
export function listingBlocker(form, itemInfo) {
  if (!form.product) return `「${form.record?.name ?? ""}」不在 Traderie 的物品表裡，無法上架`;
  if (itemInfo === null) return "Traderie 沒有這件物品的資料";
  if (form.rarity === "") return "請選擇品質（黃裝／藍裝／白裝）";
  const missing = form.conditions.filter((c) => c.on && c.available !== false && c.kind !== "bool" && !DIGITS.test(String(c.value ?? "")));
  if (missing.length) return `這些條件還沒有數值：${missing.map((c) => c.label).join("、")}`;
  if (form.prices.length > MAX_PRICE_GROUPS) return `最多 ${MAX_PRICE_GROUPS} 組`;
  const price = priceProblem(form);
  if (price) return price;
  if (!Number.isInteger(Number(form.amount)) || Number(form.amount) < 1) return "數量要是 1 以上的整數";
  return "";
}

/** One property entry the way the site's client sends it: the value under the key named after the type. */
function propertyEntry(property, value) {
  const entry = { id: property.id, name: property.name, type: property.type };
  entry[property.type] = value;
  return entry;
}

/**
 * The listing's `properties` for the create body, built from the item's own property list (`itemInfo.properties`):
 * the four environment fields (each only when the item declares that property), the Rarity of a base, and the
 * ticked conditions mapped by the same dictionary rule the affix search uses. `unavailable` lists the ticked
 * condition keys the item has no property for (the form greys them; they are not sent).
 */
export function listingProperties(form, itemInfo) {
  const properties = [];
  const byName = (name) => itemInfo.properties.find((p) => p.name === name);
  for (const { key, property } of LISTING_FIELDS) {
    const found = byName(property);
    if (found && form.env[key] != null) properties.push(propertyEntry(found, propertyValue(key, form.env[key])));
  }
  if (form.rarity) {
    const rarity = byName(RARITY_PROPERTY);
    if (rarity) properties.push(propertyEntry(rarity, form.rarity));
  }
  const ticked = form.conditions.filter((c) => c.on).map((c) => ({ key: c.key, label: c.label, on: true, min: c.kind === "bool" ? null : Number(c.value) }));
  const { mapped, unmapped } = mapConditions(ticked, itemInfo.properties);
  for (const m of mapped) properties.push(propertyEntry({ id: m.id, name: m.name, type: m.type }, m.type === "bool" ? true : m.min));
  return { properties, unavailable: unmapped };
}

/**
 * The asked price as the create body's `items`: one row per rune, `group` numbering the 「或」 alternatives; `runeIds`
 * maps a rune name to its Traderie item id (fetched by the flow). Empty when the listing accepts offers instead.
 */
export function priceItems(form, runeIds) {
  if (form.makeOffer) return [];
  return validGroups(form).map((g, group) => {
    const id = String(runeIds[g.rune]);
    return { id, value: id, item_id: id, quantity: String(Number(g.quantity)), group, diy: false, offerProps: [] };
  });
}

/** The create body, every key the site's own client sends (and no other: its schema is strict). */
export function buildListingBody({ itemInfo, form, properties, items }) {
  return {
    acceptListingPrice: false,
    all: false,
    captcha: "",
    captchaManaged: false,
    currencyGroupPrices: [],
    diy: false,
    endTime: null,
    free: false,
    item: itemInfo.id,
    itemMode: itemInfo.mode,
    itemType: itemInfo.type,
    makeOffer: Boolean(form.makeOffer),
    needMaterials: false,
    offerBells: false,
    offerNmt: false,
    offerWishlist: false,
    offerWishlistId: "",
    selling: true,
    standingListing: false,
    stockListing: false,
    touchTrading: false,
    wishlist: "",
    amount: String(Number(form.amount)),
    properties,
    items,
  };
}

/** Whether the site would demand a captcha token for this player: the game feature and the player's own flag. */
export function captchaRequired(gamesReply, detailsReply) {
  const games = gamesReply?.body?.games ?? gamesReply?.body ?? {};
  const features = Array.isArray(games?.features) ? games.features : [];
  const skip = Boolean(detailsReply?.body?.details?.skip_captcha);
  return features.includes(CAPTCHA_FEATURE) && !skip;
}

const bodyText = (body) => (typeof body === "string" ? body : JSON.stringify(body ?? ""));

/** "" for a 2xx reply without an `error`, else the reason in plain Traditional Chinese. */
export function listingReason(reply) {
  if (!reply || typeof reply.status !== "number") return "Traderie 沒有回應";
  const { status, body } = reply;
  if (status === 401 || status === 403) return `Traderie 要求登入或拒絕了這次上架（HTTP ${status}）：請在 Traderie 登入後再試`;
  if (status >= 400 && status < 500 && /captcha/iu.test(bodyText(body))) return "Traderie 要求驗證碼，無法代為上架";
  if (status < 200 || status >= 300) return `Traderie 回覆 HTTP ${status}：${bodyText(body).slice(0, 120)}`;
  if (body && typeof body === "object" && body.error) return `Traderie 拒絕了這次上架：${String(body.error).slice(0, 120)}`;
  return "";
}

/** The new listing's id from the create reply (`id`, `listing.id` or `listing`), or null when it carries none. */
export function listingIdFrom(reply) {
  const body = reply?.body;
  if (!body || typeof body !== "object") return null;
  const candidate = body.id ?? body.listing?.id ?? body.listing ?? body.listing_id ?? null;
  return candidate == null || typeof candidate === "object" ? null : String(candidate);
}

const ownRows = (reply) => (Array.isArray(reply?.body?.listings) ? reply.body.listings : []);

/** Whether the own-listings reply lists the posted item (and, when known, the listing id). */
export function listedInOwn(reply, itemId, listingId = null) {
  const rows = ownRows(reply);
  if (listingId) return rows.some((row) => String(row.id) === listingId);
  return rows.some((row) => String(row.item_id) === String(itemId));
}

/** The newest own listing of `itemId` (ids grow with time): the link target when the create reply carried no id. */
export function newestOwnListingId(reply, itemId) {
  const ids = ownRows(reply)
    .filter((row) => String(row.item_id) === String(itemId) && /^\d+$/u.test(String(row.id))) // BigInt needs digits
    .map((row) => String(row.id));
  if (!ids.length) return null;
  return ids.reduce((a, b) => (BigInt(b) > BigInt(a) ? b : a));
}
