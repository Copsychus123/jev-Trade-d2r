// Three ways to reach the product page, one attempt each:
//   1. table jump  - the English name is in the item table: open /product/<slug>, check the page really is that item
//   2. search      - Jev types the English name in the search box and picks the result (the existing agent flow)
//   3. base list   - search found nothing for a well-formed name: Jev picks the plain item type from a fixed list,
//                    then one more search with that name; no pick means "not found" and the run ends.
// Everything the caller needs to clean up (tab, agent) is stored on `session` as soon as it exists.
import { runAgent } from "./controller.js";
import {
  findProduct,
  isWellFormed,
  nameStatus,
  productUrlFor,
  resolveInput,
  searchFoundNothing,
  stripToBase,
  tableAge,
  titleIsItem,
} from "./lookup.js";
import { TRADERIE_D2R_URL, detectGuard, productRootUrl } from "./site.js";
import { timed } from "../timeline.js";

/** What Tab.open measured (navigate, settle, visibility), for the timeline entry of an open. */
const openDetails = (tab) => tab?.openTiming ?? {};

export const LAYER_LABELS = { table: "查表直接開啟", search: "站內搜尋", base: "底材清單" };

const NAME_NOTES = {
  game_only: "遊戲裡有這個物品，但 Traderie 目錄沒有收錄，或名稱寫法不同",
  unknown: "兩份名稱表都沒有這個名稱，可能是打錯字，或是表還沒收錄的新物品",
};

/** After the table jump: is the page open the product the table promised? */
async function checkLanding(tab, product) {
  let page;
  try {
    page = await tab.readSettledPage(500, 8000);
  } catch {
    return { ok: false, reason: "商品頁沒有載入完成" };
  }
  const guard = await detectGuard(page, tab);
  if (guard) return { ok: false, guard };
  if (!productRootUrl(page.url)) return { ok: false, reason: `開到的不是商品頁：${page.url}` };
  if (!titleIsItem(product.name, page.title ?? "")) return { ok: false, reason: `商品頁標題不是 ${product.name}` };
  return { ok: true };
}

async function backToSearch(tab, session) {
  await timed(session, "navigate", () => tab.navigate(TRADERIE_D2R_URL), (r) => r ?? {});
  await timed(session, "settle", () => tab.settle(), (r) => r ?? {});
}

/**
 * Layer 1: open `/product/<slug>` from the item table and check the page really is that item.
 * Returns "guard" when the site challenged; otherwise null, and `lookup.layer` says whether the jump landed.
 */
async function tableJump({ product, tables, openTab, session, lookup, tableStats, onStatus }) {
  tableStats.jumps += 1;
  onStatus("查表：直接開啟商品頁…");
  session.tab = await timed(session, "open_tab", () => openTab(productUrlFor(product)), openDetails);
  const landing = await timed(session, "check_landing", () => checkLanding(session.tab, product), (r) => ({ ok: r.ok }));
  if (landing.guard) return "guard";
  if (landing.ok) {
    lookup.layer = "table";
    return null;
  }
  tableStats.misses += 1;
  const missed = `${tableStats.misses}/${tableStats.jumps}`;
  lookup.notes.push(
    `查表開啟的頁面不對（${landing.reason}），改用搜尋（查表落空 ${missed} 次；${tableAge(tables.generatedAt).text}）`,
  );
  await backToSearch(session.tab, session);
  return null;
}

/**
 * Layer 3, only for a well-formed name that the search really did not find. The program drops leading words until
 * what is left is a base (free and steady); Jev picks from the fixed list only when that finds none, and no pick
 * means "not found". Resolves with "ran" or "not_found".
 */
async function baseFallback({ resolved, tables, session, lookup, run, foundNothing, shouldStop, pickBase, onStatus }) {
  const notFound = () => {
    const note = NAME_NOTES[nameStatus(resolved.query, tables)];
    if (note) lookup.notes.push(note);
    return "not_found";
  };
  if (!isWellFormed(resolved.query)) return notFound();
  onStatus("搜尋找不到，改從底材清單挑…");
  const matched = stripToBase(resolved.query, tables);
  const picked = await timed(session, "pick_base", () =>
    pickBase({ runToken: session.run.run_token, options: tables.bases, base: matched }),
  );
  if (!picked.base) return notFound();
  session.run = { ...session.run, run_token: picked.run_token, item_name: picked.base };
  session.itemName = picked.base;
  Object.assign(lookup, { layer: "base", used: picked.base });
  lookup.notes.push(`你查的是 ${resolved.query}，顯示的是底材 ${picked.base}，沒有依品質篩選`);
  await backToSearch(session.tab, session);
  await run();
  return !shouldStop() && foundNothing() ? notFound() : "ran";
}

/**
 * Resolves the typed name, starts the run and records the lookup the panel shows, ready for the layers below.
 * `session` receives the run and the item name; `market.lookup` is the record the later layers keep filling in.
 */
async function prepareLookup({ rawItem, tables, loadMore, startRun, market, session }) {
  const resolved = resolveInput(rawItem, tables);
  const lookup = { typed: resolved.typed, requested: resolved.query, used: resolved.query, layer: null, notes: [] };
  market.lookup = lookup;
  if (resolved.translated) lookup.notes.push(`「${resolved.typed}」對照為 ${resolved.query}`);

  session.run = await timed(session, "start_run", () => startRun({ itemName: resolved.query, loadMore }));
  session.itemName = session.run.item_name;
  return { resolved, lookup };
}

/**
 * Finds the product and reads both views. `session` receives tab, agent, run and itemName as they are created.
 * Resolves with "ran" (the agent finished or stopped; the caller judges the result), "guard" (site challenge)
 * or "not_found" (all layers tried).
 * `tableStats` counts table jumps and the ones that opened the wrong page ("misses"); a caller that keeps the object
 * between runs gets running totals in the note of each miss (a growing share of misses means the table is out of date).
 */
export async function findAndRead({
  rawItem,
  tables,
  loadMore,
  startRun,
  pickBase,
  openTab,
  makeAgent,
  market,
  session,
  shouldStop = () => false,
  onUpdate = () => {},
  onStatus = () => {},
  tableStats = { jumps: 0, misses: 0 },
}) {
  const { resolved, lookup } = await prepareLookup({ rawItem, tables, loadMore, startRun, market, session });

  const product = findProduct(resolved.query, tables);
  if (product) {
    const jumped = await tableJump({ product, tables, openTab, session, lookup, tableStats, onStatus });
    if (jumped === "guard") return "guard";
  }
  if (!lookup.layer) {
    // Layer 2: Jev types the name the program supplies and picks the result.
    onStatus("站內搜尋…");
    session.tab ??= await timed(session, "open_tab", () => openTab(TRADERIE_D2R_URL), openDetails);
    lookup.layer = "search";
  }

  const run = async () => {
    session.agent = await timed(session, "make_agent", () => makeAgent(session.tab, session.run));
    await timed(session, "run_agent", () => runAgent(session.agent, session.itemName, market, { shouldStop, onUpdate, session }));
  };
  const foundNothing = () => session.agent.state.status === "blocked" && searchFoundNothing(session.agent.state.page);

  await run();
  if (shouldStop() || lookup.layer === "table" || !foundNothing()) return "ran";
  if (market.trading.status !== "NOT_RUN") return "ran";

  return await baseFallback({ resolved, tables, session, lookup, run, foundNothing, shouldStop, pickBase, onStatus });
}
