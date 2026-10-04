// Page arithmetic for the result tables. No DOM or chrome.* here: it is also tested under node.

export const PAGE_SIZE = 10;

export function pageCount(total, size = PAGE_SIZE) {
  return Math.max(1, Math.ceil(total / size));
}

/** Keeps a page number inside 1..pageCount (the rows can shrink when a new run starts). */
export function clampPage(page, total, size = PAGE_SIZE) {
  return Math.min(Math.max(1, Math.trunc(page) || 1), pageCount(total, size));
}

export function pageRows(rows, page, size = PAGE_SIZE) {
  const current = clampPage(page, rows.length, size);
  return rows.slice((current - 1) * size, current * size);
}
