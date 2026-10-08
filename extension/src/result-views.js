// What each result list is made of: its columns, cells, label and how its rows are drawn. The name search has two lists
// (current listings, recent trades); the affix search has one, the home page's listings with their items.
import { drawListings, drawRecent, drawStatsListings } from "./panel-dom.js";
import {
  RECENT_COLUMNS,
  STATS_COLUMNS,
  TRADING_COLUMNS,
  VIEW_LABELS,
  recentCells,
  statsCells,
  tradingCells,
} from "./traderie/controller.js";
import { productRootUrl } from "./traderie/site.js";
import { isHomeUrl } from "./traderie/stats.js";

export const marketViews = {
  trading: {
    prefix: "trading",
    head: TRADING_COLUMNS,
    cells: tradingCells,
    label: VIEW_LABELS.trading,
    draw: drawListings,
  },
  recent_trades: {
    prefix: "recent-trades",
    head: RECENT_COLUMNS,
    cells: recentCells,
    label: VIEW_LABELS.recent_trades,
    draw: drawRecent,
  },
};

const TAB_KEYS = Object.keys(marketViews);

const statsView = {
  prefix: "trading",
  head: STATS_COLUMNS,
  cells: statsCells,
  label: "符合條件的掛單",
  draw: drawStatsListings,
};

/** The list `key` of `market` is shown with: the affix search reuses the "trading" slot for its own list. */
export const viewConfigFor = (market, key) => (key === "trading" && market.mode === "stats" ? statsView : marketViews[key]);

/** The result tabs of `market`: the affix search has no recent-trades list. */
export const tabKeysFor = (market) => (market.mode === "stats" ? ["trading"] : TAB_KEYS);

/** True for an address the "open the site" button can take the player to (a product page or the D2R home page). */
export const openable = (url) => Boolean(productRootUrl(url || "") || isHomeUrl(url || ""));
