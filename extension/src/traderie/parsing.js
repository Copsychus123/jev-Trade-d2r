// Port of core/jev_ultrafast/traderie/parsing.py. Output must equal the Python parser exactly.
import { TRADERIE_D2R_URL } from "./site.js";

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

const TIME_REGEX = new RegExp(
  "^(?:(\\d+)\\s*(seconds?|minutes?|hours?|days?|weeks?|months?|years?|s|m|h|d|秒|分鐘|小时|小時|天)s?\\s*(?:ago|前)|" +
    `${ABSOLUTE_DATE})$`,
  "iu",
);

const TRADE_TIME_RE = new RegExp(
  "^(?:\\d+\\s*(?:秒|分鐘|小時|天|週|週|個月|年)前|[a-z ]*\\d+ ?(?:second|minute|hour|day|week|month|year)s? ago|" +
    `${ABSOLUTE_DATE})$`,
  "iu",
);

const ENV_TAGS = new Set([
  "pc", "softcore", "hardcore", "ladder", "non ladder", "xbox", "playstation",
  "nintendo switch", "reign of the warlock", "resurrected",
]);

// Python str.strip() / str.splitlines() whitespace, not JS's.
const PY_WS = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PY_STRIP = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, "gu");
const PY_LINE_BREAK = /\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/u;

const pyStrip = (s) => s.replace(PY_STRIP, "");
const splitLines = (s) => s.split(PY_LINE_BREAK);

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
  const itemLower = itemName.toLowerCase();
  for (const card of cardsRaw) {
    const cleanPrefix = card.filter((entry) => !LISTING_NOISE_LINES.has(entry.toLowerCase()));
    if (!cleanPrefix.length) continue;
    const seller = cleanPrefix[0];
    let rating = null;
    if (cleanPrefix.length > 1 && cleanPrefix[1].startsWith("(") && cleanPrefix[1].endsWith(")")) {
      rating = cleanPrefix[1];
    }

    const postedTime = card[card.length - 1];

    let itemLine = itemName;
    let itemIdx = -1;
    for (let i = 0; i < cleanPrefix.length; i += 1) {
      const low = cleanPrefix[i].toLowerCase();
      if (low.includes(itemLower)) {
        itemLine = cleanPrefix[i];
        itemIdx = i;
        break;
      }
    }

    let tradeIdx = -1;
    for (let i = 0; i < cleanPrefix.length; i += 1) {
      if (cleanPrefix[i] === "Trading For" || cleanPrefix[i] === "Make an Offer") {
        tradeIdx = i;
        break;
      }
    }
    const midLines = itemIdx !== -1 && tradeIdx !== -1 ? cleanPrefix.slice(itemIdx + 1, tradeIdx) : [];
    const midText = midLines.join(" ");
    const midLower = midText.toLowerCase();

    const isPc =
      midLines.some((entry) => entry.toLowerCase().split("•").includes("pc") || pyStrip(entry).toLowerCase() === "pc") ||
      midLower.includes("pc");
    let platform = null;
    if (isPc) platform = "PC";
    else if (midLower.includes("playstation")) platform = "Playstation";
    else if (midLower.includes("xbox")) platform = "Xbox";
    else if (midLower.includes("switch")) platform = "Switch";

    const mode = midLower.includes("hardcore") ? "Hardcore" : midLower.includes("softcore") ? "Softcore" : null;

    const isNonLadder = midLower.includes("non ladder");
    const isLadder = midLower.includes("ladder") && !isNonLadder;
    const ladder = isNonLadder ? "Non Ladder" : isLadder ? "Ladder" : null;

    const gameVersion = midLower.includes("reign of the warlock")
      ? "Reign of the Warlock"
      : midLower.includes("lord of destruction")
        ? "Lord of Destruction"
        : null;

    const isEthereal = midLower.includes("ethereal");
    const isUnidentified = midLower.includes("unidentified");

    const defM = /(\+?\d+)\s*Defense/iu.exec(midText);
    const defense = defM ? parseInt(defM[1].replace(/^\++/, ""), 10) : null;

    const stats = [];
    if (defense !== null) stats.push(`${defense} Defense`);
    for (const entry of midLines) {
      const low = entry.toLowerCase();
      if (
        ["better chance", "all skills", "to life", "to mana", "damage reduced", "required level"].some((term) =>
          low.includes(term),
        )
      ) {
        stats.push(entry);
      }
    }

    const askLines = tradeIdx !== -1 ? cleanPrefix.slice(tradeIdx, -1) : [];
    let hrv = null;
    const cleanedAsk = [];
    for (const entry of askLines) {
      if (entry.startsWith("High Rune Value:")) hrv = entry;
      else if (entry !== "Trading For") cleanedAsk.push(entry);
    }
    let ask = pyStrip(cleanedAsk.join(" "));
    if (!ask) ask = card.includes("Make an Offer") ? "Make an Offer" : "Unknown";

    listings.push({
      listing_id: null,
      seller,
      rating,
      posted_time: postedTime,
      item_name: itemLine,
      platform,
      mode,
      ladder,
      game_version: gameVersion,
      is_ethereal: isEthereal,
      is_unidentified: isUnidentified,
      defense,
      stats,
      ask,
      high_rune_value: hrv,
    });
  }
  return listings;
}

function cleanTag(line) {
  const content = pyStrip(line.replace(/•+$/u, ""));
  if (!content || ENV_TAGS.has(content.toLowerCase()) || content === "Additional Item(s)") return null;
  return content;
}

function trade(buyerOrSeller, price, tradeTime) {
  return { buyer_or_seller: buyerOrSeller, price, trade_time: tradeTime, item_name: null, specs: null };
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
    };
  }

  const trades = [];
  const lines = splitLines(text)
    .map((entry) => pyStrip(entry))
    .filter((entry) => entry);

  let i = 0;
  while (i < lines.length) {
    if (lines[i].toLowerCase() === "they give") {
      let stage = "gave";
      const gave = [];
      const received = [];
      let tradeTime = "";
      let j = i + 1;
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
          const cleaned = cleanTag(line);
          if (cleaned) gave.push(cleaned);
        } else {
          const cleaned = cleanTag(line);
          if (cleaned) received.push(cleaned);
        }
        j += 1;
      }
      if (tradeTime && (gave.length || received.length)) {
        const item = gave.length ? gave.join(", ") : "Unknown";
        const parts = [];
        for (const entry of received) {
          if (entry === "OR") {
            if (parts.length) parts[parts.length - 1] += " OR ";
            continue;
          }
          if (parts.length && parts[parts.length - 1].endsWith(" OR ")) parts[parts.length - 1] += entry;
          else parts.push(entry);
        }
        const price = parts.length ? parts.join(", ") : "Unknown";
        trades.push(trade(item, price, tradeTime));
        i = j + 1;
        continue;
      }
      i += 1;
      continue;
    }
    i += 1;
  }

  if (!trades.length) {
    const markers = ["sold for", "traded for", "closed for"];
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
  }

  if (!trades.length && (textLower.includes("sign in") || textLower.includes("login"))) {
    return {
      mode: "B",
      blocked: true,
      reason: "未偵測到成交數據或需要登入",
      trades: [],
      direct_url: url,
    };
  }

  return {
    mode: trades.length ? "A" : "B",
    blocked: !trades.length,
    reason: trades.length ? null : "無成交紀錄",
    trades,
    direct_url: url,
  };
}
