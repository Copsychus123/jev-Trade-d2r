// CSV export helpers (ES module, no DOM access so node can test it).

// Spreadsheet programs run cells that start with one of these as a formula; page text is untrusted.
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value) {
  let text = value === null || value === undefined ? "" : String(value);
  if (FORMULA_START.test(text)) text = "'" + text;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// The BOM makes Excel read the file as UTF-8; rows are joined with CRLF as RFC 4180 asks.
export function toCsv(head, rows) {
  return "\uFEFF" + [head, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export function csvFileName(item, label) {
  const safe = String(item || "").replace(/[^A-Za-z0-9 _-]/g, "_").trim() || "item";
  return `traderie-${safe}-${label}.csv`;
}
