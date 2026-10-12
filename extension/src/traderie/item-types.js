// Traderie's "Item Type" list: the sidebar entries of the D2R home page ("Amulet", "Ring", ...) that the affix
// search's filters can name. The names are not written down in this program: they are read from the home page itself
// (stats_flow.js `readHomeItemTypes`) and kept in chrome.storage.local for a week, the same policy as the property
// list (properties.js) — a copy younger than a week is used as it is, a failed read is an error and an old copy is
// never a fallback. Unlike the property list this is page text, not an API answer, so the caller hands in its read.
export const ITEM_TYPES_KEY = "traderieItemTypes";
export const ITEM_TYPES_TTL_MS = 7 * 24 * 3600 * 1000;

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** What was stored by an earlier query, or null. */
export async function cachedItemTypes(store = chrome.storage.local) {
  const saved = (await store.get(ITEM_TYPES_KEY))[ITEM_TYPES_KEY];
  if (!saved || !Number.isFinite(saved.fetchedAt) || !Array.isArray(saved.itemTypes)) return null;
  return saved;
}

/** The stored copy while it is younger than a week and carries names, else null. */
const usableCopy = (saved, now) =>
  saved && now - saved.fetchedAt < ITEM_TYPES_TTL_MS && saved.itemTypes.length ? saved : null;

/** "（上次取得：YYYY-MM-DD）" for a failed read while an old copy exists, or "" when there is none. */
const ageNote = (saved) => (saved ? `（上次取得：${isoDay(saved.fetchedAt)}）` : "");

/**
 * The Item Type names for a query and whether the stored copy was used (`cacheHit`): the stored copy while it is
 * younger than a week, otherwise `read()` — the caller's home-page read — whose names are then stored. `read()`
 * resolves with `{ itemTypes }`, or `{ guard: true }` for a site challenge, which is not a list and is never stored.
 * A failed read is an error even when an old copy exists and names the last good copy, exactly as `loadProperties`
 * promises for the property list: an out-of-date list could drop a base's type filter, so it is never a fallback. An
 * empty read is not stored either — a week of "no type" would wrongly keep a base out of the filter.
 */
export async function loadItemTypes({ read, store = chrome.storage.local, now = Date.now() }) {
  const saved = await cachedItemTypes(store);
  const fresh = usableCopy(saved, now);
  if (fresh) return { itemTypes: fresh.itemTypes, cacheHit: true };
  let result;
  try {
    result = await read();
  } catch (error) {
    throw new Error(`${error.message}${ageNote(saved)}`, { cause: error });
  }
  if (result.guard) return { guard: true };
  if (result.itemTypes.length) await store.set({ [ITEM_TYPES_KEY]: { fetchedAt: now, itemTypes: result.itemTypes } });
  return { itemTypes: result.itemTypes, cacheHit: false };
}
