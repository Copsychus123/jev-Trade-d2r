// Turns OCR text into candidate item names. Pure functions: no chrome.*, no I/O.
//
// Two passes: the text is matched against full item names (English and Traditional Chinese), and against plain item
// types ("base") with a wider tolerance -- base candidates are appended after the item ones even when items matched,
// unless the items already fill the three slots.
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
const ITEM_INCLUDE_CONTEXT = 3; // items get less gluing slack than bases: short (2-char) item names collide with stat words (力量) and with substrings of longer names (榮耀 in 格里斯育德的榮耀)

/**
 * Targeted glyph repair for frequent D2R Chinese OCR segmentation and font errors:
 * - "戒" in D2R font split into "長虹" (e.g. "長虹指走", "長虹指", "長虹")
 * - "寶" misread as "康賣" (e.g. "康賣她" for "寶冠")
 * - "冠" misread as "她" when following 寶/康賣 or in headgear/coronets
 * - "盔" misread as "炙" or "葷" when following 頭/發/輕鋼 or in helmet names
 * - "霧" misread as "宁" (e.g. "煙宁" for "煙霧")
 */
function repairCjkGlyphs(text) {
  return text
    .replace(/長虹(?:指走|指)?/gu, (match) => (match.includes("指") ? "戒指" : "戒"))
    .replace(/康賣/gu, "寶")
    .replace(/(?:[寶康賣]|三重|日冕之|皇|權)她/gu, (m) => m.slice(0, -1) + "冠")
    .replace(/(?:[頭盔發]|發頭)炙/gu, (m) => m.slice(0, -1) + "盔")
    .replace(/(?:[頭盔發]|發頭|輕?鋼)葷/gu, (m) => m.slice(0, -1) + "盔")
    .replace(/煙宁/gu, "煙霧")
    .replace(/珠喜/gu, "珠寶")
    .replace(/(?:夜視之盔|和卻視之有禹只|卻視之有禹)/gu, "暗視之盔");
}

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

/**
 * One raw line reduced to the part that can hold a name. A stat line ("+9 力量(STR)", "需要等級:46") is never a
 * name, but OCR sometimes glues the type line onto the front of one ("芭戒指天要等級:48"): keep what comes before
 * the first stat mark when that is long enough to be more than a stat word such as 力量.
 * Returns `{ line, statPrefix }`, or null for a line that has nothing but a stat.
 */
function nameLine(rawLine) {
  const untagged = rawLine.replace(TAG_START, "");
  const mark = untagged.search(STAT_LINE);
  // A stat line has a value after its mark; a name line that merely ends in a stray "+"/"%" does not, so require a
  // digit after the first mark before cutting the line down to its prefix.
  const statPrefix = mark !== -1 && /\d/u.test(untagged.slice(mark));
  const line = statPrefix ? untagged.slice(0, mark) : untagged;
  if (statPrefix && line.replace(/\s+/gu, "").length < MIN_BEFORE_STAT) return null;
  return { line, statPrefix };
}

function textPieces(text) {
  const cjk = [];
  const latin = [];
  // Every piece keeps the line it came from: it breaks ties between equally good candidates (see rank).
  for (const [at, rawLine] of String(text ?? "").split(/\r?\n/u).entries()) {
    const reduced = nameLine(rawLine);
    if (!reduced) continue;
    const { line, statPrefix } = reduced;
    const compact = repairCjkGlyphs(line.replace(/\s+/gu, ""));
    for (const run of compact.match(CJK_RUN) ?? []) cjk.push({ text: stripSeparators(run), statPrefix, at });
    const letters = line.replace(/[^A-Za-z'’\- ]+/gu, "");
    for (const run of letters.match(LATIN_RUN) ?? []) latin.push({ text: normalizeName(run), statPrefix: false, at });
  }
  return {
    cjk: cjk.filter((p) => p.text.length >= 2),
    latin: latin.filter((p) => p.text.length >= MIN_LATIN_NAME),
  };
}

/**
 * How far the text `piece` is from the catalogue name `entry.key`: the plain distance, the best window of the name's
 * own length inside a longer run (cjk), a short type word ending a longer run (cjk + suffix), or 0 when the name sits
 * in a piece with only a little glue around it. `limit` is the caller's allowed edits.
 */
function nameDistance(piece, entry, { cjk, suffix, limit }) {
  const size = entry.key.length;
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
  // OCR often glues neighbouring words onto a line: the word, spelled exactly, counts if noise is small.
  // Items get less gluing slack than bases (stat words such as 力量/生命 collide with item names).
  if (cjk && piece.length <= size + (suffix ? TYPE_CONTEXT : ITEM_INCLUDE_CONTEXT) && piece.includes(entry.key)) {
    distance = 0;
  }
  return distance;
}

function closest(pieces, entries, { cjk, wide, suffix = false, allowStatPrefix = false }) {
  const found = new Map();
  for (const raw of pieces) {
    const { text: piece, at, statPrefix } = raw;
    // Text cut from the front of a stat line is only evidence for a glued type word (base pass), never for an item.
    if (statPrefix && !allowStatPrefix) continue;
    for (const entry of entries) {
      if (entry.cjk !== cjk) continue;
      const size = entry.key.length;
      // Short English words ("Axe", "Ice") match any noisy Latin run; they are only trusted as a whole, clean line.
      if (!cjk && size < MIN_LATIN_NAME) continue;
      const limit = allowedEdits(size, { cjk, wide });
      if (piece.length < size - limit) continue;
      const distance = nameDistance(piece, entry, { cjk, suffix, limit });
      if (distance > limit) continue;
      const score = distance * 100 - Math.min(size, 40);
      const previous = found.get(entry.name);
      if (!previous || score < previous.score) {
        found.set(entry.name, { name: entry.name, distance, score, matched: piece, size, at });
      }
    }
  }
  return [...found.values()];
}

const rank = (list) => {
  const unique = new Map();
  // Equal scores are broken by where the evidence sits in the text: the earliest matching line wins. Map insertion
  // order cannot be used for this: a name that first matched some other line fuzzily keeps that place even after an
  // exact match on its own line (image-1: Honor lost to Legacy/Valor/Redemption although all four are exact).
  for (const c of list.sort((a, b) => a.score - b.score || a.at - b.at)) if (!unique.has(c.name)) unique.set(c.name, c);
  return [...unique.values()].slice(0, MAX_CANDIDATES);
};

const tagged = (kind, list) => list.map((c) => ({ kind, ...c }));

/**
 * Candidates for a pasted screenshot's OCR text, best first, at most three.
 * Each is { kind: "item" | "base", name, distance, matched }. Two passes: item candidates come first and the plain
 * item types ("base") found by the second pass are appended after them, the combined list capped at three.
 */
export function matchOcrText(text, index) {
  const { cjk, latin } = textPieces(text);
  const asItems = [
    ...closest(cjk, index.items, { cjk: true, wide: false }),
    ...closest(latin, index.items, { cjk: false, wide: false }),
  ];
  // Strong items: Chinese names longer than WEAK_ITEM_MAX or English names (length >= MIN_LATIN_NAME).
  const strong = rank(asItems.filter((c) => c.size > WEAK_ITEM_MAX));
  // The plain-type pass runs even when items matched: a rare or magic item's random name can be spelled exactly like
  // a catalogue name (「防禦者的火焰」→ Defender's Fire, 「蛋白石脈」→ Opalvein), and the type line under it is then
  // still the better answer. Skipped when the items already fill the three candidates, where a base could not show.
  // This guard is a performance skip, not behaviour: rank() already caps `strong` at three and the combined list is
  // sliced, so removing it cannot change a result.
  const asBases = strong.length >= MAX_CANDIDATES
    ? []
    : rank([
        ...closest(cjk, index.bases, { cjk: true, wide: true, suffix: true, allowStatPrefix: true }),
        ...closest(latin, index.bases, { cjk: false, wide: true }),
      ]);
  if (strong.length) {
    return [...tagged("item", strong), ...tagged("base", asBases)].slice(0, MAX_CANDIDATES);
  }
  if (asBases.length) {
    // A short Chinese name (≤3 chars) that matches a product exactly could be a real unique/set item OR a
    // rare/magic item whose random name happens to collide. Default to the exact-match item, but also offer
    // the base as an alternative candidate button for the player to pick instead.
    const exactWeak = rank(asItems.filter((c) => c.size <= WEAK_ITEM_MAX && c.distance === 0));
    if (exactWeak.length) return [...tagged("item", exactWeak), ...tagged("base", asBases)];
    return tagged("base", asBases);
  }
  return tagged("item", rank(asItems));
}

