import assert from "node:assert/strict";
import { test } from "node:test";

import { TRADERIE_D2R_URL, detectGuard, phaseFinishRule, traderieScopeReason } from "../src/traderie/site.js";

const tab = { evaluate: async () => false };
const frameTab = { evaluate: async () => true };
const product = `${TRADERIE_D2R_URL}/product/shako`;
const page = (text, title = "Shako") => ({ url: product, title, text });

// A logged-in product page as the snapshot sees it: the visible viewport is only ~2000 chars, keeps the listing
// markers, and holds Traderie's own changelog line "Fixed captcha bugs" — the measured real false positive.
const NORMAL_TEXT =
  "Trading For\n1 X Gul Rune\n39 分鐘前\nMake an Offer\n".repeat(20) + "Fixed captcha bugs when going between games";

test("a short page that asks for a captcha is a guard", async () => {
  assert.equal(await detectGuard(page("Please complete CAPTCHA before continuing"), tab), "防護頁/驗證碼");
});

test("a normal product page whose short text mentions a captcha changelog is not a guard", async () => {
  assert.ok(NORMAL_TEXT.length < 3000 && NORMAL_TEXT.includes("captcha") && NORMAL_TEXT.includes("Trading For"));
  assert.equal(await detectGuard(page(NORMAL_TEXT, "Harlequin Crest"), tab), null);
});

test("the word captcha in a long normal page (a changelog line) is not a guard", async () => {
  const text = "Trading For\n".repeat(600) + "Fixed captcha bugs when going between games";
  assert.equal(await detectGuard(page(text), tab), null);
});

// A page that looks like a challenge in every way except its length: the bare word, none of the listing markers, and
// a neutral filler so the character count is deliberate. `tab` answers the frame probe false, so only the text rules
// can decide. The product URL keeps the scope check out of the way.
const CHALLENGE_HEAD = "Please solve the captcha to continue. ";
const LISTING_MARKERS = ["Trading For", "Make an Offer"]; // the TRADING_MARKERS vocabulary, spelled out here

function challengeText(length) {
  const text = CHALLENGE_HEAD + "x".repeat(length - CHALLENGE_HEAD.length);
  assert.equal(text.length, length);
  assert.ok(text.includes("captcha"));
  assert.ok(LISTING_MARKERS.every((marker) => !text.toLowerCase().includes(marker.toLowerCase())));
  return text;
}

test("a page over the challenge length limit that only says captcha is not a guard", async () => {
  const text = challengeText(3200);
  assert.ok(text.length > 3000);
  assert.equal(await detectGuard(page(text), tab), null);
});

test("the captcha word counts only while the text stays under the limit (2999 guarded, 3000 not)", async () => {
  const short = challengeText(2999);
  const atLimit = challengeText(3000);
  assert.equal(short.length, 2999);
  assert.equal(atLimit.length, 3000);
  assert.ok(page(short).url.startsWith(`${TRADERIE_D2R_URL}/product/`));
  assert.equal(await detectGuard(page(short), tab), "防護頁/驗證碼");
  assert.equal(await detectGuard(page(atLimit), tab), null);
});

test("a Just a moment title is a guard even when the page carries listings", async () => {
  assert.equal(await detectGuard(page(NORMAL_TEXT, "Just a moment..."), tab), "防護頁/驗證碼");
});

test("verify you are human is a guard even when the page carries listings", async () => {
  assert.equal(await detectGuard(page(`${NORMAL_TEXT}\nVerify you are human`), tab), "防護頁/驗證碼");
});

test("a challenge frame in the page is a guard on its own", async () => {
  assert.equal(await detectGuard(page("Trading For\n1 X Gul Rune"), frameTab), "防護頁/驗證碼");
});

test("the load-more finish rule names the button only when a count was asked for", () => {
  assert.equal(phaseFinishRule(0), null);
  assert.deepEqual(phaseFinishRule(1), ["Load More", 1]);
  assert.deepEqual(phaseFinishRule(5), ["Load More", 5]);
});

test("the scope reason accepts the D2R root, product and search paths and rejects anything else", () => {
  assert.equal(traderieScopeReason(`${TRADERIE_D2R_URL}/product/shako`), null);
  assert.equal(traderieScopeReason(`${TRADERIE_D2R_URL}/search`), null);
  assert.equal(traderieScopeReason(TRADERIE_D2R_URL), null);
  assert.equal(
    traderieScopeReason(`${TRADERIE_D2R_URL}/settings/profile`),
    "超出 Traderie D2R 範圍：/diablo2resurrected/settings/profile",
  );
});
