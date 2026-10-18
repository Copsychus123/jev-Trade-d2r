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
// over the whitespace-stripped text. Measured on the stored reads (artifacts/ocr-e2e/report.json, 54 pictures): two
// DIFFERENT items reach at most 0.449 (image-35 against image-41) and the shipped sweep's own items at most 0.234,
// while the same tooltip read again from a second place reaches 0.689 (artifacts/diag-scan/results/t1-sanity.json,
// image-18.png read twice). 0.6 sits between them with room on both sides.
export const TEXT_SAME = 0.6;
// Below this many characters a read holds too few bigrams for similarity to be evidence -- two different items' clipped
// reads can look alike -- so there the two texts must be equal. Every stored read of the 54-picture corpus is 55
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
  const pendingKeys = []; // the keys of the crops in `queue`, in the same order, so `take` can hand a job its key
  const pendingTimes = []; // the timestamps when crops were accepted into `queue`
  // 略過 (skipped) = a tooltip that was seen but made no new record: the same panel again (crop key), the same item's
  // text again (a re-read of a tooltip already recorded) or one with nothing readable on it. 丟棄 (dropped) = a
  // tooltip lost unread because the 300-crop queue was full.
  const stats = { frames: 0, detected: 0, read: 0, skipped: 0, dropped: 0, ocrSeconds: 0, fallbackRuns: 0, fallbackHits: 0 };
  Object.defineProperty(stats, "queued", { get: () => queue.length, enumerable: true });
  let streak = 0;
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
  const sameBox = (a, b) =>
    within(a.x, b.x, 2) && within(a.y, b.y, 2) && within(a.width, b.width, 2) && within(a.height, b.height, 2);
  const boxNear = (a, b) =>
    within(a.x, b.x, HELD_BOX_PX) &&
    within(a.y, b.y, HELD_BOX_PX) &&
    within(a.width, b.width, HELD_BOX_PX) &&
    within(a.height, b.height, HELD_BOX_PX);
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
    if (held && boxNear(held.box, box) && keyDistance(boxKey(small, box), held.key) <= HELD_KEY_TOLERANCE * held.key.length) {
      return null;
    }
    if (lastBox && sameBox(lastBox, box) && lastHash === hash) streak += 1;
    else startStreak(box, hash);
    if (streak < STABLE_FRAMES || emitted) return null;
    emitted = true;
    const key = boxKey(small, box);
    held = { key, box: { ...box } };
    return { box, key };
  }

  // True when this stable crop should be queued for OCR. The key describes the panel's content, so the same panel
  // shown again elsewhere (a different backdrop, the detector's box a couple of pixels off) is refused even before
  // it is queued.
  // Queue wait semantics: stamp queuedAt at accept() time so waitMs measures time spent waiting in the queue until processScanJob starts.
  function accept(cropKey, queuedAt = (typeof performance !== "undefined" ? performance.now() : Date.now())) {
    const tolerance = KEY_TOLERANCE * cropKey.length; // 8 of a 64-cell key
    const matchKey = (key) => key && keyDistance(key, cropKey) <= tolerance;
    if (
      seenKeys.some(matchKey) ||
      records.some((r) => matchKey(r.key)) ||
      pendingKeys.some(matchKey)
    ) {
      stats.skipped += 1;
      return false;
    }
    if (queue.length >= MAX_QUEUE) {
      stats.dropped += 1;
      return false;
    }
    seenKeys.push(cropKey);
    pendingKeys.push(cropKey);
    pendingTimes.push(queuedAt);
    return true;
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
    const conditions = record.conditions || [];
    const options = (record.options || []).map((o) => ({ ...o }));
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
      options: record.name ? [] : options, // a named record has nothing left to pick
      conditions: conditions.map((c) => ({ ...c })),
      text: record.text ?? "",
      key: record.key ?? null, // the crop key `accept` saw for this panel, so removing the record can forget it
      firstKey: record.firstKey ?? "", // the first name line of the read: what a name typed for this record is remembered under
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
      if (held && keyDistance(held.key, record.key) <= HELD_KEY_TOLERANCE * held.key.length) {
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
    Object.assign(record, { name, zh, kind, options: [] });
    return true;
  }

  function updateAffixes(id, { text, conditions }) {
    const record = records.find((r) => r.id === id);
    if (!record) return false;
    record.text = text ?? record.text;
    record.conditions = conditions ?? record.conditions;
    return true;
  }

  // Names an unsure record with its `index`-th option. False, and nothing changes, for an unknown id, a record that
  // is not unsure or a bad index.
  function resolveRecord(id, index) {
    const record = records.find((r) => r.id === id);
    const option = record && isUnsure(record) ? record.options[index] : undefined;
    return option ? nameRecord(id, option) : false;
  }

  // The next crop waiting for OCR, with the generation it was captured in, or null when none is waiting.
  function take() {
    const job = queue.shift();
    if (job === undefined) return null;
    const queuedFromJob = job && typeof job === "object" && typeof job.queuedAt === "number" ? job.queuedAt : null;
    return {
      blob: job,
      generation,
      key: pendingKeys.shift() ?? null,
      queuedAt: queuedFromJob ?? pendingTimes.shift() ?? null,
    };
  }

  // Drops the records, the crops still waiting for OCR and the "already seen" memory so the player can start over.
  function clear() {
    queue.length = 0;
    pendingKeys.length = 0;
    pendingTimes.length = 0;
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
    queue,
    take,
    stats,
    records,
    addRecord,
    removeRecord,
    resolveRecord,
    nameRecord,
    updateAffixes,
    clear,
  };
}
