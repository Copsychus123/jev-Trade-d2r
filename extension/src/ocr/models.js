// Recognition models: fixed download URLs, SHA-256 check, kept in IndexedDB. Nothing here retries by itself.

const RAW = "https://raw.githubusercontent.com";

/**
 * Pinned to one commit of each model repository, so the bytes can never change under us. Files are stored exactly as
 * downloaded (the integer-best files are .gz; Tesseract unpacks them itself), and the check is on those bytes.
 *
 * `best` is the integer-quantised version of tessdata_best. The plain tessdata_best files (15 MB / 13 MB) cannot be
 * used: Tesseract.js's core aborts with "missing function DotProductSSE" on float models.
 */
const BEST = `${RAW}/naptha/tessdata/806cd9adc8c6e8abc11c782db1818c990576bebc/4.0.0_best_int`;
const pack = (code, bytes, sha256) => ({ url: `${BEST}/${code}.traineddata.gz`, bytes, sha256 });

export const MODEL_SETS = {
  best: {
    chi_tra: pack("chi_tra", 1656239, "11fe2610dab05d8a880d02f193ce70203f4c4bbe061b987d5529a2c038a22743"),
    eng: pack("eng", 2952873, "45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91"),
    chi_sim: pack("chi_sim", 1718768, "b8a23f10c7de500891eb458a8adc9cc58ab7f242f08b7d149f5e9aea4ad5db7c"),
    jpn: pack("jpn", 2030256, "2b63ebfbf1484de4a08ce53b29ef98a1c17658a93cbd38acb665d7d316d0be88"),
    kor: pack("kor", 1572336, "78c21276ab14c9bb734d83be1055d9fe5469a4e7e977c51ad385be5737e61126"),
    deu: pack("deu", 1333102, "306c4280d0cbed46fbff727486bd43b92730181bae80f56941a091f363bdf28b"),
    fra: pack("fra", 707406, "d611139672b3752c7097e671e4a1d9209dfd37f2aeb081ef6487fba3351e9255"),
    spa: pack("spa", 2100190, "40be52f97b5d4eb7460073dc1f94cd546b27150333c0bf854ed7e7132db6bceb"),
  },
};

export const ACTIVE_SET = "best";

/** Languages the player can pick (one at a time: reading two together measured worse than one). Each is downloaded
 * only when first chosen and then stays in the browser, so it works offline. */
export const LANGUAGE_OPTIONS = [
  { code: "chi_tra", label: "繁體中文" },
  { code: "eng", label: "English 英文" },
  { code: "chi_sim", label: "简体中文 簡中" },
  { code: "jpn", label: "日本語 日文" },
  { code: "kor", label: "한국어 韓文" },
  { code: "deu", label: "Deutsch 德文" },
  { code: "fra", label: "Français 法文" },
  { code: "spa", label: "Español 西文" },
];
export const DEFAULT_LANGUAGE = "chi_tra";

// Tesseract.js reads language data from this IndexedDB location (idb-keyval's default database, key
// "<cachePath>/<code>.traineddata"). We put the verified bytes there ourselves and run it read-only, so it never
// downloads anything. (Handing it the bytes directly through createWorker does not work in 7.0.0: its initialize step
// reads the language name from the data field.)
export const CACHE_PATH = "jev";
const DB_NAME = "keyval-store";
const STORE_NAME = "keyval";

export class ModelError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind; // "network" | "size" | "checksum"
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
    put: (key, value) => run("readwrite", (s) => s.put(value, key)),
  };
}

export function createModelManager({
  models = MODEL_SETS[ACTIVE_SET],
  store,
  fetchFn = globalThis.fetch.bind(globalThis),
  subtle,
} = {}) {
  const bytesKey = (code) => `${CACHE_PATH}/${code}.traineddata`;
  const hashKey = (code) => `${CACHE_PATH}/${code}.sha256`;

  async function verify(code, bytes) {
    const { bytes: expected, sha256 } = models[code];
    if (bytes.length !== expected) throw new ModelError("size", `${code} 模型大小不對（${bytes.length}，應為 ${expected}）`);
    if ((await sha256Hex(bytes, subtle)) !== sha256) throw new ModelError("checksum", `${code} 模型檢查碼不符，檔案已丟棄`);
  }

  async function keep(code, bytes) {
    await verify(code, bytes);
    await store.put(bytesKey(code), bytes);
    await store.put(hashKey(code), models[code].sha256);
  }

  return {
    /** What still has to be downloaded for these languages (a stored model of another version counts as missing). */
    async missing(codes) {
      const need = [];
      for (const code of codes) {
        const stored = await store.get(hashKey(code));
        if (stored !== models[code].sha256 || !(await store.get(bytesKey(code)))) need.push(code);
      }
      return { codes: need, bytes: need.reduce((sum, code) => sum + models[code].bytes, 0) };
    },

    /** Downloads one model from its fixed URL, checks it, stores it. One attempt: a failure is reported, not retried. */
    async download(code, { onProgress = () => {}, signal } = {}) {
      let response;
      try {
        response = await fetchFn(models[code].url, { signal });
      } catch (error) {
        throw new ModelError("network", `連不到模型下載來源：${error?.message || error}`);
      }
      if (!response.ok) throw new ModelError("network", `模型下載失敗（HTTP ${response.status}）`);
      const chunks = [];
      let received = 0;
      try {
        const reader = response.body?.getReader();
        if (reader) {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            received += value.length;
            onProgress(received, models[code].bytes);
          }
        } else {
          const whole = new Uint8Array(await response.arrayBuffer());
          chunks.push(whole);
          received = whole.length;
          onProgress(received, models[code].bytes);
        }
      } catch (error) {
        throw new ModelError("network", `模型下載中斷：${error?.message || error}`);
      }
      const bytes = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      await keep(code, bytes);
    },

    /** Manual route: the user picked a model file. Same checks as a download. */
    importFile: keep,
  };
}
