// Turns OCR text into candidate item names. Pure functions: no chrome.*, no I/O.
//
// Two passes, as agreed: first the text is matched against full item names (English and Traditional Chinese),
// and only when nothing matches against plain item types ("base"), with a wider tolerance.
import { normalizeName, stripSeparators } from "../traderie/lookup.js";

const CJK_RUN = /[\u3400-\u9fff][\u3400-\u9fff\-·‧・.]*/gu;
const LATIN_RUN = /[A-Za-z][A-Za-z'’\- ]{2,}/gu;
// A mod tag starts a bracket ("蜘蛛之網[120ED]", "蛛網束帶【精英】"); OCR often misreads the closing bracket, so the
// tag is cut off from its opening bracket to the end of the line. A rare item's random name also sits in 【】
// ("【怨靈 轉迴】"), so 【 only starts a tag when a tier word or Latin/digit tag follows it.
const TAG_START = /[[［].*$|【(?=精英|卓越|普通|[A-Za-z0-9]).*$/u;
// Stat lines ("+9 力量(STR)", "需要等級:46", "耐久度(DUR):13/20") are never names.
const STAT_LINE = /[%+:：]|[(（][A-Za-z]/u;
const MIN_LATIN_NAME = 6;
const WINDOW_MIN_NAME = 5; // shorter Chinese names must be a whole short run, not a piece of a long noisy one
const MAX_CANDIDATES = 3;
const WEAK_ITEM_MAX = 3;
const MIN_BEFORE_STAT = 4;
const TYPE_CONTEXT = 6; // how many extra characters a type word may be glued to and still count

export function levenshtein(a, b, limit = Infinity) {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    let rowBest = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (row[j] < rowBest) rowBest = row[j];
    }
    if (rowBest > limit) return limit + 1;
    prev = row;
  }
  return prev[b.length];
}

/**
 * Allowed edits for a name of this length. Chinese names are short, so two wrong characters is already a new word:
 * up to 2 characters none, 3 to 4 one, longer two. The second (base) pass allows one more, only for long names.
 */
export function allowedEdits(length, { cjk, wide = false }) {
  if (cjk) return length <= 2 ? 0 : length <= 4 ? 1 : 2 + (wide && length >= 6 ? 1 : 0);
  return (length <= 5 ? 1 : 2) + (wide ? 1 : 0);
}

/** Index of every name we can match, built once from the item tables (see indexTables in lookup.js). */
export function buildMatchIndex(tables) {
  const items = [];
  const bases = [];
  const baseKeys = new Set(tables.bases.map(normalizeName));
  for (const [key, product] of tables.byKey) {
    (baseKeys.has(key) ? bases : items).push({ key, name: product.name, cjk: false });
  }
  for (const name of tables.bases) {
    if (!tables.byKey.has(normalizeName(name))) bases.push({ key: normalizeName(name), name, cjk: false });
  }
  for (const [chinese, english] of tables.zh) {
    (baseKeys.has(normalizeName(english)) ? bases : items).push({
      key: stripSeparators(chinese),
      name: english,
      cjk: true,
    });
  }
  return { items, bases };
}

function textPieces(text) {
  const cjk = [];
  const latin = [];
  for (const rawLine of String(text ?? "").split(/\r?\n/u)) {
    // A stat line ("+9 力量(STR)", "需要等級:46") is never a name, but OCR sometimes glues the type line onto the
    // front of one ("芭戒指天要等級:48"): keep what comes before the first stat mark when that is long enough to be
    // more than a stat word such as 力量.
    const untagged = rawLine.replace(TAG_START, "");
    const mark = untagged.search(STAT_LINE);
    const line = mark === -1 ? untagged : untagged.slice(0, mark);
    if (mark !== -1 && line.replace(/\s+/gu, "").length < MIN_BEFORE_STAT) continue;
    const compact = line.replace(/\s+/gu, "");
    for (const run of compact.match(CJK_RUN) ?? []) cjk.push(stripSeparators(run));
    // Stray marks inside an English name ("KALEID@SCQPE~") are dropped so the letters around them join up again.
    const letters = line.replace(/[^A-Za-z'’\- ]+/gu, "");
    for (const run of letters.match(LATIN_RUN) ?? []) latin.push(normalizeName(run));
  }
  return { cjk: cjk.filter((s) => s.length >= 2), latin: latin.filter((s) => s.length >= MIN_LATIN_NAME) };
}

function closest(pieces, entries, { cjk, wide, suffix = false }) {
  const found = new Map();
  for (const piece of pieces) {
    for (const entry of entries) {
      if (entry.cjk !== cjk) continue;
      const size = entry.key.length;
      // Short English words ("Axe", "Ice") match any noisy Latin run; they are only trusted as a whole, clean line.
      if (!cjk && size < MIN_LATIN_NAME) continue;
      const limit = allowedEdits(size, { cjk, wide });
      if (piece.length < size - limit) continue;
      let distance = piece.length <= size + limit ? levenshtein(piece, entry.key, limit) : Infinity;
      // A long Chinese name may sit inside a longer run (a prefix glued on): try every window of the name's length.
      // (A fuzzy window for short type words was tried and removed: it matched noise such as "Defender".)
      for (let start = 0; cjk && size >= WINDOW_MIN_NAME && start + size <= piece.length && distance > 0; start += 1) {
        distance = Math.min(distance, levenshtein(piece.slice(start, start + size), entry.key, limit));
      }
      // Magic and rare charms read "<random name>特大咒符": a short type word may also end a long run (types only).
      if (cjk && suffix && size < WINDOW_MIN_NAME && piece.length > size) {
        distance = Math.min(distance, levenshtein(piece.slice(-size), entry.key, limit));
      }
      // OCR often glues neighbouring words onto a type line ("芭戒指天要等級"): the type word, spelled exactly, counts.
      if (cjk && suffix && piece.length <= size + TYPE_CONTEXT && piece.includes(entry.key)) distance = 0;
      if (distance > limit) continue;
      const score = distance * 100 - Math.min(size, 40);
      const previous = found.get(entry.name);
      if (!previous || score < previous.score) {
        found.set(entry.name, { name: entry.name, distance, score, matched: piece, size });
      }
    }
  }
  return [...found.values()];
}

const rank = (list) => {
  const unique = new Map();
  for (const c of list.sort((a, b) => a.score - b.score)) if (!unique.has(c.name)) unique.set(c.name, c);
  return [...unique.values()].slice(0, MAX_CANDIDATES);
};

/**
 * Candidates for a pasted screenshot's OCR text, best first, at most three.
 * Each is { kind: "item" | "base", name, distance, matched }. Items come first; plain item types only when no item
 * matches.
 */
export function matchOcrText(text, index) {
  const { cjk, latin } = textPieces(text);
  const asItems = [
    ...closest(cjk, index.items, { cjk: true, wide: false }),
    ...closest(latin, index.items, { cjk: false, wide: false }),
  ];
  // A one-to-three character Chinese hit is weak evidence: rare items have random names, and a random name such as
  // 投索 can equal a real item's name. It only counts when no type line explains the picture.
  const strong = rank(asItems.filter((c) => c.size > WEAK_ITEM_MAX));
  if (strong.length) return strong.map((c) => ({ kind: "item", ...pick(c) }));
  const asBases = rank([
    ...closest(cjk, index.bases, { cjk: true, wide: true, suffix: true }),
    ...closest(latin, index.bases, { cjk: false, wide: true }),
  ]);
  if (asBases.length) return asBases.map((c) => ({ kind: "base", ...pick(c) }));
  return rank(asItems).map((c) => ({ kind: "item", ...pick(c) }));
}

const pick = ({ name, distance, matched }) => ({ name, distance, matched });
