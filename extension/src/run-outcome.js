// How a finished (or failed) name query is judged, away from the panel's own state and its DOM.
//
// The panel decides its screen from five facts (`panel-state.js`); this module decides what those facts should be after a
// run: whether the query ended with data, with a problem and which banner, or with the player's stop. Pure: no DOM, no
// chrome.*, no module state — the caller passes what it knows and applies the two things the result names.

import { ApiError } from "./errors.js";

const GUARD_MESSAGE = "Traderie 要求驗證或登入。請在這個 Chrome 開啟 Traderie 處理完，再回來重新查詢。";

/** A problem whose cause is the site's guard: the banner offers the one action that helps. */
export const guardProblem = (hint) => ({ message: GUARD_MESSAGE, hint, site: true, retry: "我處理好了，重新查詢" });

/**
 * The outcome of one name search. `verify(itemName, market)` returns the verification to store; `detectGuard(page, tab)`
 * asks the page whether it is a guard (both injected, because one is the controller's and the other talks to the tab).
 * Returns `{ after, banner?, verification? }`.
 */
export async function judgeNameRun({
  stopped,
  outcome,
  status,
  scopeBlockedReason,
  page,
  tab,
  market,
  itemName,
  detectGuard,
  verify,
}) {
  if (stopped) return { after: "stopped" };
  if (outcome === "guard") return { after: "problem", banner: guardProblem() };
  if (outcome === "not_found") {
    return { after: "problem", banner: { message: "找不到這個裝備", hint: "試試英文全名，或用截圖" } };
  }
  if (status === "blocked") {
    const guard = await detectGuard(page, tab).catch(() => null);
    if (guard) return { after: "problem", banner: guardProblem(guard) };
    return { after: "problem", banner: { message: scopeBlockedReason || "無法繼續", retry: "重新查詢" } };
  }
  const verification = verify(itemName, market);
  const blocked = [market.trading, market.recent_trades].filter((view) => view.status === "BLOCKED");
  if (blocked.length) {
    const reasons = blocked.map((view) => view.reason).filter(Boolean).join("；");
    return { after: "problem", banner: guardProblem(reasons), verification };
  }
  return { after: "done", verification };
}

/**
 * How a failure is described to the player, and whether the pending invite must be dropped (the backend refused it:
 * never store it). `hasRun` is whether the backend had already accepted this query's code.
 */
export function describeRunError(error, { hasRun, hasStoredInvite, detached, detachReason }) {
  if (error instanceof ApiError && !hasRun && (error.status === 401 || error.status === 429)) {
    return { banner: { message: error.message, settings: Boolean(hasStoredInvite) }, clearPendingInvite: true };
  }
  if (error instanceof ApiError) return { banner: { message: error.message, retry: "重新查詢" } };
  if (detached) {
    return {
      banner: {
        message: "查詢視窗被關閉，或「偵錯」被取消，查詢已停止。",
        hint: `原因：${detachReason || "未知"}；${error?.message || ""}`,
        retry: "重新查詢",
      },
    };
  }
  return { banner: { message: error?.message || String(error), retry: "重新查詢" } };
}
