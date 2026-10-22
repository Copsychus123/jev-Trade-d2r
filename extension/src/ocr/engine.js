// The screenshot reader's PP-OCR engine: one Web Worker per engine, onnxruntime-web inside it. Every file it loads is
// inside the extension (vendor/ort); the model bytes come from the IndexedDB location where we stored the verified
// downloads, so it never downloads or caches anything itself.

const ORT_DIR = "vendor/ort";
export const OCR_CAPABILITY = "ppocr";

/** 有可用的 GPU adapter 才請求 WebGPU；不然只用 wasm。gpu 預設取 globalThis.navigator?.gpu。 */
export async function chooseProviders(gpu = globalThis.navigator?.gpu) {
  let providers = ["wasm"];
  try {
    if (gpu && (await gpu.requestAdapter())) providers = ["webgpu", "wasm"];
  } catch {
    // requestAdapter failed: wasm only
  }
  globalThis.__jevOcrProvider = providers[0];
  return providers;
}

/** 擴充功能自己目錄裡的 module worker；用 chrome.runtime.getURL 讓路徑留在套件內。 */
function loadWorker() {
  return new Worker(chrome.runtime.getURL("ocr/ppocr-worker.js"), { type: "module" });
}

const ENGINE_IDLE_MS = 60_000;

/**
 * One engine at a time, created once per capability and shared by everything that asks (a second read does not start a
 * second worker). The worker keeps the model in memory, so it is terminated after `idleMs` without a read.
 * `create(capability)` makes an engine ({ recognize, terminate }); a creation that fails is not remembered.
 */
export function createEngineCache({ create, idleMs = ENGINE_IDLE_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let current = null; // { capability, promise }
  let timer = null;
  let active = 0; // reads in progress: the idle countdown only runs while there are none
  let warmCount = 0; // reasons to stay warm: while warmCount > 0, idle countdown is paused

  const stop = (entry) => entry.promise.then((engine) => engine.terminate(), () => {});
  const stopTimer = () => {
    clearTimer(timer);
    timer = null;
  };
  const scheduleIdle = () => {
    stopTimer();
    if (!active && warmCount === 0 && current) {
      timer = setTimer(release, idleMs);
    }
  };
  const release = () => {
    stopTimer();
    const entry = current;
    current = null;
    return entry ? stop(entry) : Promise.resolve();
  };
  function engineFor(capability) {
    stopTimer();
    if (current?.capability === capability) return current.promise;
    const previous = current;
    const entry = { capability, promise: null };
    entry.promise = (async () => {
      if (previous) await stop(previous);
      return create(capability);
    })();
    current = entry;
    entry.promise.catch(() => {
      if (current === entry) current = null;
    });
    return entry.promise;
  }

  return {
    /** Runs `work(engine)` with the engine for `capability`, then starts the idle countdown if nothing else is reading. */
    async run(capability, work) {
      active += 1;
      try {
        return await work(await engineFor(capability));
      } finally {
        active -= 1;
        scheduleIdle();
      }
    },
    /** Pre-warms the engine and prevents idle-termination while active. Returns a release function. */
    keepWarm(capability, { warmup = true } = {}) {
      warmCount += 1;
      stopTimer();
      const warming = (async () => {
        const engine = await engineFor(capability);
        if (warmup) await engine.warmup?.();
        return engine;
      })().catch(() => {});
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        warmCount = Math.max(0, warmCount - 1);
        scheduleIdle();
      };
      release.ready = warming;
      return release;
    },
    release,
  };
}

const workerError = (event) => new Error(event.message || "辨識 worker 發生錯誤");

/**
 * The worker's message protocol as one promise: `ready` resolves on the worker's "ready" status, a "result"/"error"
 * message settles the read that waits under its id, and a worker-level error rejects the engine and every read still
 * waiting. `waiting` is the id -> { resolve, reject } map of the reads in flight; `onStatus(text)` gets the phase
 * text ("正在準備辨識引擎…" while loading, otherwise "正在辨識文字…").
 */
function connectWorker(worker, waiting, onStatus) {
  const settle = (id, outcome, value) => {
    waiting.get(id)?.[outcome](value);
    waiting.delete(id);
  };
  return new Promise((resolve, reject) => {
    worker.addEventListener("message", (event) => {
      const message = event.data;
      if (message.type === "status") {
        if (message.stage === "ready") resolve();
        onStatus(message.stage === "loading" ? "正在準備辨識引擎…" : "正在辨識文字…");
      } else if (message.type === "result") {
        const result = { text: message.text, tones: message.tones ?? [] };
        if (message.stages !== undefined) result.stages = message.stages;
        settle(message.id, "resolve", result);
      } else if (message.type === "head") {
        // The first lines of a read in flight: the read stays waiting for its result.
        waiting.get(message.id)?.onHead?.({ text: message.text, tones: message.tones ?? [] });
      } else if (message.type === "detectResult") {
        settle(message.id, "resolve", message.boxes);
      } else if (message.type === "warmupResult") {
        settle(message.id, "resolve", message.log);
      } else if (message.type === "error") {
        const error = new Error(message.message);
        if (message.id === null) reject(error);
        else settle(message.id, "reject", error);
      }
    });
    worker.addEventListener("error", (event) => {
      const error = workerError(event);
      reject(error);
      for (const { reject: rejectWaiting } of waiting.values()) rejectWaiting(error);
      waiting.clear();
    });
  });
}

/**
 * 一個 PP-OCR 引擎：把 worker 包成 { recognize, terminate }。
 * `models` 是 { det, rec, cls, dict } 四個 Uint8Array（從 IndexedDB 讀出），用 transfer 零拷貝交給 worker。
 * `providers` 省略時自己呼叫 chooseProviders()。`onStatus(text)` 在引擎一建好就開始收 worker 的階段訊息，
 * 所以冷啟動的「正在準備辨識引擎…」不會漏掉（不要等到 recognize 才掛）。
 */
export async function createOcrEngine({ models, providers, onStatus = () => {}, createWorker = loadWorker } = {}) {
  const executionProviders = providers ?? (await chooseProviders());
  const worker = createWorker();
  let nextId = 1;
  // One worker request at a time: a read never runs while the warm-up (or another read) does. A request queued
  // behind one when the worker dies is rejected, not posted to a worker that will never answer.
  let chain = Promise.resolve();
  let dead = null;
  worker.addEventListener("error", (event) => {
    dead = workerError(event);
  });
  const serial = (start) => {
    const run = chain.then(() => {
      if (dead) throw dead;
      return start();
    });
    chain = run.catch(() => {});
    return run;
  };
  const waiting = new Map(); // id -> { resolve, reject, onHead }
  // Posts one request to the worker, once the ones before it have settled, and resolves with the worker's answer.
  // `onHead` receives the first lines of a read early; with `softFail` a failed request settles as its own answer
  // (the warm-up never rejects).
  const request = (type, fields, { transfer, onHead, softFail = false } = {}) =>
    serial(() => new Promise((resolve, reject) => {
      const id = nextId++;
      waiting.set(id, { resolve, reject: softFail ? resolve : reject, onHead });
      worker.postMessage({ type, id, ...fields }, transfer);
    }));
  const ready = connectWorker(worker, waiting, onStatus);
  ready.catch(() => {}); // 不讓沒人 await 的 init reject 變成 unhandled rejection
  // The worker has no chrome.* (extension APIs are not exposed to dedicated workers), so the panel resolves the
  // extension-local ORT address and hands it over.
  const wasmPaths = globalThis.chrome?.runtime?.getURL?.(`${ORT_DIR}/`) ?? `${ORT_DIR}/`;
  const modelBuffers = {
    det: models.det.buffer, rec: models.rec.buffer, cls: models.cls.buffer, dict: models.dict.buffer,
  };
  worker.postMessage(
    { type: "init", providers: executionProviders, wasmPaths, models: modelBuffers },
    Object.values(modelBuffers),
  );
  let warmupPromise = null;
  function warmup() {
    if (!warmupPromise) {
      warmupPromise = (async () => {
        try {
          await ready;
          const res = await request("warmup", {}, { softFail: true });
          globalThis.__jevWarmupLog = res;
          return res;
        } catch {
          // silently ignored: a failed warm-up never surfaces an error
        }
      })();
    }
    return warmupPromise;
  }
  return {
    async recognize({ width, height, data }, { capDet = false, onHead = null } = {}) {
      await ready;
      return request("recognize", { width, height, data, capDet }, { transfer: [data.buffer], onHead });
    },
    async detectBoxes({ width, height, data }) {
      await ready;
      return request("detect", { width, height, data }, { transfer: [data.buffer] });
    },
    ready,
    warmup,
    terminate() {
      worker.postMessage({ type: "close" });
      worker.terminate();
    },
  };
}

/** A picture (File/Blob) as RGBA pixels, optionally only the selected rectangle { x, y, width, height }. */
export async function readPixels(blob, region = null) {
  // No colour-space conversion or alpha premultiplying: the pixels the file holds are the pixels that get read.
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  const area = region ?? { x: 0, y: 0, width: bitmap.width, height: bitmap.height };
  const canvas = new OffscreenCanvas(area.width, area.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, area.x, area.y, area.width, area.height, 0, 0, area.width, area.height);
  bitmap.close();
  const { width, height, data } = ctx.getImageData(0, 0, area.width, area.height);
  return { width, height, data };
}
