// Shapes cells and short texts for the side panel. No DOM or chrome.* here: it is also tested under node.
// The two-line rows are built from the SAME cells arrays that CSV and TSV use (`tradingCells`, `recentCells`), found
// by column name, so the screen, the copy button and the CSV file cannot drift apart.

export const isEmpty = (value) => value === null || value === undefined || value === "";
export const dash = (value) => (isEmpty(value) ? "—" : String(value));

/** Which column goes where in a listing row: line 1 is price + seller, line 2 the small grey details. */
export const LISTING_LAYOUT = {
  price: "要價",
  seller: "賣家",
  details: ["刊登時間", "平台 / 模式 / 天梯", "遊戲版本", "高符文價值", "防禦"],
};

/** The same for a recent trade: line 1 is the item and its price, line 2 the time and the environment. */
export const RECENT_LAYOUT = {
  title: "成交物品",
  price: "成交價格",
  details: ["成交時間", "平台 / 模式 / 天梯", "遊戲版本"],
};

function reader(head, cells) {
  return (name) => {
    const index = head.indexOf(name);
    if (index < 0) throw new Error(`沒有「${name}」這一欄`);
    return cells[index];
  };
}

const detailsOf = (at, names) => names.map(at).filter((value) => !isEmpty(value)).map(String);

/** One row per `layout`: every named field dashed, the non-empty details left as a list. */
function shape(head, cells, layout) {
  const at = reader(head, cells);
  const row = {};
  for (const [key, name] of Object.entries(layout)) if (key !== "details") row[key] = dash(at(name));
  row.details = detailsOf(at, layout.details);
  return row;
}

/**
 * `head` is the column names (TRADING_COLUMNS) and `cells` one row of `tradingCells(row)`.
 * Empty price/seller show as "—"; empty details are left out instead of showing "—".
 */
export function listingRow(head, cells) {
  return shape(head, cells, LISTING_LAYOUT);
}

/** `head` is RECENT_COLUMNS and `cells` one row of `recentCells(row)`; same rules as `listingRow`. */
export function recentRow(head, cells) {
  return shape(head, cells, RECENT_LAYOUT);
}

/** The same for a listing of the stats search: the item is line 1 with the price, the seller next to it. */
export const STATS_LAYOUT = { title: "物品", ...LISTING_LAYOUT };

/** `head` is STATS_COLUMNS and `cells` one row of `statsCells(row)`; same rules as `listingRow`. */
export function statsRow(head, cells) {
  return shape(head, cells, STATS_LAYOUT);
}

/** True when the view read rows but the filter keeps none of them. */
export const filteredAway = (view, shown) => view.rows.length > 0 && shown === 0;

/**
 * The one plain line under a tab when its list needs explaining: not read yet, a failure reason, why a read list is
 * empty, or that the filter hides everything. `shown` is how many rows the filter keeps (all rows without a filter).
 * A list that shows rows needs no line, so this returns "".
 */
export function viewNote(view, shown = view.rows.length) {
  if (view.status === "NOT_RUN") return "尚未讀取。";
  if (view.status !== "PASSED") return view.reason || "讀取失敗";
  if (filteredAway(view, shown)) return `篩選後沒有符合的資料（原本讀到 ${view.rows.length} 筆）`;
  return view.rows.length ? "" : (view.reason ?? "");
}

/** The number on a tab: rows read, or "kept/read" while a filter is active. Empty until the view was read. */
export function tabCount(view, shown, active) {
  if (view.status === "NOT_RUN") return "";
  return active ? `${shown}/${view.rows.length}` : String(view.rows.length);
}

/** Below this many kept rows, a filtered list that the site has more of suggests loading more batches. */
const FEW_ROWS = 10;

/**
 * The line shown while a filter is active: what is filtered, how many rows it hides, how many of those the site did
 * not label, and (when little is left and the site has more) the hint to read more batches.
 */
export function filterLine({ description, hidden, unknown, kept, hasMore }) {
  let text = `篩選中：${description}　隱藏 ${hidden} 筆`;
  if (unknown > 0) text += `（其中 ${unknown} 筆網站沒標示）`;
  if (kept < FEW_ROWS && hasMore) text += "　可到首頁調高「多讀幾批」";
  return text;
}
