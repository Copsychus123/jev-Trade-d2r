import assert from "node:assert/strict";
import { test } from "node:test";

import { TRADERIE_D2R_URL, detectGuard } from "../src/traderie/site.js";

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

test("a Just a moment title is a guard even when the page carries listings", async () => {
  assert.equal(await detectGuard(page(NORMAL_TEXT, "Just a moment..."), tab), "防護頁/驗證碼");
});

test("verify you are human is a guard even when the page carries listings", async () => {
  assert.equal(await detectGuard(page(`${NORMAL_TEXT}\nVerify you are human`), tab), "防護頁/驗證碼");
});

test("a challenge frame in the page is a guard on its own", async () => {
  assert.equal(await detectGuard(page("Trading For\n1 X Gul Rune"), frameTab), "防護頁/驗證碼");
});
