// The recognition worker (module worker, no DOM): loads onnxruntime-web, builds the three sessions from the bytes the
// panel hands over, then runs the PP-OCR pipeline. The only interface is the message protocol below.
import * as ort from "../vendor/ort/ort.min.mjs";
import { OcrPipeline, buildCharacterList, imageDataToBgr } from "./ppocrlib.js";

let pipeline = null;

ort.env.wasm.numThreads = 1; // 政策：wasm 固定 1 thread
ort.env.wasm.simd = true;
ort.env.logLevel = "warning";

const createSessions = async (providers, models) => {
  const sessions = {};
  for (const name of ["det", "rec", "cls"]) {
    sessions[name] = await ort.InferenceSession.create(models[name], {
      executionProviders: providers,
      graphOptimizationLevel: "all",
    });
  }
  return sessions;
};

async function handleInit(message) {
  self.postMessage({ type: "status", stage: "loading" });
  ort.env.wasm.wasmPaths = message.wasmPaths; // resolved by the panel: no chrome.* inside a dedicated worker
  let sessions;
  try {
    sessions = await createSessions(message.providers, message.models);
  } catch (error) {
    self.postMessage({ type: "error", id: null, message: String(error.message || error) });
    return;
  }
  const characters = buildCharacterList(new TextDecoder().decode(new Uint8Array(message.models.dict)));
  if (characters.length !== 18710) {
    self.postMessage({ type: "error", id: null, message: `字元清單長度不對（${characters.length}，應為 18710）` });
    return;
  }
  pipeline = new OcrPipeline(ort, sessions, characters);
  self.postMessage({ type: "status", stage: "ready" });
}

async function handleRecognize(message) {
  if (!pipeline) {
    self.postMessage({ type: "error", id: message.id, message: "辨識引擎尚未就緒" });
    return;
  }
  try {
    const image = imageDataToBgr({
      width: message.width,
      height: message.height,
      data: new Uint8ClampedArray(message.data),
    });
    const { lines } = await pipeline.recognizeImage(image);
    self.postMessage({ type: "result", id: message.id, text: lines.map((line) => line.text).join("\n") });
  } catch (error) {
    self.postMessage({ type: "error", id: message.id, message: String(error.message || error) });
  }
}

self.addEventListener("message", (event) => {
  const message = event.data;
  if (message.type === "init") handleInit(message);
  else if (message.type === "recognize") handleRecognize(message);
  else if (message.type === "close") self.close();
});
