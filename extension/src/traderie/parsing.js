// Port of src/jev_ultrafast/traderie/parsing.py. Output must equal the Python parser exactly.
import { TRADERIE_D2R_URL, TRADING_MARKERS } from "./site.js";

const SIGN_IN_PROMPT = "Please sign in to view offers";

const LISTING_NOISE_LINES = new Set([
  "join akrew pro for an ad free experience!",
  "pro",
  "marketplace",
  "community",
  "add listing",
  "log in",
  "sign up",
]);

// Older entries show a date instead of "N days ago". The Chinese form is what Traderie shows to a Chinese browser;
// the others are the usual numeric and English forms.
const ABSOLUTE_DATE =
  "\\d{4}年\\d{1,2}月\\d{1,2}日|\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}|\\d{1,2}/\\d{1,2}/\\d{4}" +
  "|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.? \\d{1,2},? \\d{4}";

export const TIME_REGEX = new RegExp(
  "^(?:[a-z ]*(?:\\d+|a|an)\\s*(seconds?|minutes?|hours?|days?|weeks?|months?|years?|s|m|h|d|秒|分鐘|小时|小時|天|週|周|個月|月|年)s?\\s*(?:ago|前)|" +
    "just now|剛剛|" +
    `${ABSOLUTE_DATE})$`,
  "iu",
);

const TRADE_TIME_RE = new RegExp(
  "^(?:\\d+\\s*(?:秒|分鐘|小时|小時|天|週|周|個月|月|年)前|" +
    "(?:[a-z ]*)?(?:\\d+|a|an) ?(?:second|minute|hour|day|week|month|year|s|m|h|d)s? ago|" +
    "just now|剛剛|" +
    `${ABSOLUTE_DATE})$`,
  "iu",
);

// Environment words skipped on the Recent Trades side (a narrower list than CARD_ENV_TAGS: a trade's item name may
// itself be a quality word such as "Monarch").
const RECENT_ENV_TAGS = new Set([
  "pc", "softcore", "hardcore", "ladder", "non ladder", "xbox", "playstation",
  "nintendo switch", "reign of the warlock", "resurrected", "lord of destruction", "classic (base game)",
]);

// Environment/quality words that are not affixes on a listing card. Built once: every card is parsed against the
// same set.
const CARD_ENV_TAGS = new Set([
  "pc", "softcore", "hardcore", "ladder", "non ladder", "playstation", "xbox",
  "nintendo switch", "reign of the warlock", "resurrected", "lord of destruction", "classic (base game)",
  "rare", "classic", "penta", "magic", "monarch", "sun", "dot", "orange",
]);

// Python str.strip() / str.splitlines() whitespace, not JS's.
const PY_WS = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PY_STRIP = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, "gu");
const PY_LINE_BREAK = /\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/u;

const pyStrip = (s) => s.replace(PY_STRIP, "");
/** Python's `str.splitlines()`: the controller writes the same line list for its page-shape checks. */
export const splitLines = (s) => s.split(PY_LINE_BREAK);

/** The mode, ladder and game version words found in `low` (lower-cased text). */
function envLabels(low) {
  const mode = low.includes("hardcore") ? "Hardcore" : low.includes("softcore") ? "Softcore" : null;
  const ladder = low.includes("non ladder") ? "Non Ladder" : low.includes("ladder") ? "Ladder" : null;
  const gameVersion = low.includes("classic (base game)")
    ? "Classic (Base Game)"
    : low.includes("reign of the warlock")
      ? "Reign of the Warlock"
      : low.includes("lord of destruction")
        ? "Lord of Destruction"
        : null;
  return { mode, ladder, gameVersion };
}

/**
 * The platform of a card: the first of PC, Playstation, Xbox, Switch mentioned in its middle lines. Recent Trades
 * reads a different rule (see `tradeBlock`), so the two do not share this helper.
 * @returns {string|null}
 */
function cardPlatform(midLower) {
  const isPc = midLower.includes("pc"); // midLower is the joined middle lines, so a per-line token test adds nothing
  if (isPc) return "PC";
  if (midLower.includes("playstation")) return "Playstation";
  if (midLower.includes("xbox")) return "Xbox";
  if (midLower.includes("switch")) return "Switch";
  return null;
}

/**
 * The card line naming the item and its index in `cleanPrefix` (the given name and -1 when not found).
 * @returns {{itemLine: string|null, itemIdx: number}}
 */
function itemLine(cleanPrefix, itemName, itemLower) {
  let nameLine = itemName;
  let itemIdx = -1;
  if (itemLower !== null) {
    for (let i = 0; i < cleanPrefix.length; i += 1) {
      const low = cleanPrefix[i].toLowerCase();
      if (low.includes(itemLower)) {
        nameLine = cleanPrefix[i];
        itemIdx = i;
        break;
      }
    }
  } else {
    for (let i = 0; i < cleanPrefix.length; i += 1) {
      const quantityMatch = /^(\d+)\s*[xX]\s+(.+)$/.exec(cleanPrefix[i]);
      if (quantityMatch) {
        nameLine = quantityMatch[2];
        itemIdx = i;
        break;
      }
    }
  }
  return { itemLine: nameLine, itemIdx };
}

/**
 * The seller and rating of a home-page card, scanned backwards from the item line.
 * @returns {{seller: string|null, rating: string|null}}
 */
function homeSeller(cleanPrefix, itemIdx) {
  let seller = null;
  let rating = null;
  for (let i = itemIdx - 1; i >= 0; i -= 1) {
    const entry = cleanPrefix[i];
    if (entry.startsWith("(") && entry.endsWith(")")) {
      rating = entry;
      seller = i > 0 ? cleanPrefix[i - 1] : null;
      break;
    }
  }
  return { seller, rating };
}

// Card lines that are item stats, not environment tags (mirrors `STAT_TERMS` in parsing.py).
const CARD_STAT_TERMS = ["better chance", "all skills", "to life", "to mana", "damage reduced", "required level"];

/**
 * The stat lines of a card: its defense line when it has one, then the middle lines that are item stats.
 * @returns {string[]}
 */
function cardStats(midLines, defense) {
  const stats = [];
  if (defense !== null) stats.push(`${defense} Defense`);
  for (const entry of midLines) {
    const low = entry.toLowerCase();
    if (CARD_STAT_TERMS.some((term) => low.includes(term))) {
      stats.push(entry);
    }
  }
  return stats;
}

/**
 * What a listing asks for (its text and its High Rune Value line, when it has one).
 * @returns {{ask: string, highRuneValue: string|null}}
 */
function askFields(cleanPrefix, tradeIdx, card) {
  const askLines = tradeIdx !== -1 ? cleanPrefix.slice(tradeIdx, -1) : [];
  let highRuneValue = null;
  const cleanedAsk = [];
  for (const entry of askLines) {
    if (entry.startsWith("High Rune Value:")) highRuneValue = entry;
    // Only "Trading For" is dropped here: it is the separator itself, while "Make an Offer" is the ask of an
    // offer-only listing and must survive into the text below. Not the marker set, so it stays a literal.
    else if (entry !== "Trading For") cleanedAsk.push(entry);
  }
  let ask = pyStrip(cleanedAsk.join(" "));
  if (!ask) ask = card.includes("Make an Offer") ? "Make an Offer" : "Unknown";
  return { ask, highRuneValue };
}

/**
 * affixes: midLines excluding env/tag/quality words
 * @returns {string[]}
 */
function cardAffixes(midLines) {
  const affixes = [];
  for (const entry of midLines) {
    const cleaned = pyStrip(entry.replace(/•+$/u, ""));
    const low = cleaned.toLowerCase();
    if (low && !CARD_ENV_TAGS.has(low)) {
      affixes.push(cleaned);
    }
  }
  return affixes;
}

/**
 * Parse one card's raw lines into ListingCard keyword fields, or null when this card is not a listing.
 * @param {string[]} card - Raw lines of one card (ending with a time line)
 * @param {string} itemName - Item name
 * @returns {object|null}
 */
function cardData(card, itemName) {
  const itemLower = itemName ? itemName.toLowerCase() : null;
  const cleanPrefix = card.filter((entry) => !LISTING_NOISE_LINES.has(entry.toLowerCase()));
  if (!cleanPrefix.length) return null;

  const postedTime = card[card.length - 1];

  const { itemLine: nameLine, itemIdx } = itemLine(cleanPrefix, itemName, itemLower);

  // Find seller and rating — for null itemNames, scan backwards from the item for the rating
  let seller;
  let rating = null;
  if (itemLower === null && itemIdx !== -1) {
    ({ seller, rating } = homeSeller(cleanPrefix, itemIdx));
    if (!seller || rating === null) return null;
  } else {
    seller = cleanPrefix[0];
    if (cleanPrefix.length > 1 && cleanPrefix[1].startsWith("(") && cleanPrefix[1].endsWith(")")) {
      rating = cleanPrefix[1];
    }
  }

  let tradeIdx = -1;
  for (let i = 0; i < cleanPrefix.length; i += 1) {
    if (TRADING_MARKERS.includes(cleanPrefix[i])) {
      tradeIdx = i;
      break;
    }
  }
  const midLines = itemIdx !== -1 && tradeIdx !== -1 ? cleanPrefix.slice(itemIdx + 1, tradeIdx) : [];
  const midText = midLines.join(" ");
  const midLower = midText.toLowerCase();

  const platform = cardPlatform(midLower);
  const { mode, ladder, gameVersion } = envLabels(midLower);

  const isEthereal = midLower.includes("ethereal");
  const isUnidentified = midLower.includes("unidentified");

  const defenseMatch = /(\+?\d+)\s*Defense/iu.exec(midText);
  const defense = defenseMatch ? parseInt(defenseMatch[1].replace(/^\++/, ""), 10) : null;

  const stats = cardStats(midLines, defense);
  const { ask, highRuneValue } = askFields(cleanPrefix, tradeIdx, card);
  const affixes = cardAffixes(midLines);

  return {
    listing_id: null,
    seller,
    rating,
    posted_time: postedTime,
    item_name: nameLine,
    platform,
    mode,
    ladder,
    game_version: gameVersion,
    affixes,
    is_ethereal: isEthereal,
    is_unidentified: isUnidentified,
    defense,
    stats,
    ask,
    high_rune_value: highRuneValue,
  };
}

export function parseTradingTxt(text, { itemName = "Harlequin Crest" } = {}) {
  if (!text) return [];

  const lines = splitLines(text)
    .map((line) => pyStrip(line))
    .filter((line) => line)
    .map((line) => line.replaceAll("\xa0", " "));

  let start = 0;
  lines.forEach((line, i) => {
    if (line.includes("Apply this search for all")) start = i + 1;
  });

  let end = lines.length;
  for (let i = start; i < lines.length; i += 1) {
    if (lines[i].includes("Log in to Load More") || lines[i].startsWith("HELP")) {
      end = i;
      break;
    }
  }

  const cardsRaw = [];
  let current = [];
  for (const line of lines.slice(start, end)) {
    current.push(line);
    if (TIME_REGEX.test(line)) {
      cardsRaw.push(current);
      current = [];
    }
  }

  const listings = [];
  for (const card of cardsRaw) {
    const listing = cardData(card, itemName);
    if (listing) listings.push(listing);
  }
  return listings;
}

/** One wanted-tag line, cleaned; null for the environment words and the "Additional Item(s)" filler. */
function answerToken(line) {
  const content = pyStrip(line.replace(/•+$/u, ""));
  if (!content || RECENT_ENV_TAGS.has(content.toLowerCase()) || content === "Additional Item(s)") return null;
  return content;
}

function trade(buyerOrSeller, price, tradeTime) {
  return { buyer_or_seller: buyerOrSeller, price, trade_time: tradeTime, item_name: null, specs: null, platform: null, mode: null, ladder: null, game_version: null };
}

/** The wanted tags joined into one price; an "OR" line joins the tags on either side of it. */
function orPrice(received) {
  const parts = [];
  for (const entry of received) {
    if (entry === "OR") {
      if (parts.length) parts[parts.length - 1] += " OR ";
      continue;
    }
    if (parts.length && parts[parts.length - 1].endsWith(" OR ")) parts[parts.length - 1] += entry;
    else parts.push(entry);
  }
  return parts.length ? parts.join(", ") : "Unknown";
}

/**
 * Platform, mode, ladder and game version read from a trade's raw env lines (between the item line and "I Give").
 * Recent Trades reads platform as a whole token (PC) and then Switch, Playstation, Xbox: its own rule, not a card's.
 * @returns {{platform: string|null, mode: string|null, ladder: string|null, gameVersion: string|null}}
 */
function tradeEnv(rawEnvLines) {
  let platform = null;
  for (const raw of rawEnvLines) {
    const rawLow = raw.toLowerCase();
    const tokens = rawLow.split("•").map((t) => t.trim());
    if (tokens.includes("pc")) { platform = "PC"; break; }
    if (rawLow.includes("nintendo switch")) { platform = "Switch"; break; }
    if (rawLow.includes("playstation")) { platform = "Playstation"; break; }
    if (rawLow.includes("xbox")) { platform = "Xbox"; break; }
  }
  let mode = null;
  let ladder = null;
  let gameVersion = null;
  for (const raw of rawEnvLines) {
    const labels = envLabels(raw.toLowerCase());
    if (labels.mode) mode = labels.mode;
    if (labels.ladder) ladder = labels.ladder;
    if (labels.gameVersion) gameVersion = labels.gameVersion;
  }
  return { platform, mode, ladder, gameVersion };
}

/**
 * Read the "They Give" block that starts at `start` (the index of its "They Give" line).
 * @returns {{record: object|null, next: number}} the trade record, or null when the block is not a finished
 *   trade, and the line index the scan continues from.
 */
function tradeBlock(lines, start) {
  let stage = "gave";
  const gave = [];
  const received = [];
  const rawEnvLines = [];
  let tradeTime = "";
  let j = start + 1;
  while (j < lines.length && lines[j].toLowerCase() !== "they give") {
    const line = lines[j];
    const low = line.toLowerCase();
    if (low === "i give") {
      stage = "received";
    } else if (TRADE_TIME_RE.test(line)) {
      tradeTime = line;
      break;
    } else if (low.startsWith("high rune value")) {
      // skipped
    } else if (stage === "gave") {
      rawEnvLines.push(line);
      const cleaned = answerToken(line);
      if (cleaned) gave.push(cleaned);
    } else {
      const cleaned = answerToken(line);
      if (cleaned) received.push(cleaned);
    }
    j += 1;
  }

  const { platform, mode, ladder, gameVersion } = tradeEnv(rawEnvLines);

  if (!tradeTime || !(gave.length || received.length)) return { record: null, next: start + 1 };
  const item = gave.length ? gave.join(", ") : "Unknown";
  const record = trade(item, orPrice(received), tradeTime);
  record.platform = platform;
  record.mode = mode;
  record.ladder = ladder;
  record.game_version = gameVersion;
  return { record, next: j + 1 };
}

/** Fallback for a view without "They Give" blocks: one record per "Sold For"/"Traded For"/"Closed For" line. */
function markerTrades(lines) {
  const markers = ["sold for", "traded for", "closed for"];
  const trades = [];
  lines.forEach((line, idx) => {
    if (markers.includes(line.toLowerCase())) {
      trades.push(
        trade(
          idx > 0 ? lines[idx - 1] : "Unknown",
          idx + 1 < lines.length ? lines[idx + 1] : "",
          idx + 2 < lines.length ? lines[idx + 2] : "",
        ),
      );
    }
  });
  return trades;
}

export function parseRecentTrades(textContent, observeJson = null) {
  const text = (textContent || "") + " " + (observeJson ? (observeJson.text ?? "") : "");
  const url =
    (observeJson ? observeJson.url : "") || `${TRADERIE_D2R_URL}/product/harlequin-crest/recent`;
  const textLower = text.toLowerCase();

  if (textLower.includes(SIGN_IN_PROMPT.toLowerCase()) || textLower.includes("please sign in")) {
    return {
      mode: "B",
      blocked: true,
      reason: "需要登入 (Please sign in to view offers)",
      trades: [],
      direct_url: url,
      notice: "Traderie 成交紀錄頁面需要登入帳號方可查看。",
      code: "login_required",
    };
  }

  const trades = [];
  const lines = splitLines(text)
    .map((entry) => pyStrip(entry))
    .filter((entry) => entry);

  let i = 0;
  while (i < lines.length) {
    if (lines[i].toLowerCase() === "they give") {
      const { record, next } = tradeBlock(lines, i);
      if (record) trades.push(record);
      i = next;
      continue;
    }
    i += 1;
  }

  if (!trades.length) trades.push(...markerTrades(lines));

  if (!trades.length && (textLower.includes("sign in") || textLower.includes("login"))) {
    return {
      mode: "B",
      blocked: true,
      reason: "未偵測到成交數據或需要登入",
      trades: [],
      direct_url: url,
      code: "login_required",
    };
  }

  return {
    mode: trades.length ? "A" : "B",
    blocked: !trades.length,
    reason: trades.length ? null : "無成交紀錄",
    trades,
    direct_url: url,
    code: null,
  };
}
