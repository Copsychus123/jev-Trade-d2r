// Runs Tesseract inside the side panel. Every file it loads is inside the extension; the language data is read from the
// IndexedDB location where we stored the verified bytes (read-only), so it never downloads or caches anything itself.
import { CACHE_PATH } from "./models.js";
import { DEFAULT_STEPS, preprocess } from "./preprocess.js";

export const VENDOR_DIR = "vendor/tesseract";
export const CORE_FILE = "tesseract-core-simd-lstm.wasm.js"; // one fixed SIMD, text-only core: no CDN, no variants

export function loadTesseract(doc = document, win = window) {
  if (win.Tesseract) return Promise.resolve(win.Tesseract);
  return new Promise((resolve, reject) => {
    const script = doc.createElement("script");
    script.src = `${VENDOR_DIR}/tesseract.min.js`;
    script.onload = () => resolve(win.Tesseract);
    script.onerror = () => reject(new Error("辨識程式載入失敗，請重新安裝擴充功能"));
    doc.head.append(script);
  });
}

/** `baseUrl` is the extension's own address (chrome.runtime.getURL("")), so every path stays inside the extension. */
export async function createEngine({ Tesseract, baseUrl = "", languages }) {
  const worker = await Tesseract.createWorker(languages.join("+"), Tesseract.OEM.LSTM_ONLY, {
    // ocr/worker.js quiets Tesseract's harmless self-notes, then loads the vendored worker unchanged.
    workerPath: `${baseUrl}ocr/worker.js`,
    corePath: `${baseUrl}${VENDOR_DIR}/${CORE_FILE}`,
    // Models come from the cache only. If one were missing, this extension-local address would fail loudly
    // instead of falling back to a CDN.
    langPath: `${baseUrl}${VENDOR_DIR}/no-models-here`,
    cachePath: CACHE_PATH,
    cacheMethod: "readOnly",
    workerBlobURL: false, // a blob: worker would need a looser security rule than the extension allows
  });
  return {
    async recognize(source) {
      const { data } = await worker.recognize(source);
      return data.text;
    },
    terminate: () => worker.terminate(),
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

/** Prepared picture as something Tesseract accepts. */
export async function prepareForOcr(blob, { region = null, steps = DEFAULT_STEPS } = {}) {
  const prepared = preprocess(await readPixels(blob, region), { steps });
  const canvas = new OffscreenCanvas(prepared.width, prepared.height);
  canvas.getContext("2d").putImageData(new ImageData(prepared.data, prepared.width, prepared.height), 0, 0);
  return canvas.convertToBlob({ type: "image/png" });
}
