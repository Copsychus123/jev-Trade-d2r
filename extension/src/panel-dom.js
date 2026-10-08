// DOM drawing helpers for the side panel. Page text is untrusted: every value is written with textContent, never
// innerHTML. The data (cells, rows, steps) is worked out elsewhere; nothing here decides what is true.
import { progressSteps, verificationSummary } from "./labels.js";
import { listingRow, recentRow, statsRow } from "./rows.js";
import {
  RECENT_COLUMNS,
  STATS_COLUMNS,
  TRADING_COLUMNS,
  recentCells,
  statsCells,
  tradingCells,
} from "./traderie/controller.js";
import { LAYER_LABELS } from "./traderie/finder.js";

const $ = (id) => document.getElementById(id);

export const clock = (iso) =>
  iso ? new Date(iso).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) : "";

const element = (tag, props = {}) => Object.assign(document.createElement(tag), props);

function drawTwoLine(list, first, second, details) {
  const li = element("li");
  const top = element("div", { className: "line1" });
  top.append(element("strong", { textContent: first }), element("span", { className: "side", textContent: second }));
  li.append(top);
  if (details.length) li.append(element("div", { className: "line2", textContent: details.join(" · ") }));
  list.append(li);
}

/** Two-line rows of the stats search: the item and its price next to the seller, then the small grey details. */
export function drawStatsListings(list, rows) {
  for (const row of rows) {
    const { title, price, seller, details } = statsRow(STATS_COLUMNS, statsCells(row));
    drawTwoLine(list, `${title} ・ ${price}`, seller, details);
  }
}

/** Two-line rows: price and seller, then the small grey details. */
export function drawListings(list, rows) {
  for (const row of rows) {
    // The same cells as CSV and copy, so the three cannot drift.
    const { price, seller, details } = listingRow(TRADING_COLUMNS, tradingCells(row));
    drawTwoLine(list, price, seller, details);
  }
}

/** Two-line rows: the item and its price, then time and environment. */
export function drawRecent(list, rows) {
  for (const row of rows) {
    const { title, price, details } = recentRow(RECENT_COLUMNS, recentCells(row));
    drawTwoLine(list, title, price, details);
  }
}

/** The trust line (checked: how it was found and when) or the expandable list of what did not pass. */
export function drawTrust(market) {
  const summary = verificationSummary(market.verification);
  $("trust").dataset.kind = summary.kind;
  $("trust").dataset.layer = market.lookup?.layer ?? ""; // how the product was found (the end-to-end checks read it)
  const line = $("trust-line");
  line.hidden = summary.kind !== "ok";
  $("trust-more").hidden = summary.kind !== "warn";
  line.textContent =
    summary.kind === "ok"
      ? [`✔ ${summary.headline}`, LAYER_LABELS[market.lookup?.layer], clock(market.verification.observed_at)]
          .filter(Boolean)
          .join(" · ")
      : "";
  $("trust-head").textContent = summary.kind === "warn" ? `⚠ ${summary.headline} ›` : "";
  $("trust-reasons").replaceChildren(...summary.reasons.map((reason) => element("li", { textContent: reason })));
}

const MARKS = { done: "✔", active: "●", pending: "○", failed: "✖" };
const STATE_NAMES = { done: "完成", active: "進行中", pending: "還沒開始", failed: "失敗" };

/** The four steps of a query, and the current status line under them. */
export function drawProgress({ market, phase, running, statusText }) {
  $("steps").replaceChildren(
    ...progressSteps({ market, phase, running }).map((step) => {
      const mark = element("span", { className: "mark", textContent: MARKS[step.state] });
      mark.setAttribute("aria-hidden", "true");
      const li = element("li");
      li.dataset.state = step.state;
      li.append(mark, element("span", { textContent: step.label }), element("span", { className: "sr", textContent: `（${STATE_NAMES[step.state]}）` }));
      if (step.detail) li.append(element("small", { textContent: step.detail }));
      return li;
    }),
  );
  $("progress-status").textContent = statusText;
}
