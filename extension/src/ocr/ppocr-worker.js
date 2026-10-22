// The recognition worker (module worker, no DOM): loads onnxruntime-web, builds the three sessions from the bytes the
// panel hands over, then runs the PP-OCR pipeline. The only interface is the message protocol below.
import * as ort from "../vendor/ort/ort.min.mjs";
import { OcrPipeline, buildCharacterList, imageDataToBgr } from "./ppocrlib.js";

let pipeline = null;
const DICT_SIZE = 18710; // characters of the recogniser's dictionary, including the blank and space tokens

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

// The only error shape the panel reads: `id: null` means "the engine never started", otherwise it is the failed read.
const postError = (id, message) => self.postMessage({ type: "error", id, message });
const errorText = (error) => error?.message || String(error);

// Reports a read that arrived before the engine was ready; true when the handler must stop there.
const notReady = (message) => {
  if (pipeline) return false;
  postError(message.id, "辨識引擎尚未就緒");
  return true;
};

// The picture of a read request as the BGR image the pipeline takes.
const messageImage = (message) =>
  imageDataToBgr({ width: message.width, height: message.height, data: new Uint8ClampedArray(message.data) });

async function handleInit(message) {
  self.postMessage({ type: "status", stage: "loading" });
  ort.env.wasm.wasmPaths = message.wasmPaths; // resolved by the panel: no chrome.* inside a dedicated worker
  let sessions;
  try {
    sessions = await createSessions(message.providers, message.models);
  } catch (error) {
    postError(null, errorText(error));
    return;
  }
  const characters = buildCharacterList(new TextDecoder().decode(new Uint8Array(message.models.dict)));
  if (characters.length !== DICT_SIZE) {
    postError(null, `字元清單長度不對（${characters.length}，應為 ${DICT_SIZE}）`);
    return;
  }
  pipeline = new OcrPipeline(ort, sessions, characters);
  self.postMessage({ type: "status", stage: "ready" });
}

async function handleRecognize(message) {
  if (notReady(message)) return;
  try {
    const image = messageImage(message);
    const recognized = await pipeline.recognizeImage(image, {
      capDet: Boolean(message.capDet),
      // The first lines of the picture, as soon as they are read; the result with every line follows.
      onHead: (headLines) =>
        self.postMessage({
          type: "head",
          id: message.id,
          text: headLines.map((line) => line.text).join("\n"),
          tones: headLines.map((line) => line.tone),
        }),
    });
    const lines = recognized.lines ?? [];
    const resultMsg = {
      type: "result",
      id: message.id,
      text: lines.map((line) => line.text).join("\n"),
      tones: lines.map((line) => line.tone),
    };
    if (recognized.stages !== undefined && recognized.stages !== null) resultMsg.stages = recognized.stages;
    self.postMessage(resultMsg);
  } catch (error) {
    postError(message.id, errorText(error));
  }
}

async function handleDetect(message) {
  if (notReady(message)) return;
  try {
    const image = messageImage(message);
    const quads = await pipeline.detect(image);
    const boxes = quads.map((q) => {
      const xs = q.map(([x]) => x);
      const ys = q.map(([, y]) => y);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      return {
        x: Math.round(minX),
        y: Math.round(minY),
        width: Math.round(maxX - minX),
        height: Math.round(maxY - minY),
      };
    });
    self.postMessage({
      type: "detectResult",
      id: message.id,
      boxes,
      width: message.width,
      height: message.height,
    });
  } catch (error) {
    postError(message.id, errorText(error));
  }
}

async function handleWarmup(message) {
  const reply = (log) => {
    if (message.id !== undefined && message.id !== null) {
      self.postMessage({ type: "warmupResult", id: message.id, log });
    }
  };
  if (!pipeline) {
    reply(["no pipeline"]);
    return;
  }
  let log;
  try {
    log = await pipeline.warmup();
  } catch (error) {
    log = [`error: ${error?.message}`];
  }
  reply(log);
}

self.addEventListener("message", (event) => {
  const message = event.data;
  if (message.type === "init") handleInit(message);
  else if (message.type === "recognize") handleRecognize(message);
  else if (message.type === "detect") handleDetect(message);
  else if (message.type === "warmup") handleWarmup(message);
  else if (message.type === "close") self.close();
});
