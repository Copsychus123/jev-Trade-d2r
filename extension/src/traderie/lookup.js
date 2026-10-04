// Item-name helpers for the three-layer lookup (table jump, search, base list). Pure functions: no chrome.*, no I/O.
import { TRADERIE_D2R_URL } from "./site.js";

const CJK = /[\u3400-\u9fff]/u;
// Characters a Traderie item name can contain; anything else is dropped before searching.
const ALLOWED_QUERY = /[^A-Za-z0-9 '\-.,:]/gu;
const NO_RESULTS = /no results (?:could be|were) found/iu;

/** Key used to compare names: no accents, apostrophes or punctuation, lower case, no leading "the". */
export function normalizeName(name) {
  const text = String(name ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/['’`]/gu, "")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
  return text.startsWith("the ") ? text.slice(4) : text;
}

export const hasChinese = (text) => CJK.test(text);

/** Full-width to half-width, one space between words, no outer spaces. */
export function cleanName(raw) {
  return String(raw ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
}

// Names such as 阿爾瑪‧尼格拉 or 塔.拉夏的守護 are written with a middle dot, a period, a hyphen or nothing at all,
// depending on the source; for matching they are all the same name.
const SEPARATORS = /[-·‧・.]/gu;
export const stripSeparators = (text) => text.replace(SEPARATORS, "");

/** Text that is safe to type into the search box. Chinese letters are not allowed here (they are translated first). */
export function searchText(name) {
  return cleanName(name).replace(ALLOWED_QUERY, " ").replace(/\s+/gu, " ").trim();
}

/** True when the search text is plain Latin words: a failed search is then a real "no such item", not a typing problem. */
export function isWellFormed(query) {
  return query.length > 0 && query === searchText(query) && !hasChinese(query);
}

export function indexTables(data) {
  const byKey = new Map();
  for (const product of data.products) byKey.set(normalizeName(product.name), product);
  const zh = new Map();
  for (const [chinese, english] of Object.entries(data.zh)) {
    zh.set(stripSeparators(cleanName(chinese).replace(/\s+/gu, "")), english);
  }
  return {
    byKey,
    zh,
    bases: data.bases,
    baseByKey: new Map(data.bases.map((name) => [normalizeName(name), name])),
    gameOnly: new Set(data.game_only.map(normalizeName)),
    generatedAt: data.generated_at,
  };
}

/**
 * Turns what the user typed into the English name to use. Chinese names are translated through the table;
 * a Chinese name that is not in the table cannot be searched, so it fails here before anything is used up.
 */
export function resolveInput(raw, tables) {
  const typed = cleanName(raw);
  if (!typed) throw new Error("請輸入裝備名稱");
  if (hasChinese(typed)) {
    const english = tables.zh.get(stripSeparators(typed.replace(/\s+/gu, "")));
    if (!english) {
      throw new Error(`對照表裡沒有「${typed}」的英文名稱，請改輸入英文名稱（也可能是新物品，表還沒更新）`);
    }
    return { typed, query: english, translated: true };
  }
  const query = searchText(typed);
  if (!query) throw new Error("裝備名稱裡沒有可以搜尋的英文字母，請改輸入英文名稱");
  const product = tables.byKey.get(normalizeName(query));
  // The table spelling wins ("Stone of Jordan" is "The Stone of Jordan" on Traderie).
  return { typed, query: product ? product.name : query, translated: false };
}

export function findProduct(query, tables) {
  return tables.byKey.get(normalizeName(query)) ?? null;
}

export const productUrl = (product) => `${TRADERIE_D2R_URL}/product/${product.slug}`;

/** "traderie": in Traderie's catalog; "game_only": a real game item Traderie lacks or spells differently; "unknown". */
export function nameStatus(query, tables) {
  const key = normalizeName(query);
  if (tables.byKey.has(key)) return "traderie";
  return tables.gameOnly.has(key) ? "game_only" : "unknown";
}

/** The search results page says nothing matched. */
export function searchFoundNothing(page) {
  return NO_RESULTS.test(page?.text ?? "");
}

/** Whole-word check of the page title, stricter than the page-text check used after reading. */
export function titleIsItem(itemName, title) {
  const wanted = normalizeName(itemName);
  return Boolean(wanted) && ` ${normalizeName(title)} `.includes(` ${wanted} `);
}

/** A search results page that lists a link named exactly like the item (so "blocked" is a misjudgement). */
export function searchShowsItem(page, itemName) {
  const wanted = normalizeName(itemName);
  if (!wanted || !/[?&]search=/u.test(page?.url ?? "") || searchFoundNothing(page)) return false;
  return (page.actions ?? []).some((a) => a.kind === "click" && a.role === "link" && normalizeName(a.label) === wanted);
}

/**
 * "Rare Ring" -> "Ring": drops leading words one at a time and returns the first remainder that is a plain item type
 * in the base list (longest remainder first, so "Magic Grand Charm" gives "Grand Charm", not "Charm"). No model call.
 */
export function stripToBase(query, tables) {
  const words = cleanName(query).split(" ");
  for (let i = 1; i < words.length; i += 1) {
    const base = tables.baseByKey.get(normalizeName(words.slice(i).join(" ")));
    if (base) return base;
  }
  return null;
}
