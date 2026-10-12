// The recognition worker (ocr/ppocr-worker.js) is the module the side panel really talks to, and the panel's own test
// drives a hand-written fake worker instead. So the two sides of one wire were never checked against each other: if
// the worker's message names or shapes and the panel's expectations drift apart, recognition dies in the browser and
// no test notices. This file imports the REAL worker — only its two browser-only imports, onnxruntime and the PP-OCR
// pipeline, are replaced by stand-ins through a resolve hook — into a fake worker global scope, drives it through its
// own "message" handler, and then runs the real engine (the panel's side of the wire) against it.
//
// Offline: no onnxruntime, no model bytes, no worker, no network, no timers. Every test loads a fresh instance of the
// worker, because the module's `pipeline` is private state that can never be reset from outside.

import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

import { createOcrEngine } from "../src/ocr/engine.js";

const OCR_DIR = new URL("../src/ocr/", import.meta.url);

// --- the two imports a real worker has and node cannot give it -------------------------------------------------
// onnxruntime is a minified bundle and the pipeline does real tensor work; the worker touches only a handful of their
// names, and every argument they are handed is recorded on globalThis.__ppocrWorkerTest for the test to read back.
const ORT_SOURCE = `
export const env = { logLevel: "", wasm: { numThreads: 0, simd: false, wasmPaths: undefined } };
export const InferenceSession = {
  async create(bytes, options) {
    const state = globalThis.__ppocrWorkerTest;
    if (state.sessionError) throw state.sessionError; // the first session that fails ends the init
    state.sessions.push({ bytes, options });
    return { bytes, options };
  },
};
`;
const LIB_SOURCE = `
export function buildCharacterList(text) {
  const state = globalThis.__ppocrWorkerTest;
  state.dicts.push(text);
  return state.characters;
}
export function imageDataToBgr(image) {
  const state = globalThis.__ppocrWorkerTest;
  state.conversions.push(image);
  // The real module's shape and field names (ppocrlib.js imageDataToBgr -> { data, w, h }).
  const bgr = { data: new Uint8Array(image.width * image.height * 3), w: image.width, h: image.height };
  state.bgr.push(bgr);
  return bgr;
}
export class OcrPipeline {
  constructor(ort, sessions, characters) {
    globalThis.__ppocrWorkerTest.builds.push({ ort, sessions, characters });
  }
  async recognizeImage(image) {
    const state = globalThis.__ppocrWorkerTest;
    state.reads.push(image);
    return state.answer(image);
  }
}
`;
const dataUrl = (source) => `data:text/javascript,${encodeURIComponent(source)}`;
const ortUrl = dataUrl(ORT_SOURCE);
const libUrl = dataUrl(LIB_SOURCE);

// Only the worker's own two specifiers are rewritten, exactly like the neighbours' csv/config hooks.
const loader = `export async function resolve(specifier, context, next) {
  if (specifier === "../vendor/ort/ort.min.mjs" && context.parentURL?.includes("ppocr-worker.js")) {
    return { url: ${JSON.stringify(ortUrl)}, shortCircuit: true };
  }
  if (specifier === "./ppocrlib.js" && context.parentURL?.includes("ppocr-worker.js")) {
    return { url: ${JSON.stringify(libUrl)}, shortCircuit: true };
  }
  return next(specifier, context);
}`;
register(new URL("data:text/javascript;base64," + Buffer.from(loader).toString("base64")));

const ort = await import(ortUrl); // the very namespace object the worker imports, so identity can be asserted

// --- the worker global scope and the state behind its stubs ----------------------------------------------------

const DICT_LENGTH = 18710; // the length the worker insists on before it will recognise anything

function workerState(overrides = {}) {
  return {
    sessions: [], // InferenceSession.create arguments, in order
    sessionError: null, // thrown by the first create() when set
    characters: new Array(DICT_LENGTH).fill("x"), // what buildCharacterList returns
    dicts: [], // dict texts handed to buildCharacterList
    conversions: [], // imageDatas handed to imageDataToBgr
    bgr: [], // what imageDataToBgr returned, in order
    builds: [], // OcrPipeline constructor arguments
    reads: [], // what recognizeImage was handed
    answer: async () => ({ lines: [] }),
    ...overrides,
  };
}

/** A worker global scope: `self` with the three members the worker uses, and a way to hand it a message event. */
function makeScope() {
  const scope = {
    posted: [], // what the worker sent to the panel
    closes: 0,
    listeners: new Map(),
    sink: null, // the engine round trip points this at itself
    addEventListener(type, handler) {
      if (!scope.listeners.has(type)) scope.listeners.set(type, []);
      scope.listeners.get(type).push(handler);
    },
    postMessage(message) {
      scope.posted.push(message);
      scope.sink?.(message);
    },
    close() {
      scope.closes += 1;
    },
    /** The browser's message event, delivered to the worker's own handler. */
    receive(data) {
      for (const handler of scope.listeners.get("message") ?? []) handler({ data });
    },
  };
  return scope;
}

let loads = 0;

/** Loads the real worker module into `scope` with `state` behind its two imports; a fresh module instance per call. */
async function loadWorker(scope, state) {
  globalThis.__ppocrWorkerTest = state;
  globalThis.self = scope;
  // The worker module is re-imported per call, but `ort` is one namespace shared by every test, so its env still holds
  // whatever the previous test's module load left. Put it back to the stub's own start, or a test that asserts a value
  // the worker did not set only passes because it happened to run first.
  ort.env.wasm.numThreads = 0;
  ort.env.wasm.simd = false;
  ort.env.wasm.wasmPaths = undefined;
  ort.env.logLevel = "";
  loads += 1;
  return import(new URL(`ppocr-worker.js?case=${loads}`, OCR_DIR).href);
}

/** One init as the panel posts it: the bytes are ArrayBuffers, because the panel transfers them. */
function initMessage(overrides = {}) {
  const models = {
    det: new ArrayBuffer(1),
    rec: new ArrayBuffer(2),
    cls: new ArrayBuffer(3),
    dict: new TextEncoder().encode("甲\n乙").buffer,
  };
  return { type: "init", providers: ["wasm"], wasmPaths: "chrome-extension://fake/vendor/ort/", models, ...overrides };
}

const sleep = () => new Promise((resolve) => setImmediate(resolve));

/** Runs the pending microtasks until `done()`, so a broken promise chain fails instead of hanging the run. */
async function settleUntil(done, label) {
  for (let i = 0; i < 200 && !done(); i += 1) await sleep();
  assert.ok(done(), `never settled: ${label}`);
}

// --- the worker's side of the protocol -------------------------------------------------------------------------

test("loading the worker keeps onnxruntime on one wasm thread", async () => {
  await loadWorker(makeScope(), workerState());
  assert.deepEqual([ort.env.wasm.numThreads, ort.env.wasm.simd, ort.env.logLevel], [1, true, "warning"]);
});

test("an init answers loading then ready, and builds the three sessions and the character list from the panel's bytes", async () => {
  const scope = makeScope();
  const state = workerState();
  await loadWorker(scope, state);
  const init = initMessage();

  scope.receive(init);
  assert.deepEqual(scope.posted, [{ type: "status", stage: "loading" }], "loading comes before anything is awaited");
  await settleUntil(() => scope.posted.length === 2, "the ready status");
  assert.deepEqual(scope.posted, [
    { type: "status", stage: "loading" },
    { type: "status", stage: "ready" },
  ]);
  assert.equal(ort.env.wasm.wasmPaths, init.wasmPaths, "the panel's ORT directory is the one onnxruntime is given");

  assert.deepEqual(
    state.sessions.map((s) => s.options),
    Array.from({ length: 3 }, () => ({ executionProviders: ["wasm"], graphOptimizationLevel: "all" })),
  );
  assert.equal(state.sessions[0].bytes, init.models.det, "the panel's det bytes reach onnxruntime without a copy");
  assert.equal(state.sessions[1].bytes, init.models.rec);
  assert.equal(state.sessions[2].bytes, init.models.cls);

  assert.deepEqual(state.dicts, ["甲\n乙"], "the dict is decoded as UTF-8 text before the character list is built");
  assert.equal(state.builds.length, 1);
  assert.equal(state.builds[0].ort, ort, "the pipeline gets the onnxruntime namespace itself");
  assert.equal(state.builds[0].characters, state.characters, "the pipeline gets the list the dict built, not the dict");
  assert.deepEqual(Object.keys(state.builds[0].sessions), ["det", "rec", "cls"], "the sessions keep their model names");
  assert.equal(state.builds[0].sessions.cls.bytes, init.models.cls);
});

test("an init whose sessions fail reports an engine failure (no id) and never builds the pipeline", async () => {
  const scope = makeScope();
  const state = workerState({ sessionError: new Error("wasm 檔載入失敗") });
  await loadWorker(scope, state);

  scope.receive(initMessage());
  await settleUntil(() => scope.posted.length === 2, "the failure");
  assert.deepEqual(scope.posted, [
    { type: "status", stage: "loading" },
    { type: "error", id: null, message: "wasm 檔載入失敗" },
  ]);
  assert.deepEqual(state.sessions, [], "the first session that throws ends the init");
  assert.deepEqual(state.builds, []);
});

test("an init stops on a character list of the wrong length, naming the count it got", async () => {
  const scope = makeScope();
  const state = workerState({ characters: ["a", "b", "c"] });
  await loadWorker(scope, state);

  scope.receive(initMessage());
  await settleUntil(() => scope.posted.length === 2, "the length check");
  assert.deepEqual(scope.posted, [
    { type: "status", stage: "loading" },
    { type: "error", id: null, message: "字元清單長度不對（3，應為 18710）" },
  ]);
  assert.deepEqual(state.dicts, ["甲\n乙"], "the check is on the list the dict built");
  assert.deepEqual(state.builds, []);
});

test("a recognize before any init is answered under its own id, nothing converted", async () => {
  const scope = makeScope();
  const state = workerState();
  await loadWorker(scope, state);

  scope.receive({ type: "recognize", id: 7, width: 1, height: 1, data: new Uint8ClampedArray(4) });
  await settleUntil(() => scope.posted.length === 1, "the not-ready error");
  assert.deepEqual(scope.posted, [{ type: "error", id: 7, message: "辨識引擎尚未就緒" }]);
  assert.deepEqual(state.conversions, []);
});

test("a recognize converts the panel's pixels and answers with the same id and the lines joined by a newline", async () => {
  const scope = makeScope();
  const state = workerState({
    answer: async () => ({ lines: [{ text: "哈勒昆", score: 0.9 }, { text: "之冠", score: 0.8 }] }),
  });
  await loadWorker(scope, state);
  scope.receive(initMessage());
  await settleUntil(() => scope.posted.length === 2, "the ready status");

  const data = new Uint8ClampedArray([1, 2, 3, 4, 5, 6, 7, 8]);
  scope.receive({ type: "recognize", id: 5, width: 2, height: 1, data });
  await settleUntil(() => scope.posted.length === 3, "the result");
  assert.deepEqual(scope.posted[2], { type: "result", id: 5, text: "哈勒昆\n之冠" });

  const converted = state.conversions[0];
  assert.ok(converted.data instanceof Uint8ClampedArray, "the RGBA bytes are rebuilt as clamped pixels");
  assert.notEqual(converted.data, data, "the worker rebuilds the pixels instead of handing the transferred view on");
  assert.deepEqual([converted.width, converted.height, ...converted.data], [2, 1, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(state.reads.length, 1, "the one conversion feeds the one read");
  assert.equal(state.reads[0], state.bgr[0], "the pipeline reads exactly what imageDataToBgr returned");
  assert.deepEqual(
    [Object.keys(state.reads[0]).sort(), state.reads[0].w, state.reads[0].h],
    [["data", "h", "w"], 2, 1],
    "that value is the real module's { data, w, h }, not a shape of the stand-in's invention",
  );
});

test("a recognize that throws answers the read's own id, with the thrown value's own text when it is not an Error", async () => {
  const scope = makeScope();
  const state = workerState({
    answer: async () => {
      throw new Error("圖片太小");
    },
  });
  await loadWorker(scope, state);
  scope.receive(initMessage());
  await settleUntil(() => scope.posted.length === 2, "the ready status");

  scope.receive({ type: "recognize", id: 6, width: 1, height: 1, data: new Uint8ClampedArray(4) });
  await settleUntil(() => scope.posted.length === 3, "the error");
  assert.deepEqual(scope.posted[2], { type: "error", id: 6, message: "圖片太小" });

  state.answer = async () => {
    throw "沒有 message 的錯誤";
  };
  scope.receive({ type: "recognize", id: 8, width: 1, height: 1, data: new Uint8ClampedArray(4) });
  await settleUntil(() => scope.posted.length === 4, "the second error");
  assert.deepEqual(scope.posted[3], { type: "error", id: 8, message: "沒有 message 的錯誤" });
});

test("a message the worker does not know is ignored", async () => {
  const scope = makeScope();
  await loadWorker(scope, workerState());

  scope.receive({ type: "diagnose" });
  scope.receive({ type: "init " }); // a near miss: the worker matches the exact name only
  await sleep();
  assert.deepEqual(scope.posted, []);
  assert.equal(scope.closes, 0);
});

test("a close message closes the worker scope and answers nothing", async () => {
  const scope = makeScope();
  await loadWorker(scope, workerState());

  scope.receive({ type: "close" });
  await sleep();
  assert.equal(scope.closes, 1);
  assert.deepEqual(scope.posted, []);
});

// --- the panel's side of the same wire -------------------------------------------------------------------------
// engine.js connectWorker is where the panel reads the worker's messages, and what it posts is what the worker reads.
// Here the two run against each other: this fake Worker is the panel's, wired straight into the real module.

function makeRelay(scope) {
  const relay = {
    posted: [],
    listeners: new Map(),
    terminated: false,
    addEventListener(type, handler) {
      if (!relay.listeners.has(type)) relay.listeners.set(type, []);
      relay.listeners.get(type).push(handler);
    },
    /**
     * The browser's postMessage: the receiver is handed a structured clone (so the worker's buffers are its own), the
     * buffers on the transfer list leave the sender detached, and delivery lands on a later turn of the event loop -
     * never synchronously, which would let the panel read state the worker cannot have set yet.
     */
    postMessage(message, transfer = []) {
      relay.posted.push(message);
      const delivered = structuredClone(message, { transfer });
      setImmediate(() => scope.receive(delivered));
    },
    terminate() {
      relay.terminated = true;
    },
    emit(message) {
      for (const handler of relay.listeners.get("message") ?? []) handler({ data: message });
    },
  };
  scope.sink = (message) => relay.emit(message);
  return relay;
}

const panelModels = () => ({
  det: new Uint8Array([1]),
  rec: new Uint8Array([2, 2]),
  cls: new Uint8Array([3, 3, 3]),
  dict: new TextEncoder().encode("甲\n乙"),
});

/** Starts a read without awaiting it, so a read that never comes back fails the settle instead of hanging. */
function watchRead(engine) {
  const reading = { state: "pending", text: undefined };
  engine.recognize({ width: 1, height: 1, data: new Uint8ClampedArray(4) }).then(
    (text) => {
      reading.state = "resolved";
      reading.text = text;
    },
    (error) => {
      reading.state = "rejected";
      reading.text = error.message;
    },
  );
  return reading;
}

test("the engine and the worker agree end to end: init, the two phase texts, a read and a close", async () => {
  const scope = makeScope();
  const state = workerState({
    answer: async () => ({ lines: [{ text: "第一行", score: 0.9 }, { text: "第二行", score: 0.8 }] }),
  });
  await loadWorker(scope, state);

  const relay = makeRelay(scope);
  const statuses = [];
  const models = panelModels();
  const engine = await createOcrEngine({
    models,
    providers: ["wasm"],
    onStatus: (text) => statuses.push(text),
    createWorker: () => relay,
  });

  const init = relay.posted[0];
  assert.deepEqual(Object.keys(init).sort(), ["models", "providers", "type", "wasmPaths"], "the init is the worker's");
  assert.equal(init.type, "init");
  assert.deepEqual(init.providers, ["wasm"]);
  assert.equal(init.wasmPaths, "vendor/ort/", "no chrome.* inside the worker: the panel resolves the ORT directory");
  await settleUntil(() => state.builds.length === 1, "the init to build the pipeline");

  // The panel transfers the bytes away, so its own four buffers end up detached - and the worker's sessions are built
  // from its own copies of the same content, never from the panel's objects, which hold nothing any more.
  assert.deepEqual(
    [models.det.buffer.detached, models.rec.buffer.detached, models.cls.buffer.detached, models.dict.buffer.detached],
    [true, true, true, true],
    "the transferred model bytes leave the panel",
  );
  const sent = state.builds[0].sessions;
  assert.deepEqual(
    [sent.det.bytes, sent.rec.bytes, sent.cls.bytes].map((b) => [...new Uint8Array(b)]),
    [[1], [2, 2], [3, 3, 3]],
    "the worker's det/rec/cls sessions hold the panel's bytes, content and all",
  );
  assert.notEqual(sent.det.bytes, models.det.buffer, "the worker's buffer is its own, not the panel's detached one");
  assert.equal(ort.env.wasm.wasmPaths, init.wasmPaths, "the address the panel sent is the one onnxruntime is given");

  const reading = watchRead(engine);
  await settleUntil(() => reading.state !== "pending", "the read to come back from the worker");
  assert.deepEqual(reading, { state: "resolved", text: "第一行\n第二行" });
  assert.deepEqual(statuses, ["正在準備辨識引擎…", "正在辨識文字…"], "the worker's stages are the panel's phase texts");
  assert.deepEqual(scope.posted.map((m) => m.type), ["status", "status", "result"]);
  assert.deepEqual(relay.posted[1].type, "recognize");
  assert.deepEqual(relay.posted[1].id, 1, "the id the panel waits under is the one the worker answers");

  engine.terminate();
  assert.equal(relay.terminated, true);
  assert.deepEqual(relay.posted.at(-1), { type: "close" });
  await settleUntil(() => scope.closes === 1, "the close to reach the worker");
  assert.equal(scope.closes, 1, "the panel's close reaches the worker's self.close()");
});

test("the engine takes the worker's engine-level failure as its own, message and all", async () => {
  const scope = makeScope();
  await loadWorker(scope, workerState({ characters: ["a"] })); // a list the worker refuses: 1, not 18710

  const relay = makeRelay(scope);
  const engine = await createOcrEngine({ models: panelModels(), providers: ["wasm"], createWorker: () => relay });

  const reading = watchRead(engine);
  await settleUntil(() => reading.state !== "pending", "the engine-level failure");
  assert.deepEqual(reading, { state: "rejected", text: "字元清單長度不對（1，應為 18710）" });
  assert.deepEqual(relay.posted.map((m) => m.type), ["init"], "a read is not even posted once the engine has failed");
});
