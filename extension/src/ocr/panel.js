// The "截圖辨識" card: paste / drop / pick a screenshot, optionally drag a box, read it, offer 1 to 3 names to pick.
// All page-unrelated text comes from OCR, so everything is written with textContent.
import { createEngine, loadTesseract, prepareForOcr } from "./engine.js";
import { buildMatchIndex, matchOcrText } from "./match.js";
import { DEFAULT_LANGUAGE, LANGUAGE_OPTIONS, ModelError, createModelManager, idbStore } from "./models.js";

const $ = (id) => document.getElementById(id);
const mb = (bytes) => (bytes / 1e6).toFixed(1);

export function initOcrPanel({ tables, onPick, isBusy }) {
  const manager = createModelManager({ store: idbStore() });
  const index = buildMatchIndex(tables);
  let image = null; // the Blob being read
  let region = null; // { x, y, width, height } in image pixels, or null for the whole picture
  let engine = null;
  let engineLanguage = null;

  const say = (text, kind = "") => {
    $("ocr-status").textContent = text;
    $("ocr-status").dataset.kind = kind;
  };

  // Writes the name into the item field (the caller refuses while a query runs) and marks it as coming from a picture.
  const fill = (name) => {
    if (onPick(name)) $("ocr-tag").hidden = false;
  };

  // ---- the picture and the optional box -------------------------------------------------------------------------
  const preview = $("ocr-preview");
  const box = $("ocr-box");
  const drag = { active: false, x: 0, y: 0, moved: false };

  async function setImage(blob) {
    image = blob;
    region = null;
    box.hidden = true;
    $("ocr-candidates").replaceChildren();
    preview.src = URL.createObjectURL(blob);
    preview.hidden = false;
    $("ocr-panel").hidden = false;
    $("ocr-go").disabled = false;
    $("ocr-panel").classList.remove("done");
    say("已讀入圖片。可在圖上拖一個框只讀那一塊（不框就讀整張），再按「辨識」。");
    // With the language pack already on this computer, reading starts by itself (nothing is downloaded, nothing searched).
    if ($("ocr-auto").checked && !isBusy() && !(await manager.missing([language()])).codes.length) $("ocr-go").click();
  }

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
    const scale = preview.naturalWidth / rect.width;
    const w = Math.round(parseFloat(box.style.width) * scale);
    const h = Math.round(parseFloat(box.style.height) * scale);
    region = w > 20 && h > 10 ? { x: Math.round(parseFloat(box.style.left) * scale), y: Math.round(parseFloat(box.style.top) * scale), width: w, height: h } : null;
    if (!region) box.hidden = true;
  });

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
  drop.addEventListener("dragover", (event) => event.preventDefault());
  drop.addEventListener("drop", (event) => {
    event.preventDefault();
    if (event.dataTransfer.files.length) fromFiles(event.dataTransfer.files);
  });

  // The screenshot entrance sits next to the item name; the reading panel only exists while there is a picture.
  $("ocr-pick").addEventListener("click", () => $("ocr-file").click());
  const closePanel = () => {
    image = null;
    region = null;
    box.hidden = true;
    preview.hidden = true;
    $("ocr-panel").hidden = true;
    $("ocr-go").disabled = true;
    $("ocr-candidates").replaceChildren();
    $("ocr-file").value = "";
  };
  $("ocr-close").addEventListener("click", closePanel);
  preview.addEventListener("click", () => {
    if (!drag.moved) $("ocr-panel").classList.toggle("done"); // thumbnail <-> full picture
  });

  // Small entrance, explained only when needed: a tooltip on hover/focus, a drop zone while dragging, a dot once.
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
  const zone = $("ocr-dropzone");
  let depth = 0;
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
  drop.addEventListener("drop", () => {
    depth = 0;
    zone.hidden = true;
  });

  async function initPreferences() {
    const saved = await chrome.storage.local.get(["ocrAuto", "ocrHintSeen"]);
    $("ocr-auto").checked = saved.ocrAuto !== false; // on unless the player turned it off
    $("ocr-auto").addEventListener("change", () => chrome.storage.local.set({ ocrAuto: $("ocr-auto").checked }));
    $("ocr-dot").hidden = Boolean(saved.ocrHintSeen);
  }
  // The name no longer comes from the screenshot as soon as the player edits it.
  $("item").addEventListener("input", () => {
    $("ocr-tag").hidden = true;
  });

  // ---- models: ask first, download once, keep -------------------------------------------------------------------
  async function ensureModels() {
    const code = language();
    const { codes, bytes } = await manager.missing([code]);
    if (!codes.length) return true;
    const ok = await askToDownload(codes, bytes);
    if (!ok) return false;
    for (const missingCode of codes) {
      await manager.download(missingCode, {
        onProgress: (got, total) => say(`下載辨識模型「${labelOf(missingCode)}」：${mb(got)} / ${mb(total)} MB`),
      });
      await markStoredLanguages();
    }
    return true;
  }

  function askToDownload(codes, bytes) {
    return new Promise((resolve) => {
      $("ocr-consent-text").textContent =
        `首次使用「${labelOf(codes[0])}」需下載辨識模型（約 ${mb(bytes)} MB，只下載一次，存在這個瀏覽器裡，之後可離線使用）。`;
      $("ocr-consent").hidden = false;
      const done = (answer) => {
        $("ocr-consent").hidden = true;
        $("ocr-agree").onclick = $("ocr-decline").onclick = null;
        resolve(answer);
      };
      $("ocr-agree").onclick = () => done(true);
      $("ocr-decline").onclick = () => done(false);
    });
  }

  $("ocr-model-file").addEventListener("change", async (event) => {
    for (const file of event.target.files) {
      const code = file.name.replace(/\.traineddata(\.gz)?$/u, "");
      try {
        if (!known.has(code)) throw new Error(`不認得的檔名：${file.name}（檔名要像 ${DEFAULT_LANGUAGE}.traineddata.gz）`);
        await manager.importFile(code, new Uint8Array(await file.arrayBuffer()));
        say(`${labelOf(code)} 模型已匯入並通過檢查碼驗證`, "ok");
        await markStoredLanguages();
      } catch (error) {
        say(`匯入失敗：${error.message}`, "error");
      }
    }
    event.target.value = "";
  });

  // ---- language choice: one language at a time, downloaded when first chosen, then offline -------------------------
  const select = $("ocr-lang");
  const known = new Set(LANGUAGE_OPTIONS.map((l) => l.code));
  const language = () => (known.has(select.value) ? select.value : DEFAULT_LANGUAGE);
  const labelOf = (code) => LANGUAGE_OPTIONS.find((l) => l.code === code).label;

  async function markStoredLanguages() {
    for (const option of select.options) {
      const stored = !(await manager.missing([option.value])).codes.length;
      option.textContent = `${labelOf(option.value)}${stored ? "（已存在本機，可離線）" : ""}`;
    }
  }

  async function initLanguageChoice() {
    for (const { code } of LANGUAGE_OPTIONS) select.append(new Option(labelOf(code), code));
    const saved = (await chrome.storage.local.get("ocrLanguage")).ocrLanguage;
    select.value = known.has(saved) ? saved : DEFAULT_LANGUAGE;
    select.addEventListener("change", () => chrome.storage.local.set({ ocrLanguage: language() }));
    await markStoredLanguages();
  }

  async function getEngine() {
    const wanted = language();
    if (engine && engineLanguage === wanted) return engine;
    await engine?.terminate();
    engine = null;
    engine = await createEngine({
      Tesseract: await loadTesseract(),
      baseUrl: chrome.runtime.getURL(""),
      languages: [wanted],
    });
    engineLanguage = wanted;
    return engine;
  }

  function showCandidates(candidates) {
    const list = $("ocr-candidates");
    list.replaceChildren();
    if (!candidates.length) {
      say("認不出裝備名稱，請手動輸入英文名稱（或換一張更清楚的圖、框出名稱那幾行）。", "error");
      return;
    }
    const baseOnly = candidates.every((c) => c.kind === "base");
    fill(candidates[0].name); // the best result goes straight into the name field; the player decides to search
    say(
      (baseOnly ? "只認出底材（不會依品質篩選）" : "已辨識") +
        `，並填入裝備名稱「${candidates[0].name}」。請確認後自己按「開始查詢」。` +
        (candidates.length > 1 ? "不對的話，可改點下面其他名稱：" : ""),
      baseOnly ? "" : "ok",
    );
    if (candidates.length < 2) return;
    for (const candidate of candidates) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = candidate.kind === "base" ? `${candidate.name}（底材）` : candidate.name;
      button.addEventListener("click", () => {
        fill(candidate.name);
        say(`已改填「${candidate.name}」。請確認後自己按「開始查詢」。`, "ok");
      });
      list.append(button);
    }
  }

  $("ocr-go").addEventListener("click", async () => {
    if (!image || isBusy()) return;
    $("ocr-go").disabled = true;
    try {
      if (!(await ensureModels())) {
        say("沒有下載這個語言的辨識模型，無法辨識。可以改選已下載的語言、手動輸入名稱，或用下面的「手動匯入模型」。", "error");
        return;
      }
      $("ocr-panel").classList.remove("done");
      $("ocr-time").textContent = "";
      $("ocr-text").textContent = "";
      $("ocr-candidates").replaceChildren();
      say("辨識中…");
      const started = performance.now();
      const text = await (await getEngine()).recognize(await prepareForOcr(image, { region }));
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      const found = matchOcrText(text, index);
      showCandidates(found);
      $("ocr-panel").classList.toggle("done", found.length > 0); // a result shrinks the picture to a thumbnail
      $("ocr-time").textContent = `辨識用時 ${seconds} 秒`;
      $("ocr-text").textContent = text;
    } catch (error) {
      const hint = error instanceof ModelError ? "。可以再按一次「辨識」重試，或用「手動匯入模型」" : "";
      say(`辨識失敗：${error.message || error}${hint}`, "error");
    } finally {
      $("ocr-go").disabled = !image;
    }
  });

  initLanguageChoice();
  initPreferences();
}
