import assert from "node:assert/strict";
import test from "node:test";

import {
  ModelError,
  PPOCR,
  PPOCR_BYTES,
  PPOCR_FILES,
  createModelManager,
  sha256Hex,
} from "../src/ocr/models.js";

const MS = "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.9.2";

test("the asset list is the fixed pinned URLs with the recorded sizes and hashes", () => {
  const expected = {
    det: { url: `${MS}/onnx/PP-OCRv6/det/PP-OCRv6_det_small.onnx`, bytes: 9929594, sha256: "090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f" },
    rec: { url: `${MS}/onnx/PP-OCRv6/rec/PP-OCRv6_rec_small.onnx`, bytes: 21234383, sha256: "6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884" },
    cls: { url: `${MS}/onnx/PP-OCRv4/cls/ch_ppocr_mobile_v2.0_cls_mobile.onnx`, bytes: 585532, sha256: "e47acedf663230f8863ff1ab0e64dd2d82b838fceb5957146dab185a89d6215c" },
    dict: { url: `${MS}/paddle/PP-OCRv6/rec/PP-OCRv6_rec_small/ppocrv6_dict.txt`, bytes: 74947, sha256: "b5f2bfe2bdd9448429e3e82b51c789775d9b42f2403d082b00662eb77e401c5d" },
  };
  assert.deepEqual(PPOCR, expected);
  assert.deepEqual(PPOCR_FILES, ["det", "rec", "cls", "dict"]);
  assert.equal(PPOCR_FILES.reduce((sum, name) => sum + PPOCR[name].bytes, 0), PPOCR_BYTES);
  assert.equal(PPOCR_BYTES, 31824456);
});

const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const good = { eng: { url: "https://example.test/eng", bytes: bytes.length, sha256: await sha256Hex(bytes) } };
const BYTES_KEY = "jev/ppocr/eng";
const HASH_KEY = "jev/ppocr/eng.sha256";

function memoryStore() {
  const data = new Map();
  return {
    data,
    reads: [],
    get: async function (k) {
      this.reads.push(k);
      return data.get(k);
    },
    has: async (k) => data.has(k),
    put: async (k, v) => void data.set(k, v),
    delete: async (k) => void data.delete(k),
  };
}

const reply = (body, status = 200) => ({
  ok: status === 200,
  status,
  body: { getReader: () => ({ chunks: [body.slice(0, 3), body.slice(3)], read: async function () { const v = this.chunks.shift(); return v ? { done: false, value: v } : { done: true }; } }) },
});

/** A one-file manager for the 8-byte `eng` fixture, over `store` (a fresh memory store unless given). */
const makeManager = (fetchFn, store = memoryStore(), extra = {}) =>
  createModelManager({ files: good, order: ["eng"], store, fetchFn, ...extra });

/** A manager that has already downloaded the fixture file once, plus the store it wrote into. */
async function downloaded() {
  const store = memoryStore();
  const manager = makeManager(async () => reply(bytes), store);
  await manager.download("eng");
  return { store, manager };
}

test("a download is verified, stored once, and reported as progress", async () => {
  const store = memoryStore();
  const seen = [];
  const manager = makeManager(async () => reply(bytes), store);
  assert.deepEqual(await manager.missing(), { names: ["eng"], bytes: 8 });
  await manager.download("eng", { onProgress: (got) => seen.push(got) });
  assert.deepEqual(seen, [3, 8]);
  assert.deepEqual(await manager.missing(), { names: [], bytes: 0 });
  assert.deepEqual([...store.data.get(BYTES_KEY)], [...bytes]);
  assert.equal(store.data.get(HASH_KEY), good.eng.sha256);
});

test("a file with the wrong checksum or size is rejected and never stored", async () => {
  const store = memoryStore();
  const tampered = new Uint8Array(bytes);
  tampered[0] = 99;
  const bad = makeManager(async () => reply(tampered), store);
  await assert.rejects(bad.download("eng"), (e) => e instanceof ModelError && e.kind === "checksum");
  const short = makeManager(async () => reply(bytes.slice(0, 5)), store);
  await assert.rejects(short.download("eng"), (e) => e.kind === "size");
  assert.equal(store.data.size, 0);
});

test("a failed download is reported once and not retried by itself", async () => {
  let calls = 0;
  const manager = makeManager(async () => {
    calls += 1;
    throw new Error("offline");
  });
  await assert.rejects(manager.download("eng"), (e) => e.kind === "network" && /offline/.test(e.message));
  const http = makeManager(async () => reply(bytes, 404));
  await assert.rejects(http.download("eng"), (e) => e.kind === "network" && /404/.test(e.message));
  assert.equal(calls, 1);
});

test("a stored file of another version counts as missing again", async () => {
  const { store, manager } = await downloaded();
  store.data.set(HASH_KEY, "old-version");
  assert.deepEqual((await manager.missing()).names, ["eng"]);
});

test("checking what is stored never reads the model bytes", async () => {
  const { store, manager } = await downloaded();
  store.reads.length = 0;
  assert.deepEqual((await manager.missing()).names, []);
  assert.deepEqual(store.reads, [HASH_KEY]);
});

test("a file whose bytes are gone counts as missing even when its version record is still there", async () => {
  const { store, manager } = await downloaded();
  store.data.delete(BYTES_KEY);
  assert.deepEqual((await manager.missing()).names, ["eng"]);
});

test("forgetting a file makes it missing again", async () => {
  const { store, manager } = await downloaded();
  await manager.forget("eng");
  assert.equal(store.data.size, 0);
  assert.deepEqual((await manager.missing()).names, ["eng"]);
});

test("load returns the four stored byte arrays and null when one is short", async () => {
  const a = new Uint8Array([1, 2, 3]);
  const b = new Uint8Array([4, 5, 6, 7]);
  const c = new Uint8Array([8, 9]);
  const d = new Uint8Array([10]);
  const files = {
    det: { url: "x", bytes: a.length, sha256: "a" },
    rec: { url: "x", bytes: b.length, sha256: "b" },
    cls: { url: "x", bytes: c.length, sha256: "c" },
    dict: { url: "x", bytes: d.length, sha256: "d" },
  };
  const store = memoryStore();
  for (const [name, value] of Object.entries({ det: a, rec: b, cls: c, dict: d })) {
    store.put(`jev/ppocr/${name}`, value);
  }
  const manager = createModelManager({ files, order: ["det", "rec", "cls", "dict"], store });
  const loaded = await manager.load();
  assert.deepEqual(Object.keys(loaded), ["det", "rec", "cls", "dict"]);
  assert.deepEqual([...loaded.det], [...a]);

  store.put("jev/ppocr/cls", new Uint8Array([8])); // wrong length
  assert.equal(await manager.load(), null);
  store.put("jev/ppocr/cls", c);
  store.delete("jev/ppocr/dict"); // one entirely gone
  assert.equal(await manager.load(), null);
});

test("a download that delivers more bytes than the file has is stopped at once, before the rest is read", async () => {
  let reads = 0;
  let aborted = false;
  const fetchFn = async (_url, { signal }) => {
    signal.addEventListener("abort", () => (aborted = true));
    return {
      ok: true,
      body: {
        getReader: () => ({
          read: async () => {
            reads += 1;
            return reads > 100 ? { done: true } : { done: false, value: new Uint8Array(5) };
          },
        }),
      },
    };
  };
  const manager = makeManager(fetchFn);
  await assert.rejects(manager.download("eng"), (e) => e instanceof ModelError && e.kind === "size");
  assert.equal(reads, 2); // 5 bytes fit in the 8 expected, the second chunk (10 > 8) ends it
  assert.ok(aborted);
});

test("a download that stops delivering gives up after the stall time and stores nothing", async () => {
  const store = memoryStore();
  const fetchFn = async (_url, { signal }) => ({
    ok: true,
    body: {
      getReader: () => ({
        read: () =>
          new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))),
      }),
    },
  });
  const manager = makeManager(fetchFn, store, { stallMs: 30 });
  await assert.rejects(manager.download("eng"), (e) => e.kind === "network" && /沒有收到資料/u.test(e.message));
  assert.equal(store.data.size, 0);
});

test("a server that never answers is also a stall", async () => {
  const fetchFn = (_url, { signal }) =>
    new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
  const manager = makeManager(fetchFn, memoryStore(), { stallMs: 30 });
  await assert.rejects(manager.download("eng"), (e) => e.kind === "network" && /沒有收到資料/u.test(e.message));
});

test("cancelling a running download ends it as 'cancelled' and stores nothing", async () => {
  const store = memoryStore();
  const controller = new AbortController();
  const fetchFn = async (_url, { signal }) => ({
    ok: true,
    body: {
      getReader: () => ({
        read: () => {
          const pending = new Promise((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(new Error("aborted"))),
          );
          controller.abort(); // the user presses cancel while the first chunk is on its way
          return pending;
        },
      }),
    },
  });
  const manager = makeManager(fetchFn, store);
  await assert.rejects(manager.download("eng", { signal: controller.signal }), (e) => e.kind === "cancelled");
  assert.equal(store.data.size, 0);
  const already = new AbortController();
  already.abort();
  const never = makeManager(async () => assert.fail("no request"), store);
  await assert.rejects(never.download("eng", { signal: already.signal }), (e) => e.kind === "cancelled");
});
