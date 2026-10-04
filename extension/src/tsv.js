// Tab-separated text for pasting into a spreadsheet. No DOM or chrome.* here: it is also tested under node.

const FORMULA_START = /^[=+\-@\t\r]/;

/** One cell: tabs and line breaks would split it across columns/rows, and a leading = + - @ would run as a formula. */
export function tsvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  const flat = text.replace(/[\t\r\n]+/g, " ").trim();
  return FORMULA_START.test(flat) ? `'${flat}` : flat;
}

export function toTsv(head, rows) {
  return [head, ...rows].map((row) => row.map(tsvCell).join("\t")).join("\n") + "\n";
}
