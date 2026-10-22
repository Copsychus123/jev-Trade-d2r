// The second way to search: items without a fixed name (yellow, blue, white) found by what they carry. The player's
// confirmed conditions become the filters of the D2R home page ("Search All Stats"); the program opens that address
// and reads the first page of the list. No Jev, no backend: nothing here chooses what to click.
//
//   1. get the home page's list of Item Types (stored for a week like the property list; a fresh copy skips the load)
//   2. get Traderie's property list (stored for a week) and map the conditions to it
//   3. open the home page with the filters in its address, read the list, check the filters were kept
//
// Resolves with "ran" (the list was read; the caller judges the result), "guard" (site challenge) or "unmapped"
// (a switched-on condition has no property at Traderie; nothing was searched).
import { TimeoutError, StalePage } from "../errors.js";
import { readStatsView, verifyStats } from "./controller.js";
import { loadItemTypes } from "./item-types.js";
import { ensureProperties, loadProperties, numberConditionLabels } from "./properties.js";
import { TRADERIE_D2R_URL, detectGuard } from "./site.js";
import { openDetails, timed } from "../timeline.js";
import {
  MAX_CONDITIONS,
  buildStatsUrl,
  describeConditions,
  mapConditions,
  mapQuality,
  parseItemTypes,
  qualityChoice,
  typeForBase,
} from "./stats.js";

const HOME_READS = 4;

/**
 * Step 1's real read: open the D2R home page and read its Item Type list. Returns `{ itemTypes }`, or `{ guard: true }`
 * when the site challenged the request. `loadItemTypes` runs this only on a cache miss; a fresh stored copy skips the
 * home-page load (and with it this guard check — the filtered page's own read still catches a challenge).
 */
async function readHomeItemTypes({ openTab, session, onStatus }) {
  onStatus("開啟 Traderie 首頁…");
  session.tab = await timed(session, "open_tab", () => openTab(TRADERIE_D2R_URL), openDetails);
  // The sidebar's Item Type list is drawn a moment after the rest of the page; a base needs it, so read again a few
  // times (reading changes nothing) before treating the base as "not a site type".
  let itemTypes = [];
  for (let attempt = 0; attempt < HOME_READS; attempt += 1) {
    let home;
    try {
      home = await timed(session, "read_home", () => session.tab.readSettledPage(500, 8000), (p) => ({
        attempt: attempt + 1,
        settled: p?.settled ?? null,
      }));
    } catch (error) {
      if (!(error instanceof TimeoutError || error instanceof StalePage)) throw error;
      throw new Error("Traderie 首頁一直沒有載入完成", { cause: error });
    }
    if (await detectGuard(home, session.tab)) return { guard: true };
    itemTypes = parseItemTypes(home.text);
    if (itemTypes.length) break;
  }
  return { itemTypes };
}

/**
 * The sentences the panel needs about the filters that did not apply: a chosen quality or a base type Traderie's own
 * list cannot filter on. In the order of `lookup.notes`.
 */
function filterNotes({ quality, chosenQuality, base, type }) {
  const notes = [];
  if (quality !== "any" && !chosenQuality) {
    notes.push("未依品質篩選（Traderie 的屬性清單裡找不到這個品質）");
  }
  if (base) {
    notes.push(
      type
        ? `網站已依類型「${type}」篩選，再只列名稱是「${base}」的掛單`
        : `「${base}」不是網站的物品類型，只在顯示時依名稱篩選（只看網站回傳的這一頁）`,
    );
  }
  return notes;
}

/**
 * Step 2: map the conditions the player confirmed onto Traderie's own property list (kept for a week), write down
 * what could not be filtered, and build the address of the filtered home page. Returns `{ url, mapped }`, or
 * `{ unmapped }` when a switched-on condition has no property at Traderie.
 */
async function planStatsSearch({ conditions, base, quality, itemTypes, scripts, store, session, lookup, onStatus, openTab }) {
  onStatus("取得 Traderie 的屬性清單…");
  // loadProperties reports whether it used the stored list: one source of truth, no second storage read. Without a
  // query tab (the Item Type list came from cache) a stale property list is read in a tab of its own, closed again.
  const readProperties = () =>
    session.tab
      ? loadProperties({ tab: session.tab, scripts, store })
      : ensureProperties({ openTab: () => openTab(TRADERIE_D2R_URL), scripts, store });
  const loaded = await timed(session, "load_properties", readProperties, (r) => ({ cache_hit: r.cacheHit }));
  const properties = loaded.properties;
  lookup.stage = "apply";
  const { mapped, unmapped } = mapConditions(conditions, properties);
  if (unmapped.length) {
    lookup.unmapped = unmapped;
    return { unmapped };
  }
  if (mapped.length > MAX_CONDITIONS) throw new Error(`條件最多 ${MAX_CONDITIONS} 條，請取消一些`);

  const chosenQuality = mapQuality(quality, properties);
  const type = typeForBase(base, itemTypes);
  lookup.notes.push(...filterNotes({ quality, chosenQuality, base, type }));
  if (!mapped.length && !chosenQuality && !type) {
    throw new Error("這個底材網站沒有對應的物品類型，請至少勾選一個詞綴條件或選一種品質");
  }

  const url = buildStatsUrl({ mapped, quality: chosenQuality, type });
  const qualityLabel = qualityChoice(quality)?.label;
  const parts = [describeConditions(mapped), chosenQuality ? qualityLabel : null, type ? `類型 ${type}` : null];
  Object.assign(lookup, {
    stage: "read",
    conditions: mapped,
    description: parts.filter(Boolean).join("、"),
    type,
    url,
  });
  return { url, mapped };
}

/**
 * Step 3: open the filtered address, read its list, keep only the rows whose name is the base, and check the read
 * independently. Every sentence the player needs about what was read ends up in `lookup.notes`.
 */
async function readFilteredRows({
  url, mapped, base, market, session, lookup, onStatus, openedHere = false, readOptions = {},
}) {
  onStatus("套用條件…");
  // `openTab` already navigated and settled the tab on this address; navigating again would reload the page for nothing.
  if (!openedHere) await timed(session, "navigate", () => session.tab.navigate(url), (r) => r ?? {});
  await timed(session, "settle", () => session.tab.settle(), (r) => r ?? {});
  onStatus("讀取符合條件的掛單…");
  const expectedLabels = numberConditionLabels(mapped);
  // `readOptions` carries the read's retry policy (attempts/waitMs); the panel leaves it empty, so the controller's
  // own defaults apply, and a test can drive the same flow without real waits between attempts.
  market.trading = await readStatsView(session.tab, url, { expectText: expectedLabels, session, ...readOptions });

  if (base && market.trading.status === "PASSED") {
    const all = market.trading.rows;
    const wantedBase = base.toLowerCase();
    market.trading.rows_before_base = all.length;
    market.trading.rows = all.filter((row) => row.item_name.toLowerCase() === wantedBase);
    if (all.length && !market.trading.rows.length) {
      lookup.notes.push(`網站回傳的 ${all.length} 筆裡沒有名稱是「${base}」的掛單`);
    }
  }
  if (market.trading.status === "PASSED" && !market.trading.rows.length && !market.trading.rows_before_base) {
    lookup.notes.push(market.trading.reason || "沒有符合條件的掛單"); // an empty list needs a sentence, not a blank screen
  }
  if (market.trading.status === "FAILED" && market.trading.reason) lookup.notes.push(`沒有讀成功：${market.trading.reason}`);
  if (market.trading.has_more) lookup.notes.push("只讀了第一頁");
  market.verification = verifyStats(market);
}

export async function findAndReadStats({
  conditions,
  base,
  quality,
  openTab,
  scripts,
  store,
  market,
  session,
  shouldStop = () => false,
  onStatus = () => {},
  readOptions = {},
}) {
  const lookup = { mode: "stats", stage: "properties", notes: [], base, quality };
  Object.assign(market, { mode: "stats", lookup });

  const types = await timed(
    session,
    "load_item_types",
    () => loadItemTypes({ read: () => readHomeItemTypes({ openTab, session, onStatus }), store }),
    (r) => ({ cache_hit: r.cacheHit }),
  );
  if (types.guard) return "guard";

  const filters = await planStatsSearch({
    conditions,
    base,
    quality,
    itemTypes: types.itemTypes,
    scripts,
    store,
    session,
    lookup,
    onStatus,
    openTab,
  });
  if (filters.unmapped) return "unmapped";
  if (shouldStop()) return "ran";

  // A stored Item Type list skipped step 1's home-page load, so there is no query tab yet: open it straight on the
  // filtered address (one home load saved) instead of opening the home page and navigating again.
  const openedHere = !session.tab;
  if (openedHere) {
    session.tab = await timed(session, "open_tab", () => openTab(filters.url), openDetails);
  }
  await readFilteredRows({
    url: filters.url, mapped: filters.mapped, base, market, session, lookup, onStatus, openedHere, readOptions,
  });
  return "ran";
}
