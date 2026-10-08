// The second search (yellow, blue and white items by their affixes) as the side panel runs it: what one query reads
// from the form, how it is started and how it is judged afterwards. The panel keeps the session state (running, the
// open tab, the banner) and hands in what the query needs. The page flow itself is traderie/stats_flow.js.
import { loadPageScripts, Tab } from "./cdp.js";
import { resolveBase } from "./traderie/lookup.js";
import { QUALITIES } from "./traderie/stats.js";
import { findAndReadStats } from "./traderie/stats_flow.js";
import { loadTables } from "./sidepanel.js";

/**
 * How a stats query ended: { after, banner? }. A condition Traderie has no property for ends it before anything was
 * searched (the form then greys those conditions out).
 */
export function judgeStats(session, { market, statsForm, stopped, guardProblem }) {
  if (stopped) return { after: "stopped" };
  if (session.outcome === "guard") return { after: "problem", banner: guardProblem() };
  if (session.outcome === "unmapped") {
    const keys = market.lookup.unmapped;
    const names = keys.map((key) => statsForm.get().conditions.find((c) => c.key === key)?.label ?? key);
    statsForm.markUnavailable(keys);
    return {
      after: "problem",
      banner: { message: `這些條件 Traderie 沒有對應的屬性：${names.join("、")}`, hint: "已先取消勾選，確認後再查", retry: "知道了" },
    };
  }
  if (market.trading.status === "BLOCKED") return { after: "problem", banner: guardProblem(market.trading.reason) };
  return { after: "done" };
}

/**
 * Runs one query on `session` ({ tab, outcome }, which the panel owns so Stop and the cleanup reach its tab) and
 * resolves with the name the downloads use. Errors are the panel's to describe. `begin(text)` clears the last query,
 * shows the running screen and returns the fresh market; `setStatus(text)`, `render()` and `shouldStop()` are the panel's.
 */
export async function runStatsFlow(input, session, { begin, setStatus, render, shouldStop }) {
  const rawBase = (input.base ?? "").trim();
  const tables = await loadTables();
  const englishBase = resolveBase(rawBase, tables);
  const quality = QUALITIES.find((q) => q.key === input.quality);
  const chosen = input.conditions.filter((c) => c.on).map((c) => c.label);
  const market = begin([...chosen, quality.values ? quality.label : null, englishBase || null].filter(Boolean).join("・"));
  if (rawBase && englishBase && rawBase !== englishBase) {
    if (!market.lookup) market.lookup = { notes: [] };
    if (!market.lookup.notes) market.lookup.notes = [];
    market.lookup.notes.push(`底材「${rawBase}」對照為 ${englishBase}`);
  }
  setStatus("正在準備…");
  const scripts = await loadPageScripts();
  session.outcome = await findAndReadStats({
    conditions: input.conditions,
    base: englishBase,
    quality: input.quality,
    openTab: (url) => Tab.open(url, scripts),
    scripts,
    store: chrome.storage.local,
    market,
    session,
    shouldStop,
    onStatus: (text) => {
      setStatus(text);
      render();
    },
  });
  return englishBase || "stats";
}
