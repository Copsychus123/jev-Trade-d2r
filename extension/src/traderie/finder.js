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
  productUrl,
  resolveInput,
  searchFoundNothing,
  stripToBase,
  titleIsItem,
} from "./lookup.js";
import { TRADERIE_D2R_URL, detectGuard, productRootUrl } from "./site.js";

export const LAYER_LABELS = { table: "查表直接開啟", search: "站內搜尋", base: "底材清單" };

const NAME_NOTES = {
  game_only: "遊戲裡有這個物品，但 Traderie 目錄沒有收錄，或名稱寫法不同",
  unknown: "兩份名稱表都沒有這個名稱，可能是打錯字，或是表還沒收錄的新物品",
};

/** After the table jump: is the page open the product the table promised? */
export async function checkLanding(tab, product) {
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

async function backToSearch(tab) {
  await tab.navigate(TRADERIE_D2R_URL);
  await tab.settle();
}

/**
 * Finds the product and reads both views. `session` receives tab, agent, run and itemName as they are created.
 * Resolves with "ran" (the agent finished or stopped; the caller judges the result), "guard" (site challenge)
 * or "not_found" (all layers tried).
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
}) {
  const resolved = resolveInput(rawItem, tables);
  const lookup = { typed: resolved.typed, requested: resolved.query, used: resolved.query, layer: null, notes: [] };
  market.lookup = lookup;
  if (resolved.translated) lookup.notes.push(`「${resolved.typed}」對照為 ${resolved.query}`);

  session.run = await startRun({ itemName: resolved.query, loadMore });
  session.itemName = session.run.item_name;

  const product = findProduct(resolved.query, tables);
  if (product) {
    onStatus("查表：直接開啟商品頁…");
    session.tab = await openTab(productUrl(product));
    const landing = await checkLanding(session.tab, product);
    if (landing.guard) return "guard";
    if (landing.ok) {
      lookup.layer = "table";
    } else {
      lookup.notes.push(`查表開啟的頁面不對（${landing.reason}），改用搜尋`);
      await backToSearch(session.tab);
    }
  }
  if (!lookup.layer) {
    onStatus("站內搜尋…");
    session.tab ??= await openTab(TRADERIE_D2R_URL);
    lookup.layer = "search";
  }

  const run = async () => {
    session.agent = await makeAgent(session.tab, session.run);
    await runAgent(session.agent, session.itemName, market, { shouldStop, onUpdate });
  };
  const foundNothing = () => session.agent.state.status === "blocked" && searchFoundNothing(session.agent.state.page);

  await run();
  if (shouldStop() || lookup.layer === "table" || !foundNothing()) return "ran";
  if (market.trading.status !== "NOT_RUN") return "ran";

  // Layer 3: only for a well-formed name that search really did not find.
  const notFound = () => {
    const note = NAME_NOTES[nameStatus(resolved.query, tables)];
    if (note) lookup.notes.push(note);
    return "not_found";
  };
  if (!isWellFormed(resolved.query)) return notFound();
  onStatus("搜尋找不到，改從底材清單挑…");
  // The program tries first (drop leading words until the rest is a base: free and steady); Jev only when that finds none.
  const matched = stripToBase(resolved.query, tables);
  const picked = await pickBase({ runToken: session.run.run_token, options: tables.bases, base: matched });
  if (!picked.base) return notFound();
  session.run = { ...session.run, run_token: picked.run_token, item_name: picked.base };
  session.itemName = picked.base;
  Object.assign(lookup, { layer: "base", used: picked.base });
  lookup.notes.push(`你查的是 ${resolved.query}，顯示的是底材 ${picked.base}，沒有依品質篩選`);
  await backToSearch(session.tab);
  await run();
  return !shouldStop() && foundNothing() ? notFound() : "ran";
}
