// Traderie's list of searchable properties (the things "Search All Stats" can filter on). The ids and names are not
// written down in this program: they are read from Traderie itself, from inside the player's own Traderie tab (the
// same GET the site makes for its own sidebar), and kept in chrome.storage.local for a week.
export const PROPERTIES_KEY = "traderieProperties";
export const PROPERTIES_TTL_MS = 7 * 24 * 3600 * 1000;
const PROPERTIES_PATH = "/api/diablo2resurrected/properties?global=true";

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** A property name with every {{…}} placeholder shown as a plain X ("+{{value}}% ..." -> "+X% ..."). */
export const propertyLabel = (name) => String(name).replace(/\{\{[^}]+\}\}/gu, "X");

/**
 * The labels of the number conditions: what a filtered read waits to see in the sidebar and what the checks look for.
 * One place, so the list the reader waits for and the list the verify step expects can never drift apart.
 */
export const numberConditionLabels = (conditions) =>
  conditions.filter((c) => c.type === "number").map((c) => propertyLabel(c.name));

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

/** The stored copy while it is younger than `ttlMs` and its `field` list has entries, else null (item-types.js too). */
export const usableCopy = (saved, now, ttlMs, field) =>
  saved && now - saved.fetchedAt < ttlMs && saved[field].length ? saved : null;

/** "（上次取得：YYYY-MM-DD）" for a failed read while an old copy exists, or "" when there is none. */
export const ageNote = (saved) => (saved ? `（上次取得：${isoDay(saved.fetchedAt)}）` : "");

/**
 * A fresh read stored for later; a failure is an error that names the last good copy. `openTab` (optional) opens the
 * tab itself and it is closed again either way, so failing to open one is reported like failing to read it.
 */
async function fetchAndStore({ tab, openTab, scripts, store, now, saved }) {
  let owned = null;
  try {
    if (openTab) tab = owned = await openTab();
    const properties = await fetchProperties(tab, scripts);
    await store.set({ [PROPERTIES_KEY]: { fetchedAt: now, properties } });
    return { properties, cacheHit: false };
  } catch (error) {
    throw new Error(`${error.message}${ageNote(saved)}`, { cause: error });
  } finally {
    if (owned) await owned.close().catch(() => {});
  }
}

/** The stored copy and whether it is still usable, read once for the two entry points below. */
async function storedCopy(store, now) {
  const saved = await cachedProperties(store);
  return { saved, fresh: usableCopy(saved, now, PROPERTIES_TTL_MS, "properties") };
}

/**
 * The stored copy while it is younger than a week, otherwise a fresh read that is stored: the shared body of the two
 * entry points below, which differ only in the tab they read in. `tab` is one the caller already has; `openTab` opens
 * and closes one of its own (the settings screen has none to give).
 */
async function propertiesList({ tab, openTab, scripts, store, now }) {
  const { saved, fresh } = await storedCopy(store, now);
  if (fresh) return { properties: fresh.properties, cacheHit: true };
  return fetchAndStore({ tab, openTab, scripts, store, now, saved });
}

/**
 * The list for a query and whether the stored copy was used (`cacheHit`): the stored one while it is younger than a
 * week, otherwise a fresh read that is stored. A failed read is an error even when an old copy exists: an out-of-date
 * list could map a condition to the wrong property, so it is never used as a fallback.
 */
export async function loadProperties({ tab, scripts, store = chrome.storage.local, now = Date.now() }) {
  return propertiesList({ tab, scripts, store, now });
}

/**
 * Makes sure a usable list exists *before* the player's first affix search, so the form can grey out conditions the
 * site has no property for instead of wasting a trip. The stored copy is used while it is younger than a week; only
 * when there is none (or it is old) is `openTab()` — a function that opens one Traderie tab and resolves with it —
 * called, once, to read the list, which is then stored; that tab is closed again whether the read worked or not.
 * A failed read is an error and an old copy is never a fallback, exactly as `loadProperties` promises, so the caller
 * may catch it and carry on without the list.
 */
export async function ensureProperties({ openTab, scripts, store = chrome.storage.local, now = Date.now() }) {
  return propertiesList({ openTab, scripts, store, now });
}
