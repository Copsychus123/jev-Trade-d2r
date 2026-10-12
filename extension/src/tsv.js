// Tab-separated text for pasting into a spreadsheet. No DOM or chrome.* here: it is also tested under node.

import { formulaSafe } from "./csv.js";

/** One cell: tabs and line breaks would split it across columns/rows, and a leading = + - @ would run as a formula. */
export function tsvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return formulaSafe(text.replace(/[\t\r\n]+/g, " ").trim());
}

export function toTsv(head, rows) {
  return [head, ...rows].map((row) => row.map(tsvCell).join("\t")).join("\n") + "\n";
}
