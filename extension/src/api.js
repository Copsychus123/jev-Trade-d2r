// Backend calls. No chrome.* here; the base URL is passed in.

import { ApiError } from "./errors.js";

const TIMEOUT_MS = 300000;

async function post(base, path, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch {
    throw new ApiError(0, "連不到伺服器，請檢查網路");
  } finally {
    clearTimeout(timer);
  }
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) throw new ApiError(response.status, body?.error || "伺服器沒有回應");
  if (body === null) throw new ApiError(response.status, "伺服器沒有回應");
  return body;
}

export function startRun(base, { invite, itemName, loadMore }) {
  return post(base, "/api/run/start", { invite, item_name: itemName, load_more: loadMore });
}

export function chooseNext(base, { runToken, phase, page, history, noBlock = false }) {
  return post(base, "/api/choose", {
    ...(noBlock ? { no_block: true } : {}),
    run_token: runToken,
    phase,
    page: { url: page.url, title: page.title, text: page.text, actions: page.actions },
    history: history.map((h) => ({
      action: h.action,
      kind: h.kind,
      text: h.text,
      page_changed: h.page_changed,
    })),
  });
}

export function pickBase(base, { runToken, options, base: chosen = null }) {
  return post(base, "/api/run/base", { run_token: runToken, options, ...(chosen ? { base: chosen } : {}) });
}
