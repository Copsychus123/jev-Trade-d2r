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
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

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

  const reading = engine.recognize({ width: 1, height: 1, data: new Uint8ClampedArray(4) });
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
