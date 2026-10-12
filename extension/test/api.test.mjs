// api.js is the panel's only backend client: it builds the URL, sets the JSON content type, stringifies the body,
// arms a 300 s abort timer and turns either a transport failure or a non-OK response into an ApiError. Every caller's
// test fakes `fetch`, so the request it actually sends (path, method, headers, body shape, the signal handed to fetch)
// and the message it hands back (the SERVER's own Traditional-Chinese wording for a refused invite or an exhausted
// quota, not a generic one) were never pinned. This file drives the real module with a fake fetch, a fake
// AbortController and fake timers, so nothing waits 300 s and no socket is opened.
//
// The paths and body keys are the server's, not a guess: services/jevsvc/app.py routes "/api/run/start", "/api/choose"
// and "/api/run/base" and reads `invite`/`item_name`/`load_more` and `run_token`/`phase`/`page`/`history`/`no_block`
// (run_start, choose_step). The client also sends `options`/`base` to pick_base_step, but the server ignores the list
// (its docstring: "A list in the request is ignored: the client does not get to decide what Jev may choose from") and
// picks from its own BASES - so `options` is the CLIENT's contract, pinned here, not something the server reads.
// The refusal messages echoed below are the server's own; the file each one comes from is named next to it.

import assert from "node:assert/strict";
import test from "node:test";

import { ApiError } from "../src/errors.js";
import { chooseNext, pickBase, startRun } from "../src/api.js";

const BASE = "https://api.test";
const TIMEOUT_MS = 300000;

const real = {
  fetch: globalThis.fetch,
  AbortController: globalThis.AbortController,
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
};

const okJson = (body, status = 200) => ({ ok: true, status, json: async () => body });
const reply = ({ status = 200, body, jsonError = false }) => ({
  ok: status >= 200 && status < 300,
  status,
  json: jsonError ? async () => {
    throw new SyntaxError("Unexpected token < in JSON");
  } : async () => body,
});

/**
 * Installs a recording fake fetch plus a fake AbortController and fake timers (so the module's 300 s deadline is
 * inspected, never waited on). `answer(href, init)` scripts the response; the default is an empty 200 JSON object.
 */
function install({ answer = () => okJson({}), fetchImpl = null } = {}) {
  const calls = [];
  const timers = [];
  const cleared = [];
  const controllers = [];
  let seq = 0;
  class FakeAbortController {
    constructor() {
      this.signal = {
        aborted: false,
        _handlers: [],
        addEventListener: (type, handler) => {
          if (type === "abort") this.signal._handlers.push(handler);
        },
      };
      controllers.push(this);
    }

    abort() {
      if (this.signal.aborted) return;
      this.signal.aborted = true;
      for (const handler of this.signal._handlers) handler();
    }
  }
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    calls.push({ href, init });
    return fetchImpl ? fetchImpl(href, init) : answer(href, init);
  };
  globalThis.AbortController = FakeAbortController;
  globalThis.setTimeout = (fn, ms) => {
    const id = ++seq;
    timers.push({ id, fn, ms });
    return id;
  };
  globalThis.clearTimeout = (id) => cleared.push(id);
  return {
    calls,
    timers,
    cleared,
    controllers,
    restore: () => Object.assign(globalThis, real),
  };
}

const bodyOf = (call) => JSON.parse(call.init.body);

// --- the request each call sends --------------------------------------------------------------------------------

test("startRun POSTs the invite, item name and load-more to /api/run/start and returns the parsed run", async (t) => {
  const h = install({ answer: () => okJson({ run_token: "tok", item_name: "Monarch", load_more: 25, used: 3, limit: 5 }) });
  t.after(h.restore);

  const run = await startRun(BASE, { invite: "INV-123", itemName: "君主盾", loadMore: 25 });

  assert.equal(h.calls.length, 1);
  const [call] = h.calls;
  assert.equal(call.href, "https://api.test/api/run/start");
  assert.equal(call.init.method, "POST");
  assert.deepEqual(call.init.headers, { "Content-Type": "application/json" });
  assert.deepEqual(bodyOf(call), { invite: "INV-123", item_name: "君主盾", load_more: 25 });
  assert.deepEqual(run, { run_token: "tok", item_name: "Monarch", load_more: 25, used: 3, limit: 5 });
});

test("chooseNext POSTs the run token, phase, the page's four fields and the mapped history to /api/choose", async (t) => {
  const h = install({ answer: () => okJson({ action: "click", kind: "next_page" }) });
  t.after(h.restore);

  const page = { url: "https://traderie.test/x", title: "T", text: "hello", actions: [{ i: 0, t: "Next" }], html: "<sink>" };
  const history = [
    { action: "click", kind: "next_page", text: "Next", page_changed: true, raw: "drop-me" },
    { action: "done", kind: "results", text: "list", page_changed: false, extra: 1 },
  ];

  await chooseNext(BASE, { runToken: "tok", phase: "trading", page, history });

  const [call] = h.calls;
  assert.equal(call.href, "https://api.test/api/choose");
  assert.equal(call.init.method, "POST");
  assert.deepEqual(call.init.headers, { "Content-Type": "application/json" });
  assert.deepEqual(bodyOf(call), {
    run_token: "tok",
    phase: "trading",
    page: { url: "https://traderie.test/x", title: "T", text: "hello", actions: [{ i: 0, t: "Next" }] },
    history: [
      { action: "click", kind: "next_page", text: "Next", page_changed: true },
      { action: "done", kind: "results", text: "list", page_changed: false },
    ],
  });
});

test("chooseNext adds no_block only when asked for, and reports the decision the server returned", async (t) => {
  const h = install({ answer: () => okJson({ action: "stop", kind: "settled" }) });
  t.after(h.restore);

  const page = { url: "u", title: "t", text: "x", actions: [] };
  await chooseNext(BASE, { runToken: "tok", phase: "trading", page, history: [] });
  await chooseNext(BASE, { runToken: "tok", phase: "trading", page, history: [], noBlock: true });

  assert.equal(h.calls.length, 2);
  assert.equal("no_block" in bodyOf(h.calls[0]), false);
  assert.equal(bodyOf(h.calls[1]).no_block, true);
  assert.deepEqual(bodyOf(h.calls[1]).history, []);
});

test("pickBase POSTs the options (which the server ignores) and includes base only when the caller already matched it", async (t) => {
  // The wire body is the client's contract: pick_base_step (services/jevsvc/app.py) ignores a list in the request and
  // picks from the server's own BASES. A non-null pick answers with the real `_base_reply` shape - base, probability,
  // usage, item_name and a fresh run_token (services/jevsvc/app.py `_base_reply`) - so the fake replies with that.
  const h = install({
    answer: () => okJson({
      base: "Monarch",
      probability: 0.9,
      usage: { input_tokens: 12, output_tokens: 3 },
      item_name: "Monarch",
      run_token: "tok-base",
    }),
  });
  t.after(h.restore);

  await pickBase(BASE, { runToken: "tok", options: ["Monarch", "Bone Wand"] });
  await pickBase(BASE, { runToken: "tok", options: ["Monarch", "Bone Wand"], base: "Monarch" });

  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].href, "https://api.test/api/run/base");
  assert.deepEqual(h.calls[0].init.headers, { "Content-Type": "application/json" });
  assert.deepEqual(bodyOf(h.calls[0]), { run_token: "tok", options: ["Monarch", "Bone Wand"] });
  assert.deepEqual(bodyOf(h.calls[1]), { run_token: "tok", options: ["Monarch", "Bone Wand"], base: "Monarch" });
});

// --- the deadline and its abort ----------------------------------------------------------------------------------

test("every call arms a 300 s timer that aborts the signal handed to fetch, then clears it", async (t) => {
  // The fetch never settles on its own: it rejects only when the signal it was handed aborts, the way the browser's
  // fetch does. So the deadline firing is what makes the call fail, not a timer the test fires into the void. The
  // abort is asserted SYNCHRONOUSLY, straight after the deadline and before any await: were `controller.abort()` a
  // no-op, the awaited promise below would never settle and this test would hang, taking its `t.after` fakes and the
  // rest of the file with it. Checked this way, the same mutation fails right here.
  let sawAbort = false;
  const h = install({
    fetchImpl: (_href, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          sawAbort = true;
          reject(new Error("AbortError"));
        });
      }),
  });
  t.after(h.restore);

  const pending = startRun(BASE, { invite: "i", itemName: "Monarch", loadMore: 0 }).then(
    () => "resolved",
    (error) => error,
  );
  await Promise.resolve();

  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].ms, TIMEOUT_MS);
  assert.equal(h.cleared.length, 0, "the timer is still armed while the request is in flight");

  const signal = h.calls[0].init.signal;
  assert.equal(signal, h.controllers[0].signal, "fetch is handed the controller's own signal");
  assert.equal(signal.aborted, false);
  assert.equal(h.calls[0].href, "https://api.test/api/run/start");

  h.timers[0].fn(); // the deadline: 300 s, compressed into one call

  assert.equal(signal.aborted, true, "the deadline aborts the signal fetch holds");
  assert.equal(sawAbort, true, "the fetch saw the abort, so it rejects as the browser's would");

  const error = await pending;
  assert.ok(error instanceof ApiError, `expected ApiError, got ${error}`);
  assert.equal(error.status, 0);
  assert.equal(error.message, "連不到伺服器，請檢查網路");
  assert.equal(h.cleared[0], h.timers[0].id, "the timer is cleared once the fetch settled");
});

test("a successful call also clears its timer", async (t) => {
  const h = install({ answer: () => okJson({ run_token: "tok" }) });
  t.after(h.restore);

  await startRun(BASE, { invite: "i", itemName: "Monarch", loadMore: 0 });

  assert.deepEqual(h.cleared, [h.timers[0].id]);
});

// --- what the caller is told -------------------------------------------------------------------------------------

test("a refused invite reaches the caller as the server's own message, with its status", async (t) => {
  // "邀請碼無效或已停用" is the server's wording for a bad or disabled invite (services/jevsvc/invites.py, raised as
  // InviteError and handed straight through as the body's `error` by services/jevsvc/http.py). The client must echo
  // that field, not invent a message of its own.
  const h = install({ answer: () => reply({ status: 401, body: { error: "邀請碼無效或已停用", code: "invite_invalid" } }) });
  t.after(h.restore);

  const error = await startRun(BASE, { invite: "bad", itemName: "Monarch", loadMore: 0 }).then(
    () => null,
    (e) => e,
  );

  assert.ok(error instanceof ApiError);
  assert.equal(error.status, 401);
  assert.equal(error.message, "邀請碼無效或已停用");
});

test("an exhausted quota reaches the caller as the server's own message, with its status", async (t) => {
  // The server builds this one from its own cap: "…已達上限（30 次）…" with MAX_MODEL_CALLS = 30
  // (services/jevsvc/app.py, `_reserve_call_budget`). The client echoes the body's `error` verbatim.
  const h = install({ answer: () => reply({ status: 429, body: { error: "這次查詢的 Jev 呼叫次數已達上限（30 次），請重新開始", code: "call_limit" } }) });
  t.after(h.restore);

  const error = await chooseNext(BASE, { runToken: "tok", phase: "trading", page: { url: "u", title: "t", text: "x", actions: [] }, history: [] }).then(
    () => null,
    (e) => e,
  );

  assert.ok(error instanceof ApiError);
  assert.equal(error.status, 429);
  assert.equal(error.message, "這次查詢的 Jev 呼叫次數已達上限（30 次），請重新開始");
});

test("a non-OK answer without a message falls back to 伺服器沒有回應 and keeps the status", async (t) => {
  // Synthetic: the server's `_error` (services/jevsvc/app.py) always sends `error` next to `code`, so a body with
  // only `code` is a shape app.py never sends - kept to prove the client's defensive fallback when `error` is absent.
  const h = install({ answer: () => reply({ status: 500, body: { code: "not_configured" } }) });
  t.after(h.restore);

  const error = await startRun(BASE, { invite: "i", itemName: "x", loadMore: 0 }).then(
    () => null,
    (e) => e,
  );

  assert.equal(error.status, 500);
  assert.equal(error.message, "伺服器沒有回應");
});

test("a body that is not JSON inside a non-OK answer is the same 伺服器沒有回應", async (t) => {
  const h = install({ answer: () => reply({ status: 502, jsonError: true }) });
  t.after(h.restore);

  const error = await startRun(BASE, { invite: "i", itemName: "x", loadMore: 0 }).then(
    () => null,
    (e) => e,
  );

  assert.equal(error.status, 502);
  assert.equal(error.message, "伺服器沒有回應");
});

test("an OK answer whose body is not JSON is a 伺服器沒有回應 too, not a silent success", async (t) => {
  const h = install({ answer: () => reply({ status: 200, jsonError: true }) });
  t.after(h.restore);

  const error = await startRun(BASE, { invite: "i", itemName: "x", loadMore: 0 }).then(
    () => null,
    (e) => e,
  );

  assert.ok(error instanceof ApiError);
  assert.equal(error.status, 200);
  assert.equal(error.message, "伺服器沒有回應");
});

test("a transport failure is status 0 with the network wording", async (t) => {
  const h = install({ answer: () => {
    throw new TypeError("Failed to fetch");
  } });
  t.after(h.restore);

  const error = await startRun(BASE, { invite: "i", itemName: "x", loadMore: 0 }).then(
    () => null,
    (e) => e,
  );

  assert.ok(error instanceof ApiError);
  assert.equal(error.status, 0);
  assert.equal(error.message, "連不到伺服器，請檢查網路");
});
