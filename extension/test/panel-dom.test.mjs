// panel-dom.js writes what the player sees in the drawers; nothing executed it under node, so a change to the row
// shape, a class name or a textContent join could ship unnoticed. This drives the real module against a minimal DOM
// fake and reads the boxes back as structure + text. Page text is untrusted: `<b>` and newlines must land as TEXT.

import assert from "node:assert/strict";
import test from "node:test";

// --- a DOM just big enough for the module ---------------------------------------------------------------------
// page text must never reach a markup sink: setting innerHTML throws, so a regression that switches to markup fails.
const MARKUP_SINK = () => {
  throw new Error("innerHTML is a markup sink; panel-dom writes textContent only");
};

class FakeNode {
  constructor(tag) {
    this.nodeType = 1;
    this.tagName = tag;
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.className = "";
    this.hidden = false;
    this.disabled = false;
    this._text = "";
    this.listeners = {};
    this.classList = {
      add: () => {},
      remove: () => {},
      toggle: () => {},
      contains: () => false,
    };
  }

  get textContent() {
    return this.children.length ? this.children.map((child) => child.textContent).join("") : this._text;
  }

  set textContent(value) {
    this._text = String(value);
    this.children = [];
  }

  set innerHTML(_value) {
    MARKUP_SINK();
  }

  append(...nodes) {
    for (const node of nodes) {
      this.children.push(typeof node === "string" ? { nodeType: 3, textContent: node } : node);
    }
  }

  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  addEventListener(type, handler) {
    (this.listeners[type] ??= []).push(handler);
  }
}

function makeDocument(ids) {
  const byId = new Map(ids.map((id) => [id, new FakeNode("div")]));
  return {
    byId,
    createElement: (tag) => new FakeNode(tag),
    createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
    getElementById: (id) => byId.get(id) ?? null,
    querySelectorAll: () => [],
  };
}

/** A plain reading of a node: tag, class, dataset, attributes and text — enough to pin exact structure. */
function tree(node) {
  if (node.nodeType === 3) return { text: node.textContent };
  const out = { tag: node.tagName };
  if (node.className) out.className = node.className;
  if (node.attributes["aria-hidden"] !== undefined) out.ariaHidden = node.attributes["aria-hidden"];
  if (Object.keys(node.dataset).length) out.dataset = { ...node.dataset };
  if (node.hidden) out.hidden = true;
  if (node.children.length === 0) out.text = node.textContent;
  else out.children = node.children.map(tree);
  return out;
}

const IDS = ["trust", "trust-line", "trust-more", "trust-head", "trust-reasons", "steps", "progress-status"];

let document;
let byId;
let drawTrust;
let drawProgress;
let drawListings;
let drawRecent;
let drawStatsListings;

test.before(async () => {
  document = makeDocument(IDS);
  byId = document.byId;
  globalThis.document = document;
  ({ drawListings, drawProgress, drawRecent, drawStatsListings, drawTrust } = await import("../src/panel-dom.js"));
});

const list = () => document.createElement("ol");

// --- drawTrust ------------------------------------------------------------------------------------------------

test("trust: a passed verification shows the checked line with how the product was found and when", () => {
  const observed = "2026-01-02T03:04:05Z";
  drawTrust({ verification: { passed: true, observed_at: observed }, lookup: { layer: "table" } });
  assert.equal(byId.get("trust").dataset.kind, "ok");
  assert.equal(byId.get("trust").dataset.layer, "table");
  assert.equal(byId.get("trust-line").hidden, false);
  assert.equal(byId.get("trust-more").hidden, true);
  // The SHAPE of the line, not an expectation built from the module's own clock(): a regression in clock() would move
  // both sides of an equality and stay invisible. The stamp has to read as HH:MM.
  assert.match(byId.get("trust-line").textContent, /^✔ 資料已核對 · 查表直接開啟 · \d{2}:\d{2}$/);
  assert.deepEqual(byId.get("trust-reasons").children, []);
});

test("trust: a failed verification hides the ok line and lists each reason once, under the warning head", () => {
  drawTrust({
    verification: { passed: false, failed_checks: ["product_page", "item_match", "product_page"] },
    lookup: null,
  });
  assert.equal(byId.get("trust").dataset.kind, "warn");
  assert.equal(byId.get("trust").dataset.layer, "");
  assert.equal(byId.get("trust-line").hidden, true);
  assert.equal(byId.get("trust-line").textContent, "");
  assert.equal(byId.get("trust-more").hidden, false);
  assert.equal(byId.get("trust-head").textContent, "⚠ 部分資料沒通過核對 ›");
  assert.deepEqual(tree(byId.get("trust-reasons")).children, [
    { tag: "li", text: "無法確認進到了商品頁面" },
    { tag: "li", text: "這頁面不像是你找的商品" },
  ]);
});

test("trust: no verification at all shows neither line nor reasons", () => {
  drawTrust({ verification: null, lookup: { layer: "search" } });
  assert.equal(byId.get("trust").dataset.kind, "none");
  assert.equal(byId.get("trust").dataset.layer, "search");
  assert.equal(byId.get("trust-line").hidden, true);
  assert.equal(byId.get("trust-more").hidden, true);
  assert.equal(byId.get("trust-line").textContent, "");
  assert.equal(byId.get("trust-head").textContent, "");
  assert.deepEqual(byId.get("trust-reasons").children, []);
});

// --- drawProgress ---------------------------------------------------------------------------------------------

const stepTree = (state, mark, label, name, detail) => {
  const li = { tag: "li", dataset: { state }, children: [
    { tag: "span", className: "mark", ariaHidden: "true", text: mark },
    { tag: "span", text: label },
    { tag: "span", className: "sr", text: `（${name}）` },
  ] };
  if (detail) li.children.push({ tag: "small", text: detail });
  return li;
};

test("progress: the four steps carry mark, screen-reader name and the current status line", () => {
  const market = {
    mode: "name",
    lookup: { layer: "table" },
    trading: { status: "PASSED" },
    recent_trades: { status: "FAILED", reason: "沒有打開近期成交頁面" },
    verification: null,
  };
  drawProgress({ market, phase: null, running: true, statusText: "讀取中…" });
  assert.deepEqual(tree(byId.get("steps")).children, [
    stepTree("done", "✔", "找到商品", "完成", "查表直接開啟"),
    stepTree("done", "✔", "讀取目前掛單", "完成", ""),
    stepTree("failed", "✖", "讀取近期成交", "失敗", "沒有打開近期成交頁面"),
    stepTree("active", "●", "核對資料", "進行中", ""),
  ]);
  assert.equal(byId.get("progress-status").textContent, "讀取中…");
});

test("progress: every step is pending before anything runs", () => {
  const market = {
    mode: "name",
    lookup: null,
    trading: { status: "NOT_RUN" },
    recent_trades: { status: "NOT_RUN" },
    verification: null,
  };
  drawProgress({ market, phase: null, running: false, statusText: "" });
  assert.deepEqual(tree(byId.get("steps")).children, [
    stepTree("pending", "○", "找到商品", "還沒開始", ""),
    stepTree("pending", "○", "讀取目前掛單", "還沒開始", ""),
    stepTree("pending", "○", "讀取近期成交", "還沒開始", ""),
    stepTree("pending", "○", "核對資料", "還沒開始", ""),
  ]);
});

test("progress: the step being worked on is active, and verification done/failed follow its verdict", () => {
  const findActive = {
    mode: "name",
    lookup: null,
    trading: { status: "NOT_RUN" },
    recent_trades: { status: "NOT_RUN" },
    verification: null,
  };
  drawProgress({ market: findActive, phase: null, running: true, statusText: "" });
  assert.equal(byId.get("steps").children[0].dataset.state, "active");
  assert.equal(byId.get("steps").children[1].dataset.state, "pending");

  const verifying = {
    mode: "name",
    lookup: { layer: "base" },
    trading: { status: "PASSED" },
    recent_trades: { status: "PASSED" },
  };
  drawProgress({ market: { ...verifying, verification: { passed: true } }, phase: null, running: true, statusText: "" });
  assert.equal(byId.get("steps").children[3].dataset.state, "done");
  assert.equal(byId.get("steps").children[3].children[0].textContent, "✔");

  drawProgress({
    market: { ...verifying, verification: { passed: false, failed_checks: ["item_match"] } },
    phase: null,
    running: true,
    statusText: "",
  });
  assert.equal(byId.get("steps").children[3].dataset.state, "failed");
  assert.equal(byId.get("steps").children[3].children[0].textContent, "✖");
});

// --- drawListings / drawRecent / drawStatsListings ------------------------------------------------------------

const fullTrade = {
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

test("listings: price and seller on line 1, the merged environment (and the other details) as small extra text", () => {
  const ol = list();
  drawListings(ol, [fullTrade]);
  assert.deepEqual(tree(ol), {
    tag: "ol",
    children: [
      {
        tag: "li",
        children: [
          {
            tag: "div",
            className: "line1",
            children: [
              { tag: "strong", text: "2 Ist" },
              { tag: "span", className: "side", text: "阿明" },
            ],
          },
          { tag: "div", className: "line2", text: "12:00 · PC / Softcore / Ladder · 2.6 · 5" },
        ],
      },
    ],
  });
});

test("listings: an empty cell shows a dash and empty details leave the second line out", () => {
  const ol = list();
  drawListings(ol, [
    {
      seller: null,
      ask: "",
      high_rune_value: null,
      posted_time: null,
      platform: null,
      mode: null,
      ladder: null,
      defense: null,
      game_version: null,
    },
  ]);
  const li = ol.children[0];
  assert.equal(li.children[0].children[0].textContent, "—");
  assert.equal(li.children[0].children[1].textContent, "—");
  assert.equal(li.children.length, 1, "no line2 when every detail is empty");
});

test("recent: the item and its price on line 1, time and environment as small extra text", () => {
  const ol = list();
  drawRecent(ol, [
    {
      buyer_or_seller: "賣家甲",
      price: "1 Ber",
      trade_time: "昨天",
      platform: "PC",
      mode: "Hardcore",
      ladder: "Non-Ladder",
      game_version: "2.7",
    },
  ]);
  assert.deepEqual(tree(ol).children[0], {
    tag: "li",
    children: [
      {
        tag: "div",
        className: "line1",
        children: [
          { tag: "strong", text: "賣家甲" },
          { tag: "span", className: "side", text: "1 Ber" },
        ],
      },
      { tag: "div", className: "line2", text: "昨天 · PC / Hardcore / Non-Ladder · 2.7" },
    ],
  });
});

test("stats listings: the item sits with the price on line 1 and the seller beside it", () => {
  const ol = list();
  drawStatsListings(ol, [fullTrade]);
  const line1 = ol.children[0].children[0];
  assert.equal(line1.children[0].textContent, "— ・ 2 Ist", "a row without an item name dashes the title");
  assert.equal(line1.children[1].textContent, "阿明");
  assert.equal(ol.children[0].children[1].textContent, "12:00 · PC / Softcore / Ladder · 2.6 · 5");

  const named = list();
  drawStatsListings(named, [{ item_name: "軍帽", ...fullTrade, seller: "小明" }]);
  assert.equal(named.children[0].children[0].children[0].textContent, "軍帽 ・ 2 Ist");
  assert.equal(named.children[0].children[0].children[1].textContent, "小明");
});

// --- untrusted page text --------------------------------------------------------------------------------------

test("page text reaches the DOM as TEXT: the raw value is kept, angle brackets and all", () => {
  const ol = list();
  const hostile = "<b>壞</b>|x\ny";
  drawListings(ol, [{ ...fullTrade, seller: hostile, posted_time: hostile }]);
  const line1 = ol.children[0].children[0];
  const side = line1.children[1];
  assert.equal(side.textContent, hostile, "the raw text is kept, angle brackets and all");
  assert.deepEqual(tree(side), { tag: "span", className: "side", text: hostile }, "and it is one text leaf, not a parse");
  const line2 = ol.children[0].children[1];
  assert.equal(line2.textContent, `${hostile} · PC / Softcore / Ladder · 2.6 · 5`);
});
