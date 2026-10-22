// Pure scan session state machine for the gear scanner: no DOM, no timers, node-testable.
//
// The panel feeds one shrink-to-DETECT_WIDTH frame at a time. A box is handed out only on the frame
// that first shows a stable tooltip, so holding the mouse over one item crops it exactly once.

import { boxHash, boxKey, findTooltip } from "./tooltip.js";

export const STABLE_FRAMES = 2; // same box (±2 px each side) and same boxHash on 2 processed frames in a row
export const MAX_QUEUE = 300; // crops waiting for OCR
export const KEY_TOLERANCE = 0.125; // crop keys this close (a fraction of the cells) are the same panel, not a new crop
// A held picture stays the same while the detector's box is within HELD_BOX_PX px and the crop key is within
// HELD_KEY_TOLERANCE of the key of the crop already taken. Measured (artifacts/repeatfix, node over the sweep's own
// pictures, and docs/design.md): one panel differs in 0..4 of 64 cells across the eight sweep positions and in 0..10
// with its glyphs slid and the frame re-encoded, while two different pictures differ in 23..38; a held picture's box
// jitters by a pixel or two, and the same picture at two places sits 43 px or more apart. This is twice
// KEY_TOLERANCE on purpose: the held question is looser than accept's, which must never swallow a different item.
export const HELD_BOX_PX = 6;
export const HELD_KEY_TOLERANCE = 2 * KEY_TOLERANCE; // 16 of 64 cells
// Two reads whose texts are at least this alike are the same item read again, not a second item: character bigrams
// over the whitespace-stripped text. Measured on the stored reads (artifacts/ocr-e2e/report.json, the earlier 54-picture set): two
// DIFFERENT items reach at most 0.449 (image-35 against image-41) and the shipped sweep's own items at most 0.234,
// while the same tooltip read again from a second place reaches 0.689 (artifacts/diag-scan/results/t1-sanity.json,
// image-18.png read twice). 0.6 sits between them with room on both sides.
export const TEXT_SAME = 0.6;
// Below this many characters a read holds too few bigrams for similarity to be evidence -- two different items' clipped
// reads can look alike -- so there the two texts must be equal. Every stored read of the earlier 54-picture corpus (50 pictures now) is 55
// characters or longer (median 157), and so is every record the measured sweep produced but one (43), so the rule
// always has enough text to judge on a real tooltip.
export const TEXT_SAME_MIN = 40;

export const RECORD_HEAD = ["時間", "名稱", "中文名稱", "類型", "詞綴", "辨識文字"];

const KIND_LABELS = { item: "暗金/套裝/符文之語", base: "底材" };

/** `text` with all whitespace removed. */
export function normalizeText(text) {
  return String(text ?? "").replace(/\s+/g, "");
}

/**
 * How alike two OCR texts are: the character bigrams they share over all the bigrams either of them holds. Two reads
 * of one tooltip share nearly all of them; two different items share only the shape words every tooltip repeats.
 */
export function textSimilarity(textA, textB) {
  const bigrams = (text) => {
    const set = new Set();
    for (let i = 0; i + 1 < text.length; i++) set.add(text.slice(i, i + 2));
    return set;
  };
  const a = bigrams(textA);
  const b = bigrams(textB);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** The name of the first `kind === "base"` candidate among OCR matches, or null when there is none. */
export function baseCandidate(candidates) {
  for (const c of candidates ?? []) if (c?.kind === "base") return c.name ?? null;
  return null;
}

/**
 * A record whose read was not sure (decideCandidates): it has no name yet and keeps the possible names to pick from
 * (`options`: { kind, name, zh, label, matched, learned }, at most five, memory only). Picking one (`resolveRecord`)
 * or typing a table name (`nameRecord`) names it; until then it is not searchable by name and exports an empty name,
 * like any unnamed record.
 */
export function isUnsure(record) {
  return !record.name && (record.options?.length ?? 0) > 0;
}

/** How many of the two keys' cells differ; keys of different lengths never match. */
export function keyDistance(a, b) {
  if (a.length !== b.length) return Infinity;
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n += 1;
  return n;
}

/** Whether two keys show the same panel: at most `tolerance` (a fraction of the cells) of their cells differ. */
export function keysAlike(a, b, tolerance) {
  return keyDistance(a, b) <= tolerance * a.length;
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** A copy of every plain object in `list` (the records keep their own, so a caller's array can change freely). */
const copyEach = (list) => (list ?? []).map((item) => ({ ...item }));

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
  const queue = []; // jobs waiting for OCR: { blob, key, queuedAt }, each crop its own, so nothing can be paired wrongly
  const records = [];
  const seenKeys = []; // crop keys already queued this session, compared with KEY_TOLERANCE
  // 略過 (skipped) = a tooltip that was seen but made no new record: the same panel again (crop key), the same item's
  // text again (a re-read of a tooltip already recorded) or one with nothing readable on it. 丟棄 (dropped) = a
  // tooltip lost unread because the 300-crop queue was full.
  const stats = { frames: 0, detected: 0, read: 0, skipped: 0, dropped: 0, ocrSeconds: 0, fallbackRuns: 0, fallbackHits: 0 };
  Object.defineProperty(stats, "queued", { get: () => queue.length, enumerable: true });
  let streak = 0;
  let lastEmittedBox = null; // the box of the last emitted crop: forgetKey needs it when held is already gone
  let emitted = false;
  let lastBox = null;
  let lastHash = null;
  // The picture a crop was already taken for: its content key and the box it was seen at (see HELD_*). While this
  // matches, the same hover never becomes a second crop -- and so never a second read or record.
  let held = null;
  // Bumped by `clear`. A crop taken before it belongs to the cleared run: its result must not become a record, or
  // records reappear after the player pressed 清除紀錄. `take`/`addRecord` carry it, so this is provable offline.
  let generation = 0;
  let nextId = 1; // never reused, not even after 清除紀錄: an old row's ✕ can never delete a newer record
  const within = (a, b, px) => Math.abs(a - b) <= px;
  const boxWithin = (a, b, px) =>
    within(a.x, b.x, px) && within(a.y, b.y, px) && within(a.width, b.width, px) && within(a.height, b.height, px);
  const sameBox = (a, b) => boxWithin(a, b, 2);
  const boxNear = (a, b) => boxWithin(a, b, HELD_BOX_PX);
  // A full queue refuses the crop; the count is what the panel shows as 丟棄.
  const queueIsFull = () => {
    if (queue.length < MAX_QUEUE) return false;
    stats.dropped += 1;
    return true;
  };
  const readAgain = (a, b) => {
    const na = normalizeText(a);
    const nb = normalizeText(b);
    if (na === nb) return true; // includes two empty reads, which the name/affix check below then still refuses
    if (!na || !nb) return false;
    if (na.length < TEXT_SAME_MIN || nb.length < TEXT_SAME_MIN) return false; // too few bigrams to judge: not the same
    return textSimilarity(na, nb) >= TEXT_SAME;
  };

  const reset = () => {
    streak = 0;
    emitted = false;
    lastBox = null;
    lastHash = null;
    held = null;
    lastEmittedBox = null;
  };

  // A box that differs from the last one starts a fresh run of identical frames: one off, and not yet handed out.
  const startStreak = (box, hash) => {
    streak = 1;
    emitted = false;
    lastBox = { ...box };
    lastHash = hash;
  };

  // Returns { box, key } on the frame that first shows a stable tooltip, null otherwise.
  function feed(small) {
    stats.frames += 1;
    const box = findTooltip(small);
    if (!box) {
      reset();
      return null;
    }
    stats.detected += 1;
    const hash = boxHash(small, box);
    // The picture already cropped stays held while its box barely moves and its content is still the same panel: one
    // hover is one crop, however long it lasts and however much the game re-renders underneath it (the key is anchored
    // on the panel's own dark structure, so a re-encoded frame and a pixel of hand shake stay inside the tolerance).
    if (held && boxNear(held.box, box) && keysAlike(boxKey(small, box), held.key, HELD_KEY_TOLERANCE)) return null;
    if (lastBox && sameBox(lastBox, box) && lastHash === hash) streak += 1;
    else startStreak(box, hash);
    if (streak < STABLE_FRAMES || emitted) return null;
    emitted = true;
    const key = boxKey(small, box);
    held = { key, box: { ...box } };
    lastEmittedBox = { ...box };
    return { box, key };
  }

  // The job this stable crop is queued as, or null when it is refused. The key describes the panel's content, so the
  // same panel shown again elsewhere (a different backdrop, the detector's box a couple of pixels off) is refused even
  // before it is queued. The crop itself is filled in later, by `fill`, once the browser has encoded it: the key, the
  // time and the picture then travel as one object, so a crop whose encode fails (see `drop`) cannot shift a later
  // crop's identity.
  // Queue wait semantics: stamp queuedAt at accept() time so waitMs measures time spent waiting in the queue until processScanJob starts.
  function accept(cropKey, queuedAt = now()) {
    const matchKey = (key) => key && keysAlike(key, cropKey, KEY_TOLERANCE); // 8 of a 64-cell key
    if (seenKeys.some(matchKey) || records.some((r) => matchKey(r.key))) {
      stats.skipped += 1;
      return null;
    }
    if (queueIsFull()) return null;
    const job = { blob: null, key: cropKey, queuedAt };
    seenKeys.push(cropKey);
    queue.push(job);
    return job;
  }

  // A picture the player uploaded: one finished job with no crop key (it is not a hover, so there is no panel content
  // to compare); the same item uploaded twice is still one record, through the text rule in `addRecord`. Null (and
  // counted as 丟棄) when the queue is full.
  function addUpload(blob, queuedAt = now()) {
    if (queueIsFull()) return null;
    const job = { blob, key: null, queuedAt };
    queue.push(job);
    return job;
  }

  // The encoded crop for a job `accept` handed out. Until this runs, `take` passes the job over: a picture that is
  // still being encoded is never read.
  function fill(job, blob) {
    job.blob = blob;
    return job;
  }

  // A crop the browser could not encode: it is forgotten, key and all, so the item can be cropped again and so that
  // the failure cannot be charged to another crop. The count is what the panel shows as 丟棄. A job `clear` already
  // took out of the queue is left alone: its key is gone with it, and the same key in `seenKeys` now belongs to a crop
  // accepted after the clear.
  function drop(job) {
    const at = queue.indexOf(job);
    if (at < 0) return;
    queue.splice(at, 1);
    seenKeys.splice(seenKeys.indexOf(job.key), 1);
    stats.dropped += 1;
  }

  // A crop whose read failed before it made any record: its key is forgotten (and the hold released) so the same
  // tooltip can be cropped and read again, as after an encode failure. A key of a cleared run, or one that a record
  // carries (the head already made it), stays.
  function forgetKey(key, from = generation) {
    if (!key || from !== generation || records.some((record) => record.key && keysAlike(record.key, key, KEY_TOLERANCE))) return;
    const at = seenKeys.findIndex((seen) => keyDistance(seen, key) === 0);
    if (at >= 0) seenKeys.splice(at, 1);
    // A read that keeps failing is retried after a fresh stable run, not on every frame; a different tooltip's run in
    // progress is left alone. The reset cannot sit inside the held-branch below: a read that fails after its head has
    // removeRecord already clear the hold (removeRecord keeps its own state clean), so held is null here and the
    // still-failing tooltip would re-emit on the very next frame.
    if (lastEmittedBox && (!held || boxNear(held.box, lastEmittedBox))) {
      streak = 0;
      lastBox = null;
    }
    if (held && keysAlike(held.key, key, HELD_KEY_TOLERANCE)) {
      held = null;
      emitted = false;
    }
  }

  // True when this OCR result becomes a record. A result carrying the generation of a run that was cleared since
  // its crop was taken is refused: the player asked for a clean list. A result whose text is the same item read
  // again (readAgain) is refused too: the identity rule -- the crop key accept() compares -- is what normally stops
  // that even being read, and this is the backstop for the cases the key cannot know (the same tooltip re-hovered
  // where the key drifted past its tolerance).
  function addRecord(record, from = generation) {
    if (from !== generation) return false;
    stats.read += 1;
    if (records.some((seen) => readAgain(seen.text, record.text))) {
      stats.skipped += 1;
      return false;
    }
    const conditions = copyEach(record.conditions);
    const options = copyEach(record.options);
    if (!record.name && options.length === 0 && conditions.length === 0) {
      stats.skipped += 1;
      return false;
    }
    records.unshift({
      id: nextId++,
      at: record.at instanceof Date ? record.at : new Date(),
      name: record.name ?? null,
      zh: record.zh ?? "",
      kind: record.kind ?? null,
      base: record.base ?? null,
      baseKey: record.baseKey ?? "", // the text piece the base is remembered under when the player changes it
      baseLearned: record.baseLearned ?? 0, // how many times in a row the player corrected this read's base (0: the base is the reader's own)
      options: record.name ? [] : options, // a named record has nothing left to pick
      conditions,
      text: record.text ?? "",
      key: record.key ?? null, // the crop key `accept` saw for this panel, so removing the record can forget it
      firstKey: record.firstKey ?? "", // the first name line of the read: what a name typed for this record is remembered under
      quality: record.quality ?? null, // the name line's colour class (gold/green/yellow/blue/white), for the listing's Rarity
    });
    return true;
  }

  // Drops one record by its `id`; false (and nothing changes) for an id that is not in the list. The "already seen"
  // memory of that item goes with it, text and crop key both, so hovering it again records it again -- and if that
  // item is the picture currently held, the hold is released too, so the same hover is cropped again without the
  // tooltip having to close in between.
  function removeRecord(id) {
    const index = records.findIndex((record) => record.id === id);
    if (index < 0) return false;
    const [record] = records.splice(index, 1);
    if (record.key) {
      const at = seenKeys.findIndex((seen) => keyDistance(seen, record.key) === 0);
      if (at >= 0) seenKeys.splice(at, 1);
      if (held && keysAlike(held.key, record.key, HELD_KEY_TOLERANCE)) {
        held = null;
        emitted = false;
      }
    }
    return true;
  }

  // Names a record that has no name yet from `{ name, kind, zh }` (a picked option, or a table name the player typed),
  // as an auto-picked record is named (name, kind, zh; `base` came with the read) and with nothing left to pick.
  // False, and nothing changes, for an unknown id, a record that already has a name or a choice without a name or kind.
  function nameRecord(id, { name, kind, zh = "" } = {}) {
    const record = records.find((r) => r.id === id);
    if (!record || record.name || !name || !kind) return false;
    Object.assign(record, { name, zh, kind, options: [], chosen: true });
    return true;
  }

  // The rest of a read whose head already made a record: the full text and its affix lines. A full text that reads as
  // an item already on the list (readAgain) is the same item shown again, so the provisional record goes away and
  // counts as 略過 (its crop key stays seen and the hold is not released: it IS that item). The whole text's own
  // decision is the record's: a sure name (`name`, `kind`, `zh`) names it, possible names (`options`) make it unsure,
  // and a whole text with neither leaves the head's name alone; a missing base is filled in.
  // False when the record is gone (cleared or deleted meanwhile) or was taken off as a repeat.
  function finishRecord(
    id,
    { text, conditions, name = null, kind = null, zh = "", base = null, baseKey = "", baseLearned = 0, options = [], firstKey = "", quality = null },
  ) {
    const index = records.findIndex((r) => r.id === id);
    if (index < 0) return false;
    const record = records[index];
    if (records.some((other) => other !== record && readAgain(other.text, text))) {
      records.splice(index, 1);
      stats.skipped += 1;
      return false;
    }
    record.text = text;
    record.conditions = copyEach(conditions);
    record.firstKey = firstKey || record.firstKey;
    record.quality = quality ?? record.quality;
    // A name the player picked or typed on this record while the rest was being read stays: only the whole text's
    // affix lines, text and base are taken from it.
    if (!record.chosen && name && kind) {
      // The whole text decides what the record is called: a sure name there names a record the head could not name and
      // replaces another one the head was sure about (a crop holding two tooltips, where a later line carries the name
      // the matcher prefers).
      if (record.name !== name) Object.assign(record, { name, zh, kind, options: [], base: base ?? record.base });
    } else if (!record.chosen && options.length) {
      // ... and a whole text that is not sure takes a name the head filled in back: the record asks, as it always did
      // when the whole text was all there was.
      Object.assign(record, { name: null, zh: "", kind: null, options: copyEach(options), base: base ?? record.base });
    }
    // The whole text reads the same lines as the head and more, so a base the player's memory knows is the whole's to give.
    if (!record.base || baseLearned > record.baseLearned) {
      Object.assign(record, { base: base ?? record.base, baseKey: baseKey || record.baseKey, baseLearned: baseLearned || record.baseLearned });
    }
    return true;
  }

  // Names an unsure record with its `index`-th option. False, and nothing changes, for an unknown id, a record that
  // is not unsure or a bad index.
  function resolveRecord(id, index) {
    const record = records.find((r) => r.id === id);
    const option = record && isUnsure(record) ? record.options[index] : undefined;
    return option ? nameRecord(id, option) : false;
  }

  // The next crop waiting for OCR, with the generation it was captured in, or null when none is ready. A job whose
  // picture is still being encoded is stepped over, and the order of the ready ones is kept.
  function take() {
    const at = queue.findIndex((job) => job.blob !== null);
    if (at < 0) return null;
    const [job] = queue.splice(at, 1);
    return { blob: job.blob, generation, key: job.key, queuedAt: job.queuedAt ?? null };
  }

  // Drops the records, the crops still waiting for OCR and the "already seen" memory so the player can start over.
  function clear() {
    queue.length = 0;
    records.length = 0;
    seenKeys.length = 0;
    generation += 1;
    reset();
  }

  return {
    feed,
    get streak() {
      return streak;
    },
    accept,
    addUpload,
    fill,
    drop,
    forgetKey,
    queue,
    take,
    stats,
    records,
    addRecord,
    removeRecord,
    resolveRecord,
    nameRecord,
    finishRecord,
    clear,
  };
}
