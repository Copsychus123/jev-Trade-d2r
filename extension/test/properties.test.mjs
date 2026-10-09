import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import {
  PROPERTIES_KEY,
  PROPERTIES_TTL_MS,
  cachedProperties,
  ensureProperties,
  loadProperties,
  normalizeProperties,
  propertiesAge,
} from "../src/traderie/properties.js";

const DAY = 24 * 3600 * 1000;
const NOW = Date.parse("2026-10-05T12:00:00Z");
const API = { properties: [{ id: 520, name: "+{{value}}% Faster Cast Rate", type: "number", options: null }] };

class FakeStore {
  constructor(data = {}) {
    this.data = data;
    this.writes = 0;
  }
  async get(key) {
    return key in this.data ? { [key]: this.data[key] } : {};
  }
  async set(values) {
    this.writes += 1;
    Object.assign(this.data, values);
  }
}

class FakeTab {
  constructor(reply) {
    this.reply = reply;
    this.calls = [];
    this.closes = 0;
  }
  async evaluate(expression, options) {
    this.calls.push({ expression, options });
    return this.reply;
  }
  async close() {
    this.closes += 1;
  }
}

const scripts = { fetchJson: "(async (path) => path)" };

test("the answer is reduced to id, name, type, options and a label with X for the number", () => {
  const [p] = normalizeProperties({ properties: [...API.properties, { id: "x", name: "bad", type: "number" }, null, { id: 1 }] });
  assert.deepEqual(p, { id: 520, name: "+{{value}}% Faster Cast Rate", type: "number", options: null, label: "+X% Faster Cast Rate" });
  assert.equal(normalizeProperties({ properties: [...API.properties, { id: "x", name: "bad", type: "number" }] }).length, 1);
  assert.deepEqual(normalizeProperties(null), []);
  assert.deepEqual(normalizeProperties({ properties: "nope" }), []);
});

test("a copy younger than a week is used without asking Traderie", async () => {
  const properties = normalizeProperties(API);
  const store = new FakeStore({ [PROPERTIES_KEY]: { fetchedAt: NOW - 3 * DAY, properties } });
  const tab = new FakeTab({ status: 500, body: "" });
  assert.deepEqual(await loadProperties({ tab, scripts, store, now: NOW }), { properties, cacheHit: true });
  assert.equal(tab.calls.length, 0);
});

test("an old or missing copy is read once from Traderie and stored with its time", async () => {
  const store = new FakeStore({ [PROPERTIES_KEY]: { fetchedAt: NOW - PROPERTIES_TTL_MS - 1, properties: normalizeProperties(API) } });
  const tab = new FakeTab({ status: 200, body: API });
  const { properties, cacheHit } = await loadProperties({ tab, scripts, store, now: NOW });
  assert.equal(properties[0].id, 520);
  assert.equal(cacheHit, false);
  assert.equal(tab.calls.length, 1);
  assert.match(tab.calls[0].expression, /^\(async \(path\) => path\)\("\/api\/diablo2resurrected\/properties\?global=true"\)$/u);
  assert.equal(tab.calls[0].options.awaitPromise, true);
  assert.equal(store.data[PROPERTIES_KEY].fetchedAt, NOW);
  assert.equal(store.writes, 1);
});

test("a refused read is an error that names the last good copy, and the old copy is not used", async () => {
  const store = new FakeStore({ [PROPERTIES_KEY]: { fetchedAt: NOW - 9 * DAY, properties: normalizeProperties(API) } });
  const tab = new FakeTab({ status: 403, body: "Just a moment" });
  await assert.rejects(loadProperties({ tab, scripts, store, now: NOW }), /HTTP 403.*上次取得：2026-09-26/u);
  assert.equal(store.writes, 0);
  await assert.rejects(loadProperties({ tab: new FakeTab({ status: 200, body: { properties: [] } }), scripts, store: new FakeStore(), now: NOW }), /無法取得 Traderie 屬性清單/u);
});

test("ensureProperties uses a fresh copy without opening a Traderie tab", async () => {
  const properties = normalizeProperties(API);
  const store = new FakeStore({ [PROPERTIES_KEY]: { fetchedAt: NOW - 3 * DAY, properties } });
  let opened = 0;
  const openTab = async () => {
    opened += 1;
    return new FakeTab({ status: 500, body: "" });
  };
  assert.deepEqual(await ensureProperties({ openTab, scripts, store, now: NOW }), { properties, cacheHit: true });
  assert.equal(opened, 0);
});

test("ensureProperties opens one tab, reads once and stores the list when the copy is old, then closes that tab", async () => {
  const store = new FakeStore({ [PROPERTIES_KEY]: { fetchedAt: NOW - PROPERTIES_TTL_MS - 1, properties: normalizeProperties(API) } });
  const tab = new FakeTab({ status: 200, body: API });
  let opened = 0;
  const openTab = async () => {
    opened += 1;
    return tab;
  };
  const { properties, cacheHit } = await ensureProperties({ openTab, scripts, store, now: NOW });
  assert.equal(properties[0].id, 520);
  assert.equal(cacheHit, false);
  assert.equal(opened, 1);
  assert.equal(tab.calls.length, 1);
  assert.equal(store.data[PROPERTIES_KEY].fetchedAt, NOW);
  assert.equal(store.writes, 1);
  assert.equal(tab.closes, 1);
});

test("ensureProperties treats a failed read as an error, keeps no old copy and always closes the tab", async () => {
  const store = new FakeStore({ [PROPERTIES_KEY]: { fetchedAt: NOW - 9 * DAY, properties: normalizeProperties(API) } });
  const tab = new FakeTab({ status: 403, body: "Just a moment" });
  await assert.rejects(ensureProperties({ openTab: async () => tab, scripts, store, now: NOW }), /HTTP 403.*上次取得：2026-09-26/u);
  assert.equal(store.writes, 0);
  assert.equal(tab.closes, 1);
  const empty = new FakeTab({ status: 200, body: { properties: [] } });
  await assert.rejects(
    ensureProperties({ openTab: async () => empty, scripts, store: new FakeStore(), now: NOW }),
    /無法取得 Traderie 屬性清單/u,
  );
  assert.equal(empty.closes, 1);
});

test("a damaged stored value counts as no copy", async () => {
  assert.equal(await cachedProperties(new FakeStore({ [PROPERTIES_KEY]: { fetchedAt: "yesterday", properties: [] } })), null);
  assert.equal(await cachedProperties(new FakeStore({ [PROPERTIES_KEY]: "garbage" })), null);
  assert.equal(await cachedProperties(new FakeStore()), null);
});

test("the settings line says when the list was read and how many properties it has", () => {
  assert.equal(propertiesAge(null), "Traderie 屬性清單：尚未取得（第一次查詢時會自動取得）");
  assert.equal(
    propertiesAge({ fetchedAt: NOW, properties: normalizeProperties(API) }),
    "Traderie 屬性清單：2026-10-05 取得（1 項）",
  );
});

test("the page script that reads Traderie's list is a function expression that can be called with a path", async () => {
  const text = readFileSync(new URL("../../src/jev_ultrafast/traderie/fetch_json.js", import.meta.url), "utf8").trim();
  const asked = [];
  const page = {
    localStorage: { getItem: (key) => (key === "jwt" ? "token-1" : null) },
    fetch: async (path, options) => {
      asked.push([path, options]);
      return { status: 200, text: async () => '{"properties":[]}' };
    },
  };
  const reply = await runInNewContext(`${text}("/api/x?y=1")`, page);
  assert.deepEqual(JSON.parse(JSON.stringify(reply)), { status: 200, body: { properties: [] } });
  assert.equal(asked[0][0], "/api/x?y=1");
  assert.equal(asked[0][1].credentials, "include");
  assert.equal(asked[0][1].headers.Authorization, "Bearer token-1");
  const refused = await runInNewContext(`${text}("/api/x")`, {
    ...page,
    fetch: async () => ({ status: 403, text: async () => "Just a moment..." }),
  });
  assert.deepEqual(JSON.parse(JSON.stringify(refused)), { status: 403, body: "Just a moment..." });
});
