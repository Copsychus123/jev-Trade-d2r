import { csvFileName, toCsv } from "/csv.js";
const $ = (id) => document.getElementById(id);
const token = document.querySelector('meta[name="demo-token"]').content;
let state = null,
  busy = false,
  automatic = false;
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"]/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const percent = (value) => `${(value * 100).toFixed(value < 0.01 ? 1 : 0)}%`;
const statusDot = $("status-dot");
const dash = (value) =>
  value === null || value === undefined || value === "" ? "—" : String(value);
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
const formatUsd = (value) =>
  !(value > 0)
    ? "$0"
    : value >= 0.01
      ? `$${value.toFixed(2)}`
      : `$${value.toFixed(4)}（約 ${(value * 100).toFixed(2)} 美分）`;

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
      const cell = document.createElement("div");
      const name = document.createElement("span");
      const strong = document.createElement("strong");
      name.textContent = label;
      strong.textContent = value;
      cell.append(name, strong);
      return cell;
    }),
  );
  box.hidden = !usage;
}

function renderPlan() {
  const labels = state.phase_labels || [];
  $("plan").replaceChildren(
    ...labels.map((label, i) => {
      const step = document.createElement("div");
      const mark = document.createElement("span");
      step.className = `plan-step ${i === state.plan_index ? "current" : ""}`;
      mark.textContent = i < state.plan_index ? "✓" : String(i + 1);
      step.append(mark, document.createTextNode(label));
      return step;
    }),
  );
  // The plan entries share the goal and differ only in a final "Current phase" line: show the shared part once.
  $("goal-full").textContent = (state.plan || []).length ? state.plan[0].split("\nCurrent phase")[0] : "";
  $("goal-details").hidden = !(state.plan || []).length;
}

function renderDecisions(decisions, executedSteps, ruleEvents = []) {
  const log = $("decision-log");
  if (!decisions.length) {
    log.replaceChildren();
    return;
  }
  const phaseLabelOf = (phase) => (state.phase_labels || [])[["trading", "recent_trades"].indexOf(phase)] || phase;
  // A rule finished a phase without asking Jev: show it between the decisions around it.
  const ruleRow = (event) => {
    const row = document.createElement("div");
    row.className = "decision-row rule-row";
    row.textContent = event.press
      ? `規則：${event.label}（沒有呼叫 Jev）`
      : `規則：${event.label} 已按 ${event.count} 次，${phaseLabelOf(event.phase)}完成（沒有呼叫 Jev）`;
    return row;
  };
  const pending = [...ruleEvents];
  const rows = decisions.flatMap((d, i) => {
    const before = [];
    while (pending.length && pending[0].step <= d.step) before.push(ruleRow(pending.shift()));
    return [...before, (() => {
      const row = document.createElement("div");
      row.className = "decision-row";
      const next = decisions[i + 1];
      const executed = next ? next.step > d.step : executedSteps > d.step;
      const finishes = d.operation === "DONE" || d.operation === "BLOCKED";
      const alternatives = (d.alternatives || []).slice(0, 2);
      const phaseIndex = ["trading", "recent_trades"].indexOf(d.phase);
      const phaseLabel = (state.phase_labels || [])[phaseIndex];
      const what = finishes && d.operation === "DONE" ? phaseLabel || "完成階段" : d.label || d.choice;
      const chosen =
        d.probability == null
          ? null
          : d.target_probability != null
            ? `操作 ${percent(d.probability)} · 目標 ${percent(d.target_probability)}`
            : percent(d.probability);
      // Two answers within 15 percentage points of each other: the user may want to look closer.
      const close = d.probability != null && alternatives.length > 0 && d.probability - alternatives[0][1] < 0.15;
      const parts = [
        `第 ${i + 1} 次決策`,
        `${operationName(d.operation)} → ${what}`,
        chosen,
        ...alternatives.map(([name, p]) => `${operationName(name)} ${percent(p)}`),
        `輸入 ${formatNumber(d.usage?.input_tokens)} token`,
        `${((d.latency_ms || 0) / 1000).toFixed(1)} 秒`,
        finishes ? null : executed ? `已執行（第 ${d.step + 1} 步）` : "未執行：頁面已變動，重新決策",
        close ? "（接近）" : null,
        d.reasked
          ? `（原本選${operationName(d.reasked.operation)}，目標只有 ${percent(d.reasked.target_probability)}，已重問）`
          : null,
      ].filter(Boolean);
      row.textContent = parts.join(" · ");
      if (close) row.classList.add("close-call");
      if (!finishes && !executed) row.classList.add("skipped");
      return row;
    })()];
  });
  log.replaceChildren(...rows, ...pending.map(ruleRow));
}
const marketViews = {
  trading: {
    prefix: "trading",
    head: ["賣家", "要價", "高符文價值", "刊登時間", "平台 / 模式 / 天梯", "防禦"],
    cells: (r) => [
      r.seller,
      r.ask,
      r.high_rune_value,
      r.posted_time,
      [r.platform, r.mode, r.ladder].filter(Boolean).join(" / "),
      r.defense,
    ],
    label: "目前掛單",
    mergeInto: { from: 2, into: 1 },
  },
  recent_trades: {
    prefix: "recent-trades",
    head: ["成交物品", "成交價格", "成交時間"],
    cells: (r) => [r.buyer_or_seller, r.price, r.trade_time],
    label: "近期成交",
  },
};

for (const [key, config] of Object.entries(marketViews)) {
  $(`${config.prefix}-csv`).addEventListener("click", () => {
    const rows = state?.market?.[key]?.rows || [];
    if (!rows.length) return;
    // The same cells as the on-screen table, so the file cannot drift from what the user sees.
    const blob = new Blob([toCsv(config.head, rows.map(config.cells))], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = csvFileName(state.item_name, config.label);
    a.click();
    URL.revokeObjectURL(url);
  });
}

let activeTab = "run";
let userPickedTab = false;
let resultsSeen = false;
let resultsViewed = false;

function showTab(name, { user = false } = {}) {
  if (user) userPickedTab = true;
  activeTab = name;
  for (const tab of document.querySelectorAll('[role="tab"]')) {
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
  } else if (state?.page && !["done", "blocked"].includes(state.status)) {
    results += "（讀取中…）";
  }
  $("tab-results-label").textContent = results;
  $("tab-usage-label").textContent = state?.usage?.calls
    ? `用量與決策（${formatUsd(state.usage.cost_usd).split("（")[0]}）`
    : "用量與決策";
  // Switch to the answer once when the run finishes, unless the user already chose a tab.
  if (market.verification && !resultsSeen) {
    resultsSeen = true;
    if (!userPickedTab) showTab("results");
  }
  // The dot says "finished" until the results were opened once.
  if (resultsSeen && !resultsViewed) $("tab-results-dot").hidden = false;
}

for (const tab of document.querySelectorAll('[role="tab"]')) {
  tab.addEventListener("click", () => showTab(tab.dataset.tab, { user: true }));
  tab.addEventListener("keydown", (event) => {
    const tabs = [...document.querySelectorAll('[role="tab"]')];
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (!step) return;
    const next = tabs[(tabs.indexOf(tab) + step + tabs.length) % tabs.length];
    showTab(next.dataset.tab, { user: true });
    next.focus();
  });
}

// Page text is untrusted: every cell is written with textContent, never innerHTML.
function renderMarket(key) {
  const config = marketViews[key];
  const view = state?.market?.[key] || { status: "NOT_RUN", rows: [], text: "" };
  const p = config.prefix;
  const status = $(`${p}-status`);
  status.textContent = view.status;
  status.dataset.status = view.status;
  $(`${p}-csv`).disabled = !view.rows.length;
  const time = view.observed_at
    ? new Date(view.observed_at).toLocaleTimeString("zh-TW", { hour12: false })
    : "";
  $(`${p}-meta`).textContent =
    view.status === "NOT_RUN"
      ? "尚未讀取。"
      : view.status === "PASSED"
        ? `共 ${view.rows.length} 筆（${view.has_more ? "網站上還有更多，已達載入次數上限" : "已全部載入"}） · 讀取時間 ${time} · ${view.url}`
        : view.reason || "讀取失敗";
  const table = $(`${p}-table`);
  const stamp = `${view.status}|${view.observed_at}`;
  if (table.dataset.stamp === stamp) return;
  table.dataset.stamp = stamp;
  table.replaceChildren();
  if (!view.rows.length) {
    table.hidden = true;
  } else {
    table.hidden = false;
    const headRow = table.createTHead().insertRow();
    config.head.forEach((name, i) => {
      const th = document.createElement("th");
      th.textContent = name;
      if (i === config.mergeInto?.from) th.className = "col-merge";
      if (i === config.mergeInto?.into) {
        const suffix = document.createElement("span");
        suffix.className = "inline-head";
        suffix.textContent = ` / ${config.head[config.mergeInto.from]}`;
        th.append(suffix);
      }
      headRow.append(th);
    });
    const body = table.createTBody();
    for (const row of view.rows) {
      const tr = body.insertRow();
      const values = config.cells(row);
      values.forEach((cell, i) => {
        const td = tr.insertCell();
        td.textContent = dash(cell);
        if (i === config.mergeInto?.from) td.className = "col-merge";
      });
      if (config.mergeInto) {
        // Wide layout: the column is hidden and shown as small text under the target cell (CSS decides).
        const extra = document.createElement("small");
        extra.className = "inline-extra";
        extra.textContent = dash(values[config.mergeInto.from]);
        tr.cells[config.mergeInto.into].append(extra);
      }
    }
  }
  const raw = $(`${p}-raw`);
  raw.textContent = "";
  delete raw.dataset.loaded;
  if (raw.parentElement.open) loadRaw(key);
}

// The raw page text is not part of the state: fetch it only when its details block is open.
async function loadRaw(key) {
  const raw = $(`${marketViews[key].prefix}-raw`);
  if (raw.dataset.loaded || !state?.market?.[key]?.text_length) return;
  raw.dataset.loaded = "1";
  const response = await fetch("/api/raw?view=" + key);
  raw.textContent = response.ok ? await response.text() : "";
  if (!response.ok) delete raw.dataset.loaded;
}

for (const key of Object.keys(marketViews)) {
  $(`${marketViews[key].prefix}-raw`).parentElement.addEventListener("toggle", (event) => {
    if (event.target.open) loadRaw(key);
  });
}

// The report text is not part of the state: fetch it once when it becomes ready.
let reportText = null;
let reportFetching = false;

async function fetchReport() {
  reportFetching = true;
  try {
    const response = await fetch("/api/report");
    reportText = response.ok ? await response.text() : null;
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
    const failed = (verification.failed_checks || []).join("、");
    reasonEl.hidden = false;
    reasonEl.textContent = `檢查未通過：${[...reasons, failed].filter(Boolean).join("；")}`;
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

function controls() {
  const live = state?.page && !["done", "blocked"].includes(state.status);
  $("start").disabled = busy;
  if ($("goal")) $("goal").disabled = busy;
  $("load-more").disabled = busy;
  $("stop").hidden = !automatic;
  $("download").disabled = !state?.history?.length;
  $("report").disabled = busy || !state?.market?.verification?.passed;
}

async function runAutomaticLoop() {
  const live = state?.page && !["done", "blocked"].includes(state.status);
  if (!live) return;
  automatic = true;
  controls();
  for (let i = 0; i < state.max_steps * 2 && automatic; i++) {
    $("status").textContent = "正在執行探索…";
    await call("tick");
    if (["done", "blocked"].includes(state.status)) break;
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
      state = await fetch("/api/state").then((r) => r.json());
      render();
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

function render() {
  if (!state) return;
  renderPlan();
  renderUsage(state.usage);
  const page = state.page,
    d =
      state.decision ||
      (state.status === "done" ? state.decisions?.at(-1) : null);
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
  if (!busy) {
    const rawBlockedReason = state.scope_blocked_reason;
    if (state.status === "blocked" && rawBlockedReason) {
      $("status").textContent = `探索停止 · ${rawBlockedReason}`;
    } else {
      $("status").textContent = labels[state.status] || labels.idle;
    }
  }
  renderMarket("trading");
  renderMarket("recent_trades");
  renderReport();
  renderTabs();



  if (!page) {
    controls();
    return;
  }
  $("empty").hidden = true;
  if (page.screenshot_id) {
    $("screenshot").hidden = false;
    const src = `/api/screenshot?v=${page.screenshot_id}`;
    if ($("screenshot").getAttribute("src") !== src) $("screenshot").src = src;
  } else {
    $("screenshot").hidden = true;
  }
  $("url").textContent = page.url || "—";
  $("page-title").textContent = page.title || "—";
  const elements = Array.isArray(state.elements) ? [...state.elements] : [];
  $("action-count").textContent = `${elements.length} 個元素`;
  const pageActions = Array.isArray(page.actions) ? page.actions : [];
  const chosen = pageActions.find((a) => a.id === d?.choice);
  $("choice-title").textContent = d ? (chosen?.label || d.choice) : "請選擇動作";
  $("latency").textContent = d ? `${d.latency_ms} ms` : "—";
  $("ranking-details").hidden = !d?.target;
  $("ranking-note").textContent = d ? "由 Jev 完成排序" : "未排序";
  const op = Object.entries(d?.operation_probabilities || {}).sort((a,b)=>b[1]-a[1]);
  $("operation-choices").innerHTML = op.map(([name,p]) =>
    `<span class="operation-choice ${name === d.operation ? 'best' : ''}">${escape(name)} <b>${percent(p)}</b></span>`).join('');
  const probability = e => d?.target_probabilities?.[e.index] ??
    Math.max(-1, ...(e.options || []).map(o=>d?.target_probabilities?.[o.index] ?? -1));
  const selectedIndex = d?.target?.split(':')[0];
  if (d && elements.length) elements.sort((a,b)=>probability(b)-probability(a));
  $("choices").innerHTML = elements.length
    ? elements.map(e => {
        const p = d ? probability(e) : -1;
        return `<div class="choice ${selectedIndex === e.index ? 'best' : ''}" data-action="${escape(e.index)}"><span class="choice-id">[${escape(e.index)}]</span><div class="choice-label">${escape(e.label)}<small>${escape(e.role)}${e.value ? ' · '+escape(e.value) : ''}${e.checked !== undefined ? ' · checked '+escape(e.checked) : ''}</small>${p >= 0 ? `<div class="bar" style="--probability:${p*100}%"></div>` : ''}</div><span class="probability">${p >= 0 ? percent(p) : '—'}</span></div>`;
      }).join('')
    : '<p class="muted">可執行的動作將顯示於此。</p>';
  const targets = new Map();
  for (const a of pageActions) if (a.rect && !targets.has(a.node)) targets.set(a.node, a);
  const pw = page.w || 1;
  const ph = page.h || 1;
  $("targets").innerHTML = [...targets.values()].map((a,i) => {
    const index=String(i+1);
    return `<div class="target ${index === selectedIndex ? 'selected' : ''}" data-action="${index}" style="left:${100*a.rect.x/pw}%;top:${100*a.rect.y/ph}%;width:${100*a.rect.w/pw}%;height:${100*a.rect.h/ph}%"><span>${index}</span></div>`;
  }).join('');
  $("targets").hidden = !$("overlays").checked;
  const history = Array.isArray(state.history) ? state.history : [];
  $("history").innerHTML = history.length
    ? history
        .map(
          (h) =>
            `<div class="trace-row"><span class="number">${String(h.step).padStart(2, "0")}</span><div>${escape(h.action)}${h.text ? ` <b>“${escape(h.text)}”</b>` : ""}</div><span class="time">${h.latency_ms} ms · ${percent(h.probability)}</span><span class="effect">${h.page_changed ? "頁面已更新" : "頁面無變化"}</span></div>`,
        )
        .join("")
    : '<p class="muted">每次執行的動作都會留下觀察結果。</p>';
  const elapsedSec = typeof state.elapsed_ms === "number" ? (state.elapsed_ms / 1000).toFixed(2) : "0.00";
  $("step-count").textContent = `${history.length} 次動作 · ${elapsedSec} 秒`;
  renderDecisions(Array.isArray(state.decisions) ? state.decisions : [], history.length, state.rule_events || []);
  $("model-state").textContent = JSON.stringify(
    d?.request || {
      goal: state.goal,
      url: page.url,
      text: page.text,
      actions: pageActions.map(({ rect, node, ...rest }) => rest),
    },
    null,
    2,
  );
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
    await call("reset", { goal: $("goal").value, mode: "traderie", load_more: Number($("load-more").value) });
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

$("overlays").addEventListener("change", () => {
  $("targets").hidden = !$("overlays").checked;
});

$("choices").addEventListener("pointerover", (event) => {
  const id = event.target.closest("[data-action]")?.dataset.action;
  document
    .querySelectorAll(".target")
    .forEach((t) =>
      t.classList.toggle(
        "selected",
        t.dataset.action === id || t.dataset.action === state?.decision?.target?.split(":")[0],
      ),
    );
});

$("choices").addEventListener("pointerleave", () =>
  document
    .querySelectorAll(".target")
    .forEach((t) =>
      t.classList.toggle(
        "selected",
        t.dataset.action === state?.decision?.target?.split(":")[0],
      ),
    ),
);

$("download").addEventListener("click", () => {
  const { page, ...rest } = state;
  const blob = new Blob(
    [
      JSON.stringify(
        { ...rest, page: { ...page, screenshot: undefined } },
        null,
        2,
      ),
    ],
    { type: "application/json" },
  );
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "typesafe-browser-trace.json";
  a.click();
  URL.revokeObjectURL(url);
});

fetch("/api/state")
  .then((r) => r.json())
  .then((s) => {
    state = s;
    render();
  })
  .catch(() => {
    $("status").textContent = "無法連線至本機 Demo 伺服器";
  });

const downloadReportBtn = $("download-report");
if (downloadReportBtn) {
  downloadReportBtn.addEventListener("click", async () => {
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
      const blob = new Blob([markdownText], { type: "text/markdown; charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "traderie-market-report.md";
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert(`下載報告出錯: ${e.message}`);
    }
  });
}

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
