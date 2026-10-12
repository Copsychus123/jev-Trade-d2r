// Page arithmetic for the result tables. No DOM or chrome.* here: it is also tested under node.

export const PAGE_SIZE = 10;

export function pageCount(total) {
  return Math.max(1, Math.ceil(total / PAGE_SIZE));
}

/** Keeps a page number inside 1..pageCount (the rows can shrink when a new run starts). */
export function clampPage(page, total) {
  return Math.min(Math.max(1, Math.trunc(page) || 1), pageCount(total));
}

export function pageRows(rows, page) {
  const current = clampPage(page, rows.length);
  return rows.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
}
