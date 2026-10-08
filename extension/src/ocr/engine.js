// The screenshot reader's PP-OCR engine: one Web Worker per engine, onnxruntime-web inside it. Every file it loads is
// inside the extension (vendor/ort); the model bytes come from the IndexedDB location where we stored the verified
// downloads, so it never downloads or caches anything itself.

const ORT_DIR = "vendor/ort";
export const OCR_CAPABILITY = "ppocr";

/** 有可用的 GPU adapter 才請求 WebGPU；不然只用 wasm。gpu 預設取 globalThis.navigator?.gpu。 */
export async function chooseProviders(gpu = globalThis.navigator?.gpu) {
  if (!gpu) return ["wasm"];
  try {
    return (await gpu.requestAdapter()) ? ["webgpu", "wasm"] : ["wasm"];
  } catch {
    return ["wasm"];
  }
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

  const stop = (entry) => entry.promise.then((engine) => engine.terminate(), () => {});
  const release = () => {
    clearTimer(timer);
    timer = null;
    const entry = current;
    current = null;
    return entry ? stop(entry) : Promise.resolve();
  };
  function engineFor(capability) {
    clearTimer(timer);
    timer = null;
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
        if (!active && current) {
          clearTimer(timer);
          timer = setTimer(release, idleMs);
        }
      }
    },
    release,
  };
}

/**
 * 一個 PP-OCR 引擎：把 worker 包成 { recognize, terminate }。
 * `models` 是 { det, rec, cls, dict } 四個 Uint8Array（從 IndexedDB 讀出），用 transfer 零拷貝交給 worker。
 * `providers` 省略時自己呼叫 chooseProviders()。`onStatus(text)` 在引擎一建好就開始收 worker 的階段訊息，
 * 所以冷啟動的「正在準備辨識引擎…」不會漏掉（不要等到 recognize 才掛）。
 */
export async function createOcrEngine({ models, providers, onStatus = () => {}, createWorker = loadWorker } = {}) {
  const eps = providers ?? (await chooseProviders());
  const worker = createWorker();
  let nextId = 1;
  const waiting = new Map(); // id -> { resolve, reject }
  const ready = new Promise((resolve, reject) => {
    worker.addEventListener("message", (event) => {
      const message = event.data;
      if (message.type === "status") {
        if (message.stage === "ready") resolve();
        onStatus(message.stage === "loading" ? "正在準備辨識引擎…" : "正在辨識文字…");
      } else if (message.type === "result") {
        waiting.get(message.id)?.resolve(message.text);
        waiting.delete(message.id);
      } else if (message.type === "error") {
        const error = new Error(message.message);
        if (message.id === null) reject(error);
        else {
          waiting.get(message.id)?.reject(error);
          waiting.delete(message.id);
        }
      }
    });
    worker.addEventListener("error", (event) => {
      const error = new Error(event.message || "辨識 worker 發生錯誤");
      reject(error);
      for (const { reject: rejectWaiting } of waiting.values()) rejectWaiting(error);
      waiting.clear();
    });
  });
  ready.catch(() => {}); // 不讓沒人 await 的 init reject 變成 unhandled rejection
  // The worker has no chrome.* (extension APIs are not exposed to dedicated workers), so the panel resolves the
  // extension-local ORT address and hands it over.
  const wasmPaths = globalThis.chrome?.runtime?.getURL?.(`${ORT_DIR}/`) ?? `${ORT_DIR}/`;
  worker.postMessage(
    { type: "init", providers: eps, wasmPaths, models: {
      det: models.det.buffer, rec: models.rec.buffer, cls: models.cls.buffer, dict: models.dict.buffer } },
    [models.det.buffer, models.rec.buffer, models.cls.buffer, models.dict.buffer],
  );
  return {
    async recognize({ width, height, data }) {
      await ready;
      const id = nextId++;
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        worker.postMessage({ type: "recognize", id, width, height, data }, [data.buffer]);
      });
    },
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
  const r = region ?? { x: 0, y: 0, width: bitmap.width, height: bitmap.height };
  const canvas = new OffscreenCanvas(r.width, r.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, r.x, r.y, r.width, r.height, 0, 0, r.width, r.height);
  bitmap.close();
  const { width, height, data } = ctx.getImageData(0, 0, r.width, r.height);
  return { width, height, data };
}
