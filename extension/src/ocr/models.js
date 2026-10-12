// Recognition models: fixed download URLs, SHA-256 check, kept in IndexedDB. Nothing here retries by itself.

// Pinned to one revision of RapidAI/RapidOCR, so the bytes can never change under us. The three ONNX models and the
// character list are downloaded the first time a panel needs them and are stored exactly as downloaded.
const MS = "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.9.2";
export const PPOCR = {
  det:  { url: `${MS}/onnx/PP-OCRv6/det/PP-OCRv6_det_small.onnx`, bytes: 9929594,
          sha256: "090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f" },
  rec:  { url: `${MS}/onnx/PP-OCRv6/rec/PP-OCRv6_rec_small.onnx`, bytes: 21234383,
          sha256: "6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884" },
  cls:  { url: `${MS}/onnx/PP-OCRv4/cls/ch_ppocr_mobile_v2.0_cls_mobile.onnx`, bytes: 585532,
          sha256: "e47acedf663230f8863ff1ab0e64dd2d82b838fceb5957146dab185a89d6215c" },
  dict: { url: `${MS}/paddle/PP-OCRv6/rec/PP-OCRv6_rec_small/ppocrv6_dict.txt`, bytes: 74947,
          sha256: "b5f2bfe2bdd9448429e3e82b51c789775d9b42f2403d082b00662eb77e401c5d" },
};
export const PPOCR_FILES = ["det", "rec", "cls", "dict"]; // 下載順序
export const PPOCR_BYTES = 31824456;

/** A number of model bytes as MB with one decimal, for the "download once" messages of both panels. */
export const formatMB = (bytes) => (bytes / 1e6).toFixed(1);

// The IndexedDB location the model bytes live in (idb-keyval's default database). We put the verified bytes there
// ourselves and read them back to hand to onnxruntime, so nothing ever downloads at run time.
const CACHE_PATH = "jev";
const DB_NAME = "keyval-store";
const STORE_NAME = "keyval";
const bytesKey = (name) => `${CACHE_PATH}/ppocr/${name}`;
const hashKey = (name) => `${CACHE_PATH}/ppocr/${name}.sha256`;

export class ModelError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind; // "network" | "size" | "checksum" | "cancelled" | "init"
  }
}

export async function sha256Hex(bytes, subtle = globalThis.crypto.subtle) {
  const digest = new Uint8Array(await subtle.digest("SHA-256", bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The real storage: one IndexedDB object store, same shape idb-keyval creates. */
export function idbStore() {
  const open = () =>
    new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  const run = async (mode, action) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const request = action(db.transaction(STORE_NAME, mode).objectStore(STORE_NAME));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }).finally(() => db.close());
  };
  return {
    get: (key) => run("readonly", (s) => s.get(key)),
    // getKey reads the key only, never the stored bytes (a model is a few MB)
    has: async (key) => (await run("readonly", (s) => s.getKey(key))) !== undefined,
    put: (key, value) => run("readwrite", (s) => s.put(value, key)),
    delete: (key) => run("readwrite", (s) => s.delete(key)),
  };
}

/** A download that receives nothing for this long is given up (the user can then try again). */
const STALL_MS = 30_000;

/** An AbortController that also aborts when the caller's `signal` does; `cleanup()` detaches it again. */
function linkedAbort(signal) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  return { controller, cleanup: () => signal?.removeEventListener("abort", cancel) };
}

/** The download stall timer: `watch()` (after every chunk) restarts it, `stop()` clears it, `fired()` says whether
 * it ever ran out. Each time it runs out it calls `onStall()` once. */
function stallTimer(stallMs, onStall) {
  let timer;
  let fired = false;
  const watch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      fired = true;
      onStall();
    }, stallMs);
  };
  return { watch, stop: () => clearTimeout(timer), fired: () => fired };
}

export function createModelManager({
  files = PPOCR,
  order = PPOCR_FILES,
  store,
  fetchFn = globalThis.fetch.bind(globalThis),
  subtle,
  stallMs = STALL_MS,
} = {}) {
  async function verify(name, bytes) {
    const { bytes: expected, sha256 } = files[name];
    if (bytes.length !== expected) throw new ModelError("size", `模型大小不對（${bytes.length}，應為 ${expected}）`);
    if ((await sha256Hex(bytes, subtle)) !== sha256) throw new ModelError("checksum", "模型檢查碼不符，檔案已丟棄");
  }

  async function keep(name, bytes) {
    await verify(name, bytes);
    await store.put(bytesKey(name), bytes);
    await store.put(hashKey(name), files[name].sha256);
  }

  async function forget(name) {
    await store.delete(hashKey(name));
    await store.delete(bytesKey(name));
  }

  /**
   * Reads one response into a single array, chunk by chunk. Stops at once (ModelError "size", after `abort()`) when
   * more than `expected` bytes arrive; `onProgress(received, expected)` runs after every chunk and `watch()` restarts
   * the stall timer.
   */
  async function streamResponse(name, response, expected, { onProgress, watch, abort }) {
    const chunks = [];
    let received = 0;
    const tooBig = () => {
      abort(); // stop the transfer; nothing more is read
      return new ModelError("size", `${name} 模型大小不對（超過應有的 ${expected} 位元組，已停止下載）`);
    };
    const reader = response.body?.getReader();
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        if (received > expected) throw tooBig();
        onProgress(received, expected);
        watch();
      }
    } else {
      const whole = new Uint8Array(await response.arrayBuffer());
      chunks.push(whole);
      received = whole.length;
      if (received > expected) throw tooBig();
      onProgress(received, expected);
    }
    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  }

  return {
    /** What still has to be downloaded (a stored file of another version counts as missing). Looks at the small
     * version record and the key of the bytes; the bytes themselves are not read. */
    async missing() {
      const names = [];
      for (const name of order) {
        const stored = await store.get(hashKey(name));
        if (stored !== files[name].sha256 || !(await store.has(bytesKey(name)))) names.push(name);
      }
      return { names, bytes: names.reduce((sum, name) => sum + files[name].bytes, 0) };
    },

    /** The four stored byte arrays for the engine, or null when one is gone or the wrong length. */
    async load() {
      const out = {};
      for (const name of order) {
        const bytes = await store.get(bytesKey(name));
        if (!(bytes instanceof Uint8Array) || bytes.length !== files[name].bytes) return null;
        out[name] = bytes;
      }
      return out;
    },

    /** Drops what is stored for a file, so it counts as missing and is offered for download again. */
    forget,

    /** Drops every stored file (the engine could not start, so the next read offers the download again). */
    async forgetAll() {
      for (const name of order) await forget(name);
    },

    /**
     * Downloads one file from its fixed URL, checks it, stores it. One attempt: a failure is reported, not retried.
     * `signal` cancels it (ModelError "cancelled"); no data for `stallMs` gives up (ModelError "network"); more bytes
     * than the file has stops it at once (ModelError "size").
     */
    async download(name, { onProgress = () => {}, signal } = {}) {
      const { url, bytes: expected } = files[name];
      if (signal?.aborted) throw new ModelError("cancelled", "已取消下載");
      const { controller, cleanup } = linkedAbort(signal);
      const cancel = () => controller.abort();
      const stall = stallTimer(stallMs, cancel);
      const failed = (what, error) => {
        if (signal?.aborted) return new ModelError("cancelled", "已取消下載");
        if (stall.fired()) return new ModelError("network", `模型下載停住：超過 ${Math.round(stallMs / 1000)} 秒沒有收到資料`);
        return new ModelError("network", `${what}：${error?.message || error}`);
      };
      let bytes;
      try {
        stall.watch();
        let response;
        try {
          response = await fetchFn(url, { signal: controller.signal });
        } catch (error) {
          throw failed("連不到模型下載來源", error);
        }
        if (!response.ok) throw new ModelError("network", `模型下載失敗（HTTP ${response.status}）`);
        try {
          bytes = await streamResponse(name, response, expected, { onProgress, watch: stall.watch, abort: cancel });
        } catch (error) {
          throw error instanceof ModelError ? error : failed("模型下載中斷", error);
        }
      } finally {
        stall.stop();
        cleanup();
      }
      await keep(name, bytes);
    },
  };
}

