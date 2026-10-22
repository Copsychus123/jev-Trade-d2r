// The 學習紀錄 block of the settings screen (learning-panel.js) on a hand-built DOM, with the real correction memory behind
// it: the count line, the one-step confirmation before clearing, and the ✕ that undoes one remembered pair.
import assert from "node:assert/strict";
import test from "node:test";

import { createCorrections } from "../src/ocr/corrections.js";
import { createValueCorrections } from "../src/ocr/value-corrections.js";
import { MAX_LISTED, countLine, initLearningPanel } from "../src/learning-panel.js";
import { indexTables } from "../src/traderie/lookup.js";

class Node {
  constructor(tag = "div") {
    this.tagName = tag;
    this.children = [];
    this.hidden = false;
    this.listeners = {};
    this.attributes = {};
    this.className = "";
    this._text = "";
  }
  get textContent() {
    return this.children.length ? this.children.map((c) => c.textContent).join("") : this._text;
  }
  set textContent(value) {
    this._text = String(value);
    this.children = [];
  }
  append(...nodes) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes) {
    this.children = [...nodes];
  }
  addEventListener(type, handler) {
    (this.listeners[type] ??= []).push(handler);
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  click() {
    for (const handler of this.listeners.click ?? []) handler({});
  }
}

const tables = indexTables({
  generated_at: "x",
  products: [
    { name: "Arachnid Mesh", slug: "arachnid-mesh", category: "uniques" },
    { name: "Ring Mail", slug: "ring-mail", category: "base" },
  ],
  zh: { 蜘蛛之網: "Arachnid Mesh", 鎖子甲: "Ring Mail" },
  bases: ["Ring Mail"],
  game_only: [],
});

async function setup({ withTables = true } = {}) {
  const ids = ["learn-count", "learn-clear", "learn-confirm", "learn-clear-yes", "learn-clear-no", "learn-details", "learn-list"];
  const byId = new Map(ids.map((id) => [id, new Node()]));
  byId.get("learn-confirm").hidden = true;
  globalThis.document = { getElementById: (id) => byId.get(id), createElement: (tag) => new Node(tag) };
  const memoryOptions = { storage: { get: async () => undefined, set: async () => {} }, setTimer: () => 0, clearTimer: () => {} };
  let clock = 1000;
  const now = () => (clock += 1); // every learn is a later moment, so "newest first" is not a tie
  const corrections = createCorrections({ ...memoryOptions, now });
  const baseCorrections = createCorrections({ ...memoryOptions, only: "base", now });
  const valueCorrections = createValueCorrections({ ...memoryOptions, now });
  await Promise.all([corrections.load(), baseCorrections.load(), valueCorrections.load()]);
  corrections.attach(tables);
  baseCorrections.attach(tables);
  initLearningPanel({ corrections, baseCorrections, valueCorrections, getTables: () => (withTables ? tables : null) });
  const el = (id) => byId.get(id);
  return { corrections, baseCorrections, valueCorrections, el, rows: () => el("learn-list").children };
}

test("with nothing remembered the block says so, and offers neither clearing nor a list", async () => {
  const s = await setup();
  assert.equal(s.el("learn-count").textContent, "還沒有記住任何更正。");
  assert.equal(s.el("learn-clear").hidden, true);
  assert.equal(s.el("learn-details").hidden, true);
});

test("the count line says how many are remembered and how many are already sure", async () => {
  const s = await setup();
  s.corrections.learn("蜘蛛之網x", "Arachnid Mesh");
  s.corrections.learn("鎖子甲x", "Ring Mail");
  s.corrections.learn("鎖子甲x", "Ring Mail");

  assert.equal(s.el("learn-count").textContent, "已記住 2 筆更正：名稱 2 筆（其中 1 筆選過 2 次以上，下次會自動填入）。");
  assert.equal(countLine(), "還沒有記住任何更正。");
  assert.equal(s.el("learn-clear").hidden, false);
  assert.equal(s.el("learn-details").hidden, false);
});

test("names, bases and numbers are one list, newest first, each with its own sentence and its own ✕", async () => {
  const s = await setup();
  s.corrections.learn("蜘蛛之網x", "Arachnid Mesh");
  s.baseCorrections.learn("rondache", "Ring Mail");
  s.baseCorrections.learn("rondache", "Ring Mail");
  s.valueCorrections.learn("+7% Faster Cast Rate", "fcr", 8);

  assert.deepEqual(s.rows().map((row) => row.children[0].textContent), [
    "讀到「7 faster cast rate」→ 數值 8（改過 1 次）",
    "讀到「rondache」→ 底材 鎖子甲（Ring Mail）（改過 2 次）",
    "讀到「蜘蛛之網x」→ 蜘蛛之網（Arachnid Mesh）（選過 1 次）",
  ]);
  assert.equal(
    s.el("learn-count").textContent,
    "已記住 3 筆更正：名稱 1 筆（其中 0 筆選過 2 次以上，下次會自動填入）、底材 1 筆（其中 1 筆改過 2 次以上，下次會直接用）、數值 1 筆（下次直接填）。",
  );

  s.rows()[0].children[1].click();
  assert.equal(s.valueCorrections.size, 0);
  assert.equal(s.baseCorrections.size, 1);
  assert.equal(s.corrections.size, 1);

  s.el("learn-clear").click();
  s.el("learn-clear-yes").click();
  assert.equal(s.baseCorrections.size + s.corrections.size, 0);
});

test("each remembered pair is a plain Chinese sentence with a ✕, newest first", async () => {
  const s = await setup();
  s.corrections.learn("蜘蛛之網x", "Arachnid Mesh");
  s.corrections.learn("鎖子甲x", "Ring Mail");

  assert.deepEqual(s.rows().map((row) => row.children[0].textContent), [
    "讀到「鎖子甲x」→ 鎖子甲（Ring Mail）（選過 1 次）",
    "讀到「蜘蛛之網x」→ 蜘蛛之網（Arachnid Mesh）（選過 1 次）",
  ]);
  assert.equal(s.rows()[0].children[1].attributes["aria-label"], "刪除這筆學習：鎖子甲x");
});

test("the ✕ undoes one pair and leaves the others", async () => {
  const s = await setup();
  s.corrections.learn("蜘蛛之網x", "Arachnid Mesh");
  s.corrections.learn("鎖子甲x", "Ring Mail");

  s.rows()[0].children[1].click();

  assert.deepEqual(s.corrections.list().map((e) => e.key), ["蜘蛛之網x"]);
  assert.equal(s.rows().length, 1);
  assert.equal(s.el("learn-count").textContent.startsWith("已記住 1 筆"), true);
});

test("clearing takes two steps: the first press only asks, cancelling keeps everything, confirming clears", async () => {
  const s = await setup();
  s.corrections.learn("蜘蛛之網x", "Arachnid Mesh");

  s.el("learn-clear").click();
  assert.equal(s.el("learn-confirm").hidden, false, "the question shows");
  assert.equal(s.el("learn-clear").hidden, true, "in place of the button");
  assert.equal(s.corrections.size, 1, "and nothing is cleared yet");

  s.el("learn-clear-no").click();
  assert.equal(s.el("learn-confirm").hidden, true);
  assert.equal(s.corrections.size, 1);
  assert.equal(s.el("learn-clear").hidden, false);

  s.el("learn-clear").click();
  s.el("learn-clear-yes").click();
  assert.equal(s.corrections.size, 0);
  assert.equal(s.el("learn-confirm").hidden, true);
  assert.equal(s.el("learn-count").textContent, "還沒有記住任何更正。");
});

test("a long list shows the newest pairs and counts the rest", async () => {
  const s = await setup();
  for (let i = 0; i < MAX_LISTED + 4; i += 1) s.corrections.learn(`蜘蛛之網${i}`, "Arachnid Mesh");

  assert.equal(s.rows().length, MAX_LISTED + 1);
  assert.equal(s.rows().at(-1).textContent, "還有 4 筆沒有列出。");
});

test("before the item tables are there the pairs are shown with the English name", async () => {
  const s = await setup({ withTables: false });
  s.corrections.learn("蜘蛛之網x", "Arachnid Mesh");
  assert.equal(s.rows()[0].children[0].textContent, "讀到「蜘蛛之網x」→ Arachnid Mesh（選過 1 次）");
});
