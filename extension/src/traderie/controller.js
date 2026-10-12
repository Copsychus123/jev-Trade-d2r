// Port of the reading/verification half of src/jev_ultrafast/traderie/controller.py. Same status, same reason_code
// for the same page; see the module docstring there for the codes.
import { AbortedError, StalePage, TimeoutError } from "../errors.js";
import { timed } from "../timeline.js";
import { TRADE_START, parseRecentTrades, parseTradingTxt, splitLines } from "./parsing.js";
import { normalizeName } from "./lookup.js";
import { numberConditionLabels } from "./properties.js";
import { detectGuard, productRootUrl, productSection, TRADING_MARKERS } from "./site.js";
import { isHomeUrl, rowsMissingConditions, urlKeepsParams } from "./stats.js";

export const TRADING_COLUMNS = ["賣家", "要價", "高符文價值", "刊登時間", "平台 / 模式 / 天梯", "防禦", "遊戲版本"];
export const RECENT_COLUMNS = ["成交物品", "成交價格", "成交時間", "平台 / 模式 / 天梯", "遊戲版本"];
export const STATS_COLUMNS = ["物品", ...TRADING_COLUMNS];
export const VIEW_LABELS = { trading: "目前掛單", recent_trades: "近期成交" };

const LOAD_MORE_PROBE =
  "[...document.querySelectorAll('button,a,[role=button]')].some(e => /^\\s*load more\\s*$/i.test(e.innerText || ''))";

const VIEW_SECTIONS = { trading: null, recent_trades: "recent" };
const EMPTY_TRADING = "there are no listings";
const EMPTY_RECENT = "there are no offers";

function view(status, reason = null, code = null) {
  return {
    status, reason, reason_code: code, url: null, title: null, observed_at: null, rows: [],
    has_more: null, // true / false once read; null = not read or the probe failed (unknown)
    settled: null, text: "",
  };
}

export function newMarket() {
  return { trading: view("NOT_RUN"), recent_trades: view("NOT_RUN"), verification: null, lookup: null, mode: "name" };
}

const NON_WORD = /[^a-z0-9]+/gu;
const titleHasWords = (text) => Boolean(text.toLowerCase().replace(NON_WORD, " ").trim());

// Same name rule as the title check in lookup.js (normalizeName: accents, apostrophes and a leading "the" ignored),
// so a table hit and the page read never disagree about the same title.
export function matchesItem(itemName, text) {
  const expected = normalizeName(itemName);
  const actual = normalizeName(text);
  if (!(expected && actual)) return false;
  return ` ${actual} `.includes(` ${expected} `) || ` ${expected} `.includes(` ${actual} `);
}

// The title decides when the page has one; the visible text is only a fallback for a page without a title.
export function pageMatchesItem(itemName, title, text) {
  return matchesItem(itemName, titleHasWords(title) ? title : text);
}

async function hasMore(tab) {
  try {
    return Boolean(await tab.evaluate(LOAD_MORE_PROBE));
  } catch {
    return null;
  }
}

// "PC / Softcore / Ladder": the same join on both lists, so the two views describe the environment alike.
function envCell(row) {
  return ["platform", "mode", "ladder"].filter((k) => row[k]).map((k) => String(row[k])).join(" / ");
}

export function tradingCells(row) {
  return [row.seller ?? null, row.ask ?? null, row.high_rune_value ?? null, row.posted_time ?? null, envCell(row),
    row.defense ?? null, row.game_version ?? null];
}

export function recentCells(row) {
  return [row.buyer_or_seller ?? null, row.price ?? null, row.trade_time ?? null, envCell(row),
    row.game_version ?? null];
}

export function statsCells(row) {
  return [row.item_name ?? null, ...tradingCells(row)];
}

function fail(result, code, reason, status = "FAILED") {
  return Object.assign(result, { status, reason, reason_code: code });
}

/**
 * Reads the settled page into a fresh FAILED view: { result, page }. `page` is null when the read already decided
 * the outcome (the page never settled, or a site challenge: BLOCKED), and `result` then says why.
 */
async function observePage(tab) {
  const result = view("FAILED");
  result.observed_at = new Date().toISOString();
  let page;
  try {
    page = await tab.readSettledPage(500, 5000);
  } catch (error) {
    if (!(error instanceof TimeoutError || error instanceof StalePage)) throw error;
    result.settled = false;
    return { result: fail(result, "unsettled", "頁面一直沒有載入完成"), page: null };
  }
  Object.assign(result, { url: page.url, title: page.title ?? "", text: page.text, settled: page.settled ?? null });
  const guard = await detectGuard(page, tab);
  if (guard) return { result: fail(result, "guard", `網站阻擋：${guard}`, "BLOCKED"), page: null };
  return { result, page };
}

/** How many row markers the page shows: the count the parsed rows are cross-checked against. */
const markerCount = (lines) => lines.filter((line) => TRADING_MARKERS.includes(line)).length;

// Reason builders shared by the readers below, which fail the same way and must say the same thing.
const UNSETTLED_REASON = "頁面在時限內沒有穩定下來，讀到的筆數不可信";
const NO_ROWS_REASON = "頁面上沒有讀到任何掛單";
const noAnchorReason = (rows) => `讀到 ${rows.length} 筆，但頁面上找不到可以核對的筆數標記`;
const fewerRows = (rows, markers) => (rows.length < markers ? `表格 ${rows.length} 筆，少於網頁上的 ${markers} 筆` : null);

/**
 * Per-view read rules, so `readView` (trading, recent_trades) and `readStatsOnce` (stats) share one reconcile.
 * `parse` builds the rows and the parsed recent-trades answer (which carries its own login verdict); `markers`
 * counts the page's own row anchors; `emptyText` is the sentence that means a legitimately empty list and
 * `emptyReason` what such a list passes with; `noRows`/`noAnchor` build those failures' reasons from the read;
 * `mismatch` returns the row-count failure's reason, or null when the rows and the page agree.
 */
const VIEW_READERS = {
  trading: {
    parse: (text, itemName) => ({ rows: parseTradingTxt(text, { itemName }), parsed: null }),
    markers: markerCount,
    emptyText: EMPTY_TRADING,
    emptyReason: "目前沒有掛單",
    noRows: () => NO_ROWS_REASON,
    noAnchor: noAnchorReason,
    mismatch: fewerRows,
  },
  recent_trades: {
    parse: (text) => {
      const parsed = parseRecentTrades(text);
      return { rows: parsed.trades, parsed };
    },
    markers: (lines) => lines.filter((line) => line.toLowerCase() === TRADE_START.toLowerCase()).length,
    emptyText: EMPTY_RECENT,
    emptyReason: "目前沒有成交紀錄",
    noRows: (parsed) => parsed.reason,
    noAnchor: noAnchorReason,
    mismatch: (rows, markers) => (rows.length !== markers ? `表格 ${rows.length} 筆，和網頁上的 ${markers} 筆不一致` : null),
  },
  stats: {
    // "There are no listings" is the measured empty-search sentence; a sidebar followed by blank placeholder lines
    // is a list that has not loaded, not an empty one. The list names its own items, so its markers sit on the home
    // page and its no-anchor reason says so.
    parse: (text) => ({ rows: parseTradingTxt(text, { itemName: null }), parsed: null }),
    markers: markerCount,
    emptyText: EMPTY_TRADING,
    emptyReason: "沒有符合條件的掛單",
    noRows: () => NO_ROWS_REASON,
    noAnchor: (rows) => `讀到 ${rows.length} 筆，但首頁上看不到可以核對的筆數標記`,
    mismatch: fewerRows,
  },
};

/**
 * The rows of one view from its page text, with the page's own row-marker count and the parsed recent-trades answer.
 * @returns {{rows: object[], markers: number, parsed: object|null}}
 */
function parseView(reader, lines, text, itemName) {
  const { rows, parsed } = reader.parse(text, itemName);
  return { rows, markers: reader.markers(lines), parsed };
}

/**
 * Parses one view's page text into `result`: the login verdict first, then the row-count reconcile, else PASSED.
 */
async function readRows(reader, result, text, itemName, tab) {
  const lines = splitLines(text).map((line) => line.trim());
  const read = parseView(reader, lines, text, itemName);
  if (read.parsed?.code === "login_required" || read.parsed?.code === "login_or_no_data") {
    return fail(result, "login_required", read.parsed.reason, "BLOCKED");
  }
  const reconciled = reconcile(result, reader, read, lines);
  return reconciled ?? Object.assign(result, { status: "PASSED", rows: read.rows, has_more: await hasMore(tab) });
}

/** The row-count check: the finished result when the read is inconclusive, or null when the rows and the page agree. */
function reconcile(result, reader, { rows, markers, parsed }, lines) {
  if (!rows.length) {
    // "Nothing to list" is a real answer only when the page says so and has no row markers of its own.
    if (markers === 0 && lines.some((line) => line.toLowerCase() === reader.emptyText)) {
      return Object.assign(result, { status: "PASSED", reason: reader.emptyReason, reason_code: "empty", has_more: false });
    }
    return fail(result, "no_rows", reader.noRows(parsed));
  }
  if (markers === 0) return fail(result, "no_anchor", reader.noAnchor(rows));
  const mismatch = reader.mismatch(rows, markers);
  if (mismatch) return fail(result, "row_mismatch", mismatch);
  return null;
}

export async function readView(tab, itemName, viewName) {
  const { result, page } = await observePage(tab);
  if (!page) return result;
  const trading = viewName === "trading";
  const text = page.text;

  if (!productRootUrl(page.url) || productSection(page.url) !== VIEW_SECTIONS[viewName]) {
    return fail(result, "wrong_view", `Agent 停在的不是${trading ? "掛單" : "近期成交"}頁：${page.url}`);
  }
  if (!pageMatchesItem(itemName, page.title ?? "", text)) {
    return fail(result, "wrong_item", `頁面不是 ${itemName} 的商品頁`);
  }
  if (result.settled === false) return fail(result, "unsettled", UNSETTLED_REASON);

  const reader = VIEW_READERS[viewName];
  return readRows(reader, result, text, itemName, tab);
}

// The stats search reads the first page of the home page's listing list: every card names its own item, so there is
// no item to compare the page with; what is checked instead is that the address still carries the filters we sent.
async function readStatsOnce(tab, expectedUrl) {
  const { result, page } = await observePage(tab);
  result.url_kept = null;
  if (!page) return result;
  const text = page.text;

  if (!isHomeUrl(page.url)) return fail(result, "wrong_view", `停在的不是 Traderie 首頁：${page.url}`);
  result.url_kept = urlKeepsParams(page.url, expectedUrl);
  if (result.settled === false) return fail(result, "unsettled", UNSETTLED_REASON);

  const reader = VIEW_READERS.stats;
  return readRows(reader, result, text, null, tab);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Reads the list. The page text stops changing a moment before the cards, and the sidebar's "Active Filters", are
 * drawn, so a read that finds no cards (or fewer than the markers), or a list whose sidebar does not show `expectText`
 * yet (the labels of the filters we sent), is repeated a few times: reading changes nothing. Any other outcome is final,
 * and after the last try the result stands so the checks can say what is missing.
 */
export async function readStatsView(tab, expectedUrl, { attempts = 6, waitMs = 1500, expectText = [], session = null } = {}) {
  let result;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    result = await timed(session, "read_stats", () => readStatsOnce(tab, expectedUrl), (r) => ({
      attempt,
      status: r.status,
      reason_code: r.reason_code,
    }));
    const unfinished =
      ["no_rows", "row_mismatch", "no_anchor"].includes(result.reason_code) ||
      (result.status === "PASSED" && expectText.some((label) => !(result.text || "").includes(label)));
    if (!unfinished) break;
    if (attempt < attempts) await sleep(waitMs);
  }
  return result;
}

/** The verification object both checks return: what passed, what did not, and when it was measured. */
function verification({ checks, item_name = null, product_url = null, view_reasons = {} }) {
  const failed = Object.keys(checks).filter((name) => !checks[name]);
  return {
    passed: failed.length === 0,
    item_name,
    product_url,
    observed_at: new Date().toISOString(),
    checks,
    failed_checks: failed,
    view_reasons,
  };
}

/** The checks of a stats query: the page is the home page, it kept and shows the filters, and its list was read. */
export function verifyStats(market) {
  const trading = market.trading;
  const conditions = market.lookup?.conditions ?? [];
  const labels = numberConditionLabels(conditions);
  const missing = trading.status === "PASSED" ? rowsMissingConditions(trading.rows ?? [], conditions) : 0;
  const checks = {
    home_page: isHomeUrl(trading.url || ""),
    filters_in_url: trading.url_kept === true,
    filters_shown: labels.every((label) => (trading.text || "").includes(label)),
    rows_match_filters: missing === 0,
    trading_rows_ok: trading.status === "PASSED",
    not_blocked: trading.status !== "BLOCKED",
  };
  let tradingReason = trading.reason;
  if (!tradingReason && !checks.rows_match_filters) {
    tradingReason = `${missing} 筆掛單沒有你設定的條件，網站可能沒有套用篩選`;
  }
  return verification({ checks, view_reasons: tradingReason ? { trading: tradingReason } : {} });
}

export function verifyViews(itemName, market) {
  const trading = market.trading;
  const recent = market.recent_trades;
  const tradingUrl = trading.url || "";
  const recentUrl = recent.url || "";
  const tradingRoot = productRootUrl(tradingUrl);
  const recentRoot = productRootUrl(recentUrl);
  const checks = {
    product_page: recentRoot !== null,
    item_match: pageMatchesItem(itemName, recent.title || "", recent.text),
    same_product: tradingRoot !== null && tradingRoot === recentRoot,
    trading_view: tradingRoot !== null && productSection(tradingUrl) === null,
    recent_view: recentRoot !== null && productSection(recentUrl) === "recent",
    trading_rows_ok: trading.status === "PASSED",
    recent_rows_ok: recent.status === "PASSED",
    not_blocked: ![trading.status, recent.status].includes("BLOCKED"),
  };
  const viewReasons = {};
  for (const key of ["trading", "recent_trades"]) {
    if (market[key].reason) viewReasons[key] = market[key].reason;
  }
  return verification({ checks, item_name: itemName, product_url: recentRoot, view_reasons: viewReasons });
}

// Controller work that is due for the Agent's current state. Idempotent: safe to call before and after any command.
// `session` (optional) only receives timeline entries for the view reads.
export async function advance(agent, itemName, market, session = null) {
  const state = agent.state;
  const viewDetails = (view) => ({ status: view.status, settled: view.settled });
  if (state.awaiting_handoff) {
    market.trading = await timed(session, "read_trading", () => readView(agent.tab, itemName, "trading"), viewDetails);
    try {
      await agent.tab.evaluate("window.scrollTo(0, 0)"); // viewport only, so the tabs are in view for Phase B
    } catch (error) {
      if (!(error instanceof StalePage)) throw error; // cosmetic; the handoff must not be lost to it
    }
    await agent.command("handoff");
  } else if (state.status === "done" && market.recent_trades.status === "NOT_RUN") {
    market.recent_trades = await timed(
      session,
      "read_recent_trades",
      () => readView(agent.tab, itemName, "recent_trades"),
      viewDetails,
    );
    market.verification = verifyViews(itemName, market);
  } else if (state.status === "blocked" && market.verification == null) {
    market.verification = verifyViews(itemName, market);
  }
}

// One loop step: finish controller work left over from an earlier step, tick, then do the work the tick made due.
// The controller work also runs when the tick threw (the Agent may have reached DONE or a handoff first); the tick's
// error is the one that propagates.
export async function step(agent, itemName, market, session = null) {
  await advance(agent, itemName, market, session);
  let snapshot;
  try {
    snapshot = await agent.command("tick");
  } catch (error) {
    if (!(error instanceof AbortedError)) {
      try {
        await advance(agent, itemName, market, session);
      } catch {
        // the next step runs it again before anything else
      }
    }
    throw error;
  }
  await advance(agent, itemName, market, session);
  return snapshot;
}

export async function runAgent(
  agent,
  itemName,
  market,
  { shouldStop = () => false, onUpdate = () => {}, session = null } = {},
) {
  while (!["done", "blocked"].includes(agent.state.status) && !shouldStop()) {
    const snapshot = await step(agent, itemName, market, session);
    onUpdate(snapshot, market);
  }
}
