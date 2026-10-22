import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { DEFAULT_LISTING } from "../src/listing-defaults.js";
import { StalePage } from "../src/errors.js";
import { emptyListingForm } from "../src/traderie/listing.js";
import { UNCONFIRMED_REASON, UNVERIFIED_NOTE, postListing } from "../src/traderie/listing_flow.js";
import { indexTables } from "../src/traderie/lookup.js";
import { newTimeline } from "../src/timeline.js";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const ITEM = fixture("item_harlequin_crest.json");
const BER = fixture("item_ber_rune.json");
const PRODUCTS = [
  { name: "Harlequin Crest", slug: "harlequin-crest", category: "uniques" },
  { name: "Ber Rune", slug: "ber-rune", category: "runes" },
];
const tables = { ...indexTables({ products: PRODUCTS, zh: {}, bases: [], game_only: [], generated_at: "2026-01-01" }), products: PRODUCTS };
const scripts = { fetchJson: "FETCH", postForm: "POST" };
const PRODUCT_PAGE = { url: "https://traderie.com/diablo2resurrected/product/harlequin-crest", title: "Harlequin Crest", text: "Trading For ".repeat(50) };

const record = () => ({
  id: 1,
  name: "Harlequin Crest",
  kind: "item",
  quality: "gold",
  conditions: [{ key: "all_skills", label: "所有技能", kind: "plain", line: "", min: 2, max: null, on: false, confident: true }],
});

/** A fake Tab whose evaluate answers by the path inside the expression; `answers` can override one path's reply. */
function fakeTab({ page = PRODUCT_PAGE, answers = {}, createReply = { status: 200, body: { id: 42 } }, createThrows = null } = {}) {
  const tab = { opened: [], evaluated: [], closed: 0, openTiming: { navigate_ms: 1 } };
  tab.readSettledPage = async () => page;
  tab.close = async () => {
    tab.closed += 1;
  };
  tab.evaluate = async (expression) => {
    tab.evaluated.push(expression);
    if (expression.startsWith("!!document.querySelector")) return false;
    if (expression.startsWith("POST(")) {
      if (createThrows) throw createThrows;
      return createReply;
    }
    const path = JSON.parse(expression.slice("FETCH(".length, -1));
    if (path in answers) return answers[path];
    if (path.includes("id=harlequin-crest")) return { status: 200, body: ITEM };
    if (path.includes("id=ber-rune")) return { status: 200, body: BER };
    if (path.startsWith("/api/games")) return { status: 200, body: { games: { features: [] } } };
    if (path.startsWith("/api/diablo2resurrected/users/details")) return { status: 200, body: { details: { skip_captcha: false } } };
    if (path === "/api/diablo2resurrected/user?") return { status: 200, body: { user: { id: "77" } } };
    if (path.includes("seller=77")) return { status: 200, body: { listings: [{ id: "42", item_id: "2487112490" }] } };
    throw new Error(`unexpected path ${path}`);
  };
  return tab;
}

function run(form, tab) {
  const session = { tab: null, timeline: newTimeline() };
  const opened = [];
  const statuses = [];
  const result = postListing({ form, tables, openTab: async (url) => (opened.push(url), tab), scripts, session, onStatus: (t) => statuses.push(t) });
  return { session, opened, statuses, result };
}

const creates = (tab) => tab.evaluated.filter((e) => e.startsWith("POST("));
const priced = () => {
  const form = emptyListingForm(record(), tables, DEFAULT_LISTING);
  form.prices = [{ rune: "Ber Rune", quantity: 2 }];
  return form;
};

test("a priced listing opens the product page, posts exactly one create built from the form, and is verified in the own listings", async () => {
  const tab = fakeTab();
  const { session, opened, result, statuses } = run(priced(), tab);
  const outcome = await result;
  assert.deepEqual(opened, ["https://www.traderie.com/diablo2resurrected/product/harlequin-crest"]);
  assert.equal(creates(tab).length, 1);
  const [path, bodyJson] = JSON.parse(`[${creates(tab)[0].slice("POST(".length, -1)}]`);
  assert.equal(path, "/api/diablo2resurrected/listings/create");
  const body = JSON.parse(bodyJson);
  assert.deepEqual([body.item, body.itemType, body.makeOffer, body.amount], ["2487112490", "uniques", false, "1"]);
  assert.deepEqual(body.items.map((r) => [r.id, r.quantity, r.group]), [["4149485449", "2", 0]]);
  assert.ok(body.properties.find((p) => p.name === "+{{value}} to All Skills" && p.number === 2));
  assert.ok(body.properties.find((p) => p.name === "Ladder" && p.bool === true));
  assert.deepEqual(session.listing.body, body);
  assert.deepEqual(outcome, {
    outcome: "posted",
    reason: "",
    listingId: "42",
    listingUrl: "https://traderie.com/diablo2resurrected/listing/42",
    profileUrl: "https://traderie.com/diablo2resurrected/profile/77/listings",
    verified: true,
    unavailable: [],
  });
  assert.equal(tab.closed, 1);
  assert.equal(session.tab, null);
  assert.deepEqual(statuses, ["開啟商品頁…", "讀取物品資料…", "送出掛單…", "確認掛單清單…"]);
  const stages = session.timeline.entries.map((e) => e.stage);
  assert.ok(stages.includes("post_listing"), stages.join(","));
  assert.ok(stages.indexOf("post_listing") > stages.indexOf("read_item"));
});

test("a 403 on the create is failed with the login reason: one request, no second try, the tab closed", async () => {
  const tab = fakeTab({ createReply: { status: 403, body: "" } });
  const outcome = await run(priced(), tab).result;
  assert.equal(outcome.outcome, "failed");
  assert.match(outcome.reason, /HTTP 403/u);
  assert.equal(creates(tab).length, 1);
  assert.equal(tab.closed, 1);
});

const RING = fixture("item_ring.json");
const RING_PATH = "/api/diablo2resurrected/items?id=harlequin-crest&variants=&tags=&properties=&adding=true";

test("nothing is posted when a ticked attribute does not exist on the item, or a required property is not filled", async () => {
  // The ring record has no +All Skills property: the ticked row cannot be sent, so the listing is refused whole.
  const noSkills = fakeTab({ answers: { [RING_PATH]: { status: 200, body: RING } } });
  const refused = await run(priced(), noSkills).result;
  assert.deepEqual([refused.outcome, refused.unavailable], ["refused", ["all_skills"]]);
  assert.match(refused.reason, /沒有這些屬性欄位：所有技能/u);
  assert.equal(creates(noSkills).length, 0);

  // Without that row, the ring still requires a Rarity that a non-base record has no way to give.
  const form = priced();
  form.conditions[0].on = false;
  const noRarity = fakeTab({ answers: { [RING_PATH]: { status: 200, body: RING } } });
  const missing = await run(form, noRarity).result;
  assert.deepEqual([missing.outcome, missing.reason], ["refused", "Traderie 要求這些欄位，但表單沒有填：Rarity"]);
  assert.equal(creates(noRarity).length, 0);
});

test("a create answered by a gateway error or nothing may exist: it says so, offers the own listings and no re-list", async () => {
  for (const createReply of [{ status: 502, body: "<html>bad gateway" }, null]) {
    const tab = fakeTab({ createReply });
    const outcome = await run(priced(), tab).result;
    assert.deepEqual([outcome.outcome, outcome.reason, outcome.unconfirmed], ["failed", UNCONFIRMED_REASON, true]);
    assert.equal(outcome.profileUrl, "https://traderie.com/diablo2resurrected/profile/77/listings");
    assert.equal(creates(tab).length, 1, "never sent twice");
  }
  const refused = await run(priced(), fakeTab({ createReply: { status: 400, body: { error: "bad" } } })).result;
  assert.equal(refused.unconfirmed, undefined, "a clear 4xx refusal is a plain failure");
});

test("the invite use is counted only after every check, right before the request; a refusal there posts nothing", async () => {
  const order = [];
  const tab = fakeTab();
  const evaluate = tab.evaluate;
  tab.evaluate = async (expression) => (expression.startsWith("POST(") ? (order.push("request"), evaluate(expression)) : evaluate(expression));
  const session = { tab: null, timeline: newTimeline() };
  await postListing({ form: priced(), tables, openTab: async () => tab, scripts, session, beforePost: async () => order.push("count") });
  assert.deepEqual(order, ["count", "request"]);

  // Nothing is counted when a check refuses first (here: a challenge page) ...
  const counted = [];
  const guard = fakeTab({ page: { url: PRODUCT_PAGE.url, title: "Just a moment...", text: "verify you are human" } });
  await postListing({ form: priced(), tables, openTab: async () => guard, scripts, session: { tab: null }, beforePost: async () => counted.push(1) });
  assert.deepEqual(counted, []);

  // ... and a used-up code stops the post with the server's words.
  const used = fakeTab();
  const outcome = await postListing({ form: priced(), tables, openTab: async () => used, scripts, session: { tab: null }, beforePost: async () => { throw new Error("這組邀請碼的 5 次查詢已用完"); } });
  assert.deepEqual([outcome.outcome, outcome.reason], ["refused", "這組邀請碼的 5 次查詢已用完"]);
  assert.equal(creates(used).length, 0);
});

test("what is about to be sent is logged and handed out before the request leaves", async () => {
  const tab = fakeTab();
  const order = [];
  const evaluate = tab.evaluate;
  tab.evaluate = async (expression) => {
    if (expression.startsWith("POST(")) order.push("request");
    return evaluate(expression);
  };
  const session = { tab: null, timeline: newTimeline() };
  await postListing({ form: priced(), tables, openTab: async () => tab, scripts, session, onSend: (body) => order.push(`onSend:${body.item}`) });
  assert.deepEqual(order, ["onSend:2487112490", "request"]);
  assert.ok(session.timeline.entries.findIndex((e) => e.stage === "post_listing_sent") < session.timeline.entries.findIndex((e) => e.stage === "post_listing"));
});

test("a challenge page is guard: no record read, no create", async () => {
  const tab = fakeTab({ page: { url: "https://traderie.com/diablo2resurrected/product/harlequin-crest", title: "Just a moment...", text: "verify you are human" } });
  const outcome = await run(priced(), tab).result;
  assert.equal(outcome.outcome, "guard");
  assert.equal(creates(tab).length, 0);
  assert.equal(tab.evaluated.length, 0, "the guard was read off the page text; nothing was fetched");
  assert.equal(tab.closed, 1);
});

test("a blocker refuses before anything is opened; a missing item record or rune refuses after the page, with no create", async () => {
  const noPrice = emptyListingForm(record(), tables, DEFAULT_LISTING);
  const tab = fakeTab();
  const { opened, result } = run(noPrice, tab);
  assert.deepEqual(await result, { outcome: "refused", reason: "請選擇想換的符文和數量，或勾「接受出價」", listingId: null, listingUrl: null, verified: false });
  assert.deepEqual(opened, []);

  const noItem = fakeTab({ answers: { "/api/diablo2resurrected/items?id=harlequin-crest&variants=&tags=&properties=&adding=true": { status: 404, body: "" } } });
  const missing = await run(priced(), noItem).result;
  assert.deepEqual([missing.outcome, missing.reason], ["refused", "Traderie 沒有這件物品的資料（HTTP 404）"]);
  assert.equal(creates(noItem).length, 0);

  const noRune = fakeTab({ answers: { "/api/diablo2resurrected/items?id=ber-rune&variants=&tags=&properties=&adding=true": { status: 200, body: { items: [] } } } });
  const rune = await run(priced(), noRune).result;
  assert.deepEqual([rune.outcome, rune.reason], ["refused", "找不到符文「Ber Rune」的 Traderie 資料"]);
  assert.equal(creates(noRune).length, 0);
});

test("a player the site would ask a captcha of is refused before the create", async () => {
  const tab = fakeTab({ answers: { "/api/games?game=diablo2resurrected": { status: 200, body: { games: { features: ["LISTINGS:CAPTCHA"] } } } } });
  const outcome = await run(priced(), tab).result;
  assert.deepEqual([outcome.outcome, outcome.reason], ["refused", "Traderie 要求驗證碼，無法代為上架"]);
  assert.equal(creates(tab).length, 0);
});

test("a create whose evaluate dies (stale page) is failed with the 確認 reason, is never sent again, and keeps its timeline entry", async () => {
  const tab = fakeTab({ createThrows: new StalePage("gone") });
  const { session, result } = run(priced(), tab);
  const outcome = await result;
  assert.deepEqual([outcome.outcome, outcome.reason], ["failed", UNCONFIRMED_REASON]);
  assert.equal(creates(tab).length, 1);
  assert.equal(session.timeline.entries.find((e) => e.stage === "post_listing")?.error, "StalePage");
  assert.equal(tab.closed, 1);
});

test("接受出價 posts no price rows and fetches no rune; a create the own listings do not show is posted but unverified", async () => {
  const form = emptyListingForm(record(), tables, DEFAULT_LISTING);
  form.makeOffer = true;
  const tab = fakeTab({ createReply: { status: 200, body: { success: true } }, answers: { "/api/diablo2resurrected/user?": { status: 200, body: { user: { id: "78" } } } } });
  tab.evaluate = ((inner) => async (expression) => {
    if (expression.includes("seller=78")) return { status: 200, body: { listings: [] } };
    return inner(expression);
  })(tab.evaluate);
  const outcome = await run(form, tab).result;
  assert.equal(tab.evaluated.some((e) => e.includes("id=ber-rune")), false);
  const body = JSON.parse(JSON.parse(`[${creates(tab)[0].slice("POST(".length, -1)}]`)[1]);
  assert.deepEqual([body.makeOffer, body.items], [true, []]);
  assert.deepEqual([outcome.outcome, outcome.verified, outcome.listingId, outcome.listingUrl, outcome.reason], ["posted", false, null, null, UNVERIFIED_NOTE]);

  // A create reply without an id, but seen in the own listings: the link comes from the newest listing of the item.
  const noId = fakeTab({ createReply: { status: 200, body: { success: true } }, answers: { "/api/diablo2resurrected/listings?itemTags=true&selling=true&auction=false&page=0&seller=77&completed=false&active=all": { status: 200, body: { listings: [{ id: "100", item_id: "2487112490" }, { id: "205", item_id: "2487112490" }, { id: "300", item_id: "1" }] } } } });
  const found = await run(priced(), noId).result;
  assert.deepEqual([found.verified, found.listingId, found.listingUrl], [true, "205", "https://traderie.com/diablo2resurrected/listing/205"]);
});
