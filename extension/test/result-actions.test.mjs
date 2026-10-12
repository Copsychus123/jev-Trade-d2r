// result-actions.js decides what the export buttons do — the export gate (a failed verification refuses the file and
// says why), the CSV the download writes and the TSV the copy button puts on the clipboard. No test executed it.
//
// copy() also takes its label back on a timer; setTimeout/clearTimeout are captured here so no test leaves one running.
//
// The module imports "./csv.js", which ships only into extension/dist (extension/build.py copies it from
// src/jev_ultrafast/static/csv.js, it is not in extension/src). A tiny resolve hook points that one specifier at the
// real source file, so the shipped module runs as it is written.

import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const csvUrl = pathToFileURL(fileURLToPath(new URL("../../src/jev_ultrafast/static/csv.js", import.meta.url))).href;
const loader = `export async function resolve(specifier, context, next) {
  if (specifier === "./csv.js" && context.parentURL?.endsWith("/result-actions.js")) {
    return { url: ${JSON.stringify(csvUrl)}, shortCircuit: true };
  }
  return next(specifier, context);
}`;
register(new URL("data:text/javascript;base64," + Buffer.from(loader).toString("base64")));

const { createResultActions } = await import("../src/result-actions.js");

// --- a DOM just big enough for result-actions + download.js ---------------------------------------------------
class FakeNode {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.className = "";
    this.hidden = false;
    this.disabled = false;
    this._text = "";
    this.classList = { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false };
  }

  get textContent() {
    return this.children.length ? this.children.map((child) => child.textContent).join("") : this._text;
  }

  set textContent(value) {
    this._text = String(value);
    this.children = [];
  }

  set innerHTML(_value) {
    throw new Error("innerHTML is a markup sink");
  }

  append(...nodes) {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  click() {
    this.clicked = (this.clicked ?? 0) + 1;
  }

  addEventListener() {}
}

// The download path: saveText builds a Blob, asks URL for an object URL and clicks an anchor.
const anchors = [];
const blobs = [];

class FakeBlob {
  constructor(parts, options = {}) {
    this.parts = parts;
    this.type = options.type;
    blobs.push(this);
  }
}

const realCreate = URL.createObjectURL;
const realRevoke = URL.revokeObjectURL;
const realBlob = globalThis.Blob;
URL.createObjectURL = () => `blob:test/${blobs.length}`;
URL.revokeObjectURL = () => {};
globalThis.Blob = FakeBlob;

const writes = [];
const tabs = [];
let activeTab = "trading";
// node defines `navigator` read-only, so the clipboard holder is swapped with defineProperty.
Object.defineProperty(globalThis, "navigator", {
  value: { clipboard: { writeText: async (text) => writes.push(text) } },
  configurable: true,
});
globalThis.chrome = { tabs: { create: (options) => tabs.push(options) } };

const note = new FakeNode("p");
const copyButton = new FakeNode("button");
copyButton.textContent = "複製";
const document = {
  getElementById: (id) => (id === "result-note" ? note : id === "result-copy" ? copyButton : null),
  createElement: (tag) => {
    const node = new FakeNode(tag);
    if (tag === "a") anchors.push(node);
    return node;
  },
  createTextNode: (text) => ({ textContent: String(text) }),
  querySelectorAll: () => [],
};
globalThis.document = document;

// copy() arms a reset timer (1.5 s in the module). Nothing here waits for it, and a real one would outlive the test
// that armed it, so timers are captured and fired by hand - the same trick name-suggest.test.mjs uses for its delay.
const timers = [];
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
globalThis.setTimeout = (fn, ms = 0, ...args) => {
  const timer = { fn, ms, args };
  timers.push(timer);
  return timer;
};
globalThis.clearTimeout = (timer) => {
  const index = timers.indexOf(timer);
  if (index >= 0) timers.splice(index, 1);
};

test.after(() => {
  URL.createObjectURL = realCreate;
  URL.revokeObjectURL = realRevoke;
  globalThis.Blob = realBlob;
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
});

// --- fixtures -------------------------------------------------------------------------------------------------

const rowOne = {
  seller: "阿明",
  ask: "2 Ist",
  high_rune_value: 5,
  posted_time: "12:00",
  platform: "PC",
  mode: "Softcore",
  ladder: "Ladder",
  defense: null,
  game_version: "2.6",
};
const rowTwo = {
  seller: "小明",
  ask: "3 Ber",
  high_rune_value: null,
  posted_time: null,
  platform: "PC",
  mode: "Hardcore",
  ladder: "Non-Ladder",
  defense: "10",
  game_version: "2.7",
};

let market;
let rows;
let actions;

test.beforeEach(() => {
  anchors.length = 0;
  blobs.length = 0;
  writes.length = 0;
  tabs.length = 0;
  timers.length = 0;
  note.textContent = "";
  note.hidden = true;
  copyButton.textContent = "複製";
  activeTab = "trading";
  market = { mode: "name", verification: null, trading: { url: "https://www.traderie.com/diablo2resurrected/product/magefist" } };
  rows = { trading: [rowOne, rowTwo], recent_trades: [] };
  actions = createResultActions({
    getMarket: () => market,
    rowsOf: (key) => rows[key] ?? [],
    getItemName: () => "Magefist",
    getActiveTab: () => activeTab,
  });
});

// --- the export gate ------------------------------------------------------------------------------------------

test("a failed verification refuses the export with the exact sentence, and nothing leaves the machine", async () => {
  market.verification = { passed: false, failed_checks: ["product_page", "item_match"] };
  actions.download("trading");
  assert.equal(note.textContent, "部分資料沒通過核對：無法確認進到了商品頁面；這頁面不像是你找的商品");
  assert.equal(note.hidden, false);
  assert.equal(anchors.length, 0, "no CSV was written");

  await actions.copy("trading");
  assert.equal(note.textContent, "部分資料沒通過核對：無法確認進到了商品頁面；這頁面不像是你找的商品");
  assert.equal(note.hidden, false);
  assert.equal(writes.length, 0, "nothing was copied");
});

test("a failed verification with no named checks uses the headline alone", () => {
  market.verification = { passed: false, failed_checks: [] };
  actions.download("trading");
  assert.equal(note.textContent, "部分資料沒通過核對");
  assert.equal(note.hidden, false);
  assert.equal(anchors.length, 0);
});

test("a run with no verification at all exports as before", async () => {
  assert.equal(market.verification, null, "nothing was ever checked");
  actions.download("trading");
  assert.equal(note.hidden, true, "an unchecked run is never locked out of its own data");
  assert.equal(anchors.length, 1, "the CSV is written");
  assert.equal(anchors[0].clicked, 1, "and the anchor is clicked, which is what hands the file to Chrome");
  await actions.copy("trading");
  assert.equal(writes.length, 1, "and the rows still copy");
});

test("a passed run with rows hides the note and writes the CSV under the item name and the tab label", () => {
  market.verification = { passed: true };
  note.hidden = false;
  note.textContent = "old warning";
  actions.download("trading");

  assert.equal(note.hidden, true, "the note is hidden again once the export goes ahead");
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].download, "traderie-Magefist-目前掛單.csv");
  assert.equal(anchors[0].href, "blob:test/1");
  assert.equal(anchors[0].clicked, 1, "the anchor is clicked, which is what hands the file to Chrome");
  const blob = blobs[0];
  assert.equal(blob.type, "text/csv;charset=utf-8");
  const csv = blob.parts[0];
  assert.equal(
    csv,
    "\uFEFF" +
      "賣家,要價,高符文價值,刊登時間,平台 / 模式 / 天梯,防禦,遊戲版本\r\n" +
      "阿明,2 Ist,5,12:00,PC / Softcore / Ladder,,2.6\r\n" +
      "小明,3 Ber,,,PC / Hardcore / Non-Ladder,10,2.7\r\n",
  );
});

test("a passed run with no rows does nothing at all", async () => {
  market.verification = { passed: true };
  rows.trading = [];
  actions.download("trading");
  assert.equal(note.hidden, true);
  assert.equal(anchors.length, 0, "no file for an empty list");
  await actions.copy("trading");
  assert.equal(writes.length, 0, "no clipboard write for an empty list");
});

// --- copy -----------------------------------------------------------------------------------------------------

test("copy writes the tab-separated rows and reports how many, then the label can be reset", async () => {
  market.verification = { passed: true };
  await actions.copy("trading");
  assert.equal(
    writes[0],
    "賣家\t要價\t高符文價值\t刊登時間\t平台 / 模式 / 天梯\t防禦\t遊戲版本\n" +
      "阿明\t2 Ist\t5\t12:00\tPC / Softcore / Ladder\t\t2.6\n" +
      "小明\t3 Ber\t\t\tPC / Hardcore / Non-Ladder\t10\t2.7\n",
  );
  assert.equal(copyButton.textContent, "已複製 2 筆");
  assert.equal(note.hidden, true);
  // The label is taken back by itself after a moment: the reset is armed here, and firing it is what restores the
  // button (the module's own delay is its business; only that it is deferred, never synchronous).
  assert.equal(timers.length, 1, "one reset is armed");
  assert.ok(timers[0].ms > 0, "the reset is deferred, not synchronous");
  timers[0].fn();
  assert.equal(copyButton.textContent, "複製");
  assert.equal(timers.length, 0, "firing it clears it");
  actions.resetCopyLabel();
  assert.equal(copyButton.textContent, "複製");
  assert.equal(note.hidden, true);
});

test("copy on a tab the player has switched away from shows no label", async () => {
  market.verification = { passed: true };
  activeTab = "recent_trades";
  await actions.copy("trading");
  assert.equal(writes.length, 1, "the rows still went to the clipboard");
  assert.equal(copyButton.textContent, "複製", "but the feedback belongs to the other tab, so none is shown");
  assert.equal(timers.length, 0, "and no label means no reset armed behind the player's back");
});

test("a clipboard that refuses shows the failure label and copies nothing", async () => {
  market.verification = { passed: true };
  const realWriteText = navigator.clipboard.writeText;
  navigator.clipboard.writeText = async () => {
    throw new Error("permission denied");
  };
  try {
    await actions.copy("trading");
  } finally {
    navigator.clipboard.writeText = realWriteText;
  }
  assert.equal(copyButton.textContent, "複製失敗");
  assert.equal(writes.length, 0, "nothing reached the clipboard");
  assert.equal(timers.length, 1, "the failure label is taken back on the same timer");
  timers[0].fn();
  assert.equal(copyButton.textContent, "複製");
});

// --- open the site --------------------------------------------------------------------------------------------

test("open the site only opens an address the product page or home page can take", () => {
  actions.openSite("trading");
  assert.deepEqual(tabs, [{ url: "https://www.traderie.com/diablo2resurrected/product/magefist" }]);
  market.trading.url = "https://example.com/";
  actions.openSite("trading");
  assert.equal(tabs.length, 1, "an unknown address opens nothing");
});
