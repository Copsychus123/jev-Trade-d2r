import { chooseNext, pickBase, startRun } from "./api.js";
import { Agent } from "./agent.js";
import { API_BASE } from "./config.js";
import { Tab, loadPageScripts } from "./cdp.js";
import { csvFileName, toCsv } from "./csv.js";
import { PAGE_SIZE, clampPage, pageCount, pageRows } from "./paginate.js";
import { toTsv } from "./tsv.js";
import { ApiError } from "./errors.js";
import {
  RECENT_COLUMNS,
  TRADING_COLUMNS,
  VIEW_LABELS,
  newMarket,
  recentCells,
  tradingCells,
  verifyViews,
} from "./traderie/controller.js";
import { LAYER_LABELS, findAndRead } from "./traderie/finder.js";
import { indexTables, searchShowsItem } from "./traderie/lookup.js";
import { initOcrPanel } from "./ocr/panel.js";
import { TRADERIE_D2R_URL, detectGuard, phaseFinishRule, productRootUrl } from "./traderie/site.js";

const GUARD_HINT = `Traderie 要求驗證或登入。請自己在這個 Chrome 開 ${TRADERIE_D2R_URL} 處理完，再按開始。`;

/** Opens the page this table was read from, in a normal tab (the query window is already closed by then). */
function openSite(key) {
  const url = market[key].url;
  if (productRootUrl(url || "")) chrome.tabs.create({ url });
}
const $ = (id) => document.getElementById(id);
const dash = (value) => (value === null || value === undefined || value === "" ? "—" : String(value));

const marketViews = {
  trading: { prefix: "trading", head: TRADING_COLUMNS, cells: tradingCells, label: VIEW_LABELS.trading },
  recent_trades: {
    prefix: "recent-trades",
    head: RECENT_COLUMNS,
    cells: recentCells,
    label: VIEW_LABELS.recent_trades,
  },
};

const pages = { trading: 1, recent_trades: 1 };
let running = false;
let stopRequested = false;
let market = newMarket();
let itemName = "";
let agent = null;
let loggedSteps = 0;

function setStatus(text, kind = "") {
  const el = $("status");
  el.textContent = text;
  el.dataset.kind = kind;
}

// Page text is untrusted: every cell is written with textContent, never innerHTML.
function renderMarket(key) {
  const config = marketViews[key];
  const view = market[key];
  const p = config.prefix;
  const status = $(`${p}-status`);
  status.textContent = view.status;
  status.dataset.status = view.status;
  $(`${p}-csv`).disabled = !view.rows.length;
  $(`${p}-copy`).disabled = !view.rows.length;
  $(`${p}-open`).disabled = !productRootUrl(view.url || "");
  const time = view.observed_at ? new Date(view.observed_at).toLocaleTimeString("zh-TW", { hour12: false }) : "";
  $(`${p}-meta`).textContent =
    view.status === "NOT_RUN"
      ? "尚未讀取。"
      : view.status === "PASSED" && !view.rows.length
        ? `${view.reason} · 讀取時間 ${time} · ${view.url}`
        : view.status === "PASSED"
          ? `共 ${view.rows.length} 筆（${view.has_more ? "網站上還有更多，已達載入次數上限" : "已全部載入"}） · 讀取時間 ${time} · ${view.url}`
          : view.reason || "讀取失敗";
  const table = $(`${p}-table`);
  const page = clampPage(pages[key], view.rows.length);
  pages[key] = page;
  const pager = $(`${p}-pager`);
  pager.hidden = view.rows.length <= PAGE_SIZE;
  $(`${p}-page`).textContent = `第 ${page} / ${pageCount(view.rows.length)} 頁（共 ${view.rows.length} 筆）`;
  $(`${p}-prev`).disabled = page <= 1;
  $(`${p}-next`).disabled = page >= pageCount(view.rows.length);
  const stamp = `${view.status}|${view.observed_at}|${page}`;
  if (table.dataset.stamp === stamp) return;
  table.dataset.stamp = stamp;
  table.replaceChildren();
  if (!view.rows.length) {
    table.hidden = true;
    return;
  }
  table.hidden = false;
  const headRow = table.createTHead().insertRow();
  for (const name of config.head) {
    const th = document.createElement("th");
    th.textContent = name;
    headRow.append(th);
  }
  const body = table.createTBody();
  for (const row of pageRows(view.rows, page)) {
    const tr = body.insertRow();
    for (const cell of config.cells(row)) tr.insertCell().textContent = dash(cell);
  }
}

function renderVerification() {
  const v = market.verification;
  $("verification").textContent = !v
    ? "尚未檢查。"
    : v.passed
      ? "全部檢查通過。"
      : `未通過：${v.failed_checks.join("、")}`;
}

function renderLog() {
  const history = agent?.state.history ?? [];
  const log = $("log");
  for (; loggedSteps < history.length; loggedSteps++) {
    const h = history[loggedSteps];
    const li = document.createElement("li");
    li.textContent = `第 ${h.step} 步：${h.action}${h.by_rule ? "（規則）" : ""}`;
    log.append(li);
  }
  log.lastElementChild?.scrollIntoView({ block: "nearest" });
  const decisions = agent?.state.decisions ?? [];
  const calls = decisions.reduce((n, d) => n + (d.model_calls || 0), 0);
  const tokens = decisions.reduce((n, d) => n + (d.usage?.input_tokens || 0), 0);
  $("usage").textContent = `Jev 呼叫 ${calls} 次 · 輸入 ${tokens} token`;
}

function render() {
  renderMarket("trading");
  renderMarket("recent_trades");
  renderVerification();
  renderLookup();
  renderLog();
}

function setRunning(value) {
  running = value;
  for (const id of ["invite", "save-invite", "item", "load-more"]) $(id).disabled = value;
  $("start").disabled = value;
  $("stop").disabled = !value;
}

let tables = null;

async function loadTables() {
  if (!tables) {
    const response = await fetch(chrome.runtime.getURL("traderie/data/items.json"));
    tables = indexTables(await response.json());
  }
  return tables;
}

function renderLookup() {
  const lookup = market.lookup;
  $("lookup").textContent = lookup
    ? [lookup.layer ? `查詢方式：${LAYER_LABELS[lookup.layer]}` : "", ...lookup.notes].filter(Boolean).join("。")
    : "";
}

async function start() {
  if (running) return;
  const invite = $("invite").value.trim();
  const rawItem = $("item").value;
  const loadMore = Number($("load-more").value);
  setRunning(true);
  stopRequested = false;
  market = newMarket();
  agent = null;
  loggedSteps = 0;
  $("log").replaceChildren();
  $("quota").textContent = "";
  pages.trading = 1;
  pages.recent_trades = 1;
  document.querySelectorAll("table").forEach((t) => delete t.dataset.stamp);
  render();
  const session = { tab: null, agent: null, run: null, itemName: "" };
  try {
    setStatus("正在準備…");
    const scripts = await loadPageScripts();
    const outcome = await findAndRead({
      rawItem,
      tables: await loadTables(),
      loadMore,
      startRun: async (args) => {
        const run = await startRun(API_BASE, { invite, ...args });
        $("quota").textContent = `今日已用 ${run.used}/${run.limit} 次`;
        return run;
      },
      pickBase: (args) => pickBase(API_BASE, args),
      openTab: (url) => Tab.open(url, scripts),
      makeAgent: async (tab, run) => {
        loggedSteps = 0;
        agent = await Agent.create({
          tab,
          phases: ["trading", "recent_trades"],
          text: run.item_name,
          finishPhaseAfter: phaseFinishRule(run.load_more),
          choose: (page, phase, history, options = {}) =>
            chooseNext(API_BASE, { runToken: session.run.run_token, phase, page, history, noBlock: options.noBlock }),
          vetoBlocked: (page) => searchShowsItem(page, run.item_name),
        });
        return agent;
      },
      market,
      session,
      shouldStop: () => stopRequested,
      onStatus: (text) => {
        setStatus(text);
        renderLookup();
      },
      onUpdate: () => {
        setStatus(`查詢中：${agent.state.phase ?? ""}`);
        render();
      },
    });
    itemName = session.itemName;
    if (stopRequested) {
      setStatus("已停止");
    } else if (outcome === "guard") {
      setStatus(`受阻：防護頁/驗證碼。${GUARD_HINT}`, "error");
    } else if (outcome === "not_found") {
      setStatus("找不到這個裝備：查表、站內搜尋、底材清單都沒有符合的商品", "error");
    } else if (agent.state.status === "blocked") {
      const guard = await detectGuard(agent.state.page, session.tab).catch(() => null);
      setStatus(`受阻：${guard ? `${guard}。${GUARD_HINT}` : agent.state.scope_blocked_reason || "無法繼續"}`, "error");
    } else {
      market.verification = verifyViews(itemName, market);
      const v = market.verification;
      const blocked = [market.trading, market.recent_trades].some((view) => view.status === "BLOCKED");
      if (v.passed) setStatus("查詢完成，兩段資料都通過檢查", "ok");
      else setStatus(`查詢完成，但檢查未通過：${v.failed_checks.join("、")}${blocked ? `。${GUARD_HINT}` : ""}`, "error");
    }
  } catch (error) {
    const tab = session.tab;
    if (error instanceof ApiError) setStatus(error.message, "error");
    else if (tab?.detached && !stopRequested) {
      setStatus(`查詢視窗被關閉或偵錯被取消（原因 ${tab.detachReason || "未知"}；${error?.message || ""}），查詢已停止`, "error");
    } else setStatus(error?.message || String(error), "error");
  } finally {
    render();
    if (session.tab) await session.tab.close().catch(() => {});
    setRunning(false);
  }
}

function download(key) {
  const config = marketViews[key];
  const rows = market[key].rows;
  if (!rows.length) return;
  // The same cells as the on-screen table, so the file cannot drift from what the user sees.
  const blob = new Blob([toCsv(config.head, rows.map(config.cells))], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = csvFileName(itemName, config.label);
  a.click();
  URL.revokeObjectURL(url);
}

async function copy(key) {
  const config = marketViews[key];
  const rows = market[key].rows;
  if (!rows.length) return;
  const button = $(`${config.prefix}-copy`);
  try {
    // The same cells as the on-screen table; tab separated so a spreadsheet pastes it into columns.
    await navigator.clipboard.writeText(toTsv(config.head, rows.map(config.cells)));
    button.textContent = `已複製 ${rows.length} 筆`;
  } catch {
    button.textContent = "複製失敗";
  }
  setTimeout(() => {
    button.textContent = "複製";
  }, 1500);
}

async function init() {
  const saved = await chrome.storage.local.get("invite");
  if (saved.invite) $("invite").value = saved.invite;
  $("save-invite").addEventListener("click", async () => {
    await chrome.storage.local.set({ invite: $("invite").value.trim() });
    setStatus("邀請碼已儲存", "ok");
  });
  $("load-more").value = "0"; // the browser may restore an old form value; always start at the default
  $("start").addEventListener("click", start);
  initOcrPanel({
    tables: await loadTables(),
    isBusy: () => running,
    onPick: (name) => {
      if (running) return false; // never change the name under a query that is already running
      $("item").value = name; // the player reads it, then decides to press 開始查詢
      return true;
    },
  });
  $("stop").addEventListener("click", () => {
    stopRequested = true;
    setStatus("正在停止…");
  });
  for (const [key, config] of Object.entries(marketViews)) {
    $(`${config.prefix}-csv`).addEventListener("click", () => download(key));
    $(`${config.prefix}-copy`).addEventListener("click", () => copy(key));
    $(`${config.prefix}-open`).addEventListener("click", () => openSite(key));
    // Paging only changes what the table shows; copy and CSV always take every row.
    $(`${config.prefix}-prev`).addEventListener("click", () => {
      pages[key] -= 1;
      renderMarket(key);
    });
    $(`${config.prefix}-next`).addEventListener("click", () => {
      pages[key] += 1;
      renderMarket(key);
    });
  }
  render();
}

init();
