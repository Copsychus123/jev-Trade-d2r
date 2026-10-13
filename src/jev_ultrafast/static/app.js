import { csvFileName, toCsv } from "/csv.js";
const $ = (id) => document.getElementById(id);

/** A one-line `createElement`: a tag, an optional class and optional text. */
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// What a failed check means, in the player's words: the ids in `verification.failed_checks` are internal, and a
// non-technical player must not be shown "same_product" or "recent_rows_ok". The panel has the same list
// (`extension/src/labels.js` CHECK_REASONS) and `extension/test/check-reasons-parity.test.mjs` keeps the two in step.
const CHECK_REASONS = {
  product_page: "無法確認進到了商品頁面",
  item_match: "這頁面不像是你找的商品",
  same_product: "掛單和成交紀錄是不同商品的",
  trading_view: "掛單頁不是預期的頁面",
  recent_view: "沒有打開近期成交頁面",
  trading_rows_ok: "無法讀取掛單",
  recent_rows_ok: "無法讀取成交紀錄",
  not_blocked: "網站擋住了讀取（可能需要登入）",
  home_page: "沒有停在 Traderie 首頁",
  filters_in_url: "網站沒有保留你設定的條件",
  filters_shown: "頁面上看不到套用中的條件",
  rows_match_filters: "掛單上看不到你設定的條件，網站可能沒有套用篩選",
};

/** The sentences of the failed checks, each said once, in the order they failed. */
function explainChecks(ids) {
  const sentences = [];
  for (const id of ids || []) {
    const sentence = CHECK_REASONS[id] ?? "有一項檢查沒通過";
    if (!sentences.includes(sentence)) sentences.push(sentence);
  }
  return sentences;
}
const token = document.querySelector('meta[name="demo-token"]').content;
let state = null,
  busy = false,
  automatic = false;
// The run is over in these states: the automatic loop stops and the "live page" checks fail.
const STOPPED_STATUSES = ["done", "blocked"];
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"]/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
const percent = (value) => `${(value * 100).toFixed(value < 0.01 ? 1 : 0)}%`;
const statusDot = $("status-dot");
const dash = (value) =>
  value === null || value === undefined || value === "" ? "—" : String(value);
function saveText(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
const OPERATION_NAMES = {
  CLICK: "點擊",
  TYPE_TEXT: "輸入文字",
  SELECT: "選擇",
  SCROLL_DOWN: "往下捲",
  SCROLL_UP: "往上捲",
  SCROLL_BOTTOM: "捲到底",
  SCROLL_TOP: "捲到頂",
  WAIT: "等待",
  DONE: "完成階段",
  BLOCKED: "受阻",
};
const operationName = (name) => OPERATION_NAMES[name] || name;
const formatNumber = (value) => Number(value || 0).toLocaleString("en-US");
// The plain dollar amount, without the "約 … 美分" note for values below one cent.
const usdShort = (value) => (!(value > 0) ? "$0" : `$${value.toFixed(value >= 0.01 ? 2 : 4)}`);
const formatUsd = (value) =>
  usdShort(value) + (!(value > 0) || value >= 0.01 ? "" : `（約 ${(value * 100).toFixed(2)} 美分）`);

// Every cell is written with textContent: labels and page text are untrusted.
function renderUsage(usage) {
  const box = $("usage");
  const cells = usage
    ? [
        ["Jev 呼叫", `${formatNumber(usage.calls)} 次`],
        ["已執行步驟", `${formatNumber(usage.steps)} 步`],
        ["輸入 token", formatNumber(usage.input_tokens)],
        ["輸出 token", formatNumber(usage.output_tokens)],
        ["預估費用", formatUsd(usage.cost_usd)],
        ["Jev 耗時", `${usage.jev_seconds} 秒（平均 ${usage.avg_ms} ms）`],
      ]
    : [];
  box.replaceChildren(
    ...cells.map(([label, value]) => {
      const cell = element("div");
      cell.append(element("span", null, label), element("strong", null, value));
      return cell;
    }),
  );
  box.hidden = !usage;
}

function renderPlan() {
  const labels = state.phase_labels || [];
  $("plan").replaceChildren(
    ...labels.map((label, i) => {
      const step = element("div", `plan-step ${i === state.plan_index ? "current" : ""}`);
      const mark = element("span", null, i < state.plan_index ? "✓" : String(i + 1));
      step.append(mark, document.createTextNode(label));
      return step;
    }),
  );
  // The plan entries share the goal and differ only in a final "Current phase" line: show the shared part once.
  $("goal-full").textContent = (state.plan || []).length ? state.plan[0].split("\nCurrent phase")[0] : "";
  $("goal-details").hidden = !(state.plan || []).length;
}

// The phase's display label, `undefined` when the phase is unknown.
const phaseLabelAt = (phase) => (state.phase_labels || [])[["trading", "recent_trades"].indexOf(phase)];

function phaseLabelOf(phase) {
  return phaseLabelAt(phase) || phase;
}

// A rule finished a phase without asking Jev: show it between the decisions around it.
function ruleRow(event) {
  return element(
    "div",
    "decision-row rule-row",
    event.press
      ? `規則：${event.label}（沒有呼叫 Jev）`
      : `規則：${event.label} 已按 ${event.count} 次，${phaseLabelOf(event.phase)}完成（沒有呼叫 Jev）`,
  );
}

// One "第 N 次決策" line; `next` is the following decision, `executedSteps` how far the run got.
function decisionRow(decision, i, next, executedSteps) {
  const row = element("div", "decision-row");
  const executed = next ? next.step > decision.step : executedSteps > decision.step;
  const finishes = decision.operation === "DONE" || decision.operation === "BLOCKED";
  const alternatives = (decision.alternatives || []).slice(0, 2);
  const phaseLabel = phaseLabelAt(decision.phase);
  const what =
    finishes && decision.operation === "DONE" ? phaseLabel || "完成階段" : decision.label || decision.choice;
  const chosen =
    decision.probability == null
      ? null
      : decision.target_probability != null
        ? `操作 ${percent(decision.probability)} · 目標 ${percent(decision.target_probability)}`
        : percent(decision.probability);
  // Two answers within 15 percentage points of each other: the user may want to look closer.
  const close =
    decision.probability != null && alternatives.length > 0 && decision.probability - alternatives[0][1] < 0.15;
  const parts = [
    `第 ${i + 1} 次決策`,
    `${operationName(decision.operation)} → ${what}`,
    chosen,
    ...alternatives.map(([name, p]) => `${operationName(name)} ${percent(p)}`),
    `輸入 ${formatNumber(decision.usage?.input_tokens)} token`,
    `${((decision.latency_ms || 0) / 1000).toFixed(1)} 秒`,
    finishes ? null : executed ? `已執行（第 ${decision.step + 1} 步）` : "未執行：頁面已變動，重新決策",
    close ? "（接近）" : null,
    decision.reasked
      ? `（原本選${operationName(decision.reasked.operation)}，目標只有 ${percent(decision.reasked.target_probability)}，已重問）`
      : null,
  ].filter(Boolean);
  row.textContent = parts.join(" · ");
  if (close) row.classList.add("close-call");
  if (!finishes && !executed) row.classList.add("skipped");
  return row;
}

function renderDecisions(decisions, executedSteps, ruleEvents = []) {
  const log = $("decision-log");
  if (!decisions.length) {
    log.replaceChildren();
    return;
  }
  const pending = [...ruleEvents];
  const rows = decisions.flatMap((decision, i) => {
    const before = [];
    while (pending.length && pending[0].step <= decision.step) before.push(ruleRow(pending.shift()));
    return [...before, decisionRow(decision, i, decisions[i + 1], executedSteps)];
  });
  log.replaceChildren(...rows, ...pending.map(ruleRow));
}
// The three platform parts joined for a cell, empty parts dropped.
const platformText = (r) => [r.platform, r.mode, r.ladder].filter(Boolean).join(" / ");
const marketViews = {
  trading: {
    prefix: "trading",
    // The same columns (and the same cells, in the same order) as the panel's TRADING_COLUMNS/tradingCells: one run's
    // market.json must export the same CSV whichever UI the player used.
    head: ["賣家", "要價", "高符文價值", "刊登時間", "平台 / 模式 / 天梯", "防禦", "遊戲版本"],
    cells: (r) => [
      r.seller,
      r.ask,
      r.high_rune_value,
      r.posted_time,
      platformText(r),
      r.defense,
      r.game_version,
    ],
    label: "目前掛單",
    mergeInto: { from: 2, into: 1 },
  },
  recent_trades: {
    prefix: "recent-trades",
    head: ["成交物品", "成交價格", "成交時間", "平台 / 模式 / 天梯", "遊戲版本"],
    cells: (r) => [
      r.buyer_or_seller,
      r.price,
      r.trade_time,
      platformText(r),
      r.game_version,
    ],
    label: "近期成交",
  },
};

for (const [key, config] of Object.entries(marketViews)) {
  $(`${config.prefix}-csv`).addEventListener("click", () => {
    const rows = state?.market?.[key]?.rows || [];
    if (!rows.length) return;
    // The same cells as the on-screen table, so the file cannot drift from what the user sees.
    saveText(csvFileName(state.item_name, config.label), toCsv(config.head, rows.map(config.cells)), "text/csv;charset=utf-8");
  });
  // The raw page text is not part of the state: fetch it only when its details block is open.
  $(`${config.prefix}-raw`).parentElement.addEventListener("toggle", (event) => {
    if (event.target.open) loadRaw(key);
  });
}

let userPickedTab = false;
let resultsSeen = false;
let resultsViewed = false;

// The tab buttons, in document order: keyboard navigation wraps around this list.
const allTabs = () => [...document.querySelectorAll('[role="tab"]')];

function showTab(name, { user = false } = {}) {
  if (user) userPickedTab = true;
  for (const tab of allTabs()) {
    const on = tab.dataset.tab === name;
    tab.setAttribute("aria-selected", String(on));
    tab.tabIndex = on ? 0 : -1;
    $(`tab-${tab.dataset.tab}`).hidden = !on;
  }
  if (name === "results") {
    resultsViewed = true;
    $("tab-results-dot").hidden = true;
  }
}

function renderTabs() {
  const market = state?.market || {};
  const trading = market.trading || { status: "NOT_RUN", rows: [] };
  const recent = market.recent_trades || { status: "NOT_RUN", rows: [] };
  let results = "查詢結果";
  if ([trading, recent].some((v) => v.status === "FAILED" || v.status === "BLOCKED")) {
    results += "（失敗）";
  } else if (trading.status === "PASSED" && recent.status === "PASSED") {
    results += `（掛單 ${trading.rows.length}・成交 ${recent.rows.length}）`;
  } else if (trading.status === "PASSED") {
    results += `（掛單 ${trading.rows.length}・成交讀取中…）`;
  } else if (state?.page && !STOPPED_STATUSES.includes(state.status)) {
    results += "（讀取中…）";
  }
  $("tab-results-label").textContent = results;
  $("tab-usage-label").textContent = state?.usage?.calls
    ? `用量與決策（${usdShort(state.usage.cost_usd)}）`
    : "用量與決策";
  // Switch to the answer once when the run finishes, unless the user already chose a tab.
  if (market.verification && !resultsSeen) {
    resultsSeen = true;
    if (!userPickedTab) showTab("results");
  }
  // The dot says "finished" until the results were opened once.
  if (resultsSeen && !resultsViewed) $("tab-results-dot").hidden = false;
}

for (const tab of allTabs()) {
  tab.addEventListener("click", () => showTab(tab.dataset.tab, { user: true }));
  tab.addEventListener("keydown", (event) => {
    const tabs = allTabs();
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (!step) return;
    const next = tabs[(tabs.indexOf(tab) + step + tabs.length) % tabs.length];
    showTab(next.dataset.tab, { user: true });
    next.focus();
  });
}

// The line under a table: how many rows, how fresh, and where they came from.
function marketMetaText(view, time) {
  if (view.status === "NOT_RUN") return "尚未讀取。";
  if (view.status === "PASSED") {
    return `共 ${view.rows.length} 筆（${view.has_more ? "網站上還有更多，已達載入次數上限" : "已全部載入"}） · 讀取時間 ${time} · ${view.url}`;
  }
  return view.reason || "讀取失敗";
}

// Page text is untrusted: every cell is written with textContent, never innerHTML.
function fillMarketTable(table, view, config) {
  table.replaceChildren();
  if (!view.rows.length) {
    table.hidden = true;
    return;
  }
  table.hidden = false;
  fillMarketHead(table, config);
  fillMarketBody(table, view, config);
}

function fillMarketHead(table, config) {
  const headRow = table.createTHead().insertRow();
  config.head.forEach((name, i) => {
    const th = element("th", i === config.mergeInto?.from ? "col-merge" : null, name);
    if (i === config.mergeInto?.into) {
      th.append(element("span", "inline-head", ` / ${config.head[config.mergeInto.from]}`));
    }
    headRow.append(th);
  });
}

/** One row's cells; every cell is written with `textContent`, so page text can never become markup. */
function appendCells(tr, values, config) {
  values.forEach((cell, i) => {
    const td = tr.insertCell();
    td.textContent = dash(cell);
    if (i === config.mergeInto?.from) td.className = "col-merge";
  });
}

function fillMarketBody(table, view, config) {
  const body = table.createTBody();
  for (const row of view.rows) {
    const tr = body.insertRow();
    const values = config.cells(row);
    appendCells(tr, values, config);
    if (config.mergeInto) {
      // Wide layout: the column is hidden and shown as small text under the target cell (CSS decides).
      tr.cells[config.mergeInto.into].append(
        element("small", "inline-extra", dash(values[config.mergeInto.from])),
      );
    }
  }
}

function renderMarket(key) {
  const config = marketViews[key];
  const view = state?.market?.[key] || { status: "NOT_RUN", rows: [], text: "" };
  const prefix = config.prefix;
  const status = $(`${prefix}-status`);
  status.textContent = view.status;
  status.dataset.status = view.status;
  $(`${prefix}-csv`).disabled = !view.rows.length;
  const time = view.observed_at
    ? new Date(view.observed_at).toLocaleTimeString("zh-TW", { hour12: false })
    : "";
  $(`${prefix}-meta`).textContent = marketMetaText(view, time);
  const table = $(`${prefix}-table`);
  const stamp = `${view.status}|${view.observed_at}`;
  if (table.dataset.stamp === stamp) return;
  table.dataset.stamp = stamp;
  fillMarketTable(table, view, config);
  const raw = $(`${prefix}-raw`);
  raw.textContent = "";
  delete raw.dataset.loaded;
  if (raw.parentElement.open) loadRaw(key);
}

// Fetch a URL and return its text, or null when the server answered with an error.
async function fetchText(url) {
  const response = await fetch(url);
  return response.ok ? await response.text() : null;
}

// The raw page text is not part of the state: fetch it only when its details block is open.
async function loadRaw(key) {
  const raw = $(`${marketViews[key].prefix}-raw`);
  if (raw.dataset.loaded || !state?.market?.[key]?.text_length) return;
  raw.dataset.loaded = "1";
  const text = await fetchText("/api/raw?view=" + key);
  raw.textContent = text ?? "";
  if (text === null) delete raw.dataset.loaded;
}

// The report text is not part of the state: fetch it once when it becomes ready.
let reportText = null;
let reportFetching = false;

async function fetchReport() {
  reportFetching = true;
  try {
    reportText = await fetchText("/api/report");
  } finally {
    reportFetching = false;
  }
  renderReport();
}

function renderReport() {
  const section = $("report-section");
  if (!section) return;
  const reasonEl = $("release-check-reason");
  if (!state?.report_ready) reportText = null;
  else if (reportText === null && !reportFetching) fetchReport();
  const reportMd = reportText;
  const verification = state?.market?.verification;
  if (reportMd) {
    section.hidden = false;
    $("report-title").textContent = `${state.item_name} 市場資料`;
    $("report-content").textContent = reportMd;
    $("download-report").hidden = false;
    reasonEl.hidden = true;
    reasonEl.textContent = "";
  } else if (verification && !verification.passed) {
    section.hidden = false;
    $("report-title").textContent = "報告未產生";
    $("report-content").textContent = "";
    $("download-report").hidden = true;
    const reasons = Object.values(verification.view_reasons || {});
    reasonEl.hidden = false;
    reasonEl.textContent = `檢查未通過：${[...reasons, ...explainChecks(verification.failed_checks)].filter(Boolean).join("；")}`;
  } else {
    section.hidden = true;
    reasonEl.hidden = true;
    reasonEl.textContent = "";
  }
}

async function call(name, body = {}) {
  const response = await fetch(`/api/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Demo-Token": token },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || "Request failed");
  state = data;
  render();
  return data;
}

// Re-read the current state from the server and show it (the page's only source of truth).
async function refreshState() {
  state = await fetch("/api/state").then((r) => r.json());
  render();
}

function controls() {
  $("start").disabled = busy;
  if ($("goal")) $("goal").disabled = busy;
  $("load-more").disabled = busy;
  $("stop").hidden = !automatic;
  $("download").disabled = !state?.history?.length;
  $("report").disabled = busy || !state?.market?.verification?.passed;
}

async function runAutomaticLoop() {
  const live = state?.page && !STOPPED_STATUSES.includes(state.status);
  if (!live) return;
  automatic = true;
  controls();
  for (let i = 0; i < state.max_steps * 2 && automatic; i++) {
    $("status").textContent = "正在執行探索…";
    await call("tick");
    if (STOPPED_STATUSES.includes(state.status)) break;
  }
  automatic = false;
}

async function perform(fn, label) {
  if (busy) return;
  busy = true;
  $("error").hidden = true;
  controls();
  $("status").textContent = label;
  try {
    await fn();
  } catch (error) {
    automatic = false;
    try {
      await refreshState();
    } catch {
      /* Preserve the original failure if the server disconnected. */
    }
    $("error").textContent = error.message;
    $("error").hidden = false;
    $("status").textContent = "已暫停 · 需要注意";
  } finally {
    busy = false;
    if (state && $("error").hidden) render(); // the status text is only written while idle; keep a failure message
    controls();
  }
}

// Status dot and status line. While busy the status text belongs to perform/runAutomaticLoop.
function renderStatus() {
  const labels = {
    idle: "準備開始探索",
    ready: "頁面已載入 · 等候決策",
    predicted: "動作已選定 · 可檢視或執行",
    done: state.market?.verification?.passed
      ? "兩段資料已讀取並通過檢查 · 可按「產生報告」"
      : "Agent 已完成 · 檢查未通過",
    blocked: "探索已停止 · 無可用的下一步",
  };
  statusDot.dataset.state = state.status || "idle";
  if (busy) return;
  const rawBlockedReason = state.scope_blocked_reason;
  if (state.status === "blocked" && rawBlockedReason) {
    $("status").textContent = `探索停止 · ${rawBlockedReason}`;
  } else {
    $("status").textContent = labels[state.status] || labels.idle;
  }
}

function renderPageHeader(page) {
  if (page.screenshot_id) {
    $("screenshot").hidden = false;
    const src = `/api/screenshot?v=${page.screenshot_id}`;
    if ($("screenshot").getAttribute("src") !== src) $("screenshot").src = src;
  } else {
    $("screenshot").hidden = true;
  }
  $("url").textContent = page.url || "—";
  $("page-title").textContent = page.title || "—";
}

// The chosen action, its latency and the ranked operation probabilities.
function renderActionSummary(decision, elements, pageActions) {
  $("action-count").textContent = `${elements.length} 個元素`;
  const chosen = pageActions.find((a) => a.id === decision?.choice);
  $("choice-title").textContent = decision ? chosen?.label || decision.choice : "請選擇動作";
  $("latency").textContent = decision ? `${decision.latency_ms} ms` : "—";
  $("ranking-details").hidden = !decision?.target;
  $("ranking-note").textContent = decision ? "由 Jev 完成排序" : "未排序";
  const op = Object.entries(decision?.operation_probabilities || {}).sort((a, b) => b[1] - a[1]);
  $("operation-choices").innerHTML = op
    .map(
      ([name, p]) =>
        `<span class="operation-choice ${name === decision.operation ? "best" : ""}">${escape(name)} <b>${percent(p)}</b></span>`,
    )
    .join("");
}

function targetProbability(decision, e) {
  return (
    decision?.target_probabilities?.[e.index] ??
    Math.max(-1, ...(e.options || []).map((o) => decision?.target_probabilities?.[o.index] ?? -1))
  );
}

// The decision's selected target index, as the string the element list and overlays compare with.
const selectedTarget = (decision) => decision?.target?.split(":")[0];

/** One element of the choice list, as markup; page-derived strings always go through `escape`. */
function choiceRow(entry, decision, selectedIndex) {
  const p = decision ? targetProbability(decision, entry) : -1;
  const value = entry.value ? " · " + escape(entry.value) : "";
  const checked = entry.checked !== undefined ? " · checked " + escape(entry.checked) : "";
  const bar = p >= 0 ? `<div class="bar" style="--probability:${p * 100}%"></div>` : "";
  return `<div class="choice ${selectedIndex === entry.index ? "best" : ""}" data-action="${escape(entry.index)}"><span class="choice-id">[${escape(entry.index)}]</span><div class="choice-label">${escape(entry.label)}<small>${escape(entry.role)}${value}${checked}</small>${bar}</div><span class="probability">${p >= 0 ? percent(p) : "—"}</span></div>`;
}

// The element list, best target first; returns the decision's selected target index for the overlay.
function renderChoices(elements, decision) {
  const selectedIndex = selectedTarget(decision);
  if (decision && elements.length) {
    elements.sort((a, b) => targetProbability(decision, b) - targetProbability(decision, a));
  }
  $("choices").innerHTML = elements.length
    ? elements.map((entry) => choiceRow(entry, decision, selectedIndex)).join("")
    : '<p class="muted">可執行的動作將顯示於此。</p>';
  return selectedIndex;
}

/** The overlay box for one clickable element, positioned as a share of the page so it scales with the screenshot. */
function targetBox(action, index, selectedIndex, pw, ph) {
  const { x, y, w, h } = action.rect;
  return `<div class="target ${index === selectedIndex ? "selected" : ""}" data-action="${escape(index)}" style="left:${(100 * x) / pw}%;top:${(100 * y) / ph}%;width:${(100 * w) / pw}%;height:${(100 * h) / ph}%"><span>${escape(index)}</span></div>`;
}

/** The boxes are only readable with the labels on: keep the checkbox and the overlay in step. */
function syncTargetsVisibility() {
  $("targets").hidden = !$("overlays").checked;
}

// Overlay boxes for the clickable elements; each is labelled with the element index the choice list shows, and the
// decision's selected target is marked. A node `action_space` left out (a same-name repeat it skipped) has no index
// and gets no box, so the overlay never shows a number the choice list does not have.
function renderTargets(pageActions, page, selectedIndex) {
  const indices = page.node_indices || {};
  const seen = new Set();
  const pw = page.w || 1;
  const ph = page.h || 1;
  const boxes = [];
  for (const action of pageActions) {
    const index = indices[action.node];
    if (!action.rect || index === undefined || seen.has(action.node)) continue;
    seen.add(action.node);
    boxes.push(targetBox(action, index, selectedIndex, pw, ph));
  }
  $("targets").innerHTML = boxes.join("");
  syncTargetsVisibility();
}

/** One executed action, as markup. */
function traceRow(entry) {
  return `<div class="trace-row"><span class="number">${String(entry.step).padStart(2, "0")}</span><div>${escape(entry.action)}${entry.text ? ` <b>“${escape(entry.text)}”</b>` : ""}</div><span class="time">${entry.latency_ms} ms · ${percent(entry.probability)}</span><span class="effect">${entry.page_changed ? "頁面已更新" : "頁面無變化"}</span></div>`;
}

// Returns how many actions ran, which the decision log needs.
function renderHistory() {
  const history = Array.isArray(state.history) ? state.history : [];
  $("history").innerHTML = history.length
    ? history.map(traceRow).join("")
    : '<p class="muted">每次執行的動作都會留下觀察結果。</p>';
  const elapsedSec = typeof state.elapsed_ms === "number" ? (state.elapsed_ms / 1000).toFixed(2) : "0.00";
  $("step-count").textContent = `${history.length} 次動作 · ${elapsedSec} 秒`;
  return history.length;
}

function renderModelRequest(decision, page, pageActions) {
  $("model-state").textContent = JSON.stringify(
    decision?.request || {
      goal: state.goal,
      url: page.url,
      text: page.text,
      actions: pageActions.map(({ rect, node, ...rest }) => rest),
    },
    null,
    2,
  );
}

function render() {
  if (!state) return;
  renderPlan();
  renderUsage(state.usage);
  const page = state.page;
  const decision = state.decision || (state.status === "done" ? state.decisions?.at(-1) : null);
  renderStatus();
  renderMarket("trading");
  renderMarket("recent_trades");
  renderReport();
  renderTabs();

  if (!page) {
    controls();
    return;
  }
  $("empty").hidden = true;
  renderPageHeader(page);
  const elements = Array.isArray(state.elements) ? [...state.elements] : [];
  const pageActions = Array.isArray(page.actions) ? page.actions : [];
  renderActionSummary(decision, elements, pageActions);
  const selectedIndex = renderChoices(elements, decision);
  renderTargets(pageActions, page, selectedIndex);
  const stepCount = renderHistory();
  renderDecisions(Array.isArray(state.decisions) ? state.decisions : [], stepCount, state.rule_events || []);
  renderModelRequest(decision, page, pageActions);
  controls();
}
$("task-form").addEventListener("submit", (event) => {
  userPickedTab = false;
  resultsSeen = false;
  resultsViewed = false;
  showTab("run");
  event.preventDefault();
  automatic = false;
  perform(async () => {
    await call("reset", { goal: $("goal").value, load_more: Number($("load-more").value) });
    await runAutomaticLoop();
  }, "正在開啟全新瀏覽器…");
});

$("report").addEventListener("click", () =>
  perform(() => call("report"), "正在儲存報告…"),
);

$("stop").addEventListener("click", () => {
  automatic = false;
  $("status").textContent = "正在暫停…";
  controls();
});

$("overlays").addEventListener("change", syncTargetsVisibility);

// Mark the hovered choice (if any) and the target the decision picked.
function highlightTargets(hovered) {
  const selected = selectedTarget(state?.decision);
  document
    .querySelectorAll(".target")
    .forEach((t) =>
      t.classList.toggle("selected", t.dataset.action === hovered || t.dataset.action === selected),
    );
}

$("choices").addEventListener("pointerover", (event) =>
  highlightTargets(event.target.closest("[data-action]")?.dataset.action),
);

$("choices").addEventListener("pointerleave", () => highlightTargets());

// Save the whole run as JSON, without the screenshot bytes.
function downloadTrace() {
  const { page, ...rest } = state;
  saveText(
    "typesafe-browser-trace.json",
    JSON.stringify({ ...rest, page: { ...page, screenshot: undefined } }, null, 2),
    "application/json",
  );
}

$("download").addEventListener("click", downloadTrace);

refreshState().catch(() => {
  $("status").textContent = "無法連線至本機 Demo 伺服器";
});

// Save the markdown the server generated for a finished run.
async function downloadReportFile() {
  try {
    const res = await fetch("/api/report");
    if (!res.ok) {
      let errText = "無法下載報告";
      try {
        const errJson = await res.json();
        if (errJson?.error) errText = errJson.error;
      } catch {
        /* ignore json parse error */
      }
      alert(`下載報告失敗: ${errText}`);
      return;
    }
    const markdownText = await res.text();
    saveText("traderie-market-report.md", markdownText, "text/markdown; charset=utf-8");
  } catch (e) {
    alert(`下載報告出錯: ${e.message}`);
  }
}

$("download-report").addEventListener("click", downloadReportFile);

// Rough estimate shown next to the selector. Measured with real runs: each view loads 50 listings / 20 trades per page,
// a full query takes about 19 s + 7.7 s per press, about 18.6k + 11.9k tokens per press (US$0.042 per million input).
function renderLoadMoreEstimate() {
  const n = Number($("load-more").value);
  const seconds = Math.round(19 + 7.7 * n);
  const dollars = ((18600 + 11900 * n) * 0.042) / 1e6;
  $("load-more-estimate").textContent =
    `預估：約 ${50 * (n + 1)} 筆掛單、${20 * (n + 1)} 筆成交、約 ${seconds} 秒、約 $${dollars.toFixed(4)}`;
}
$("load-more").addEventListener("change", renderLoadMoreEstimate);
renderLoadMoreEstimate();
