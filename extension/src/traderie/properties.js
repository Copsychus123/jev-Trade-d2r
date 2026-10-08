// Traderie's list of searchable properties (the things "Search All Stats" can filter on). The ids and names are not
// written down in this program: they are read from Traderie itself, from inside the player's own Traderie tab (the
// same GET the site makes for its own sidebar), and kept in chrome.storage.local for a week.
export const PROPERTIES_KEY = "traderieProperties";
export const PROPERTIES_TTL_MS = 7 * 24 * 3600 * 1000;
const PROPERTIES_PATH = "/api/diablo2resurrected/properties?global=true";

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** A property name with every {{…}} placeholder shown as a plain X ("+{{value}}% ..." -> "+X% ..."). */
export const propertyLabel = (name) => String(name).replace(/\{\{[^}]+\}\}/gu, "X");

/** The API answer ({ properties: [...] }) as [{ id, name, type, options, label }]; label is the name with {{x}} -> X. */
export function normalizeProperties(raw) {
  const list = Array.isArray(raw) ? raw : raw?.properties;
  if (!Array.isArray(list)) return [];
  const result = [];
  for (const item of list) {
    if (!item || !Number.isInteger(item.id) || typeof item.name !== "string" || typeof item.type !== "string") continue;
    result.push({
      id: item.id,
      name: item.name,
      type: item.type,
      options: Array.isArray(item.options) ? item.options : null,
      label: propertyLabel(item.name),
    });
  }
  return result;
}

/** Reads the list inside the Traderie tab. One attempt; a non-200 answer or an empty list is an error. */
async function fetchProperties(tab, scripts) {
  const reply = await tab.evaluate(`${scripts.fetchJson}(${JSON.stringify(PROPERTIES_PATH)})`, { awaitPromise: true });
  const properties = reply?.status === 200 ? normalizeProperties(reply.body) : [];
  if (!properties.length) {
    throw new Error(`無法取得 Traderie 屬性清單（HTTP ${reply?.status ?? "沒有回應"}）`);
  }
  return properties;
}

/** What was stored by an earlier query, or null. */
export async function cachedProperties(store = chrome.storage.local) {
  const saved = (await store.get(PROPERTIES_KEY))[PROPERTIES_KEY];
  if (!saved || !Number.isFinite(saved.fetchedAt) || !Array.isArray(saved.properties)) return null;
  return saved;
}

/**
 * The list for a query and whether the stored copy was used (`cacheHit`): the stored one while it is younger than a
 * week, otherwise a fresh read that is stored. A failed read is an error even when an old copy exists: an out-of-date
 * list could map a condition to the wrong property, so it is never used as a fallback.
 */
export async function loadProperties({ tab, scripts, store = chrome.storage.local, now = Date.now() }) {
  const saved = await cachedProperties(store);
  if (saved && now - saved.fetchedAt < PROPERTIES_TTL_MS && saved.properties.length) {
    return { properties: saved.properties, cacheHit: true };
  }
  try {
    const properties = await fetchProperties(tab, scripts);
    await store.set({ [PROPERTIES_KEY]: { fetchedAt: now, properties } });
    return { properties, cacheHit: false };
  } catch (error) {
    const last = saved ? `（上次取得：${isoDay(saved.fetchedAt)}）` : "";
    throw new Error(`${error.message}${last}`, { cause: error });
  }
}

/** The line in the settings page. */
export function propertiesAge(saved) {
  if (!saved) return "Traderie 屬性清單：尚未取得（第一次查詢時會自動取得）";
  return `Traderie 屬性清單：${isoDay(saved.fetchedAt)} 取得（${saved.properties.length} 項）`;
}
