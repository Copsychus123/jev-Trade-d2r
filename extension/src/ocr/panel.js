// The screenshot reader under the name field: paste / drop / pick a screenshot, optionally drag a box, read it, offer 1 to 3 names to pick.
// All page-unrelated text comes from OCR, so everything is written with textContent.
import { createEngineCache, createOcrEngine, readPixels, OCR_CAPABILITY } from "./engine.js";
import { buildMatchIndex, matchOcrText } from "./match.js";
import { ModelError, PPOCR, createModelManager, formatMB, idbStore } from "./models.js";
import { $ } from "../dom.js";
import { labelWithChinese } from "../traderie/lookup.js";

/**
 * The dragged box as a read region: the box is drawn in CSS pixels, the read needs image pixels, and a sliver thinner
 * than a name line is not worth a read at all. Pure, so the crop rule can be reasoned about without the DOM.
 */
function cropRegionFromDrag({ left, top, width, height }, previewRect, naturalWidth) {
  const toImagePixels = (value) => Math.round(parseFloat(value) * (naturalWidth / previewRect.width));
  const w = toImagePixels(width);
  const h = toImagePixels(height);
  // A sliver thinner than a name line is not worth a read. Written with `>` so a box that is not a number is refused
  // here too, exactly as the inline version did.
  if (!(w > 20 && h > 10)) return null;
  return { x: toImagePixels(left), y: toImagePixels(top), width: w, height: h };
}

export function initOcrPanel({ tables, onPick, onText = () => {}, onImage, isBusy }) {
  const manager = createModelManager({ store: idbStore() });
  const index = buildMatchIndex(tables);
  let reading = false; // only while a picture is being read does the engine's stage message reach the screen
  const engines = createEngineCache({
    create: async () => {
      const bytes = await manager.load();
      if (!bytes) throw new ModelError("init", "本機的辨識模型不完整");
      return createOcrEngine({ models: bytes, onStatus: (message) => { if (reading) say(message); } });
    },
  });
  let image = null; // the Blob being read
  let region = null; // { x, y, width, height } in image pixels, or null for the whole picture
  let previewUrl = null; // object URL of the shown picture; revoked when it is replaced or closed
  let pictureVersion = 0; // bumped when the picture changes or closes: an older read then drops its result
  let downloading = null; // AbortController of the running model download

  // 換圖或關圖時，正在跑的下載會被取消。
  const supersede = () => {
    pictureVersion += 1;
    downloading?.abort();
  };
  const revokePreview = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  };
  const showPreview = (blob) => {
    revokePreview();
    previewUrl = URL.createObjectURL(blob);
    preview.src = previewUrl;
    preview.hidden = false;
  };
  const clearPreview = () => {
    revokePreview();
    previewUrl = null;
    preview.removeAttribute("src");
    preview.hidden = true;
  };

  const say = (text, kind = "") => {
    $("ocr-status").textContent = text;
    $("ocr-status").dataset.kind = kind;
  };

  /** The candidate name buttons belong to one read: a new picture, a close and a fresh read all drop them. */
  const clearCandidates = () => $("ocr-candidates").replaceChildren();

  // Hands the name (and whether it is an item or only a base) to the form, which may refuse it while a query runs or
  // when it has no field for it, and marks it as coming from a picture.
  const fill = (name, kind) => {
    if (onPick(name, kind)) $("ocr-tag").hidden = false;
  };

  // ---- the picture and the optional box -------------------------------------------------------------------------
  const preview = $("ocr-preview");
  const box = $("ocr-box");
  const drag = { active: false, x: 0, y: 0, moved: false };

  // The 辨識 button is only needed when reading does not start by itself: auto-read is off,
  // or the player boxed a region to read again.
  function updateGo() {
    $("ocr-go").hidden = $("ocr-auto").checked && !region;
  }

  async function setImage(blob) {
    supersede();
    onImage();
    image = blob;
    region = null;
    box.hidden = true;
    clearCandidates();
    showPreview(blob);
    $("ocr-panel").hidden = false;
    $("ocr-go").disabled = false;
    $("ocr-panel").classList.remove("done");
    updateGo();
    // With the model already on this computer, reading starts by itself (nothing is downloaded, nothing searched).
    if ($("ocr-go").hidden && !isBusy()) {
      say("已讀入圖片，正在辨識…");
      $("ocr-go").click();
      return;
    }
    $("ocr-go").hidden = false; // reading waits for the player (a query may be running right now)
    say("已讀入圖片。可在圖上拖一個框只讀那一塊（不框就讀整張），再按「辨識」。");
  }

  /** One drag on the picture: the box follows the pointer and becomes the read region when it is released. */
  function wirePictureBox() {
    preview.addEventListener("pointerdown", (event) => {
      const rect = preview.getBoundingClientRect();
      drag.active = true;
      drag.moved = false;
      drag.x = event.clientX - rect.left;
      drag.y = event.clientY - rect.top;
      preview.setPointerCapture(event.pointerId);
    });
    preview.addEventListener("pointermove", (event) => {
      if (!drag.active) return;
      const rect = preview.getBoundingClientRect();
      const x = Math.max(0, Math.min(event.clientX - rect.left, rect.width));
      const y = Math.max(0, Math.min(event.clientY - rect.top, rect.height));
      Object.assign(box.style, {
        left: `${Math.min(drag.x, x)}px`,
        top: `${Math.min(drag.y, y)}px`,
        width: `${Math.abs(x - drag.x)}px`,
        height: `${Math.abs(y - drag.y)}px`,
      });
      if (Math.abs(x - drag.x) > 4 || Math.abs(y - drag.y) > 4) drag.moved = true;
      box.hidden = false;
    });
    preview.addEventListener("pointerup", () => {
      drag.active = false;
      if (box.hidden) return;
      const rect = preview.getBoundingClientRect();
      region = cropRegionFromDrag(box.style, rect, preview.naturalWidth);
      if (!region) box.hidden = true;
      updateGo(); // a box means the player wants a manual read
    });
    preview.addEventListener("click", () => {
      if (!drag.moved) $("ocr-panel").classList.toggle("done"); // thumbnail <-> full picture
    });
  }

  /** The three ways a picture gets in: paste anywhere, the file picker, or a drop on the panel. */
  function wirePictureSources() {
    const fromFiles = (files) => {
      const file = [...files].find((f) => f.type.startsWith("image/"));
      if (file) setImage(file);
      else say("這不是圖片檔", "error");
    };
    document.addEventListener("paste", (event) => {
      const files = [...(event.clipboardData?.files ?? [])];
      if (files.length) fromFiles(files); // plain text pasted into the name field is left alone
    });
    $("ocr-file").addEventListener("change", (event) => {
      if (event.target.files.length) fromFiles(event.target.files); // cancelling the dialog does nothing
    });
    const drop = $("ocr-drop");
    const zone = $("ocr-dropzone");
    let depth = 0; // dragenter/dragleave fire for every element crossed; only the empty stack shows the zone
    drop.addEventListener("dragover", (event) => event.preventDefault());
    drop.addEventListener("dragenter", (event) => {
      if ([...(event.dataTransfer?.types ?? [])].includes("Files")) {
        depth += 1;
        zone.hidden = false;
      }
    });
    drop.addEventListener("dragleave", () => {
      depth = Math.max(0, depth - 1);
      if (!depth) zone.hidden = true;
    });
    drop.addEventListener("drop", (event) => {
      event.preventDefault();
      depth = 0; // the drag ended: empty the stack and hide the zone again, whatever the files turn out to be
      zone.hidden = true;
      if (event.dataTransfer.files.length) fromFiles(event.dataTransfer.files);
    });
  }

  /** The screenshot entrance sits next to the item name; the reading panel only exists while there is a picture. */
  function wirePanelControls() {
    $("ocr-pick").addEventListener("click", () => $("ocr-file").click());
    const closePanel = () => {
      supersede();
      image = null;
      region = null;
      box.hidden = true;
      clearPreview();
      $("ocr-panel").hidden = true;
      $("ocr-go").disabled = true;
      clearCandidates();
      $("ocr-file").value = "";
    };
    $("ocr-close").addEventListener("click", closePanel);
  }

  /** Small entrance, explained only when needed: a tooltip on hover/focus, and a dot that goes away once. */
  function wireHint() {
    const hint = $("ocr-hint");
    const showHint = () => {
      hint.hidden = false;
    };
    const hideHint = () => {
      hint.hidden = true;
    };
    $("ocr-pick").addEventListener("mouseenter", showHint);
    $("ocr-pick").addEventListener("mouseleave", hideHint);
    $("ocr-pick").addEventListener("focus", showHint);
    $("ocr-pick").addEventListener("blur", hideHint);
    $("ocr-pick").addEventListener("click", () => {
      $("ocr-dot").hidden = true;
      chrome.storage.local.set({ ocrHintSeen: true });
    });
  }

  wirePictureBox();
  wirePictureSources();
  wirePanelControls();
  wireHint();

  async function initPreferences() {
    const saved = await chrome.storage.local.get(["ocrAuto", "ocrHintSeen"]);
    $("ocr-auto").checked = saved.ocrAuto !== false; // on unless the player turned it off
    $("ocr-auto").addEventListener("change", () => {
      chrome.storage.local.set({ ocrAuto: $("ocr-auto").checked });
      updateGo();
    });
    $("ocr-dot").hidden = Boolean(saved.ocrHintSeen);
  }
  // The name no longer comes from the screenshot as soon as the player edits it.
  $("item").addEventListener("input", () => {
    $("ocr-tag").hidden = true;
  });
  $("ocr-cancel").addEventListener("click", () => downloading?.abort());

  // ---- models: download once on first use, then keep ------------------------------------------------------------
  /** Downloads `names` in order; `onProgress(got, total)` counts the bytes of every file so far. */
  async function runDownloads(names, bytes, { signal, onProgress }) {
    let done = 0;
    for (const name of names) {
      await manager.download(name, { signal, onProgress: (got) => onProgress(done + got, bytes) });
      done += PPOCR[name].bytes;
    }
  }

  /**
   * The one "download once, with a notice" path this panel and the gear scanner share: it shows `noticeId`, writes
   * `textId`, drives `progressId` and (when given) wires `cancelId`. `tail` is the screen's own closing sentence and
   * `say` its own status line, so each screen keeps its wording while the controller, the progress scale and the
   * cancel bookkeeping live here only. True when the models are there; a cancelled download throws as it always did.
   */
  async function downloadWithNotice({ noticeId, textId, progressId, cancelId = null, tail, names, bytes, say }) {
    const controller = new AbortController();
    downloading = controller; // the panel's own cancel listener aborts this one
    if (cancelId) $(cancelId).onclick = () => controller.abort();
    $(textId).textContent =
      `首次使用，正在下載辨識模型（約 ${formatMB(bytes)} MB，只下載一次，存在這個瀏覽器裡，${tail}）。`;
    $(noticeId).hidden = false;
    $(progressId).value = 0;
    try {
      await runDownloads(names, bytes, {
        signal: controller.signal,
        onProgress: (got) => {
          $(progressId).value = bytes ? Math.round((got / bytes) * 100) : 0;
          say(`下載辨識模型（${formatMB(got)} / ${formatMB(bytes)} MB）`);
        },
      });
      return true;
    } finally {
      if (downloading === controller) {
        downloading = null;
        $(noticeId).hidden = true;
      }
      if (cancelId) $(cancelId).onclick = null;
    }
  }

  /** True when reading can proceed (models present, or downloaded now). False when the download was cancelled. */
  async function ensureModels() {
    const { names, bytes } = await manager.missing();
    if (!names.length) return true;
    return downloadWithNotice({
      noticeId: "ocr-download",
      textId: "ocr-download-text",
      progressId: "ocr-progress",
      tail: "之後可以離線使用",
      names,
      bytes,
      say,
    });
  }

  function showCandidates(candidates) {
    const list = $("ocr-candidates");
    clearCandidates();
    // Exposed for the end-to-end check: the kind is not readable from the label any more.
    list.dataset.firstKind = candidates[0]?.kind ?? "";
    list.dataset.firstName = candidates[0]?.name ?? "";
    if (!candidates.length) {
      say("認不出裝備名稱，請手動輸入英文名稱（或換一張更清楚的圖、框出名稱那幾行）。", "error");
      return;
    }
    const baseOnly = candidates[0]?.kind === "base";
    fill(candidates[0].name, candidates[0].kind); // the best result goes straight into the name field; the player decides to search
    say(
      (baseOnly ? "只認出底材（不會依品質篩選）" : "已辨識") +
        `，並填入裝備名稱「${labelWithChinese(candidates[0].name, tables, candidates[0].matched)}」。請確認後自己按「開始查詢」。` +
        (candidates.length > 1 ? "不對的話，可改點下面其他名稱：" : ""),
      baseOnly ? "" : "ok",
    );
    if (candidates.length < 2) return;
    for (const candidate of candidates) {
      const label = labelWithChinese(candidate.name, tables, candidate.matched);
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.kind = candidate.kind;
      button.dataset.name = candidate.name;
      button.textContent = label;
      button.addEventListener("click", () => {
        fill(candidate.name, candidate.kind);
        say(`已改填「${label}」。請確認後自己按「開始查詢」。`, "ok");
      });
      list.append(button);
    }
  }

  async function readPicture(blob, area, isCurrent) {
    $("ocr-panel").classList.remove("done");
    $("ocr-time").textContent = "";
    $("ocr-text").textContent = "";
    clearCandidates();
    const pixels = await readPixels(blob, area);
    reading = true;
    say("辨識中…");
    const started = performance.now();
    const slowNoticeTimer = setTimeout(() => {
      if (isCurrent() && reading) say("這張圖比較大，還在辨識中…");
    }, 15_000);
    let text;
    try {
      text = await engines.run(OCR_CAPABILITY, (engine) => engine.recognize(pixels));
    } finally {
      clearTimeout(slowNoticeTimer);
    }
    if (!isCurrent()) return;
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    const found = matchOcrText(text, index);
    showCandidates(found);
    onText(text);
    $("ocr-panel").classList.toggle("done", found.length > 0); // a result shrinks the picture to a thumbnail
    $("ocr-time").textContent = `辨識用時 ${seconds} 秒`;
    $("ocr-text").textContent = text;
  }

  async function handleReadFailure(error) {
    if (error instanceof ModelError && error.kind === "cancelled") {
      say("已取消下載，沒有辨識模型就無法辨識。");
      return;
    }
    if (error instanceof ModelError && error.kind === "init") {
      await manager.forgetAll();
      updateGo();
      say(`辨識引擎啟動失敗（${error.message || error}）。已清除已下載的模型紀錄，再按一次「辨識」會重新下載。`, "error");
      return;
    }
    say(`辨識失敗：${error.message || error}。可以再按一次「辨識」重試。`, "error");
  }

  /** 辨識: make sure the models are here, then read the picture (or the boxed region) shown right now. */
  async function readCurrentPicture() {
    if (!image || isBusy()) return;
    const versionAtStart = pictureVersion;
    const isCurrent = () => versionAtStart === pictureVersion; // false once the picture was replaced or closed
    const blob = image;
    const area = region;
    $("ocr-go").disabled = true;
    try {
      if (!(await ensureModels())) {
        if (isCurrent()) {
          say("沒有下載辨識模型，無法辨識。可以再按一次「辨識」重新下載，或手動輸入名稱。", "error");
        }
        return;
      }
      if (!isCurrent()) return;
      await readPicture(blob, area, isCurrent);
    } catch (error) {
      if (!isCurrent()) return;
      await handleReadFailure(error);
    } finally {
      reading = false;
      if (isCurrent()) $("ocr-go").disabled = !image;
    }
  }

  $("ocr-go").addEventListener("click", readCurrentPicture);

  initPreferences();

  // ---- what the gear scanner shares with this panel: the model store, the one engine and the matcher ---------------
  // The scanner must not open a second engine cache or a second download path, so it works through these.
  return {
    /** The four assets still missing on this computer: { names, bytes }. */
    missingModels: () => manager.missing(),
    /** Download what `names`/`bytes` describe behind this panel's own notice; the scanner passes its own ids. */
    downloadWithNotice,
    /** A cropped tooltip (Blob) as OCR text. A broken engine drops the stored models, so a download is offered again. */
    async recognize(blob) {
      try {
        return await engines.run(OCR_CAPABILITY, async (engine) => engine.recognize(await readPixels(blob)));
      } catch (error) {
        if (error instanceof ModelError && error.kind === "init") await manager.forgetAll();
        throw error;
      }
    },
    /** Candidate names for OCR text, best first (at most three). */
    match: (text) => matchOcrText(text, index),
  };
}
