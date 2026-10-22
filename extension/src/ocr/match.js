// Turns OCR text into candidate item names. Pure functions: no chrome.*, no I/O.
//
// Two passes: the text is matched against full item names (English and Traditional Chinese), and against plain item
// types ("base") with a wider tolerance -- base candidates are appended after the item ones even when items matched,
// unless the items already fill the three slots.
import { chineseName, normalizeName, stripSeparators } from "../traderie/lookup.js";
import { toTraditional } from "./simplified.js";
import { isFixedName, toneQuality } from "./tone.js";

const CJK_ANY = /[\u3400-\u9fff]/u;

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
export const MAX_POSSIBLE = 5; // the "possible names" list the player chooses from is at most this long
export const LEARNED_SURE = 2; // a remembered choice fills the field by itself only after the player made it this often
const LOOSE_LATIN = 0.4; // extendCandidates: this fraction of a long English name may be wrong
const WEAK_ITEM_MAX = 3;
const MIN_BEFORE_STAT = 4;
const TYPE_CONTEXT = 6; // how many extra characters a type word may be glued to and still count
const ITEM_INCLUDE_CONTEXT = 3; // items get less gluing slack than bases: short (2-char) item names collide with stat words (力量) and with substrings of longer names (榮耀 in 格里斯育德的榮耀)

// The game prints variant glyphs or older translations the item table does not list, and the matcher's edit distance
// cannot always bridge them (a "sure/unsure" decision must not depend on whether a variant glyph landed inside the
// tolerance). ALIASES maps one variant glyph or word to the table's form; `applyAliases` runs it at the same place
// `toTraditional` runs, before any comparison.
//
// How entries are added (docs/design.md, "Alias table"): find a real picture whose OCR text carries the variant form
// (a corpus row in artifacts/ocr-e2e/ whose stored `text` matches a table name only through it), add the *glyph or
// word pair* -- never a whole item name and never a guess -- then replay the stored corpus (all 52 scored rows) and
// run `node --test "extension/test/*.test.mjs"`: no row may change its answer except the one the alias fixes, and no
// name that already matched may stop matching. 註→注 is a glyph pair shared by any text;
// 安達莉爾的面容→安達莉爾的面貌 is one word pair, kept whole because the table also lists 面* names that genuinely
// end in 容 (亞瑞特的面容, 赫拉森的面容), which a bare 容→貌 rewrite would break.
const ALIASES = [
  // image-31 (2026-10-16 corpus): the game prints 基德的賭註 (Gheed's Wager), the table 賭注; the picture read 賭註
  // and the item flipped between sure and unsure across reports. No other table name contains 注.
  ["註", "注"],
  // image-12: the game's title 安達莉爾的面容 (Andariel's Visage) prints 貌 with a glyph the OCR reads as 容; the
  // table's entry is 安達莉爾的面貌.
  ["安達莉爾的面容", "安達莉爾的面貌"],
];

/** The alias map applied before matching. A longer pair always wins over a shorter one it contains. */
function applyAliases(text) {
  let out = text;
  for (const [from, to] of ALIASES) out = out.split(from).join(to);
  return out;
}

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
 * `loose` is the third tier, only for the "possible names" list the player chooses from (extendCandidates): about two
 * fifths of a long English name and half of a Chinese name of four or more characters may be wrong.
 */
export function allowedEdits(length, { cjk, wide = false, loose = false }) {
  const tolerance = (() => {
    if (!cjk) return (length <= 5 ? 1 : 2) + (wide ? 1 : 0);
    if (length <= 2) return 0;
    if (length <= 4) return 1;
    return wide && length >= 6 ? 3 : 2;
  })();
  if (!loose) return tolerance;
  return Math.max(tolerance, cjk ? (length >= 4 ? Math.floor(length / 2) : 0) : Math.round(length * LOOSE_LATIN));
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
    const key = normalizeName(name);
    if (!tables.byKey.has(key)) bases.push({ key, name, cjk: false });
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
    const compact = applyAliases(toTraditional(repairCjkGlyphs(line.replace(/\s+/gu, ""))));
    for (const run of compact.match(CJK_RUN) ?? []) cjk.push({ text: stripSeparators(run), statPrefix, at });
    const letters = line.replace(/[^A-Za-z'’\- ]+/gu, "");
    for (const run of letters.match(LATIN_RUN) ?? []) latin.push({ text: normalizeName(run), statPrefix: false, at });
  }
  return {
    cjk: cjk.filter((piece) => piece.text.length >= 2),
    latin: latin.filter((piece) => piece.text.length >= MIN_LATIN_NAME),
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

function closest(pieces, entries, { cjk, wide, loose = false, suffix = false, allowStatPrefix = false, typeWords = null }) {
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
      const limit = allowedEdits(size, { cjk, wide, loose });
      if (piece.length < size - limit) continue;
      const distance = nameDistance(piece, entry, { cjk, suffix, limit });
      if (distance > limit) continue;
      // A whole line that is exactly a plain item type ("護身符") is the type line; it is not a misspelt item name.
      if (distance > 0 && typeWords?.has(piece)) continue;
      const score = distance * 100 - Math.min(size, 40);
      const previous = found.get(entry.name);
      if (!previous || score < previous.score) {
        found.set(entry.name, { name: entry.name, distance, score, matched: piece, size, at });
      }
    }
  }
  return [...found.values()];
}

/** `closest` over both scripts, Chinese pieces first; `cjkOnly` adds the options only the Chinese pass uses. */
const closestBoth = ({ cjk, latin }, entries, options, cjkOnly = {}) => [
  ...closest(cjk, entries, { ...options, ...cjkOnly, cjk: true }),
  ...closest(latin, entries, { ...options, cjk: false }),
];

const rank = (list, cap = MAX_CANDIDATES) => {
  const unique = new Map();
  // Equal scores are broken by where the evidence sits in the text: the earliest matching line wins. Map insertion
  // order cannot be used for this: a name that first matched some other line fuzzily keeps that place even after an
  // exact match on its own line (image-1: Honor lost to Legacy/Valor/Redemption although all four are exact).
  for (const c of list.sort((a, b) => a.score - b.score || a.at - b.at)) if (!unique.has(c.name)) unique.set(c.name, c);
  return [...unique.values()].slice(0, cap);
};

const tagged = (kind, list) => list.map((c) => ({ kind, ...c }));

/**
 * Candidates for a pasted screenshot's OCR text, best first, at most three.
 * Each is { kind: "item" | "base", name, distance, matched, at, quality }. Two passes: item candidates come first and the
 * plain item types ("base") found by the second pass are appended after them, the combined list capped at three.
 * `tones` (optional) is the lettering colour of each text line, in line order (the engine's `tones`): each candidate
 * then carries the `quality` the colour of its own line says (tone.js), which decideCandidates reads.
 */
export function matchOcrText(text, index, tones = null) {
  const found = matchLines(text, index);
  return tones ? found.map((c) => ({ ...c, quality: toneQuality(tones[c.at]) })) : found;
}

function matchLines(text, index) {
  const pieces = textPieces(text);
  const typeWords = new Set(index.bases.map((entry) => entry.key));
  const asItems = closestBoth(pieces, index.items, { wide: false, typeWords });
  // Strong items: Chinese names longer than WEAK_ITEM_MAX or English names (length >= MIN_LATIN_NAME).
  const strong = rank(asItems.filter((c) => c.size > WEAK_ITEM_MAX));
  // The plain-type pass runs even when items matched: a rare or magic item's random name can be spelled exactly like
  // a catalogue name, and the type line under it is then still the better answer (and what decideCandidates asks
  // about). Skipped when the items already fill the three candidates, where a base could not show.
  // This guard is a performance skip, not behaviour: rank() already caps `strong` at three and the combined list is
  // sliced, so removing it cannot change a result.
  const asBases = strong.length >= MAX_CANDIDATES
    ? []
    : rank(closestBoth(pieces, index.bases, { wide: true }, { suffix: true, allowStatPrefix: true }));
  if (strong.length) {
    return [...tagged("item", strong), ...tagged("base", asBases)].slice(0, MAX_CANDIDATES);
  }
  if (asBases.length) {
    // A short Chinese name (≤3 chars) that matches a product exactly could be a real unique/set item OR a
    // rare/magic item whose random name happens to collide. Default to the exact-match item, but also offer
    // the base as an alternative candidate button for the player to pick instead.
    // With a type line in the picture, a short name only counts when it is a line of its own: glued into a longer
    // run ("需要力量" for Strength, "燦爛戒指" for Splendor, "寒冰彈" for Ice) it is more likely a stat word or the
    // type line itself, and the type line already explains that text.
    const exactWeak = rank(asItems.filter((c) => c.size <= WEAK_ITEM_MAX && c.distance === 0 && c.matched.length === c.size));
    if (exactWeak.length) return [...tagged("item", exactWeak), ...tagged("base", asBases)];
    return tagged("base", asBases);
  }
  return tagged("item", rank(asItems));
}

/**
 * The "possible names" the player chooses from when a read is not sure: the candidates the matcher gave (`first`, kept in
 * their order), then up to MAX_POSSIBLE in all of the next best table names for the same text. The extra names come from
 * the matcher's own tolerance widened (items get the base pass's `wide` setting, then a third `loose` tier, see
 * allowedEdits) over the same name index, never from anything else, and they are only ever offered: a name that is not
 * sure is never filled in by itself. An item name of WEAK_ITEM_MAX characters or fewer stays out (it collides with stat
 * words), and so does a name the text only matches through a type word (see `typeWords`).
 */
export function extendCandidates(first, text, index) {
  if (first.length >= MAX_POSSIBLE) return first;
  const pieces = textPieces(text);
  const typeWords = new Set(index.bases.map((entry) => entry.key));
  const taken = new Set(first.map((c) => c.name));
  const more = [
    ...tagged("item", closestBoth(pieces, index.items, { wide: true, loose: true, typeWords }).filter((c) => c.size > WEAK_ITEM_MAX)),
    ...tagged(
      "base",
      closestBoth(pieces, index.bases, { wide: true, loose: true }, { suffix: true, allowStatPrefix: true }),
    ),
  ].filter((c) => !taken.has(c.name));
  // One list, best match first (the same score the matcher ranks by), the earliest line first among equals.
  const extra = rank(more, MAX_POSSIBLE);
  return [...first, ...extra].slice(0, MAX_POSSIBLE);
}

/** The comparison form of one name-line piece: what `nameKeys` returns and what the correction memory is keyed by. */
export function normalizeKey(raw) {
  const text = String(raw ?? "");
  return CJK_ANY.test(text) ? stripSeparators(applyAliases(toTraditional(text.replace(/\s+/gu, "")))) : normalizeName(text);
}

/**
 * The name-line pieces of an OCR text in reading order, as the matcher sees them ({ key, at }: the normalised text of one
 * run and the line it sits on). Stat lines, tags and the front of a stat line are not name lines and never appear here.
 * The correction memory looks every key up, and keys a player's choice by the piece the matcher matched (or, for a name
 * typed for a read that matched nothing, by the first one).
 */
export function nameKeys(text) {
  const { cjk, latin } = textPieces(text);
  return [...cjk, ...latin]
    .filter((piece) => !piece.statPrefix)
    .sort((a, b) => a.at - b.at)
    .map((piece) => ({ key: piece.text, at: piece.at }));
}

/**
 * Whether the best candidate may be filled in without asking. Measured on the earlier 54-picture truth set (50 pictures now; docs/design.md): a rare
 * or magic item prints a random name that can be spelled like a catalogue name, so an item with a type line under it
 * (which is what every unique prints too) is only sure when its name line is printed in the colour of a unique, runeword
 * or set item (`quality` gold or green, see tone.js); a name of WEAK_ITEM_MAX characters or fewer collides with stat
 * words, so it also needs that colour and the type line under it; three type names for one line mean no name line was
 * read. Sure = an item with no type line and a longer name, an item whose name line is gold or green (a short one
 * needs its type line too), or at most two type names. `candidates` come from matchOcrText (with its `tones`; none
 * means no colour evidence and the asks of the text alone).
 */
export function decideCandidates(candidates) {
  const [best] = candidates ?? [];
  if (!best) return { confident: false };
  // A name the player chose before for this same text (corrections.js applyLearned): one earlier choice only moved it
  // to the top and asks again; LEARNED_SURE choices in a row make a name sure, whatever the colours say. An item the
  // matcher already put first needs no promotion, so it keeps the matcher's own decision until then.
  if (best.learned >= LEARNED_SURE) return { confident: true };
  if (best.promoted) return { confident: false };
  if (best.kind === "base") return { confident: candidates.length < MAX_CANDIDATES };
  const typeLine = candidates.some((c) => c.kind === "base");
  // A name printed in the colour of a unique, runeword or set item (gold or green) is a catalogue name; a rare or magic
  // item's random name is yellow or blue. That settles a type line under the name for a long name; a short name also
  // needs the type line, because a short word on a line of its own is the one thing a stat word cannot fake.
  const named = isFixedName(best.quality);
  if (best.size <= WEAK_ITEM_MAX) return { confident: typeLine && named };
  return { confident: !typeLine || named };
}

/**
 * The OCR text for the player to read: every raw line is kept, and a line that matched a table entry gets that entry's
 * Traditional Chinese name appended ("Ripsaw" -> "Ripsaw（鋸齒刃）"). A line that already holds Chinese, a stat line, a
 * line with no match and a match with no Chinese name stay as they are. It reuses the matcher line by line (no second
 * matcher, no model, no network) and only changes how the text is shown: the raw text is what the form still receives.
 */
export function textWithChinese(text, index, tables) {
  return String(text ?? "")
    .split("\n")
    .map((line) => {
      if (!line.trim() || CJK_ANY.test(line)) return line;
      const best = matchOcrText(line, index)[0];
      const chinese = best ? chineseName(best.name, tables, best.matched) : "";
      return chinese ? `${line.trimEnd()}（${chinese}）` : line;
    })
    .join("\n");
}

