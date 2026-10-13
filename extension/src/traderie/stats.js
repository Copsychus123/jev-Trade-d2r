// Turns the conditions a player confirmed into the address of Traderie's home page with its "Search All Stats" filters
// switched on, and checks the page really kept them. Pure functions: no chrome.*, no I/O. Property ids and names come
// from Traderie's own list (properties.js); apart from the quality property ("Rarity"), nothing about a particular
// property is written down here except the dictionary of what the screenshot reader knows (ocr/affix_dictionary.js).
import { AFFIXES } from "../ocr/affix_dictionary.js";
import { TRADERIE_D2R_URL } from "./site.js";

// The home page address, parsed once. `bareHost` lower-cases the host itself: only special schemes (http/https) are
// lower-cased by the URL parser, so an opaque-scheme host would otherwise compare case-sensitively.
const HOME = new URL(TRADERIE_D2R_URL);
const bareHost = (url) => url.host.toLowerCase().replace(/^www\./u, "");

// How many conditions may be on together: Traderie combines them with "and" (measured: a condition nobody can meet
// together with a common one lists nothing), so more conditions only narrow the list.
export const MAX_CONDITIONS = 8;

// Item quality is a property of Traderie's list, "Rarity" (options rare, magic, superior, normal, low quality).
// White items are normal and superior ones.
const QUALITY_PROPERTY = "Rarity";
export const QUALITIES = [
  { key: "any", label: "不指定", values: null },
  { key: "rare", label: "黃裝", values: ["rare"] },
  { key: "magic", label: "藍裝", values: ["magic"] },
  { key: "normal", label: "白裝", values: ["normal", "superior"] },
];

/** The QUALITIES row for a key ("rare"), or undefined when there is no such quality: one lookup for the whole form. */
export const qualityChoice = (quality) => QUALITIES.find((q) => q.key === quality);

// The sidebar's "Item Type" entries filter with this parameter (tags[]=Ring lists rings, unique ones included).
const TYPE_PARAM = "tags[]";

const NUMBER = /^\d+(?:\.\d+)?$/u;

/** The dictionary entries that match exactly one property of Traderie's list with the right kind of value. */
function propertyFor(entry, properties) {
  const wanted = entry.kind === "bool" ? "bool" : "number";
  const found = properties.filter((p) => p.type === wanted && entry.traderie.test(p.label));
  return found.length === 1 ? found[0] : null;
}

/** Keys of the dictionary that Traderie has no single property for (shown greyed out in the form). */
export function unmappedKeys(properties) {
  return AFFIXES.filter((entry) => !propertyFor(entry, properties)).map((entry) => entry.key);
}

/**
 * The switched-on conditions as [{ key, label, id, name, type, min, max }] and the keys Traderie has no property for.
 *
 * A ticked number condition with no value yet (the screenshot reader now only ticks; the player types the numbers)
 * is not a filter and is left out of the returned list. A bool condition has no value by nature and is kept. A
 * switched-on condition Traderie has no property for is always reported in `unmapped`, value or not. The returned
 * list is what the address, the summary and the page checks all use, so this is the one place that decides.
 */
export function mapConditions(conditions, properties) {
  const mapped = [];
  const unmapped = [];
  for (const condition of conditions.filter((c) => c.on === true)) {
    const entry = AFFIXES.find((e) => e.key === condition.key);
    const property = entry ? propertyFor(entry, properties) : null;
    if (!property) {
      unmapped.push(condition.key);
      continue;
    }
    if (property.type !== "bool" && condition.min == null && condition.max == null) continue;
    mapped.push({
      key: condition.key,
      label: condition.label,
      id: property.id,
      name: property.name,
      type: property.type,
      min: condition.min ?? null,
      max: condition.max ?? null,
    });
  }
  return { mapped, unmapped };
}

/** { name, value } for a chosen quality, or null when "any" was chosen or Traderie's list has no usable Rarity. */
export function mapQuality(quality, properties) {
  const wanted = qualityChoice(quality);
  if (!wanted?.values) return null;
  const property = properties.find((p) => p.name === QUALITY_PROPERTY && p.type === "string");
  if (!property || !wanted.values.every((value) => property.options?.includes(value))) return null;
  return { name: property.name, value: wanted.values.join(",") };
}

/**
 * The "Item Type" names the home page lists in its sidebar ("Amulet", "Ring", ...), read from the page text: the
 * lines between the heading "Item Type" and the next heading "Skills".
 */
export function parseItemTypes(pageText) {
  const lines = String(pageText ?? "")
    .split(/\r\n|[\n\r]/u)
    .map((line) => line.trim());
  const start = lines.indexOf("Item Type");
  if (start === -1) return [];
  const end = lines.indexOf("Skills", start);
  return (end === -1 ? [] : lines.slice(start + 1, end)).filter(Boolean);
}

/** The Item Type entry that is the same word as the base ("ring" -> "Ring"), or null. */
export function typeForBase(base, itemTypes) {
  const wanted = String(base ?? "").trim().toLowerCase();
  return wanted ? (itemTypes.find((type) => type.toLowerCase() === wanted) ?? null) : null;
}

const number = (value) => {
  const text = String(value);
  if (!NUMBER.test(text)) throw new Error("條件數值只能是數字");
  return text;
};

/**
 * The home page address with the filters. Values are checked here, so nothing but numbers and the names of
 * Traderie's own properties ever reaches the address. `quality` is { name, value } from mapQuality, `type` an Item
 * Type entry from typeForBase. Throws when there is nothing to filter on.
 */
export function buildStatsUrl({ mapped, quality = null, type = null }) {
  const propParam = (name, value) => `prop_${name}=${value}`;
  const parts = [];
  for (const m of mapped) {
    if (m.type === "bool") {
      parts.push(propParam(encodeURIComponent(m.name), "true"));
      continue;
    }
    if (m.min !== null) parts.push(propParam(`${m.id}Min`, number(m.min)));
    if (m.max !== null) parts.push(propParam(`${m.id}Max`, number(m.max)));
  }
  if (quality) {
    parts.push(propParam(encodeURIComponent(quality.name), encodeURIComponent(quality.value).replace(/%2C/gu, ",")));
  }
  if (type) parts.push(`${TYPE_PARAM}=${encodeURIComponent(type)}`);
  if (!parts.length) throw new Error("至少要有一個條件");
  return `${TRADERIE_D2R_URL}?${parts.join("&")}`;
}

/** "施法速度 ≥10、所有抗性 ≥20、無形" */
export function describeConditions(mapped) {
  return mapped
    .map((m) => {
      if (m.type === "bool") return m.label;
      if (m.min !== null && m.max !== null) return `${m.label} ${m.min}–${m.max}`;
      if (m.max !== null) return `${m.label} ≤${m.max}`;
      if (m.min !== null) return `${m.label} ≥${m.min}`;
      return null; // ticked but no value yet: not a filter, nothing to describe
    })
    .filter((text) => text !== null)
    .join("、");
}

/** True when every parameter of the address we opened is still in the address the page ended up on. */
export function urlKeepsParams(finalUrl, expectedUrl) {
  try {
    const got = new URL(finalUrl).searchParams;
    return [...new URL(expectedUrl).searchParams].every(([key, value]) => got.getAll(key).includes(value));
  } catch {
    return false;
  }
}

/**
 * The pattern of a card line that shows a number property: each {{…}} of the property name becomes a number, the rest
 * is matched literally, whole line, ignoring case ("+{{value}}% Faster Cast Rate" -> "+8% faster cast rate").
 */
export function conditionPattern(name) {
  const body = name
    .split(/\{\{[^}]*\}\}/u)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("\\d+(?:\\.\\d+)?");
  return new RegExp(`^${body}$`, "iu");
}

/** How many rows lack a card line for at least one number condition (a row without `affixes` lacks all of them). */
export function rowsMissingConditions(rows, conditions) {
  const patterns = conditions.filter((c) => c.type === "number").map((c) => conditionPattern(c.name));
  if (!patterns.length) return 0;
  return rows.filter((row) => {
    const affixes = row.affixes ?? [];
    return patterns.some((pattern) => !affixes.some((line) => pattern.test(line)));
  }).length;
}

/** True for the D2R home page (any query string). */
export function isHomeUrl(url) {
  try {
    const page = new URL(url);
    return bareHost(page) === bareHost(HOME) && page.pathname.replace(/\/+$/u, "") === HOME.pathname;
  } catch {
    return false;
  }
}
