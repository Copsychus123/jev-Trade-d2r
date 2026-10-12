// The 裝備掃描 screen: share the game window once, watch for tooltips, crop each one, read it with the OCR panel's
// engine and keep one record per item. Nothing here sends input to the game or starts a query by itself.
//
// Everything written to the page goes through textContent: OCR text is untrusted page-like text, and the plan forbids
// innerHTML for it.
import { toCsv } from "../csv.js";
import { $ } from "../dom.js";
import { saveText } from "../download.js";
import { parseAffixLines } from "../ocr/affixes.js";
import { chineseName } from "../traderie/lookup.js";
import { startCapture } from "./capture.js";
import { RECORD_HEAD, baseCandidate, createScanSession, recordCells } from "./session.js";
import { DETECT_WIDTH, boxKey } from "./tooltip.js";

const FRAME_US = 66_000; // at most one processed frame per 66 ms; the skipped ones are closed at once
const PAD = 4; // the crop keeps 4 px of the frame around the detected box
const BLACK_MEAN = 5; // a frame this dark is not the game, it is a fullscreen capture that came out black
const BLACK_FRAMES = 30;
const SLOW_FPS = 5; // below this the game is throttling the shared window
const SLOW_SECONDS = 3;
const BLACK_MESSAGE = "擷取到的是黑畫面：請把遊戲改成「視窗化全螢幕」。";
const SLOW_MESSAGE = "遊戲蓋住 Chrome 時畫面會變慢：請把遊戲設為視窗模式並與 Chrome 並排，或用第二個螢幕。";

// ---- the pieces that need no per-panel state: a crop's read, a list row, the stats line -------------------------

/**
 * One queued crop through the engine: read it, match what it says, and let the session keep the record the two make
 * (it refuses one with neither a name nor an affix line, and one whose crop came from a cleared run). The read's own
 * seconds are what 平均辨識 averages. `onRead` runs the moment the engine answered and before the record lands, so
 * the screen drops an earlier failure at the point the panel learns a later read worked.
 */
async function processScanJob(job, { ocr, tables, session, onRead }) {
  const started = performance.now();
  const text = await ocr.recognize(job.blob);
  onRead();
  const candidates = ocr.match(text);
  const match = candidates[0] ?? null;
  session.stats.ocrSeconds += (performance.now() - started) / 1000;
  const name = match?.name ?? null;
  session.addRecord(
    {
      at: new Date(),
      name,
      zh: name ? chineseName(name, tables, match.matched) : "",
      kind: match?.kind ?? null,
      base: baseCandidate(candidates),
      conditions: parseAffixLines(text).conditions,
      text,
    },
    job.generation, // a crop taken before 清除紀錄 does not come back as a record
  );
}

/** A `.link` button for a record at `index`, carrying the index and running `onClick`. */
function linkButton(text, index, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "link";
  button.dataset.index = String(index);
  button.textContent = text;
  button.addEventListener("click", onClick);
  return button;
}

/** One `<li>` per record: the name line, the 類型/詞綴 line and the two search buttons. */
function recordListItem(record, index, { onSearchName, onSearchStats }) {
  const cells = recordCells(record); // one source of truth for 類型 and 詞綴
  const li = document.createElement("li");
  li.dataset.index = String(index);
  li.dataset.name = record.name ?? "";
  li.dataset.kind = record.kind ?? "";
  const line1 = document.createElement("div");
  line1.className = "line1";
  const name = document.createElement("strong");
  name.textContent = record.name ? cells[1] + (cells[2] ? `（${cells[2]}）` : "") : "沒認出名稱";
  line1.append(name);
  const line2 = document.createElement("div");
  line2.className = "line2";
  line2.textContent = `${cells[0].slice(11)} · ${cells[3]}${cells[4] ? ` · ${cells[4]}` : ""}`;
  const actions = document.createElement("div");
  actions.className = "actions";
  const precise = linkButton("精準搜尋", index, () => onSearchName(record));
  precise.disabled = !record.name; // nothing to look up without a name
  actions.append(precise, linkButton("模糊搜尋", index, () => onSearchStats(record)));
  li.append(line1, line2, actions);
  return li;
}

/** The 掃描統計 line: this second's frame rate, the run's counts, and the average read ("—" until one has landed). */
function statsLine(stats, fps) {
  const { detected, skipped, dropped, read, ocrSeconds } = stats;
  const average = read ? (ocrSeconds / read).toFixed(1) : "—";
  return `每秒畫面 ${fps}、偵測 ${detected}、略過 ${skipped}、丟棄 ${dropped}、平均辨識 ${average} 秒`;
}

export function initScanPanel({ ocr, tables, onSearchName, onSearchStats }) {
  const session = createScanSession();
  let capture = null;
  let pumping = false; // one OCR at a time
  let lastStamp = 0; // frame.timestamp of the last frame that got processed (µs)
  let frames = 0; // frames delivered since the capture started
  let framesAtTick = 0;
  let fps = 0;
  let slowSeconds = 0;
  let blackRun = 0;
  let warning = ""; // one of the two contingency messages; onFrame owns the black one, tick the slow one
  let errorText = ""; // the last OCR failure or the reason the capture stopped, shown in front of the status
  let statusText = ""; // what the status line says while no capture is running
  let stopped = false; // a capture has ended, so the status shows the final count
  let ticker = null;

  const detect = new OffscreenCanvas(1, 1);
  const crop = new OffscreenCanvas(1, 1);
  // What every list item's two search buttons carry; built once so a redraw allocates nothing per record.
  const searches = { onSearchName, onSearchStats };

  // ---- reading one frame ------------------------------------------------------------------------------------------

  function downscaleFrame(bitmap) {
    const width = DETECT_WIDTH; // the width the detector is tuned for
    const height = Math.max(1, Math.round((bitmap.height * width) / bitmap.width));
    detect.width = width;
    detect.height = height;
    const ctx = detect.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, width, height);
    return ctx.getImageData(0, 0, width, height);
  }

  function meanGrey(img) {
    let sum = 0;
    let count = 0;
    for (let i = 0; i < img.data.length; i += 4 * 17) {
      sum += (img.data[i] + img.data[i + 1] + img.data[i + 2]) / 3;
      count += 1;
    }
    return count ? sum / count : 0;
  }

  /** A stable box came back from the session: cut it out of the full-resolution bitmap and queue it for OCR. */
  async function grab(bitmap, box, small) {
    const k = bitmap.width / small.width;
    const sx = Math.max(0, Math.floor(box.x * k) - PAD);
    const sy = Math.max(0, Math.floor(box.y * k) - PAD);
    const ex = Math.min(bitmap.width, Math.ceil((box.x + box.width) * k) + PAD);
    const ey = Math.min(bitmap.height, Math.ceil((box.y + box.height) * k) + PAD);
    const width = Math.max(1, ex - sx);
    const height = Math.max(1, ey - sy);
    crop.width = width;
    crop.height = height;
    const ctx = crop.getContext("2d");
    ctx.drawImage(bitmap, sx, sy, width, height, 0, 0, width, height);
    // The identity is the panel's own content, from the box the detector gave, not the padded crop: the padding is
    // unknown background that differs from one place on screen to the next.
    if (!session.accept(boxKey(small, box))) return;
    session.queue.push(await crop.convertToBlob({ type: "image/png" }));
    pump();
  }

  /** The black-frame advice: a long run of dark frames means the capture is not the game. */
  function noteBrightness(mean) {
    if (mean < BLACK_MEAN) {
      blackRun += 1;
      if (blackRun >= BLACK_FRAMES) warning = BLACK_MESSAGE;
    } else {
      blackRun = 0;
      if (warning === BLACK_MESSAGE) warning = ""; // the picture is back: drop only the black-screen advice
    }
  }

  async function onFrame(frame) {
    frames += 1;
    if (lastStamp && frame.timestamp - lastStamp < FRAME_US) return; // capture.js closes the frame for us
    lastStamp = frame.timestamp;
    const bitmap = await createImageBitmap(frame);
    frame.close();
    try {
      const small = downscaleFrame(bitmap);
      noteBrightness(meanGrey(small));
      const hit = session.feed(small);
      if (hit) await grab(bitmap, hit.box, small);
    } finally {
      bitmap.close();
    }
  }

  // ---- OCR, one crop at a time -----------------------------------------------------------------------------------

  // A read that came back is what retires the previous errorText: it runs while the job that read it is still going.
  const onRead = () => {
    errorText = "";
  };

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (session.queue.length) {
        await processScanJob(session.take(), { ocr, tables, session, onRead });
        renderScreen();
      }
    } catch (error) {
      // Not statusText: that is only shown while no capture is running, and a mid-scan failure must be visible now.
      errorText = `辨識失敗：${error?.message || error}`;
      refreshStatus();
    } finally {
      pumping = false;
    }
  }

  // ---- the screen ------------------------------------------------------------------------------------------------

  function say(text) {
    statusText = text;
    refreshStatus();
  }

  // One place composes the status line. While capturing, the live count is always there and an OCR error or a
  // contingency message sits in front of it, so 「待辨識 N 件」 stays readable (scripts/scan_e2e.py waits for it
  // while the queue drains). statusText is only for the not-capturing case.
  function refreshStatus() {
    let base = statusText;
    if (capture) base = `掃描中：已記錄 ${session.records.length} 件，待辨識 ${session.queue.length} 件`;
    else if (stopped) base = `已停止，共記錄 ${session.records.length} 件`;
    $("scan-status").textContent = [errorText, warning, base].filter(Boolean).join(" ");
  }

  function renderStats() {
    $("scan-stats").textContent = statsLine(session.stats, fps);
  }

  /** Everything the screen says about the session at once: the record list and the two readouts under it. */
  function renderScreen() {
    renderRecords();
    refreshStatus();
    renderStats();
  }

  function renderRecords() {
    const list = $("scan-list");
    list.replaceChildren();
    session.records.forEach((record, index) => list.append(recordListItem(record, index, searches)));
    list.hidden = !session.records.length;
    for (const id of ["scan-csv", "scan-clear"]) $(id).disabled = !session.records.length;
  }


  function fileStamp() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  }

  // ---- starting and stopping -------------------------------------------------------------------------------------

  /** Shows the download notice through the reader's shared path; false when the player cancelled. */
  async function downloadMissing({ names, bytes }) {
    try {
      return await ocr.downloadWithNotice({
        noticeId: "scan-download",
        textId: "scan-download-text",
        progressId: "scan-progress",
        cancelId: "scan-cancel",
        tail: "之後可離線使用",
        names,
        bytes,
        say,
      });
    } catch (error) {
      if (error?.kind === "cancelled") return false;
      throw error;
    }
  }

  /** A fresh capture starts from zero: no message, no error, and no frame counted yet. */
  function resetRun() {
    stopped = false;
    warning = "";
    errorText = "";
    lastStamp = 0;
    blackRun = 0;
    slowSeconds = 0;
    frames = 0;
    framesAtTick = 0;
    fps = 0;
  }

  async function begin() {
    const started = await startCapture(onFrame, endCapture);
    if (!started) {
      say("沒有選擇遊戲視窗，掃描沒有開始。");
      return;
    }
    capture = started;
    resetRun();
    $("scan-start").disabled = true;
    $("scan-stop").hidden = false;
    refreshStatus();
    renderStats();
    ticker = setInterval(tick, 1000);
  }

  async function start() {
    if (capture) return;
    $("scan-start").disabled = true;
    stopped = false;
    try {
      const missing = await ocr.missingModels();
      if (missing.names.length && !(await downloadMissing(missing))) {
        say("已取消下載辨識模型，掃描沒有開始。");
        return;
      }
      await begin();
    } catch (error) {
      say(`無法開始掃描：${error?.message || error}`);
    } finally {
      if (!capture) $("scan-start").disabled = false;
    }
  }

  /** The capture ended: the player's "stop sharing" (no argument) or a failed read loop (the error to show). */
  function endCapture(error) {
    if (error) {
      errorText = `擷取中斷：${error?.message || error}`;
      refreshStatus();
    }
    stop();
  }

  function stop() {
    if (!capture) return;
    capture.stop();
    capture = null;
    stopped = true;
    clearInterval(ticker);
    ticker = null;
    $("scan-stop").hidden = true;
    $("scan-start").disabled = false;
    refreshStatus();
    renderStats();
  }

  /** The slowdown advice, on a run of low-FPS ticks. The black-frame advice outranks it and is onFrame's to clear. */
  function noteFrameRate() {
    if (fps < SLOW_FPS) {
      slowSeconds += 1;
      if (slowSeconds >= SLOW_SECONDS && warning !== BLACK_MESSAGE) warning = SLOW_MESSAGE;
    } else {
      slowSeconds = 0;
      // The picture recovered: drop the slowdown advice only. The black-frame message is not tick's to clear.
      if (warning === SLOW_MESSAGE) warning = "";
    }
  }

  function tick() {
    fps = frames - framesAtTick;
    framesAtTick = frames;
    noteFrameRate();
    refreshStatus();
    renderStats();
  }

  // ---- wiring ----------------------------------------------------------------------------------------------------

  function wireControls() {
    $("scan-start").addEventListener("click", start);
    $("scan-stop").addEventListener("click", stop);
    $("scan-clear").addEventListener("click", () => {
      session.clear();
      renderScreen();
    });
    $("scan-csv").addEventListener("click", () => {
      if (!session.records.length) return;
      saveText(`jev-scan-${fileStamp()}.csv`, toCsv(RECORD_HEAD, session.records.map(recordCells)), "text/csv;charset=utf-8");
    });
  }

  wireControls();
  renderRecords();
  renderStats();
  refreshStatus();
}
