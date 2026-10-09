// The name query's outcome and the way a failure is described: the panel's most consequential branching, which used to
// live in the one module node cannot import. Every case here is a screen the player can end up on.

import assert from "node:assert/strict";
import test from "node:test";

import { ApiError } from "../src/errors.js";
import { describeRunError, judgeNameRun } from "../src/run-outcome.js";

const view = (status, reason = null) => ({ status, reason });
const market = (trading = view("PASSED"), recent = view("PASSED")) => ({ trading, recent_trades: recent });

const judge = (over = {}) =>
  judgeNameRun({
    stopped: false,
    outcome: null,
    status: "done",
    scopeBlockedReason: null,
    page: {},
    tab: {},
    market: market(),
    itemName: "Harlequin Crest",
    detectGuard: async () => null,
    verify: () => ({ passed: true }),
    ...over,
  });

test("a stop is the player's stop, not a problem", async () => {
  assert.deepEqual(await judge({ stopped: true }), { after: "stopped" });
});

test("a guard ends as a problem whose banner sends the player to the site", async () => {
  const { after, banner } = await judge({ outcome: "guard" });
  assert.equal(after, "problem");
  assert.equal(banner.site, true);
  assert.match(banner.retry, /重新查詢/);
});

test("not finding the item says so and suggests the two ways out", async () => {
  const { after, banner } = await judge({ outcome: "not_found" });
  assert.equal(after, "problem");
  assert.equal(banner.message, "找不到這個裝備");
  assert.match(banner.hint, /英文全名|截圖/);
});

test("a blocked run is a guard problem when the page is one, otherwise the scope reason", async () => {
  const guarded = await judge({ status: "blocked", detectGuard: async () => "Cloudflare" });
  assert.equal(guarded.after, "problem");
  assert.equal(guarded.banner.site, true);
  assert.equal(guarded.banner.hint, "Cloudflare");

  const plain = await judge({ status: "blocked", scopeBlockedReason: "不在 Traderie" });
  assert.equal(plain.banner.message, "不在 Traderie");
  assert.equal(plain.banner.site, undefined);

  const unknown = await judge({
    status: "blocked",
    detectGuard: async () => {
      throw new Error("the page went away");
    },
  });
  assert.equal(unknown.banner.message, "無法繼續");
});

test("a blocked view turns a finished run into a problem", async () => {
  const result = await judge({ market: market(view("PASSED"), view("BLOCKED", "需要登入")) });
  assert.equal(result.after, "problem");
  assert.equal(result.banner.site, true);
  assert.equal(result.banner.hint, "需要登入");
  assert.deepEqual(result.verification, { passed: true }); // the verification is still handed over
});

test("a clean run is done and carries the verification to store", async () => {
  const result = await judge();
  assert.equal(result.after, "done");
  assert.equal(result.banner, undefined);
  assert.deepEqual(result.verification, { passed: true });
});

test("the item name reaches the verification exactly as the caller gave it", async () => {
  let seen = null;
  await judge({
    itemName: "Shako",
    verify: (name) => {
      seen = name;
      return { passed: true };
    },
  });
  assert.equal(seen, "Shako");
});

test("an invite the backend refused before the run is dropped, and the banner points at the settings", () => {
  const error = new ApiError(401, "邀請碼無效或已停用");
  const { banner, clearPendingInvite } = describeRunError(error, { hasRun: false, hasStoredInvite: true });
  assert.equal(clearPendingInvite, true);
  assert.equal(banner.settings, true);
  assert.equal(banner.message, "邀請碼無效或已停用");
});

test("a failure during the run keeps the invite and offers a retry", () => {
  const { banner, clearPendingInvite } = describeRunError(new ApiError(502, "Jev 暫時無法回應"), { hasRun: true });
  assert.equal(clearPendingInvite, undefined);
  assert.equal(banner.retry, "重新查詢");
  assert.equal(banner.settings, undefined);
});

test("a closed query window says why and offers a retry", () => {
  const { banner } = describeRunError(new Error("Target closed"), { detached: true, detachReason: "使用者關閉" });
  assert.match(banner.message, /查詢視窗被關閉/);
  assert.match(banner.hint, /使用者關閉/);
  assert.equal(banner.retry, "重新查詢");
});

test("anything else is shown as it came, with a retry", () => {
  const { banner } = describeRunError(new Error("boom"), {});
  assert.equal(banner.message, "boom");
  assert.equal(banner.retry, "重新查詢");
});
