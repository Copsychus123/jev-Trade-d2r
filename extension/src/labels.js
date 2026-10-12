// Pure-logic module: turns internal codes into plain Traditional Chinese labels.
// No DOM, no chrome.* APIs. Suitable for testing with node --test.

export const LAYER_LABELS = { table: "查表直接開啟", search: "站內搜尋", base: "底材清單" };

export const STATUS_LABELS = {
  NOT_RUN: "未讀取",
  PASSED: "已讀取",
  FAILED: "讀取失敗",
  BLOCKED: "被網站擋住",
};

export function statusLabel(status) {
  return STATUS_LABELS[status] ?? STATUS_LABELS.NOT_RUN;
}

export const CHECK_REASONS = {
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


/**
 * The one-sentence conclusion for a batch of listings, from `priceSummary` (traderie/price-summary.js): what the
 * High Rune Values of the read rows are, so the player does not have to read the table to know what to ask.
 * "" when there is nothing priced at all.
 */
export function priceSummaryLine(summary) {
  if (!summary || !summary.priced) return "";
  const parts = [`價格（High Rune Value）：最低 ${summary.min}、中位數 ${summary.median}`];
  if (summary.q1 !== null && summary.q3 !== null) parts.push(`四分位 ${summary.q1}–${summary.q3}`);
  const counts = `共 ${summary.count} 筆`;
  const left = summary.unpriced ? `，${summary.unpriced} 筆沒有標價` : "";
  return `${parts.join("、")}（${counts}${left}）`;
}

const SOURCE_LABELS = { scan: "掃描紀錄", picture: "截圖" };

/**
 * Where this query's input came from, for the results screen: 「來源：掃描紀錄 12:34 · 防禦、打擊恢復」. "" when the
 * player typed everything by hand (`source` null or of an unknown kind). The caller passes the time already formatted,
 * because formatting a clock needs the DOM module and that one imports this one.
 */
export function sourceLine(source) {
  const label = source ? SOURCE_LABELS[source.kind] : "";
  if (!label) return "";
  const head = `來源：${[label, source.time].filter(Boolean).join(" ")}`;
  return source.affixes ? `${head} · ${source.affixes}` : head;
}

export function explainFailedChecks(ids) {
  const sentences = [];
  const seen = new Set();
  for (const id of ids) {
    const sentence = CHECK_REASONS[id] ?? "有一項檢查沒通過";
    if (!seen.has(sentence)) {
      sentences.push(sentence);
      seen.add(sentence);
    }
  }
  return sentences;
}

export function verificationSummary(verification) {
  if (!verification) {
    return { kind: "none", headline: "尚未核對", reasons: [] };
  }
  if (verification.passed) {
    return { kind: "ok", headline: "資料已核對", reasons: [] };
  }
  return {
    kind: "warn",
    headline: "部分資料沒通過核對",
    reasons: explainFailedChecks(verification.failed_checks),
  };
}

const ENDED = ["FAILED", "BLOCKED"];

const step = (key, label) => ({ key, label, state: "pending", detail: "" });

/** A view's step: done when read, failed (with the reason) when the read ended badly, else active when `active`. */
function viewStep(entry, view, active) {
  if (view.status === "PASSED") entry.state = "done";
  else if (ENDED.includes(view.status)) {
    entry.state = "failed";
    entry.detail = view.reason || "";
  } else if (active) entry.state = "active";
}

/** The verify step: done when the verification passed, failed when it did not, active while the check is still to come. */
function verifyStep(entry, verification, active) {
  if (verification) entry.state = verification.passed ? "done" : "failed";
  else if (active) entry.state = "active";
}

// The steps of a stats query (home page filters): the stage the flow reached is kept in market.lookup.stage.
function statsProgressSteps({ market, running }) {
  const lookup = market.lookup;
  const stage = lookup?.stage ?? (running ? "properties" : null);
  const view = market.trading;
  const read = view.status !== "NOT_RUN";
  const steps = [
    step("properties", "取得屬性清單"),
    step("apply", "套用條件"),
    step("trading", "讀取掛單"),
    step("verify", "核對資料"),
  ];
  if (stage === "properties") steps[0].state = running ? "active" : "pending";
  if (stage === "apply" || stage === "read" || read) steps[0].state = "done";
  if (stage === "apply") {
    if (lookup?.unmapped?.length) steps[1].state = "failed";
    else steps[1].state = running ? "active" : "pending";
  }
  if (lookup?.unmapped?.length) steps[1].detail = "有條件 Traderie 沒有對應的屬性";
  if (stage === "read" || read) steps[1].state = "done";
  viewStep(steps[2], view, running && stage === "read");
  verifyStep(steps[3], market.verification, running && read);
  return steps;
}

export function progressSteps({ market, phase, running }) {
  if (market.mode === "stats") return statsProgressSteps({ market, running });
  const steps = [
    step("find", "找到商品"),
    step("trading", "讀取目前掛單"),
    step("recent_trades", "讀取近期成交"),
    step("verify", "核對資料"),
  ];
  const [find, trading, recent, verify] = steps;
  const { trading: tradingView, recent_trades: recentView, verification } = market;
  const layer = market.lookup?.layer;
  const findDone =
    layer != null || phase != null || tradingView.status !== "NOT_RUN" || recentView.status !== "NOT_RUN";
  if (findDone) {
    find.state = "done";
    if (layer != null) find.detail = LAYER_LABELS[layer] || "";
  } else if (running) {
    find.state = "active";
  }
  viewStep(trading, tradingView, running && (phase === "trading" || (findDone && phase == null)));
  viewStep(recent, recentView, running && phase === "recent_trades");
  const read = (view) => view.status === "PASSED" || ENDED.includes(view.status);
  verifyStep(verify, verification, running && read(tradingView) && read(recentView));
  return steps;
}
