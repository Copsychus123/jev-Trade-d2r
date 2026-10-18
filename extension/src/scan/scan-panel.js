// The 裝備掃描 screen: share the game window once, watch for tooltips, crop each one, read it with the OCR panel's
// engine and keep one record per item. Nothing here sends input to the game or starts a query by itself.
//
// Everything written to the page goes through textContent: OCR text is untrusted page-like text, and the plan forbids
// innerHTML for it.
import { toCsv } from "../csv.js";
import { $ } from "../dom.js";
import { saveText } from "../download.js";
import { parseAffixLines } from "../ocr/affixes.js";
import { decideCandidates } from "../ocr/match.js";
import { initNameSuggest } from "../name-suggest.js";
import { LEARNED_HINT } from "../ocr/corrections.js";
import { chineseName, labelWithChinese, tableEntry } from "../traderie/lookup.js";
import { startCapture } from "./capture.js";
import { HELD_KEY_TOLERANCE, RECORD_HEAD, baseCandidate, createScanSession, isUnsure, keyDistance, recordCells } from "./session.js";
import { clusterAndPad } from "./fallback.js";
import { DETECT_WIDTH, boxHash, boxKey } from "./tooltip.js";

const FALLBACK_WIDTH = 720;
const FALLBACK_INTERVAL_US = 3_000_000; // at most one fallback per 3 seconds
// ... and a fallback run that rescued nothing holds off this long before it may run again on the same held picture.
// det costs 280-360 ms a call; re-running it on an item it just failed to read cannot change that while the picture
// is the same, and the owner's complaint is exactly this cost. 20 s is several times the 3 s rate limit, long enough
// that a normal hover never pays it twice, short enough that an item that only needed its text to finish rendering
// is tried again during the same scan.
const FALLBACK_UNREAD_BACKOFF_US = 20_000_000;
const FRAME_US = 66_000; // at most one processed frame per 66 ms; the skipped ones are closed at once
const PAD = 4; // the crop keeps 4 px of the frame around the detected box
const BLACK_MEAN = 5; // a frame this dark is not the game, it is a fullscreen capture that came out black
const BLACK_FRAMES = 30;
const SLOW_FPS = 5; // below this, on average, the shared window is not delivering the frames a quick hover needs
const SLOW_WINDOW = 6; // the last 6 seconds are judged together, so one bouncing second decides nothing
const SLOW_MIN_MOVING = 3; // a second with no frame is a still picture, not a slow one: judge only seconds with frames
const BLACK_MESSAGE = "擷取到的是黑畫面：請把遊戲改成「視窗化全螢幕」。";
const HIDDEN_MESSAGE = "遊戲視窗蓋住了這個面板，掃描會變慢、快速掠過的裝備可能漏掉。建議把遊戲改成視窗模式、和 Chrome 並排。";
const SLOW_MESSAGE = "畫面更新偏慢，快速掠過的裝備可能漏掉。建議把遊戲改成視窗模式、和 Chrome 並排，並關掉其他吃資源的程式。";

// ---- the pieces that need no per-panel state: a crop's read, a list row, the stats line -------------------------

/**
 * One queued crop through the engine: read it, match what it says, and let the session keep the record the two make
 * (it refuses one with neither a name nor an affix line, and one whose crop came from a cleared run). The read's own
 * seconds are what 平均辨識 averages. `onRead` runs the moment the engine answered and before the record lands, so
 * the screen drops an earlier failure at the point the panel learns a later read worked.
 */
async function processScanJob(job, { ocr, tables, session, onRead }) {
  const started = performance.now();
  const { text, tones, stages } = await ocr.recognize(job.blob);
  const durationSec = (performance.now() - started) / 1000;
  session.stats.ocrSeconds += durationSec;
  onRead();

  const candidates = ocr.match(text, tones);
  const sure = decideCandidates(candidates).confident;
  const match = sure ? candidates[0] : null;
  const possible = sure ? [] : ocr.possible(candidates, text);
  const name = match?.name ?? null;

  session.addRecord(
    {
      at: new Date(),
      name,
      zh: name ? chineseName(name, tables, match.matched) : "",
      kind: match?.kind ?? null,
      base: baseCandidate(candidates),
      options: possible.map((c) => ({
        kind: c.kind,
        name: c.name,
        zh: chineseName(c.name, tables, c.matched),
        label: labelWithChinese(c.name, tables, c.matched) + (c.learned ? ` · ${LEARNED_HINT}` : ""),
        matched: c.matched ?? "",
        learned: c.learned ?? 0,
      })),
      conditions: parseAffixLines(text).conditions,
      text,
      key: job.key,
      firstKey: ocr.firstKey(text),
    },
    job.generation,
  );

  const readMs = Math.round(durationSec * 1000);
  const waitMs = job.queuedAt ? Math.round(started - job.queuedAt) : 0;
  const cropTiming = {
    readMs,
    perceivedLatencyMs: readMs,
    waitMs,
    stages: stages ?? null,
    timing: job.timing ?? null,
    fallback: job.fallback ?? false,
  };
  session.stats.cropTimings = session.stats.cropTimings ?? [];
  session.stats.cropTimings.push(cropTiming);
  session.stats.maxWaitMs = Math.max(session.stats.maxWaitMs ?? 0, waitMs);
  globalThis.__jevLastRun = {
    ...(globalThis.__jevLastRun ?? {}),
    scan: {
      stats: session.stats,
      cropTimings: session.stats.cropTimings,
    },
  };
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

/**
 * The small 「輸入名稱」 box of a record that has no name: a text input with the same name suggestions as the name field,
 * and 確定 (or Enter) to hand what is in it to `onType`. `state` keeps what was typed and the last complaint per record,
 * so a redraw (a new record landing) does not wipe a half-typed name.
 */
function nameBox(record, { tables, onType, state }) {
  const box = document.createElement("div");
  box.className = "name-box";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "name-input";
  input.placeholder = "輸入名稱（中文或英文）";
  input.setAttribute("aria-label", "輸入名稱");
  input.setAttribute("autocomplete", "off");
  input.value = state.drafts.get(record.id) ?? "";
  const list = document.createElement("ul");
  list.id = `scan-suggest-${record.id}`;
  list.className = "suggest";
  list.hidden = true;
  initNameSuggest({ input, list, getTables: () => tables });
  input.addEventListener("input", () => state.drafts.set(record.id, input.value));
  const submit = () => onType(record, input.value);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.defaultPrevented) {
      event.preventDefault();
      submit();
    }
  });
  const confirm = document.createElement("button");
  confirm.type = "button";
  confirm.className = "link";
  confirm.dataset.confirm = "true";
  confirm.textContent = "確定";
  confirm.addEventListener("click", submit);
  box.append(input, confirm, list);
  state.inputs.set(record.id, input);
  const note = state.notes.get(record.id);
  if (note) {
    const message = document.createElement("span");
    message.className = "muted small";
    message.setAttribute("role", "alert");
    message.textContent = note;
    box.append(message);
  }
  return box;
}

/**
 * One `<li>` per record: the name line, the 類型/詞綴 line and the two search buttons. A record with no name also shows
 * the possible names to pick (when the read had any) and the box to type one.
 */
function recordListItem(record, index, { onSearchName, onSearchStats, onRemove, onPick, ...naming }) {
  const cells = recordCells(record); // one source of truth for 類型 and 詞綴
  const unsure = isUnsure(record);
  const li = document.createElement("li");
  li.dataset.index = String(index);
  li.dataset.name = record.name ?? "";
  li.dataset.kind = record.kind ?? "";
  if (unsure) li.dataset.unsure = "true";
  const line1 = document.createElement("div");
  line1.className = "line1";
  const name = document.createElement("strong");
  const unnamed = unsure ? "不確定" : "沒認出名稱";
  name.textContent = record.name ? (cells[2] ? `${cells[2]}（${cells[1]}）` : cells[1]) : unnamed;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "remove";
  remove.textContent = "✕";
  remove.setAttribute("aria-label", `刪除這一筆：${record.name || unnamed}`);
  remove.addEventListener("click", () => onRemove(record));
  line1.append(name, remove);
  const line2 = document.createElement("div");
  line2.className = "line2";
  line2.textContent = `${cells[0].slice(11)} · ${cells[3]}${cells[4] ? ` · ${cells[4]}` : ""}`;
  li.append(line1, line2);
  if (unsure) {
    const options = document.createElement("div");
    options.className = "options";
    options.setAttribute("aria-label", "可能是");
    record.options.forEach((option, at) => {
      const pick = linkButton(option.label, index, () => onPick(record, at));
      pick.dataset.name = option.name;
      pick.dataset.kind = option.kind;
      options.append(pick);
    });
    li.append(options);
  }
  if (!record.name) li.append(nameBox(record, naming));
  const actions = document.createElement("div");
  actions.className = "actions";
  const precise = linkButton("精準搜尋", index, () => onSearchName(record));
  const fuzzy = linkButton("模糊搜尋", index, () => onSearchStats(record));
  precise.disabled = !record.name; // nothing to look up without a name
  fuzzy.disabled = unsure; // and nothing to search by until the player has said which item it is
  actions.append(precise, fuzzy);
  li.append(actions);
  return li;
}

/** The 掃描統計 line: this second's frame rate, the run's counts, and the average read ("—" until one has landed). */
function statsLine(stats, fps) {
  const { detected, skipped, dropped, read, ocrSeconds, fallbackRuns, fallbackHits } = stats;
  const average = read ? (ocrSeconds / read).toFixed(1) : "—";
  const fallbackPart = fallbackRuns ? `、備援偵測 ${fallbackRuns} 次、救回 ${fallbackHits ?? 0} 件` : "";
  return `每秒畫面 ${fps}、偵測 ${detected}、略過 ${skipped}、丟棄 ${dropped}、平均辨識 ${average} 秒${fallbackPart}`;
}

/** 「待辨識 N 件」, plus 「，約 M 秒」 (N times the average read) once a read has landed and something is waiting. */
function queueLine({ queued, read, ocrSeconds }) {
  if (!queued || !read) return `待辨識 ${queued} 件`;
  return `待辨識 ${queued} 件，約 ${Math.max(1, Math.round((queued * ocrSeconds) / read))} 秒`;
}

/** The mean grey of a downscaled frame, sampled every 17th pixel: the black-run check only needs the average. */
function meanGrey(img) {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < img.data.length; i += 4 * 17) {
    sum += (img.data[i] + img.data[i + 1] + img.data[i + 2]) / 3;
    count += 1;
  }
  return count ? sum / count : 0;
}

export function initScanPanel({ ocr, tables, onSearchName, onSearchStats }) {
  const session = createScanSession();
  let capture = null;
  let pumping = false; // one OCR at a time
  let lastStamp = 0; // frame.timestamp of the last frame that got processed (µs)
  let frames = 0; // frames delivered since the capture started
  let framesAtTick = 0;
  let fps = 0;
  let recentFps = []; // the last SLOW_WINDOW seconds' frame counts
  let slow = false; // the window says frames arrive too slowly (tick owns it)
  let hidden = false; // this page is covered, so Chrome throttles it (tick owns it)
  let blackRun = 0;
  let errorText = ""; // the last OCR failure or the reason the capture stopped, shown in front of the status
  let statusText = ""; // what the status line says while no capture is running
  let stopped = false; // a capture has ended, so the status shows the final count
  let ticker = null;
  let scanWarmRelease = null;
  const detect = new OffscreenCanvas(1, 1);
  const crop = new OffscreenCanvas(1, 1);
  let fallbackRunning = false;
  let lastFallbackStamp = -Infinity;
  // The picture the fallback last ran on: the box det gave (in the small frame) and that box's own content key, plus
  // whether the run produced a record. A tooltip the dark-panel detector cannot see is held the same way a detected
  // one is: while the box's content stays the same key (measured: the same panel differs in 0..4 of 64 cells, two
  // different pictures in 23..38) the fallback is not run again for it, so one held item costs one det call.
  let fallbackPicture = null;
  let fallbackBlob = null; // the crop that run queued, so the pump can tell whether it became a record
  let frameStreak = 0;
  let lastFrameHash = null;
  const naming = { drafts: new Map(), notes: new Map(), inputs: new Map() };
  // The name a record got is remembered by the reader's correction memory under the text piece it was matched on, or
  // under the read's first name line when nothing matched (ocr.learn: only table names are kept).
  const keyOf = (record, option) => option?.matched || record.options[0]?.matched || record.firstKey;
  const forgetDraft = (id) => {
    naming.drafts.delete(id);
    naming.notes.delete(id);
  };
  // What every list item's buttons carry; built once so a redraw allocates nothing per record.
  const searches = {
    onSearchName,
    onSearchStats,
    tables,
    state: naming,
    onRemove: (record) => {
      if (session.removeRecord(record.id)) {
        forgetDraft(record.id);
        renderScreen();
      }
    },
    onPick: (record, at) => {
      const option = record.options[at];
      const key = keyOf(record, option);
      if (!session.resolveRecord(record.id, at)) return;
      ocr.learn(key, option.name);
      forgetDraft(record.id);
      renderScreen();
    },
    onType: (record, raw) => {
      const entry = tableEntry(raw, tables);
      if (!entry) {
        naming.notes.set(record.id, raw.trim() ? `對照表裡找不到「${raw.trim()}」，請從建議選一個，或換個寫法` : "請先輸入名稱");
        renderScreen();
        return;
      }
      const key = keyOf(record, null);
      if (!session.nameRecord(record.id, entry)) return;
      ocr.learn(key, entry.name);
      forgetDraft(record.id);
      renderScreen();
    },
  };

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

  function downscaleFallback(bitmap) {
    const width = Math.min(bitmap.width, FALLBACK_WIDTH);
    const height = Math.max(1, Math.round((bitmap.height * width) / bitmap.width));
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, width, height);
    return ctx.getImageData(0, 0, width, height);
  }
  async function runFallback(bitmap, small) {
    fallbackRunning = true;
    session.stats.fallbackRuns = (session.stats.fallbackRuns ?? 0) + 1;
    try {
      const fbSmall = downscaleFallback(bitmap);
      const boxes = await ocr.detectBoxes(fbSmall);
      const box = clusterAndPad(boxes, fbSmall.width, fbSmall.height, fbSmall);
      if (box) {
        session.stats.fallbackHits = (session.stats.fallbackHits ?? 0) + 1;
        const scX = small.width / fbSmall.width;
        const scY = small.height / fbSmall.height;
        // A box is a pixel rectangle, so it is rounded here: the detector works in whole pixels of the frame it ran
        // on, and every consumer (the crop arithmetic, boxKey, the held-picture comparison) wants whole pixels.
        const boxSmall = {
          x: Math.round(box.x * scX),
          y: Math.round(box.y * scY),
          width: Math.round(box.width * scX),
          height: Math.round(box.height * scY),
        };
        const key = boxKey(small, boxSmall);
        fallbackPicture = { box: { ...boxSmall }, key, resolved: false };
        fallbackBlob = await grab(bitmap, boxSmall, small, key);
      } else {
        fallbackPicture = null; // nothing to hold on to: a later still frame may try again (rate limited)
        fallbackBlob = null;
      }
    } catch {
      // A failed det does not break the scan
    } finally {
      fallbackRunning = false;
    }
  }

  /** A stable box came back from the session: cut it out of the full-resolution bitmap and queue it for OCR. */
  async function grab(bitmap, box, small, key = null) {
    const scale = bitmap.width / small.width; // the crop canvas is the full-resolution bitmap
    const left = Math.max(0, Math.floor(box.x * scale) - PAD);
    const top = Math.max(0, Math.floor(box.y * scale) - PAD);
    const right = Math.min(bitmap.width, Math.ceil((box.x + box.width) * scale) + PAD);
    const bottom = Math.min(bitmap.height, Math.ceil((box.y + box.height) * scale) + PAD);
    const width = Math.max(1, right - left);
    const height = Math.max(1, bottom - top);
    crop.width = width;
    crop.height = height;
    const ctx = crop.getContext("2d");
    ctx.drawImage(bitmap, left, top, width, height, 0, 0, width, height);
    // The identity is the panel's own content, from the box the detector gave, not the padded crop: the padding is
    // unknown background that differs from one place on screen to the next. The session hands its own key over for a
    // box it detected, so the grid is measured once per crop.
    const cropKey = key ?? boxKey(small, box);
    if (!session.accept(cropKey)) return null;
    const blob = await crop.convertToBlob({ type: "image/png" });
    session.queue.push(blob);
    pump();
    return blob;
  }

  /** The black-frame advice runs on blackRun (see advice()): a long run of dark frames means the capture is not the game. */
  function noteBrightness(mean) {
    blackRun = mean < BLACK_MEAN ? blackRun + 1 : 0; // one picture is enough to drop the advice again
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
      if (hit) {
        frameStreak = 0;
        lastFrameHash = null;
        await grab(bitmap, hit.box, small, hit.key);
      } else if (session.streak > 0) {
        frameStreak = 0;
        lastFrameHash = null;
      } else if (typeof ocr?.detectBoxes === "function") {
        const hash = boxHash(small, { x: 0, y: 0, width: small.width, height: small.height });
        if (lastFrameHash === hash) frameStreak += 1;
        else {
          frameStreak = 1;
          lastFrameHash = hash;
        }

        const stamp = frame.timestamp || performance.now() * 1000;
        if (
          frameStreak >= 2 &&
          !pumping &&
          session.queue.length === 0 &&
          !fallbackRunning &&
          stamp - lastFallbackStamp >= FALLBACK_INTERVAL_US &&
          fallbackIsNewPicture(small, stamp)
        ) {
          lastFallbackStamp = stamp;
          await runFallback(bitmap, small);
        }
      }
    } finally {
      bitmap.close();
    }
  }

  /**
   * Whether the fallback may run on this frame at all. A picture the fallback already ran on is not hunted again: not
   * for the rest of that hover when the run rescued it, and not before FALLBACK_UNREAD_BACKOFF_US when it did not
   * (det cannot read an unchanged unreadable item, and the owner's complaint is exactly that cost). Both questions are
   * asked of the box's own content key, so a tooltip the detector cannot see still gets one det call per hover.
   */
  function fallbackIsNewPicture(small, stamp) {
    if (!fallbackPicture) return true;
    const same = keyDistance(boxKey(small, fallbackPicture.box), fallbackPicture.key)
      <= HELD_KEY_TOLERANCE * fallbackPicture.key.length;
    if (!same) return true; // another tooltip is under the cursor now
    return !fallbackPicture.resolved && stamp - lastFallbackStamp >= FALLBACK_UNREAD_BACKOFF_US;
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
        const before = session.records.length;
        const job = session.take();
        await processScanJob(job, { ocr, tables, session, onRead, onUpdate: renderScreen });
        // Asked after the read, not before it: a fallback run assigns `fallbackBlob` right after it queues (and
        // before this read can possibly finish), so a job taken before that would never be recognised as its own.
        if (fallbackBlob !== null && job.blob === fallbackBlob) {
          fallbackBlob = null; // the fallback's own crop answered: did it rescue the item this time?
          if (fallbackPicture) fallbackPicture.resolved = session.records.length > before;
        }
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
  // while the queue drains). statusText is only for the not-capturing case. One message at a time: a black picture
  // outranks a covered panel, which outranks a slow one (it is the likely cause of the slowness).
  function advice() {
    if (blackRun >= BLACK_FRAMES) return BLACK_MESSAGE;
    if (hidden) return HIDDEN_MESSAGE;
    return slow ? SLOW_MESSAGE : "";
  }

  function refreshStatus() {
    let line = statusText;
    if (capture) line = `掃描中：已記錄 ${session.records.length} 件，${queueLine(session.stats)}`;
    else if (stopped) line = `已停止，共記錄 ${session.records.length} 件`;
    $("scan-status").textContent = [errorText, advice(), line].filter(Boolean).join(" ");
  }

  function renderStats() {
    $("scan-stats").textContent = statsLine(session.stats, fps);
  }

  /** The two readouts under the list: the status line and the 掃描統計 line. */
  function renderReadouts() {
    refreshStatus();
    renderStats();
  }

  /** Everything the screen says about the session at once: the record list and the two readouts under it. */
  function renderScreen() {
    renderRecords();
    renderReadouts();
  }

  function renderRecords() {
    const list = $("scan-list");
    // A half-typed name box keeps the keyboard when the list is drawn again (a new record landed under it).
    const typingFor = [...naming.inputs].find(([, input]) => input === document.activeElement)?.[0];
    naming.inputs.clear();
    list.replaceChildren();
    session.records.forEach((record, index) => list.append(recordListItem(record, index, searches)));
    if (typingFor !== undefined) naming.inputs.get(typingFor)?.focus();
    list.hidden = !session.records.length;
    for (const id of ["scan-csv", "scan-clear"]) $(id).disabled = !session.records.length;
  }


  function fileStamp() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  }

  // ---- starting and stopping -------------------------------------------------------------------------------------

  /** Downloads the missing models through the reader's shared, silent path; false when the download was cancelled. */
  async function downloadMissing({ names }) {
    try {
      return await ocr.downloadModels({ names });
    } catch (error) {
      if (error?.kind === "cancelled") return false;
      throw error;
    }
  }

  /** A fresh capture starts from zero: no message, no error, and no frame counted yet. */
  function resetRun() {
    stopped = false;
    recentFps = [];
    slow = false;
    hidden = false;
    errorText = "";
    lastStamp = 0;
    blackRun = 0;
    frames = 0;
    framesAtTick = 0;
    fps = 0;
    frameStreak = 0;
    lastFrameHash = null;
    lastFallbackStamp = -Infinity;
    fallbackPicture = null; // the previous run's picture says nothing about this capture's frames
    fallbackBlob = null;
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
    renderReadouts();
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
      if (typeof ocr?.keepWarm === "function" && !scanWarmRelease) {
        scanWarmRelease = ocr.keepWarm();
        if (scanWarmRelease?.ready) await scanWarmRelease.ready;
      }
      await begin();
    } catch (error) {
      if (scanWarmRelease) {
        scanWarmRelease();
        scanWarmRelease = null;
      }
      say(`無法開始掃描：${error?.message || error}`);
    } finally {
      if (!capture) {
        if (scanWarmRelease) {
          scanWarmRelease();
          scanWarmRelease = null;
        }
        $("scan-start").disabled = false;
      }
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
    if (scanWarmRelease) {
      scanWarmRelease();
      scanWarmRelease = null;
    }
    stopped = true;
    slow = false; // the advice about a running scan goes with it; a black picture stays until a bright one comes
    hidden = false;
    recentFps = [];
    clearInterval(ticker);
    ticker = null;
    $("scan-stop").hidden = true;
    $("scan-start").disabled = false;
    renderReadouts();
  }

  /**
   * The slowdown advice: the last SLOW_WINDOW seconds, judged on the seconds that carried frames. A second with none
   * is a picture that did not change (the player stopped hovering, the sweep is over), which says nothing about speed;
   * Chrome delivers frames only while the picture moves. Needs SLOW_MIN_MOVING such seconds, so a quiet scan is never
   * called slow, and their mean under SLOW_FPS, so a rate that bounces (7,2,1,6,4,3,8) is judged as a whole.
   */
  function noteFrameRate() {
    recentFps.push(fps);
    if (recentFps.length > SLOW_WINDOW) recentFps.shift();
    const moving = recentFps.filter((count) => count > 0);
    const mean = moving.reduce((sum, count) => sum + count, 0) / (moving.length || 1);
    slow = moving.length >= SLOW_MIN_MOVING && mean < SLOW_FPS;
  }

  function tick() {
    fps = frames - framesAtTick;
    framesAtTick = frames;
    hidden = document.visibilityState === "hidden"; // the game (or anything) covers this page: Chrome throttles it
    noteFrameRate();
    renderReadouts();
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
  renderReadouts();

  return { stop };
}
