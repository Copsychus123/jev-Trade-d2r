// Port of the reading/verification half of core/jev_ultrafast/traderie/controller.py.
import { TimeoutError } from "../errors.js";
import { parseRecentTrades, parseTradingTxt } from "./parsing.js";
import { detectGuard, productRootUrl } from "./site.js";

export const TRADING_COLUMNS = ["賣家", "要價", "高符文價值", "刊登時間", "平台 / 模式 / 天梯", "防禦"];
export const RECENT_COLUMNS = ["成交物品", "成交價格", "成交時間"];
export const VIEW_LABELS = { trading: "目前掛單", recent_trades: "近期成交" };

const LOAD_MORE_PROBE =
  "[...document.querySelectorAll('button,a,[role=button]')].some(e => /^\\s*load more\\s*$/i.test(e.innerText || ''))";

const EMPTY_TRADING = "there are no listings";
const EMPTY_RECENT = "there are no offers";

const isRecentUrl = (url) => url.split("?", 1)[0].replace(/\/+$/u, "").endsWith("/recent");

function view(status, reason = null) {
  return { status, reason, url: null, title: null, observed_at: null, rows: [], has_more: false, text: "" };
}

export function newMarket() {
  return { trading: view("NOT_RUN"), recent_trades: view("NOT_RUN"), verification: null, lookup: null };
}

const NON_WORD = /[^a-z0-9]+/gu;
const slug = (text) => text.toLowerCase().replace(NON_WORD, " ").trim();

function matchesItem(itemName, text) {
  const expected = slug(itemName);
  const actual = slug(text);
  return Boolean(expected && actual && (expected.includes(actual) || actual.includes(expected)));
}

async function hasMore(tab) {
  try {
    return Boolean(await tab.evaluate(LOAD_MORE_PROBE));
  } catch {
    return false;
  }
}

export function tradingCells(row) {
  const env = ["platform", "mode", "ladder"].filter((k) => row[k]).map((k) => String(row[k])).join(" / ");
  return [row.seller ?? null, row.ask ?? null, row.high_rune_value ?? null, row.posted_time ?? null, env,
    row.defense ?? null];
}

export function recentCells(row) {
  return [row.buyer_or_seller ?? null, row.price ?? null, row.trade_time ?? null];
}

export async function readView(tab, itemName, viewName) {
  const result = view("FAILED");
  result.observed_at = new Date().toISOString();
  const trading = viewName === "trading";
  let page;
  try {
    page = await tab.readSettledPage(500, 5000);
  } catch (error) {
    if (!(error instanceof TimeoutError)) throw error;
    result.reason = "頁面一直沒有載入完成";
    return result;
  }
  const text = page.text;
  Object.assign(result, { url: page.url, title: page.title ?? "", text });

  const guard = await detectGuard(page, tab);
  if (guard) {
    return Object.assign(result, { status: "BLOCKED", reason: `網站阻擋：${guard}` });
  }

  const onRecent = isRecentUrl(page.url);
  if (!productRootUrl(page.url) || onRecent === trading) {
    result.reason = `Agent 停在的不是${trading ? "掛單" : "近期成交"}頁：${page.url}`;
    return result;
  }
  if (!(matchesItem(itemName, page.title ?? "") || matchesItem(itemName, text))) {
    result.reason = `頁面不是 ${itemName} 的商品頁`;
    return result;
  }

  const lines = text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/u).map((line) => line.trim());
  let rows;
  if (trading) {
    rows = parseTradingTxt(text, { itemName });
    const expected = lines.filter((line) => line === "Trading For").length;
    if (!rows.length) {
      // The page itself says the market is empty: a real answer, not a reading failure.
      if (lines.some((line) => line.toLowerCase() === EMPTY_TRADING)) {
        return Object.assign(result, { status: "PASSED", rows: [], reason: "目前沒有掛單" });
      }
      result.reason = "頁面上沒有讀到任何掛單";
      return result;
    }
    if (rows.length < expected) {
      result.reason = `表格 ${rows.length} 筆，少於網頁上的 ${expected} 筆`;
      return result;
    }
  } else {
    const parsed = parseRecentTrades(text);
    if (parsed.blocked && !parsed.reason.includes("登入") && lines.some((line) => line.toLowerCase() === EMPTY_RECENT)) {
      return Object.assign(result, { status: "PASSED", rows: [], reason: "目前沒有成交紀錄" });
    }
    if (parsed.blocked) {
      return Object.assign(result, {
        status: parsed.reason.includes("登入") ? "BLOCKED" : "FAILED",
        reason: parsed.reason,
      });
    }
    rows = parsed.trades;
    const expected = lines.filter((line) => line.toLowerCase() === "they give").length;
    if (rows.length !== expected) {
      result.reason = `表格 ${rows.length} 筆，和網頁上的 ${expected} 筆不一致`;
      return result;
    }
  }
  return Object.assign(result, { status: "PASSED", rows, has_more: await hasMore(tab) });
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
    item_match: matchesItem(itemName, recent.title || "") || matchesItem(itemName, recent.text),
    same_product: tradingRoot !== null && tradingRoot === recentRoot,
    trading_view: tradingRoot !== null && !isRecentUrl(tradingUrl),
    recent_view: isRecentUrl(recentUrl),
    trading_rows_ok: trading.status === "PASSED",
    recent_rows_ok: recent.status === "PASSED",
    not_blocked: ![trading.status, recent.status].includes("BLOCKED"),
  };
  const failed = Object.keys(checks).filter((name) => !checks[name]);
  const viewReasons = {};
  for (const key of ["trading", "recent_trades"]) {
    if (market[key].reason) viewReasons[key] = market[key].reason;
  }
  return {
    passed: failed.length === 0,
    item_name: itemName,
    product_url: recentRoot,
    observed_at: new Date().toISOString(),
    checks,
    failed_checks: failed,
    view_reasons: viewReasons,
  };
}

export async function advance(agent, itemName, market) {
  const state = agent.state;
  if (state.awaiting_handoff) {
    market.trading = await readView(agent.tab, itemName, "trading");
    await agent.tab.evaluate("window.scrollTo(0, 0)"); // viewport only, so the tabs are in view for Phase B
    await agent.command("handoff");
  } else if (state.status === "done" && market.recent_trades.status === "NOT_RUN") {
    market.recent_trades = await readView(agent.tab, itemName, "recent_trades");
    market.verification = verifyViews(itemName, market);
  }
}

export async function runAgent(agent, itemName, market, { shouldStop = () => false, onUpdate = () => {} } = {}) {
  while (!["done", "blocked"].includes(agent.state.status) && !shouldStop()) {
    const snapshot = await agent.command("tick");
    await advance(agent, itemName, market);
    onUpdate(snapshot, market);
  }
}
