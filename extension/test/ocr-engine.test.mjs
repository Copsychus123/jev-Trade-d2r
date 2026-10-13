import assert from "node:assert/strict";
import test from "node:test";

import { chooseProviders, createEngineCache, createOcrEngine } from "../src/ocr/engine.js";

function fakeTimers() {
  const timers = [];
  return {
    timers,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      if (timer) timer.cleared = true;
    },
    fire: () => timers.filter((t) => !t.cleared).forEach((t) => ((t.cleared = true), t.fn())),
    pending: () => timers.filter((t) => !t.cleared).length,
  };
}

function setup(options = {}) {
  const clock = fakeTimers();
  const created = [];
  const cache = createEngineCache({
    create: async (capability) => {
      const engine = { capability, terminated: false, terminate: async () => void (engine.terminated = true) };
      created.push(engine);
      return engine;
    },
    idleMs: 60_000,
    ...clock,
    ...options,
  });
  return { cache, clock, created };
}

test("the engine is made once per capability and shared, even by reads that start together", async () => {
  const { cache, created } = setup();
  const [a, b] = await Promise.all([
    cache.run("ppocr", async (engine) => engine),
    cache.run("ppocr", async (engine) => engine),
  ]);
  await cache.run("ppocr", async () => {});
  assert.equal(created.length, 1);
  assert.equal(a, b);
});

test("asking for another capability ends the old engine first", async () => {
  const { cache, created } = setup();
  await cache.run("ppocr", async () => {});
  await cache.run("other", async () => {});
  assert.deepEqual(created.map((e) => [e.capability, e.terminated]), [["ppocr", true], ["other", false]]);
});

test("the engine is terminated after the idle time, and made again for the next read", async () => {
  const { cache, clock, created } = setup();
  await cache.run("ppocr", async () => {});
  assert.equal(clock.timers[0].ms, 60_000);
  assert.equal(created[0].terminated, false);
  clock.fire();
  await Promise.resolve();
  assert.equal(created[0].terminated, true);
  await cache.run("ppocr", async () => {});
  assert.equal(created.length, 2);
});

test("no countdown runs while a read is in progress, and a new read cancels a countdown", async () => {
  const { cache, clock, created } = setup();
  await cache.run("ppocr", async () => {});
  assert.equal(clock.pending(), 1);
  let finishFirst;
  const first = cache.run("ppocr", () => new Promise((resolve) => (finishFirst = resolve)));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(clock.pending(), 0);
  await cache.run("ppocr", async () => {}); // a second read ends while the first still runs
  assert.equal(clock.pending(), 0);
  finishFirst();
  await first;
  assert.equal(clock.pending(), 1);
  assert.equal(created.length, 1);
});

test("an engine that fails to start is not remembered, and starting is not retried by itself", async () => {
  let attempts = 0;
  const { cache } = setup({
    create: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("bad model");
      return { terminate: async () => {} };
    },
  });
  await assert.rejects(cache.run("ppocr", async () => {}), /bad model/u);
  assert.equal(attempts, 1);
  await cache.run("ppocr", async () => {});
  assert.equal(attempts, 2);
});

test("chooseProviders asks for webgpu only when an adapter answers", async () => {
  assert.deepEqual(await chooseProviders(undefined), ["wasm"]);
  assert.deepEqual(await chooseProviders({ requestAdapter: async () => null }), ["wasm"]);
  assert.deepEqual(await chooseProviders({ requestAdapter: async () => ({}) }), ["webgpu", "wasm"]);
  assert.deepEqual(
    await chooseProviders({
      requestAdapter: async () => {
        throw new Error("no gpu");
      },
    }),
    ["wasm"],
  );
});

class FakeWorker {
  constructor() {
    this.listeners = new Map();
    this.posted = [];
    this.terminated = false;
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  postMessage(message, transfer) {
    this.posted.push({ message, transfer });
  }
  terminate() {
    this.terminated = true;
  }
  emit(data) {
    for (const fn of this.listeners.get("message") ?? []) fn({ data });
  }
  emitError(message) {
    for (const fn of this.listeners.get("error") ?? []) fn({ message });
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** The one-pixel picture every engine test asks a read to recognise. */
const pixels = () => ({ width: 1, height: 1, data: new Uint8ClampedArray(4) });

test("createOcrEngine posts init and resolves a read with the worker's text, and terminate closes the worker", async () => {
  const worker = new FakeWorker();
  const statuses = [];
  const models = {
    det: new Uint8Array([1]),
    rec: new Uint8Array([2, 2]),
    cls: new Uint8Array([3, 3, 3]),
    dict: new Uint8Array([4, 4, 4, 4]),
  };
  const engine = await createOcrEngine({
    models,
    providers: ["wasm"],
    createWorker: () => worker,
    onStatus: (text) => statuses.push(text),
  });

  const init = worker.posted[0].message;
  assert.equal(init.type, "init");
  assert.deepEqual(init.providers, ["wasm"]);
  assert.deepEqual(Object.keys(init.models), ["det", "rec", "cls", "dict"]);
  assert.equal(init.models.det.byteLength, 1);
  assert.equal(init.models.rec.byteLength, 2);
  assert.equal(worker.posted[0].transfer.length, 4);

  worker.emit({ type: "status", stage: "loading" });
  worker.emit({ type: "status", stage: "ready" });
  assert.deepEqual(statuses, ["正在準備辨識引擎…", "正在辨識文字…"]);

  const reading = engine.recognize(pixels());
  await tick();
  const request = worker.posted[1].message;
  assert.equal(request.type, "recognize");
  assert.equal(request.id, 1);
  worker.emit({ type: "result", id: request.id, text: "line1\nline2" });
  assert.equal(await reading, "line1\nline2");

  engine.terminate();
  assert.equal(worker.posted.at(-1).message.type, "close");
  assert.equal(worker.terminated, true);
});

// --- the worker message protocol `connectWorker` implements: which message settles which promise ---

const MODELS = () => ({
  det: new Uint8Array([1]),
  rec: new Uint8Array([2, 2]),
  cls: new Uint8Array([3, 3, 3]),
  dict: new Uint8Array([4, 4, 4, 4]),
});

async function runningEngine(worker, statuses = []) {
  const engine = await createOcrEngine({
    models: MODELS(),
    providers: ["wasm"],
    createWorker: () => worker,
    onStatus: (text) => statuses.push(text),
  });
  return engine;
}

/** Watches a promise without awaiting it, so a test can say exactly which state it is in. */
function watch(promise) {
  const state = { status: "pending", value: undefined };
  promise.then(
    (value) => { state.status = "resolved"; state.value = value; },
    (error) => { state.status = "rejected"; state.value = error.message; },
  );
  return state;
}

/** Watches a read of the one-pixel picture, so a test can say exactly which state it is in. */
const watchRead = (engine) => watch(engine.recognize(pixels()));

const types = (worker) => worker.posted.map((p) => p.message.type);

test("a worker error message rejects the read waiting under its id and leaves the others alone", async () => {
  const worker = new FakeWorker();
  const engine = await runningEngine(worker);
  worker.emit({ type: "status", stage: "ready" });

  const first = watchRead(engine);
  const second = watchRead(engine);
  await tick();
  assert.deepEqual(worker.posted.filter((p) => p.message.type === "recognize").map((p) => p.message.id), [1, 2]);

  worker.emit({ type: "error", id: 1, message: "辨識引擎尚未就緒" });
  await tick();
  assert.deepEqual(first, { status: "rejected", value: "辨識引擎尚未就緒" });
  assert.deepEqual(second, { status: "pending", value: undefined });

  worker.emit({ type: "result", id: 2, text: "剩下的那一行" });
  await tick();
  assert.deepEqual(second, { status: "resolved", value: "剩下的那一行" });
});

test("a worker error whose id matches no waiting read settles nothing", async () => {
  const worker = new FakeWorker();
  const engine = await runningEngine(worker);
  worker.emit({ type: "status", stage: "ready" });

  const reading = watchRead(engine);
  await tick();
  assert.equal(worker.posted.at(-1).message.id, 1);

  worker.emit({ type: "error", id: 999, message: "不相干的錯誤" });
  await tick();
  assert.deepEqual(reading, { status: "pending", value: undefined });

  worker.emit({ type: "result", id: 1, text: "仍然讀到了" });
  await tick();
  assert.deepEqual(reading, { status: "resolved", value: "仍然讀到了" });
});

test("a read is posted only once the worker has reported ready, and each status phase reaches the listener", async () => {
  const worker = new FakeWorker();
  const statuses = [];
  const engine = await runningEngine(worker, statuses);

  const reading = watchRead(engine);
  await tick();
  assert.deepEqual(types(worker), ["init"]);
  assert.deepEqual(statuses, []);
  assert.deepEqual(reading, { status: "pending", value: undefined });

  worker.emit({ type: "status", stage: "loading" });
  await tick();
  assert.deepEqual(statuses, ["正在準備辨識引擎…"]);
  assert.deepEqual(types(worker), ["init"]);

  worker.emit({ type: "status", stage: "ready" });
  await tick();
  assert.deepEqual(statuses, ["正在準備辨識引擎…", "正在辨識文字…"]);
  assert.deepEqual(types(worker), ["init", "recognize"]);
  assert.deepEqual(reading, { status: "pending", value: undefined });
});

test("a worker error with no id fails the engine, so a read waits for nothing and rejects instead of posting", async () => {
  const worker = new FakeWorker();
  const engine = await runningEngine(worker);

  const reading = watchRead(engine);
  worker.emit({ type: "error", id: null, message: "字元清單長度不對（5，應為 18710）" });
  await tick();
  assert.deepEqual(reading, { status: "rejected", value: "字元清單長度不對（5，應為 18710）" });
  assert.deepEqual(types(worker), ["init"]);
});

test("a worker-level error event rejects the engine and every read still waiting, with a default text when it has none", async () => {
  const worker = new FakeWorker();
  const engine = await runningEngine(worker);
  worker.emit({ type: "status", stage: "ready" });

  const first = watchRead(engine);
  const second = watchRead(engine);
  await tick();
  assert.equal(types(worker).filter((t) => t === "recognize").length, 2);

  worker.emitError("worker 掛了");
  await tick();
  assert.deepEqual(first, { status: "rejected", value: "worker 掛了" });
  assert.deepEqual(second, { status: "rejected", value: "worker 掛了" });

  const other = new FakeWorker();
  const otherEngine = await runningEngine(other);
  const reading = watchRead(otherEngine);
  other.emitError(undefined);
  await tick();
  assert.deepEqual(reading, { status: "rejected", value: "辨識 worker 發生錯誤" });
});
