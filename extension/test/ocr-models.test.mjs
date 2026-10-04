import assert from "node:assert/strict";
import test from "node:test";

import { ModelError, createModelManager, sha256Hex } from "../src/ocr/models.js";

const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const good = { eng: { url: "https://example.test/eng", bytes: bytes.length, sha256: await sha256Hex(bytes) } };

function memoryStore() {
  const data = new Map();
  return { data, get: async (k) => data.get(k), put: async (k, v) => void data.set(k, v) };
}

const reply = (body, status = 200) => ({
  ok: status === 200,
  status,
  body: { getReader: () => ({ chunks: [body.slice(0, 3), body.slice(3)], read: async function () { const v = this.chunks.shift(); return v ? { done: false, value: v } : { done: true }; } }) },
});

test("a download is verified, stored once, and reported as progress", async () => {
  const store = memoryStore();
  const seen = [];
  const manager = createModelManager({ models: good, store, fetchFn: async () => reply(bytes) });
  assert.deepEqual(await manager.missing(["eng"]), { codes: ["eng"], bytes: 8 });
  await manager.download("eng", { onProgress: (got) => seen.push(got) });
  assert.deepEqual(seen, [3, 8]);
  assert.deepEqual(await manager.missing(["eng"]), { codes: [], bytes: 0 });
  assert.deepEqual([...store.data.get("jev/eng.traineddata")], [...bytes]);
  assert.equal(store.data.get("jev/eng.sha256"), good.eng.sha256);
});

test("a file with the wrong checksum or size is rejected and never stored", async () => {
  const store = memoryStore();
  const tampered = new Uint8Array(bytes);
  tampered[0] = 99;
  const bad = createModelManager({ models: good, store, fetchFn: async () => reply(tampered) });
  await assert.rejects(bad.download("eng"), (e) => e instanceof ModelError && e.kind === "checksum");
  const short = createModelManager({ models: good, store, fetchFn: async () => reply(bytes.slice(0, 5)) });
  await assert.rejects(short.download("eng"), (e) => e.kind === "size");
  assert.equal(store.data.size, 0);
});

test("a failed download is reported once and not retried by itself", async () => {
  let calls = 0;
  const manager = createModelManager({
    models: good,
    store: memoryStore(),
    fetchFn: async () => {
      calls += 1;
      throw new Error("offline");
    },
  });
  await assert.rejects(manager.download("eng"), (e) => e.kind === "network" && /offline/.test(e.message));
  const http = createModelManager({ models: good, store: memoryStore(), fetchFn: async () => reply(bytes, 404) });
  await assert.rejects(http.download("eng"), (e) => e.kind === "network" && /404/.test(e.message));
  assert.equal(calls, 1);
});

test("a stored model of another version counts as missing again", async () => {
  const store = memoryStore();
  const manager = createModelManager({ models: good, store, fetchFn: async () => reply(bytes) });
  await manager.download("eng");
  store.data.set("jev/eng.sha256", "old-version");
  assert.deepEqual((await manager.missing(["eng"])).codes, ["eng"]);
});

test("a model file picked by hand goes through the same checks", async () => {
  const store = memoryStore();
  const manager = createModelManager({ models: good, store, fetchFn: async () => assert.fail("no network") });
  await assert.rejects(manager.importFile("eng", new Uint8Array(8)), (e) => e.kind === "checksum");
  await manager.importFile("eng", bytes);
  assert.deepEqual((await manager.missing(["eng"])).codes, []);
});
