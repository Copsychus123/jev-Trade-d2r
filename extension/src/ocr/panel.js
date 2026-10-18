// The screenshot reader under the name field: paste / drop / pick a screenshot, optionally drag a box, read it, offer 1 to 3 names to pick.
// All page-unrelated text comes from OCR, so everything is written with textContent.
import { createEngineCache, createOcrEngine, readPixels, OCR_CAPABILITY } from "./engine.js";
import { applyLearned, LEARNED_HINT } from "./corrections.js";
import { buildMatchIndex, decideCandidates, extendCandidates, LEARNED_SURE, matchOcrText, nameKeys, textWithChinese } from "./match.js";
import { ModelError, createModelManager, idbStore } from "./models.js";
import { $ } from "../dom.js";
import { fieldName, labelWithChinese, tableEntry } from "../traderie/lookup.js";

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

export function initOcrPanel({ tables, onPick, onText = () => {}, onImage, isBusy, onNone = () => $("item").focus(), corrections = null }) {
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
  // The read the player is looking at, for the correction memory: the name-line key a choice is remembered under (the text
  // piece the chosen candidate matched, else the first name line), the name the field was last given and whether the player
  let warmRelease = null;
  let lastRead = null;
  corrections?.attach(tables);

  // 換圖或關圖時，正在跑的下載會被取消。
  const supersede = () => {
    pictureVersion += 1;
    lastRead = null;
    downloading?.abort();
    if (warmRelease) {
      warmRelease();
      warmRelease = null;
    }
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

  /** The matcher's candidates for a text, with the player's remembered choice for exactly this text applied (corrections.js). */
  const matchWithMemory = (text, tones) => {
    const found = matchOcrText(text, index, tones);
    const hit = corrections?.lookup(nameKeys(text)) ?? null;
    return hit ? applyLearned(found, hit) : found;
  };

  /** The player decided `candidate` for the read on screen: remember it under the text piece it matched. */
  const learnChoice = (candidate) => {
    if (!lastRead) return;
    lastRead.key = candidate.matched || lastRead.key;
    lastRead.filled = candidate.name;
    lastRead.edited = false;
    if (lastRead.key) corrections?.learn(lastRead.key, candidate.name);
  };

  /** The candidate name buttons belong to one read: a new picture, a close and a fresh read all drop them. */
  const clearCandidates = () => $("ocr-candidates").replaceChildren();

  // Hands the name (English, and whether it is an item or only a base) and the text to show in the field (Chinese
  // when the table has one) to the form, which may refuse it while a query runs or when it has no field for it, and
  // marks it as coming from a picture. The query value is always the English name: the field text is resolved back
  // through the table by resolveInput before Traderie is touched.
  const fill = (candidate) => {
    const shown = fieldName(candidate.name, tables, candidate.matched);
    if (onPick(candidate.name, candidate.kind, shown)) {
      $("ocr-tag").hidden = false;
      if (lastRead) lastRead.filled = candidate.name;
    }
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
    warmRelease = engines.keepWarm(OCR_CAPABILITY, { warmup: false });
    clearCandidates();
    showPreview(blob);
    $("ocr-panel").hidden = false;
    $("ocr-go").disabled = false;
    $("ocr-panel").classList.remove("done");
    updateGo();
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
    if (lastRead) lastRead.edited = true; // the player typed over (or instead of) what the read gave: see noteQueryName
  });
  // ---- models: download once on first use, then keep ------------------------------------------------------------
  /**
   * The one "download once, silently" path this panel and the gear scanner share: fetching `names` stores the models
   * on this computer and never writes to the screen — only a failure reaches the caller's error path. The panel's own
   * abort bookkeeping stays, so closing it or replacing the picture still stops a download in flight. True when the
   * models are there; a cancelled download throws as it always did.
   */
  async function downloadModels({ names }) {
    const controller = new AbortController();
    downloading = controller; // supersede() aborts this one when the picture changes or the panel closes
    try {
      for (const name of names) {
        await manager.download(name, { signal: controller.signal });
      }
      return true;
    } finally {
      if (downloading === controller) downloading = null;
    }
  }

  /** True when reading can proceed (models present, or downloaded now). False when the download was cancelled. */
  async function ensureModels() {
    const { names } = await manager.missing();
    if (!names.length) return true;
    return downloadModels({ names });
  }

  /** One name button; its label is Chinese-first, `data-name` stays the English name the query uses. */
  function candidateButton(candidate, onClick) {
    const label = labelWithChinese(candidate.name, tables, candidate.matched);
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.kind = candidate.kind;
    button.dataset.name = candidate.name;
    // A name the player chose before for this same text says so, so the first place is not a mystery.
    if (candidate.learned) button.dataset.learned = String(candidate.learned);
    button.textContent = candidate.learned ? `${label} · ${LEARNED_HINT}` : label;
    button.addEventListener("click", () => onClick(label));
    return button;
  }

  /**
   * A read that is not sure (decideCandidates): nothing is filled in; the player's click on a name is the decision, and
   * what the correction memory keeps. `sentence` is the question, `candidates` the possible names (extendCandidates).
   */
  function askWhich(candidates, list, sentence) {
    say(sentence);
    for (const candidate of candidates) {
      list.append(
        candidateButton(candidate, (label) => {
          learnChoice(candidate);
          fill(candidate);
          say(`已填入「${label}」。請確認後自己按「開始查詢」。`, "ok");
        }),
      );
    }
    const none = document.createElement("button");
    none.type = "button";
    none.dataset.none = "true";
    none.textContent = "都不是，我自己輸入";
    none.addEventListener("click", () => {
      onNone(); // the field stays as it is: the player types
      say("請在名稱欄自己輸入。");
    });
    list.append(none);
  }

  function showCandidates(candidates, text) {
    const list = $("ocr-candidates");
    clearCandidates();
    const { confident } = decideCandidates(candidates);
    // A read that is not sure offers up to five possible names: the matcher's own, then the next best ones from the tables.
    const asked = confident ? candidates : extendCandidates(candidates, text, index);
    // Exposed for the end-to-end check: the kind is not readable from the label any more.
    list.dataset.firstKind = candidates[0]?.kind ?? "";
    list.dataset.firstName = candidates[0]?.name ?? "";
    list.dataset.unsure = asked.length && !confident ? "true" : "";
    if (!asked.length) {
      say("認不出裝備名稱，請手動輸入英文名稱（或換一張更清楚的圖、框出名稱那幾行）。", "error");
      return;
    }
    if (!confident) {
      askWhich(asked, list, candidates.length ? "不確定是哪一件，請點選一個：" : "沒有把握，可能是下面這些，請點選一個：");
      return;
    }
    const baseOnly = candidates[0]?.kind === "base";
    fill(candidates[0]); // the best result goes straight into the name field; the player decides to search
    say(
      (baseOnly ? "只認出底材（不會依品質篩選）" : "已辨識") +
        `，並填入裝備名稱「${labelWithChinese(candidates[0].name, tables, candidates[0].matched)}」` +
        (candidates[0].learned >= LEARNED_SURE ? "（照你之前的選擇）" : "") +
        "。請確認後自己按「開始查詢」。" +
        (candidates.length > 1 ? "不對的話，可改點下面其他名稱：" : ""),
      baseOnly ? "" : "ok",
    );
    if (candidates.length < 2) return;
    for (const candidate of candidates) {
      list.append(
        candidateButton(candidate, (label) => {
          if (candidate !== candidates[0]) learnChoice(candidate); // another name than the one filled in is a correction
          fill(candidate);
          say(`已改填「${label}」。請確認後自己按「開始查詢」。`, "ok");
        }),
      );
    }
  }

  async function readPicture(blob, area, isCurrent) {
    $("ocr-panel").classList.remove("done");
    $("ocr-time").textContent = "";
    $("ocr-text").textContent = "";
    delete $("ocr-text").dataset.tones;
    clearCandidates();
    const pixels = await readPixels(blob, area);
    reading = true;
    say("辨識中…");
    const started = performance.now();
    const slowNoticeTimer = setTimeout(() => {
      if (isCurrent() && reading) say("這張圖比較大，還在辨識中…");
    }, 15_000);
    let read;
    try {
      // The reader's own picture can be a phone photo (over 1500 px a side): detect on a capped copy, read the crops
      // at full resolution. The scan's reads (the adapter below) never ask for this.
      read = await engines.run(OCR_CAPABILITY, (engine) => engine.recognize(pixels, { capDet: true }));
    } finally {
      clearTimeout(slowNoticeTimer);
    }
    const { text, tones, stages } = read;
    if (!isCurrent()) return;
    const totalMs = Math.round(performance.now() - started);
    const seconds = (totalMs / 1000).toFixed(1);
    const runRecord = {
      mode: "reader",
      startedAt: started,
      ms: totalMs,
      stages: stages ?? null,
    };
    globalThis.__jevLastRun = {
      ...(globalThis.__jevLastRun ?? {}),
      reader: runRecord,
      timeline: [
        ...(globalThis.__jevLastRun?.timeline ?? []),
        { stage: "ocr_read", start_ms: 0, ms: totalMs, stages: stages ?? null },
      ],
    };
    const found = matchWithMemory(text, tones);
    lastRead = { key: found[0]?.matched || nameKeys(text)[0]?.key || "", filled: null, edited: false };
    showCandidates(found, text);
    onText(text);
    $("ocr-panel").classList.toggle("done", found.length > 0); // a result shrinks the picture to a thumbnail
    $("ocr-time").textContent = `辨識用時 ${seconds} 秒`;
    $("ocr-text").textContent = textWithChinese(text, index, tables); // the form above still got the raw text
    $("ocr-text").dataset.tones = JSON.stringify(tones); // exposed for the end-to-end check, like the candidate list's data-*
    if (stages) $("ocr-text").dataset.stages = JSON.stringify(stages);
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
    /** Pre-warms the engine and prevents idle termination while active. Returns a release function. */
    keepWarm: () => engines.keepWarm(OCR_CAPABILITY),
    /** The four assets still missing on this computer: { names, bytes }. */
    missingModels: () => manager.missing(),
    /** Download what `names` describe, silently; the scanner uses this too. A cancelled download throws. */
    downloadModels,
    /** A cropped tooltip (Blob) as { text, tones } (the OCR text and each line's lettering colour). A broken engine drops the stored models, so a download is offered again. */
    async recognize(blob, options = {}) {
      try {
        return await engines.run(OCR_CAPABILITY, async (engine) => engine.recognize(await readPixels(blob), options));
      } catch (error) {
        if (error instanceof ModelError && error.kind === "init") await manager.forgetAll();
        throw error;
      }
    },
    /** Detect text boxes with PP-OCR det: { width, height, data } -> [{ x, y, width, height }]. */
    async detectBoxes(image) {
      try {
        return await engines.run(OCR_CAPABILITY, async (engine) => engine.detectBoxes(image));
      } catch (error) {
        if (error instanceof ModelError && error.kind === "init") await manager.forgetAll();
        throw error;
      }
    },
    /** Candidate names for OCR text and its line tones, best first (at most three), the player's remembered choice for this text first. */
    match: matchWithMemory,
    /** The possible names for a read that is not sure: its candidates, then the next best table names, at most five in all. */
    possible: (candidates, text) => extendCandidates(candidates, text, index),
    /** The key a choice for this text is remembered under when no candidate matched: its first name line ("" when none). */
    firstKey: (text) => nameKeys(text)[0]?.key ?? "",
    /** The player decided `name` for the text piece `key` (a scan record's pick or typed name); true when it was remembered. */
    learn: (key, name) => Boolean(key && corrections?.learn(key, name)),
    /**
     * A name search is starting with `rawName` (the field's text). When the player typed in the name field after the
     * picture was read, and the name is a table name other than the one the read filled in, that is a correction of
     * the read and it is remembered under the same key a click on a candidate would have used (the first search after a read only).
     */
    noteQueryName(rawName) {
      const read = lastRead;
      lastRead = null; // the first search after a read is the player's verdict on it; a later one is another matter
      const entry = read?.edited && read.key ? tableEntry(rawName, tables) : null;
      if (entry && entry.name !== read.filled) corrections?.learn(read.key, entry.name);
    },
  };
}
