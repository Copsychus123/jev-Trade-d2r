// Pure scan session state machine for the gear scanner: no DOM, no timers, node-testable.
//
// The panel feeds one shrink-to-DETECT_WIDTH frame at a time. A box is handed out only on the frame
// that first shows a stable tooltip, so holding the mouse over one item crops it exactly once.

import { boxHash, findTooltip } from "./tooltip.js";

export const STABLE_FRAMES = 2; // same box (±2 px each side) and same boxHash on 2 processed frames in a row
export const MAX_QUEUE = 300; // crops waiting for OCR
export const KEY_TOLERANCE = 0.125; // crop keys this close (a fraction of the cells) are the same panel, not a new crop

export const RECORD_HEAD = ["時間", "名稱", "中文名稱", "類型", "詞綴", "辨識文字"];

const KIND_LABELS = { item: "暗金/套裝/符文之語", base: "底材" };

/** `text` with all whitespace removed. */
export function normalizeText(text) {
  return String(text ?? "").replace(/\s+/g, "");
}

/** How many of the two keys' cells differ; keys of different lengths never match. */
export function keyDistance(a, b) {
  if (a.length !== b.length) return Infinity;
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n += 1;
  return n;
}

function stamp(at) {
  const d = at instanceof Date ? at : new Date(at);
  const pad = (n) => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** [時間, 名稱, 中文名稱, 類型, 詞綴, 辨識文字] for one record. */
export function recordCells(record) {
  const conditions = record.conditions || [];
  return [
    stamp(record.at),
    record.name ?? "",
    record.zh ?? "",
    KIND_LABELS[record.kind] ?? "—",
    conditions.map((c) => c.label).join("、"),
    record.text ?? "",
  ];
}

export function createScanSession() {
  const queue = [];
  const records = [];
  const seenKeys = []; // crop keys already queued this session, compared with KEY_TOLERANCE
  const seenText = new Set();
  const stats = { frames: 0, detected: 0, read: 0, skipped: 0, dropped: 0, ocrSeconds: 0 };
  Object.defineProperty(stats, "queued", { get: () => queue.length, enumerable: true });

  let streak = 0;
  let emitted = false;
  let lastBox = null;
  let lastHash = null;

  const sameBox = (a, b) =>
    Math.abs(a.x - b.x) <= 2 &&
    Math.abs(a.y - b.y) <= 2 &&
    Math.abs(a.width - b.width) <= 2 &&
    Math.abs(a.height - b.height) <= 2;

  const reset = () => {
    streak = 0;
    emitted = false;
    lastBox = null;
    lastHash = null;
  };

  // Returns { box } on the frame that first shows a stable tooltip, null otherwise.
  function feed(small) {
    stats.frames += 1;
    const box = findTooltip(small);
    if (!box) {
      reset();
      return null;
    }
    stats.detected += 1;
    const hash = boxHash(small, box);
    if (lastBox && sameBox(lastBox, box) && lastHash === hash) {
      streak += 1;
    } else {
      streak = 1;
      emitted = false;
      lastBox = { ...box };
      lastHash = hash;
    }
    if (streak >= STABLE_FRAMES && !emitted) {
      emitted = true;
      return { box };
    }
    return null;
  }

  // True when this stable crop should be queued for OCR. The key describes the panel's content, so the same panel
  // shown again somewhere else (a different backdrop, the detector's box a couple of pixels off) is refused even
  // though its bytes differ; KEY_TOLERANCE absorbs that drift.
  function accept(cropKey) {
    const tolerance = KEY_TOLERANCE * cropKey.length; // 8 of a 64-cell key
    for (const seen of seenKeys) if (keyDistance(seen, cropKey) <= tolerance) return false;
    if (queue.length >= MAX_QUEUE) {
      stats.dropped += 1;
      return false;
    }
    seenKeys.push(cropKey);
    return true;
  }

  // True when this OCR result becomes a record.
  function addRecord(record) {
    stats.read += 1;
    const text = normalizeText(record.text);
    if (text && seenText.has(text)) return false;
    const conditions = record.conditions || [];
    if (!record.name && conditions.length === 0) {
      stats.skipped += 1;
      return false;
    }
    if (text) seenText.add(text);
    records.unshift({
      at: record.at instanceof Date ? record.at : new Date(),
      name: record.name ?? null,
      zh: record.zh ?? "",
      kind: record.kind ?? null,
      conditions: conditions.map((c) => ({ ...c })),
      text: record.text ?? "",
    });
    return true;
  }

  // Drops the records and the "already seen" memory so the player can start over.
  function clear() {
    records.length = 0;
    seenText.clear();
    seenKeys.length = 0;
    reset();
  }

  return { feed, accept, queue, stats, records, addRecord, clear };
}
