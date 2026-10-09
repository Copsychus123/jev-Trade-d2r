// A "roughly what does this batch of asks cost" summary for the listings an affix search read back.
// The sort key is High Rune Value (HRV), the ordering already settled on for the panel.

const NUMBER_RE = /-?\d+(?:\.\d+)?/;

/**
 * The number a row's High Rune Value carries, or null when it carries none.
 *
 * The value may be a number, a string such as "High Rune Value: 36" or "High Rune Value: 0.06", or null.
 * The first number in the string is the value (the "High Rune Value:" prefix is metadata, so taking the first
 * number of the whole string covers both the prefixed and the bare form). An empty string, null or a string
 * without a number has no value; `0` is a value in its own right.
 * @returns {number|null}
 */
function highRuneValueOf(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const match = value.match(NUMBER_RE);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The High Rune Value field of a row. The parser's output key is `high_rune_value`; `highRuneValue` is accepted too.
 * @returns {unknown}
 */
function rowValue(row) {
  if (row == null) return null;
  return row.highRuneValue ?? row.high_rune_value;
}

/**
 * A summary of the High Rune Values of a batch of listing rows: how many rows carried a price and, over those,
 * the minimum and the quartiles.
 *
 * Quartiles use the "nearest-rank" definition: over the priced values sorted ascending, with n the priced count,
 * q1 is the ceil(0.25*n)-th value, q3 the ceil(0.75*n)-th and the median the ceil(0.5*n)-th (all 1-based).
 * A quartile needs n >= 4 to be meaningful, so q1 and q3 are null below that; the median is null only when
 * nothing is priced.
 *
 * @param {Array<object>} rows listing rows; each row's price is row.highRuneValue (or row.high_rune_value), a
 *   number, a "High Rune Value: N" string, or null.
 * @returns {{count: number, priced: number, unpriced: number, min: number|null, median: number|null,
 *   q1: number|null, q3: number|null, unit: string}} `count` is rows.length; the rows are not modified.
 */
export function priceSummary(rows) {
  const values = [];
  for (const row of rows) {
    const value = highRuneValueOf(rowValue(row));
    if (value !== null) values.push(value);
  }

  const priced = values.length;
  values.sort((a, b) => a - b);
  const at = (rank, n) => values[Math.ceil(rank * n) - 1];

  return {
    count: rows.length,
    priced,
    unpriced: rows.length - priced,
    min: priced ? values[0] : null,
    median: priced ? at(0.5, priced) : null,
    q1: priced >= 4 ? at(0.25, priced) : null,
    q3: priced >= 4 ? at(0.75, priced) : null,
    unit: "HRV",
  };
}
