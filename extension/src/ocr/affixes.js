// Reads the affix lines of an item screenshot (the OCR text) into search conditions. Rules only, no model. Pure
// functions: no chrome.*, no I/O. The conditions are only ever written into the form; the player switches each one on
// and corrects the numbers before anything is searched.
import { AFFIXES } from "./affix_dictionary.js";
import { levenshtein } from "./match.js";

const CJK_GAP = /(?<=[\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/gu;
const CJK_CHAR = /[\u3400-\u9fff]/gu;
const NOT_AN_AFFIX = /需要等級|Required Level|耐久|Durability|出售價格|Shift|Ctrl|\[/iu; // requirement, hints, mod summaries
// A requirement line prints the attribute the *item* needs ("需要力量:148"), never a "+X" affix, but the reader
// mangles the 需 ("南 要 力量", "劑 加 要 力量" — image-1/IMG_0379). A requirement always reads "…要<attribute>",
// so we anchor on the attribute instead of enumerating every way 需 can be misread: reject a line that contains
// 需要/需求, or has 要 immediately before a requirement attribute. Real affixes like "+27 力量" are untouched.
const REQUIREMENT = /需要|需求|要(力量|敏捷|體力|精力|等級)/u;
const ABBREVIATION = /\(([A-Za-z]{2,5})\)/u;
const BRACKETED_TOKEN = /\([A-Za-z0-9]+\)/gu;
const NUMBER = /[+-]?(\d+)/u;
// The client prints "20%" and the reader often sees "2006" or "2096": the "%" came out as two more digits.
const MISREAD_PERCENT = ["96", "06", "09"];

/** Checks if a line matches leech (e.g. 擊中竊取...法力 / 竊取...生命) */
function matchesLeech(entry, cjk) {
  if (entry.key === "ml") {
    return /擊?中?竊取.*法力/u.test(cjk) || /法力.*竊取/u.test(cjk);
  }
  if (entry.key === "ll") {
    return /擊?中?竊取.*生命/u.test(cjk) || /生命.*竊取/u.test(cjk);
  }
  return false;
}

/** Length of the longest word of `entry` that the line contains (0: none of them). */
function wordLength(entry, cjk, lower) {
  if (matchesLeech(entry, cjk)) return 10;
  let best = 0;
  for (const word of [entry.zh, ...entry.zhAlt]) if (cjk.includes(word)) best = Math.max(best, word.length);
  if (lower.includes(entry.en.toLowerCase())) best = Math.max(best, entry.en.length);
  return best;
}

function bestByWords(line, cjk, dictionary) {
  const lower = line.toLowerCase();
  let best = null;
  let bestLength = 0;
  for (const entry of dictionary) {
    const length = wordLength(entry, cjk, lower);
    if (length > bestLength) {
      best = entry;
      bestLength = length;
    }
  }
  return best;
}

/** The entry whose abbreviation the line shows, allowing one wrong letter; null when none or when two are as close. */
function bestByAbbreviation(line, dictionary) {
  const found = ABBREVIATION.exec(line);
  if (!found) return null;
  const shown = found[1].toUpperCase();
  let best = [];
  let bestDistance = 2;
  for (const entry of dictionary) {
    if (!entry.abbr) continue;
    const distance = levenshtein(shown, entry.abbr.toUpperCase(), 1);
    if (distance > 1) continue;
    if (distance < bestDistance) {
      best = [entry];
      bestDistance = distance;
    } else if (distance === bestDistance) {
      best.push(entry);
    }
  }
  return best.length === 1 ? best[0] : null;
}

/** Extracts the most plausible raw digit string from an affix line. */
function extractValueDigits(line) {
  if (!line) return null;
  // 1. Strip bracketed acronyms or misread tags (e.g. "(88)" from "(PR)", "(FB)")
  // if a number exists outside them.
  const stripped = String(line).replace(BRACKETED_TOKEN, " ").trim();

  // 2. Strip stray line prefixes like "2x " or "1x "
  const withoutPrefix = stripped.replace(/^\s*\d+\s*[xX*×]\s*/u, "");

  // Prefer numbers with clear affix indicators from cleaned line:
  // A. Explicit sign prefix like +12 or -5
  const signed = /[+-]\s*(\d+)/u.exec(withoutPrefix);
  if (signed) return signed[1];

  // B. Trailing percent sign like 7%
  const percent = /(\d+)\s*%/u.exec(withoutPrefix);
  if (percent) return percent[1];

  // C. Any remaining number in the cleaned line
  const fallback = NUMBER.exec(withoutPrefix);
  if (fallback) return fallback[1];

  // Final fallback to original line
  const lastResort = NUMBER.exec(line);
  return lastResort ? lastResort[1] : null;
}

/**
 * { min, confident } for a line of `entry`. A value that had to be repaired, or is above the affix's generous
 * ceiling (carried on the entry as `ceiling`, null for `bool`), is marked unsure.
 * A non-bool affix always prints a number, so a keyword match with `min: null` is a title/type line (e.g.
 * "生命之寶藍"), not an affix: the caller drops it silently and never adds it to `unmapped` (which is only for lines
 * that matched no dictionary entry).
 * When a percent affix prints no "%", the reader turned the glyph into trailing digits; the repair ladder is
 * ordered, first hit wins, and every repaired value stays on the `confident: false` path:
 *   a. a 3-digit value ending in 6 ("406"→40, "596"→59) — the "%" came out as the final digit;
 *   b. a two-digit misread 96/06/09 ("2096"→20, "10509"→105, "2009"→20, "406" is caught by (a) first);
 *   c. a single trailing 0/5 with 3+ digits ("205"→20, "110"→11), or 6/9 for a 4+ digit read ("1659"→165,
 *      "34060"→3406) — the "%" came out as one digit. (c) only runs when a/b did not and a non-empty, >= 1 value
 *      remains; a 2-digit read ("40") and a lone trailing 6/9 on a 3-digit read ("119") are left alone.
 *   d. continuation: a value the ladder actually repaired that is still above the affix's ceiling ("20096"→200,
 *      "34060"→3406, "1790"→179) came from an even longer glyph run, so one more trailing digit is stripped, at
 *      most twice, until the value fits the ceiling ("20096"→20, "34060"→34, "1790"→17). A raw read with no
 *      applying rung ("1332") is left as is. Only the no-% path continues; a value read with a literal "%"
 *      ("855%") is never stripped.
 */
function readNumber(entry, line) {
  if (entry.kind === "bool") return { min: null, confident: true };
  let digits = extractValueDigits(line);
  if (digits === null) return { min: null, confident: false };
  let confident = true;
  if (entry.kind === "percent" && !line.includes("%")) {
    confident = false;
    let repaired = false;
    if (digits.length === 3 && digits.endsWith("6")) {
      digits = digits.slice(0, 2);
      repaired = true;
    } else {
      const ending = MISREAD_PERCENT.find((e) => digits.length >= 3 && digits.endsWith(e));
      if (ending) {
        digits = digits.slice(0, -ending.length);
        repaired = true;
      } else if (digits.length >= 3 && "0569".includes(digits.slice(-1))) {
        const rest = digits.slice(0, -1);
        // A trailing 0/5 repairs at any length >= 3, but a trailing 6/9 only when the raw read is 4+ digits: a
        // 3-digit value such as "119" is a plausible flat read (pinned by the ring fixture), while "1659" is not.
        // Under 3 digits ("40") a plausible read is left untouched rather than degraded to "4".
        const ambiguous = /[69]/u.test(digits.slice(-1));
        if (Number(rest) >= 1 && (!ambiguous || digits.length >= 4)) {
          digits = rest;
          repaired = true;
        }
      }
    }
    // Continuation, no-% path only: a ladder-repaired value still above the affix's ceiling means the "%" became
    // even more glyphs than the ladder assumed ("+20096" is a real 20%). Strip one more trailing digit and re-check,
    // at most twice, stopping once the value fits the ceiling or drops below 1. Only a value the ladder actually
    // repaired continues; a raw read with no applying rung ("+1332") is left as is rather than inventing a rung.
    if (repaired && entry.ceiling != null) {
      for (let extra = 0; extra < 2 && Number(digits) > entry.ceiling; extra++) {
        const shorter = digits.slice(0, -1);
        if (shorter === "" || Number(shorter) < 1) break;
        digits = shorter;
      }
    }
  }
  const min = Number(digits);
  // A repaired read is already unsure; on top of that, a value above the affix's ceiling cannot be a real roll, so
  // it too is downgraded. The value itself is never changed or dropped, only `confident`.
  const withinCeiling = entry.ceiling == null || min <= entry.ceiling;
  return { min, confident: confident && withinCeiling };
}
/** A short run of Chinese without a digit is an item's name or type line, not an affix. */
function isNameLine(cjk) {
  if (/無法凍結|無形|技能/u.test(cjk)) return false;
  const count = cjk.match(CJK_CHAR)?.length ?? 0;
  return count > 0 && count <= 6 && !/\d/u.test(cjk);
}

/**
 * Reads OCR text into { conditions, unmapped }. A condition is { key, label, kind, line, min, max: null, confident,
 * on: false }; the first line of an affix wins when the same affix is printed twice. `unmapped` holds lines that look
 * like an affix but are not in the dictionary.
 */
export function parseAffixLines(text, dictionary = AFFIXES) {
  const conditions = [];
  const unmapped = [];
  const seen = new Set();
  for (const raw of String(text ?? "").split(/\r\n|[\n\r]/u)) {
    const line = raw.replace(/\s+/gu, " ").trim();
    if (!line) continue;
    const cjk = line.replace(CJK_GAP, "");
    if (NOT_AN_AFFIX.test(cjk) || REQUIREMENT.test(cjk)) continue;
    const entry = bestByWords(line, cjk, dictionary) ?? bestByAbbreviation(line, dictionary);
    if (!entry) {
      if (!isNameLine(cjk)) unmapped.push(line);
      continue;
    }
    const value = readNumber(entry, line);
    if (seen.has(entry.key)) continue;
    seen.add(entry.key);
    // A plain or percent affix always prints a number. A keyword match with no number at all is a title/type line
    // ("生命之寶藍") or a weapon-speed descriptor, never an affix: drop it silently. It is not added to `unmapped`,
    // which is only for lines that matched no dictionary entry. The key still counts as seen, exactly as before.
    if (entry.kind !== "bool" && value.min === null) continue;
    conditions.push({
      key: entry.key,
      label: entry.zh,
      kind: entry.kind,
      line,
      ...value,
      max: null,
      on: false,
    });
  }
  return { conditions, unmapped };
}
