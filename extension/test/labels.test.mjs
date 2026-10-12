import assert from "node:assert/strict";
import test from "node:test";

import {
  CHECK_REASONS,
  STATUS_LABELS,
  explainFailedChecks,
  priceSummaryLine,
  progressSteps,
  sourceLine,
  statusLabel,
  verificationSummary,
} from "../src/labels.js";

// The market shape every name-query progress test starts from; a test overrides only what it is about.
const nameMarket = (overrides = {}) => ({
  trading: { status: "NOT_RUN", reason: null },
  recent_trades: { status: "NOT_RUN", reason: null },
  verification: null,
  lookup: null,
  ...overrides,
});

test("STATUS_LABELS exports all four constants", () => {
  assert.equal(STATUS_LABELS.NOT_RUN, "未讀取");
  assert.equal(STATUS_LABELS.PASSED, "已讀取");
  assert.equal(STATUS_LABELS.FAILED, "讀取失敗");
  assert.equal(STATUS_LABELS.BLOCKED, "被網站擋住");
});

test("statusLabel returns correct label for known statuses", () => {
  assert.equal(statusLabel("NOT_RUN"), "未讀取");
  assert.equal(statusLabel("PASSED"), "已讀取");
  assert.equal(statusLabel("FAILED"), "讀取失敗");
  assert.equal(statusLabel("BLOCKED"), "被網站擋住");
});

test("statusLabel returns NOT_RUN label for unknown status", () => {
  assert.equal(statusLabel("UNKNOWN"), "未讀取");
  assert.equal(statusLabel(null), "未讀取");
  assert.equal(statusLabel(undefined), "未讀取");
});

test("CHECK_REASONS maps all 8 check ids to non-empty sentences", () => {
  const ids = ["product_page", "item_match", "same_product", "trading_view",
    "recent_view", "trading_rows_ok", "recent_rows_ok", "not_blocked"];
  for (const id of ids) {
    const reason = CHECK_REASONS[id];
    assert(reason, `CHECK_REASONS["${id}"] should exist`);
    assert.equal(typeof reason, "string");
    assert(reason.length > 0, `CHECK_REASONS["${id}"] should be non-empty`);
    assert(!reason.includes(id), `CHECK_REASONS["${id}"] should not contain raw id`);
    assert(!reason.includes("_"), `CHECK_REASONS["${id}"] should not contain underscore`);
  }
});

test("each CHECK_REASONS value is distinct", () => {
  const values = Object.values(CHECK_REASONS);
  const unique = new Set(values);
  assert.equal(values.length, unique.size, "all CHECK_REASONS values should be distinct");
});

test("explainFailedChecks returns plain sentences for known ids", () => {
  const result = explainFailedChecks(["product_page", "item_match"]);
  assert.equal(result.length, 2);
  assert.equal(result[0], CHECK_REASONS.product_page);
  assert.equal(result[1], CHECK_REASONS.item_match);
});

test("explainFailedChecks deduplicates identical sentences", () => {
  const result = explainFailedChecks(["product_page", "product_page", "item_match"]);
  assert.equal(result.length, 2);
  assert(!result.includes("有一項檢查沒通過"));
});

test("explainFailedChecks maps unknown id to fallback message", () => {
  const result = explainFailedChecks(["unknown_check"]);
  assert.equal(result.length, 1);
  assert.equal(result[0], "有一項檢查沒通過");
});

test("explainFailedChecks preserves order of first occurrence", () => {
  const result = explainFailedChecks(["recent_view", "trading_view", "product_page"]);
  assert.equal(result.length, 3);
  assert.equal(result[0], CHECK_REASONS.recent_view);
  assert.equal(result[1], CHECK_REASONS.trading_view);
  assert.equal(result[2], CHECK_REASONS.product_page);
});

test("explainFailedChecks handles empty array", () => {
  const result = explainFailedChecks([]);
  assert.equal(result.length, 0);
});

test("verificationSummary for null returns kind none", () => {
  const result = verificationSummary(null);
  assert.equal(result.kind, "none");
  assert.equal(result.headline, "尚未核對");
  assert.deepEqual(result.reasons, []);
});

test("verificationSummary for undefined returns kind none", () => {
  const result = verificationSummary(undefined);
  assert.equal(result.kind, "none");
  assert.equal(result.headline, "尚未核對");
  assert.deepEqual(result.reasons, []);
});

test("verificationSummary for passed verification returns kind ok", () => {
  const verification = { passed: true, failed_checks: [] };
  const result = verificationSummary(verification);
  assert.equal(result.kind, "ok");
  assert.equal(result.headline, "資料已核對");
  assert.deepEqual(result.reasons, []);
});

test("verificationSummary for failed verification returns kind warn with reasons", () => {
  const verification = {
    passed: false,
    failed_checks: ["product_page", "item_match"],
  };
  const result = verificationSummary(verification);
  assert.equal(result.kind, "warn");
  assert.equal(result.headline, "部分資料沒通過核對");
  assert.equal(result.reasons.length, 2);
  assert.equal(result.reasons[0], CHECK_REASONS.product_page);
  assert.equal(result.reasons[1], CHECK_REASONS.item_match);
});

test("progressSteps idle state has all pending steps", () => {
  const market = nameMarket();
  const result = progressSteps({ market, phase: null, running: false });
  assert.equal(result.length, 4);
  assert.equal(result[0].state, "pending");
  assert.equal(result[1].state, "pending");
  assert.equal(result[2].state, "pending");
  assert.equal(result[3].state, "pending");
});

test("progressSteps with running and phase trading has find and trading active", () => {
  const market = nameMarket();
  const result = progressSteps({ market, phase: "trading", running: true });
  assert.equal(result[0].state, "done"); // find: phase is non-null
  assert.equal(result[1].state, "active"); // trading: phase === "trading"
  assert.equal(result[2].state, "pending");
  assert.equal(result[3].state, "pending");
});

test("progressSteps with trading PASSED marks trading done", () => {
  const market = nameMarket({ trading: { status: "PASSED", reason: null } });
  const result = progressSteps({ market, phase: "trading", running: true });
  assert.equal(result[0].state, "done");
  assert.equal(result[1].state, "done");
  assert.equal(result[2].state, "pending");
});

test("progressSteps with recent_trades PASSED marks recent_trades done", () => {
  const market = nameMarket({
    trading: { status: "PASSED", reason: null },
    recent_trades: { status: "PASSED", reason: null },
  });
  const result = progressSteps({ market, phase: "recent_trades", running: true });
  assert.equal(result[0].state, "done");
  assert.equal(result[1].state, "done");
  assert.equal(result[2].state, "done");
  assert.equal(result[3].state, "active"); // both views PASSED, running is true -> verify is active
});

test("progressSteps with verification passed marks verify done", () => {
  const market = nameMarket({
    trading: { status: "PASSED", reason: null },
    recent_trades: { status: "PASSED", reason: null },
    verification: { passed: true, failed_checks: [] },
  });
  const result = progressSteps({ market, phase: "recent_trades", running: true });
  assert.equal(result[3].state, "done");
});

test("progressSteps with verification failed marks verify failed", () => {
  const market = nameMarket({
    trading: { status: "PASSED", reason: null },
    recent_trades: { status: "PASSED", reason: null },
    verification: { passed: false, failed_checks: ["product_page"] },
  });
  const result = progressSteps({ market, phase: null, running: false });
  assert.equal(result[3].state, "failed");
});

test("progressSteps with trading FAILED marks trading failed with reason", () => {
  const market = nameMarket({ trading: { status: "FAILED", reason: "讀取失敗", title: null } });
  const result = progressSteps({ market, phase: null, running: false });
  assert.equal(result[1].state, "failed");
  assert.equal(result[1].detail, "讀取失敗");
});

test("progressSteps with trading BLOCKED marks trading failed with reason", () => {
  const market = nameMarket({ trading: { status: "BLOCKED", reason: "網站阻擋", title: null } });
  const result = progressSteps({ market, phase: null, running: false });
  assert.equal(result[1].state, "failed");
  assert.equal(result[1].detail, "網站阻擋");
});

test("progressSteps with recent_trades FAILED marks recent_trades failed with reason", () => {
  const market = nameMarket({
    trading: { status: "PASSED", reason: null },
    recent_trades: { status: "FAILED", reason: "找不到資料", title: null },
  });
  const result = progressSteps({ market, phase: "recent_trades", running: true });
  assert.equal(result[2].state, "failed");
  assert.equal(result[2].detail, "找不到資料");
});

test("progressSteps without detail when status FAILED has no reason", () => {
  const market = nameMarket({ trading: { status: "FAILED", reason: null } });
  const result = progressSteps({ market, phase: null, running: false });
  assert.equal(result[1].detail, "");
});

test("progressSteps sets find detail from lookup layer", () => {
  const market = nameMarket({ lookup: { layer: "search" } });
  const result = progressSteps({ market, phase: null, running: false });
  assert.equal(result[0].state, "done");
  assert.equal(result[0].detail, "站內搜尋");
});

test("progressSteps handles all LAYER_LABELS keys", () => {
  const layers = ["table", "search", "base"];
  const expected = ["查表直接開啟", "站內搜尋", "底材清單"];
  for (let i = 0; i < layers.length; i++) {
    const market = nameMarket({ lookup: { layer: layers[i] } });
    const result = progressSteps({ market, phase: null, running: false });
    assert.equal(result[0].detail, expected[i], `detail for layer ${layers[i]}`);
  }
});

test("progressSteps with phase null and find done marks trading active when running", () => {
  const market = nameMarket({ lookup: { layer: "search" } });
  const result = progressSteps({ market, phase: null, running: true });
  assert.equal(result[0].state, "done"); // find done
  assert.equal(result[1].state, "active"); // trading: find done and phase null and running
});

test("progressSteps with phase null and find done does not mark trading active when not running", () => {
  const market = nameMarket({ lookup: { layer: "search" } });
  const result = progressSteps({ market, phase: null, running: false });
  assert.equal(result[0].state, "done");
  assert.equal(result[1].state, "pending"); // trading: not running
});

test("progressSteps handles lookup null gracefully", () => {
  const market = nameMarket();
  const result = progressSteps({ market, phase: null, running: false });
  assert.equal(result[0].detail, "");
});

test("progressSteps find is done when any view status is not NOT_RUN", () => {
  const market = nameMarket({ trading: { status: "FAILED", reason: null } });
  const result = progressSteps({ market, phase: null, running: false });
  assert.equal(result[0].state, "done");
});

test("progressSteps step keys and labels are correct", () => {
  const market = nameMarket();
  const result = progressSteps({ market, phase: null, running: false });
  assert.equal(result[0].key, "find");
  assert.equal(result[0].label, "找到商品");
  assert.equal(result[1].key, "trading");
  assert.equal(result[1].label, "讀取目前掛單");
  assert.equal(result[2].key, "recent_trades");
  assert.equal(result[2].label, "讀取近期成交");
  assert.equal(result[3].key, "verify");
  assert.equal(result[3].label, "核對資料");
});

test("progressSteps verify is active when both views are BLOCKED", () => {
  const market = nameMarket({
    trading: { status: "BLOCKED", reason: "網站阻擋" },
    recent_trades: { status: "BLOCKED", reason: "網站阻擋" },
  });
  const result = progressSteps({ market, phase: null, running: true });
  assert.equal(result[3].state, "active");
});

test("progressSteps verify is pending when only one view is PASSED", () => {
  const market = nameMarket({ trading: { status: "PASSED", reason: null } });
  const result = progressSteps({ market, phase: null, running: true });
  assert.equal(result[3].state, "pending");
});

test("progressSteps with phase undefined and nothing read yet has find pending", () => {
  const market = nameMarket();
  const result = progressSteps({ market, phase: undefined, running: false });
  assert.equal(result[0].state, "pending"); // phase undefined != null is false, so find not done
});

const statsMarket = (lookup, trading = { status: "NOT_RUN", reason: null }, verification = null) => ({
  mode: "stats",
  trading,
  recent_trades: { status: "NOT_RUN", reason: null },
  verification,
  lookup,
});
const states = (steps) => steps.map((s) => s.state);

test("stats progress has its own four steps and never mentions recent trades", () => {
  const steps = progressSteps({ market: statsMarket(null), phase: null, running: false });
  assert.deepEqual(steps.map((s) => s.label), ["取得屬性清單", "套用條件", "讀取掛單", "核對資料"]);
  assert.deepEqual(states(steps), ["pending", "pending", "pending", "pending"]);
});

test("stats progress moves from the property list to applying the filters to reading the list", () => {
  const at = (stage, running = true) => states(progressSteps({ market: statsMarket({ mode: "stats", stage }), phase: null, running }));
  assert.deepEqual(at("properties"), ["active", "pending", "pending", "pending"]);
  assert.deepEqual(at("apply"), ["done", "active", "pending", "pending"]);
  assert.deepEqual(at("read"), ["done", "done", "active", "pending"]);
});

test("stats progress ends done when the list was read and checked, and failed where it stopped", () => {
  const lookup = { mode: "stats", stage: "read" };
  const done = progressSteps({
    market: statsMarket(lookup, { status: "PASSED", reason: null }, { passed: true }),
    phase: null,
    running: false,
  });
  assert.deepEqual(states(done), ["done", "done", "done", "done"]);
  const unchecked = progressSteps({
    market: statsMarket(lookup, { status: "PASSED", reason: null }),
    phase: null,
    running: true,
  });
  assert.equal(unchecked[3].state, "active");
  const unmapped = progressSteps({
    market: statsMarket({ mode: "stats", stage: "apply", unmapped: ["fcr"] }),
    phase: null,
    running: false,
  });
  assert.deepEqual(states(unmapped), ["done", "failed", "pending", "pending"]);
  const blocked = progressSteps({
    market: statsMarket(lookup, { status: "BLOCKED", reason: "網站阻擋" }),
    phase: null,
    running: false,
  });
  assert.deepEqual([blocked[2].state, blocked[2].detail], ["failed", "網站阻擋"]);
});

test("stats checks have a sentence each", () => {
  for (const id of ["home_page", "filters_in_url", "filters_shown", "rows_match_filters"]) assert.ok(CHECK_REASONS[id], id);
  assert.deepEqual(explainFailedChecks(["filters_in_url", "filters_in_url"]), [CHECK_REASONS.filters_in_url]);
});

test("the price line says what to ask, and nothing when nothing is priced", () => {
  assert.equal(priceSummaryLine(null), "");
  assert.equal(priceSummaryLine({ count: 3, priced: 0, unpriced: 3, min: null, median: null, q1: null, q3: null }), "");
  assert.equal(
    priceSummaryLine({ count: 1, priced: 1, unpriced: 0, min: 3, median: 3, q1: null, q3: null }),
    "價格（High Rune Value）：最低 3、中位數 3（共 1 筆）",
  );
  assert.equal(
    priceSummaryLine({ count: 10, priced: 7, unpriced: 3, min: 0.06, median: 1, q1: 0.5, q3: 2 }),
    "價格（High Rune Value）：最低 0.06、中位數 1、四分位 0.5–2（共 10 筆，3 筆沒有標價）",
  );
});

test("the source line names where the input came from, and nothing for typing", () => {
  assert.equal(sourceLine(null), "");
  assert.equal(sourceLine({ kind: "typed" }), "");
  assert.equal(sourceLine({ kind: "picture" }), "來源：截圖");
  assert.equal(
    sourceLine({ kind: "scan", time: "12:34", affixes: "防禦、打擊恢復" }),
    "來源：掃描紀錄 12:34 · 防禦、打擊恢復",
  );
  assert.equal(sourceLine({ kind: "scan", time: "", affixes: "" }), "來源：掃描紀錄");
});

test("progressSteps with nothing found yet and a run underway marks find active", () => {
  const market = nameMarket();
  const result = progressSteps({ market, phase: null, running: true });
  assert.equal(result[0].key, "find");
  assert.equal(result[0].state, "active"); // nothing found (no layer, no phase, both views NOT_RUN) and running
  assert.equal(result[1].state, "pending"); // find is not done yet, so trading waits
});
