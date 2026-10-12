// Item-name helpers for the three-layer lookup (table jump, search, base list). Pure functions: no chrome.*, no I/O.
import { productUrl as productUrlForSlug } from "./site.js";

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

const hasChinese = (text) => CJK.test(text);

/** Full-width to half-width, one space between words, no outer spaces. */
function cleanName(raw) {
  return String(raw ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
}

// Names such as 阿爾瑪‧尼格拉 or 塔.拉夏的守護 are written with a middle dot, a period, a hyphen or nothing at all,
// depending on the source; for matching they are all the same name.
const SEPARATORS = /[-·‧・.]/gu;
export const stripSeparators = (text) => text.replace(SEPARATORS, "");

/** The key a Chinese name is looked up by, for an already cleaned name: separators and the spaces around them gone. */
const chineseKey = (cleaned) => stripSeparators(cleaned.replace(/\s+/gu, ""));

/** Text that is safe to type into the search box. Chinese letters are not allowed here (they are translated first). */
function searchText(name) {
  return cleanName(name).replace(ALLOWED_QUERY, " ").replace(/\s+/gu, " ").trim();
}

/** True when the search text is plain Latin words: a failed search is then a real "no such item", not a typing problem. */
export function isWellFormed(query) {
  return query.length > 0 && query === searchText(query) && !hasChinese(query);
}

/** Products by comparison key, and the keys that belong to more than one product: the table cannot pick one. */
function indexProducts(products) {
  const byKey = new Map();
  const ambiguous = new Set();
  for (const product of products) {
    const key = normalizeName(product.name);
    if (byKey.has(key)) ambiguous.add(key);
    byKey.set(key, product);
  }
  return { byKey, ambiguous };
}

/**
 * The Chinese side of the table: the comparison key -> English name, the table's own names (for the suggestion list)
 * and English name -> Chinese name, for the "English（中文）" label of the screenshot reader.
 */
function indexChinese(zh) {
  const byKey = new Map();
  const names = [];
  const byEnglishKey = new Map();
  for (const [chinese, english] of Object.entries(zh)) {
    const key = chineseKey(cleanName(chinese));
    byKey.set(key, english);
    names.push({ name: chinese, key, english });
    // Several Chinese names can map to one English name; the smallest one wins so the label does not depend on the
    // order of the JSON keys.
    const englishKey = normalizeName(english);
    const previous = byEnglishKey.get(englishKey);
    if (previous === undefined || chinese < previous) byEnglishKey.set(englishKey, chinese);
  }
  return { zh: byKey, zhNames: names, zhByKey: byEnglishKey };
}

/** Everything a lookup needs from the shipped item tables: the two indexes above plus the base and game-only sets. */
export function indexTables(data) {
  return {
    ...indexProducts(data.products),
    ...indexChinese(data.zh),
    bases: data.bases,
    baseByKey: new Map(data.bases.map((name) => [normalizeName(name), name])),
    gameOnly: new Set(data.game_only.map(normalizeName)),
    generatedAt: data.generated_at,
  };
}

/**
 * The item types the table ships, in its own order, for the affix form's suggestion list. The list is a fixed option
 * list (never a filter over the page's elements) and it comes from the shipped table, so no base name is written in
 * code. Empty when the tables are not loaded yet.
 */
export function baseOptions(tables) {
  return [...new Set(tables?.bases ?? [])];
}

/**
 * Up to `limit` names from the item tables for what is typed so far, best first; never the typed name itself.
 * Chinese: table names (separators ignored) that start with it, then those containing it; { label, hint: English }.
 * English (at least 2 letters after normalizeName): product names that start with it, then those with a word that
 * starts with it; { label: product.name, hint: "" }. Shorter names first within each group.
 */
export function suggestNames(raw, tables, limit = 5) {
  const typed = cleanName(raw);
  if (!typed) return [];
  if (hasChinese(typed)) {
    const k = chineseKey(typed);
    const matched = tables.zhNames
      .map((entry) => ({ entry, rank: entry.key.startsWith(k) ? 0 : entry.key.includes(k) ? 1 : -1 }))
      .filter((m) => m.rank >= 0 && m.entry.key !== k);
    matched.sort((a, b) => a.rank - b.rank || a.entry.name.length - b.entry.name.length);
    return matched.slice(0, limit).map((m) => ({ label: m.entry.name, hint: m.entry.english }));
  }
  const k = normalizeName(typed);
  if (k.length < 2) return [];
  const matched = [];
  for (const [key, product] of tables.byKey) {
    if (key === k) continue; // never suggest what was typed
    let rank;
    if (key.startsWith(k)) rank = 0;
    else if (` ${key}`.includes(` ${k}`)) rank = 1;
    else continue;
    matched.push({ label: product.name, hint: "", rank, len: product.name.length });
  }
  matched.sort((a, b) => a.rank - b.rank || a.len - b.len);
  return matched.slice(0, limit).map(({ label, hint }) => ({ label, hint }));
}

/**
 * Turns what the user typed into the English name to use. Chinese names are translated through the table;
 * a Chinese name that is not in the table cannot be searched, so it fails here before anything is used up.
 */
export function resolveInput(raw, tables) {
  const typed = cleanName(raw);
  if (!typed) throw new Error("請輸入裝備名稱");
  if (hasChinese(typed)) {
    const english = tables.zh.get(chineseKey(typed));
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

/** The table's own spelling of a base name, or the name itself when the table does not list it. */
const baseNameOf = (tables, name) => tables?.baseByKey?.get?.(normalizeName(name)) || name;

/**
 * Resolves a raw base name (Chinese or English, possibly empty) to standard English base name.
 */
export function resolveBase(raw, tables) {
  if (raw == null) return "";
  const cleaned = cleanName(raw);
  if (!cleaned) return "";
  if (!hasChinese(cleaned)) return baseNameOf(tables, cleaned);
  const english = tables?.zh?.get?.(chineseKey(cleaned));
  if (!english) throw new Error(`對照表裡沒有底材「${cleaned}」的英文名稱，請改輸入英文底材（如 Ring、Circlet）`);
  return baseNameOf(tables, english);
}

/**
 * The Chinese name the screenshot reader's label shows in its full-width brackets, or "" when the label is plain.
 * `matched` is the OCR piece the candidate matched (matchOcrText). One English name can have several Chinese names
 * (Circlet is 頭環 or 頭飾), and the reverse map can only pick one; when the picture itself spells a Chinese name that
 * is an exact table key for this same name, that is what the player sees and what the label shows. Anything else — an
 * English match, or a noisy glued run like 芭戒指天要等級 that is not a key — falls back to the reverse map.
 *
 * One source of truth: `labelWithChinese` builds "English（中文）" from this, and the gear scanner's CSV takes its
 * 中文名稱 column straight from here, so the two can never drift apart.
 */
export function chineseName(name, tables, matched = "") {
  const fromPicture = hasChinese(matched)
    ? tables?.zh?.get?.(chineseKey(cleanName(matched)))
    : undefined;
  const picked =
    fromPicture && normalizeName(fromPicture) === normalizeName(name)
      ? cleanName(matched)
      : tables?.zhByKey?.get?.(normalizeName(name));
  return picked && picked !== name ? picked : "";
}

/**
 * The label of a name in the screenshot reader: the English name with its Traditional Chinese name in full-width
 * brackets, e.g. "Diadem（權冠）". A name with no Chinese (see chineseName) is shown plain, so no empty brackets appear.
 * Used for base types and for items alike.
 */
export function labelWithChinese(name, tables, matched = "") {
  const chinese = chineseName(name, tables, matched);
  return chinese ? `${name}（${chinese}）` : name;
}

/** The product for a name, or null when the name is unknown or shared by several products (search then decides). */
export function findProduct(query, tables) {
  const key = normalizeName(query);
  return tables.ambiguous.has(key) ? null : (tables.byKey.get(key) ?? null);
}

/** The product page of a table entry: the one call site of the URL template for a lookup result. */
export const productUrlFor = (product) => productUrlForSlug(product.slug);

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

const TABLE_STALE_DAYS = 90;

/**
 * How old the item tables are, for the settings screen and for the note when a table jump misses. `generatedAt` is the
 * ISO time in items.json. A table older than TABLE_STALE_DAYS is stale: new items are missing from it, so their names
 * fall back to search (or cannot be translated).
 * Returns { days, date, stale, text }; days and date are null when the table carries no usable date.
 */
export function tableAge(generatedAt, now = Date.now()) {
  const then = Date.parse(generatedAt ?? "");
  if (Number.isNaN(then)) return { days: null, date: null, stale: false, text: "名稱表日期不明" };
  const days = Math.max(0, Math.floor((now - then) / 86_400_000));
  const date = new Date(then).toISOString().slice(0, 10);
  const stale = days > TABLE_STALE_DAYS;
  const warning = stale ? `，已超過 ${TABLE_STALE_DAYS} 天，新物品可能查不到，請更新擴充功能` : "";
  return { days, date, stale, text: `名稱表更新於 ${date}（${days} 天前）${warning}` };
}
