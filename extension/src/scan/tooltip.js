// Pure tooltip detector for the gear scanner: no DOM, no timers, node-testable.
//
// A D2R item tooltip is a dark panel with light text sitting somewhere on the game picture. Frames reach this module
// as RGBA images `{ width, height, data }`; the caller first shrinks them to DETECT_WIDTH, then asks
// findTooltip() where the panel is. The tests do that with downscale() below (the reference implementation); the
// shipped caller (scan-panel.js) downscales with an OffscreenCanvas.drawImage instead.
//
// Why not just "the longest run of dark-or-bright pixels in a row": the pixels along a glyph or a panel edge are
// antialiased mid-grey, so a row through a text line is chopped into short pieces (measured on the four screenshots
// in scripts/data: rows in the panel give runs of 12..37 px against MIN_RUN * 480 = 48). Two things fix that:
//   * the panel is the only thing in the frame with DARK pixels (the sim's background noise has none at all), so rows
//     with a few dark pixels are the seed;
//   * inside a seeded band, a row or a column belongs to the panel when it is mostly "inside" (dark or bright) -- a
//     window at MIN_DENSITY, not a run, so the antialiasing no longer breaks anything. After downscaling, the sim's
//     background is only about a third inside, so a density window cannot grow into it.

export const DETECT_WIDTH = 480; // frames are shrunk to this width before detection
const DARK_MAX = 45; // max(r,g,b) <= DARK_MAX: tooltip background
const BRIGHT_MIN = 120; // max(r,g,b) >= BRIGHT_MIN: tooltip text
const MIN_RUN = 0.1; // a panel is at least MIN_RUN * width wide (and a band at least MIN_HEIGHT * height tall)
const MIN_HEIGHT = 0.06;
const MIN_DENSITY = 0.42; // a row/column belongs to the panel when it is at least this often inside
const DARK_RATIO = 0.45; // inside the box: dark pixels >= 45 % of it
const BRIGHT_RANGE = [0.02, 0.35]; // inside the box: bright pixels between 2 % and 35 %
const ROW_DARK = 0.005; // a row seeds a band when it holds this much dark (fraction of the width)
const BAND_GAP = 0.04; // a band may bridge this much of the height with no dark rows at all
const REFINE_ROUNDS = 2; // how often the row extent and the column extent are re-fit to each other
const KEY_EXPAND = 0.2; // boxKey searches this much around the box for the panel's own dark structure
const KEY_ASPECT = 1; // boxKey reads the panel's top, at most this many widths tall (see boxKey)
const KEY_INSET = 0.02; // boxKey samples the region inset by this much a side (the very edge stays out)
const KEY_GRID = 8; // boxKey: KEY_GRID x KEY_GRID cells
const KEY_LEVELS = 6; // boxKey: a cell's mean grey is quantised into this many grey levels

/** Box-average downscale of an RGBA image to `width`; the height follows proportionally. */
export function downscale(img, width) {
  const sw = img.width;
  const sh = img.height;
  if (!(width < sw)) return img;
  const tw = Math.max(1, Math.round(width));
  const th = Math.max(1, Math.round((sh * tw) / sw));
  const src = img.data;
  const out = Array.isArray(src) ? new Array(tw * th * 4).fill(0) : new src.constructor(tw * th * 4);
  for (let y = 0; y < th; y++) {
    const sy0 = Math.floor((y * sh) / th);
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * sh) / th));
    for (let x = 0; x < tw; x++) {
      const sx0 = Math.floor((x * sw) / tw);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * sw) / tw));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let yy = sy0; yy < sy1 && yy < sh; yy++) {
        let i = (yy * sw + sx0) * 4;
        for (let xx = sx0; xx < sx1 && xx < sw; xx++, i += 4) {
          r += src[i];
          g += src[i + 1];
          b += src[i + 2];
          a += src[i + 3];
          n += 1;
        }
      }
      const o = (y * tw + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return { width: tw, height: th, data: out };
}

function maxChannel(data, i) {
  const r = data[i];
  const g = data[i + 1];
  const b = data[i + 2];
  return Math.max(r, g, b);
}

// The longest stretch [start, end] of 0..n-1 where `ok` holds, or null.
function longestRun(n, ok) {
  let best = null;
  let start = 0;
  let run = 0;
  for (let i = 0; i <= n; i++) {
    if (i < n && ok(i)) {
      if (run === 0) start = i;
      run += 1;
      if (!best || run > best[2]) best = [start, i, run];
    } else {
      run = 0;
    }
  }
  return best;
}

function ratios(img, box) {
  const { width, data } = img;
  let dark = 0;
  let bright = 0;
  let total = 0;
  const x1 = Math.min(box.x + box.width, width);
  const y1 = Math.min(box.y + box.height, img.height);
  for (let y = box.y; y < y1; y++) {
    for (let x = box.x; x < x1; x++) {
      const m = maxChannel(data, (y * width + x) * 4);
      if (m <= DARK_MAX) dark += 1;
      else if (m >= BRIGHT_MIN) bright += 1;
      total += 1;
    }
  }
  return total ? { dark: dark / total, bright: bright / total } : { dark: 0, bright: 0 };
}

/** One pass over the frame: which pixels are inside (dark or bright), and how much dark each row holds. */
function insideMask(img) {
  const { width, height, data } = img;
  const inside = new Uint8Array(width * height);
  const rowDark = new Int32Array(height);
  for (let y = 0; y < height; y++) {
    let dark = 0;
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const m = maxChannel(data, i * 4);
      if (m <= DARK_MAX) {
        inside[i] = 1;
        dark += 1;
      } else if (m >= BRIGHT_MIN) {
        inside[i] = 1;
      }
    }
    rowDark[y] = dark;
  }
  return { inside, rowDark };
}

/** Rows that hold dark pixels can only be tooltip rows: the game background around the panel does not. */
function darkRowBands(rowDark, width, height) {
  const bandGap = Math.max(1, Math.round(BAND_GAP * height));
  const seedDark = ROW_DARK * width; // a row this dark (a fraction of the width) can only be a tooltip row
  const seeds = [];
  let band = null;
  let gapRun = 0;
  for (let y = 0; y < height; y++) {
    if (rowDark[y] >= seedDark) {
      if (band && gapRun > bandGap) {
        seeds.push(band);
        band = null;
      }
      gapRun = 0;
      if (band) band.y1 = y;
      else band = { y0: y, y1: y };
    } else if (band) {
      gapRun += 1;
    }
  }
  if (band) seeds.push(band);
  return seeds;
}

/** A row or column of `span` pixels is the panel's own when at least MIN_DENSITY of it is "inside" (dark or bright). */
function isDense(insideCount, span) {
  return insideCount >= MIN_DENSITY * span;
}

/** The columns of a stretch of rows: the longest stretch of columns that are "inside" often enough. */
function panelColumns(inside, width, y0, y1) {
  const rows = y1 - y0 + 1;
  const support = new Int32Array(width);
  for (let y = y0; y <= y1; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) if (inside[row + x]) support[x] += 1;
  }
  const run = longestRun(width, (x) => isDense(support[x], rows));
  return run && run[2] >= MIN_RUN * width ? { x: run[0], width: run[2] } : null;
}

/** A row belongs to a panel of this column `span` when it is at least MIN_DENSITY "inside" across it. */
function denseRow(inside, width, y, span) {
  let n = 0;
  for (let x = span.x; x < span.x + span.width; x++) if (inside[y * width + x]) n += 1;
  return isDense(n, span.width);
}

/** Does the box hold a tooltip's mix: dark enough, with a little (2..35 %) bright text in it? */
function looksLikePanel(img, box) {
  const { dark, bright } = ratios(img, box);
  return dark >= DARK_RATIO && bright >= BRIGHT_RANGE[0] && bright <= BRIGHT_RANGE[1];
}

/**
 * The panel one seed band grows into, or null when it is not a tooltip: rows as dense as the panel are added, the
 * loose rows of the seed itself are dropped, and the columns are measured again every round until nothing moves.
 */
function panelFromSeed(seed, img, inside, minHeight) {
  const { width, height } = img;
  let span = panelColumns(inside, width, seed.y0, seed.y1);
  if (!span) return null;
  let top = seed.y0;
  let bottom = seed.y1;
  for (let round = 0; round < REFINE_ROUNDS; round++) {
    const dense = (y) => denseRow(inside, width, y, span);
    // Grow over the rows that are as dense as the panel, then drop the loose rows the seed itself ends with.
    while (top > 0 && dense(top - 1)) top -= 1;
    while (bottom < height - 1 && dense(bottom + 1)) bottom += 1;
    while (top <= bottom && !dense(top)) top += 1;
    while (bottom >= top && !dense(bottom)) bottom -= 1;
    if (top > bottom) break;
    const next = panelColumns(inside, width, top, bottom);
    if (!next) break;
    if (next.x === span.x && next.width === span.width) break;
    span = next;
  }
  if (top > bottom) return null;
  const box = { x: span.x, y: top, width: span.width, height: bottom - top + 1 };
  if (box.height < minHeight || !looksLikePanel(img, box)) return null;
  return box;
}

/** The tooltip box in `img` pixels { x, y, width, height }, or null. */
export function findTooltip(img) {
  const minHeight = MIN_HEIGHT * img.height;
  const { inside, rowDark } = insideMask(img);
  const seeds = darkRowBands(rowDark, img.width, img.height);
  let best = null;
  for (const seed of seeds) {
    const box = panelFromSeed(seed, img, inside, minHeight);
    if (box && (!best || box.width * box.height > best.width * best.height)) best = box;
  }
  return best;
}

/** The bounding box of the DARK pixels in the rectangle [x0,x1) x [y0,y1); maxX stays < 0 when there are none. */
function darkBounds(img, x0, y0, x1, y1) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  const ix0 = Math.max(0, Math.min(img.width, Math.round(x0)));
  const iy0 = Math.max(0, Math.min(img.height, Math.round(y0)));
  const ix1 = Math.max(ix0, Math.min(img.width, Math.round(x1)));
  const iy1 = Math.max(iy0, Math.min(img.height, Math.round(y1)));
  for (let y = iy0; y < iy1; y++) {
    for (let x = ix0; x < ix1; x++) {
      if (maxChannel(img.data, (y * img.width + x) * 4) <= DARK_MAX) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { minX, minY, maxX, maxY };
}

/**
 * The panel's own extent: the bbox of the DARK pixels in a window around the detector's box. The panel is the only
 * dark thing near it, so this is the panel's own rectangle. It matters because the detector's box is not stable -- it
 * moves a pixel or two with the backdrop, and more than that after the capture encoder -- and a sampling grid tied
 * to it drifts with it (measured: a 3 px box shift moved 7..15 of 64 cells, a 1 px shift 3..7). Anchored on the dark
 * structure, the same panel gives the same grid wherever the box lands (0 cells for shifts up to 15 px).
 * Falls back to the box itself (rounded to integral pixels) when there is nothing dark there, or only a speck.
 */
function panelRegion(img, box) {
  const rx = Math.round(box.x);
  const ry = Math.round(box.y);
  const rw = Math.round(box.width);
  const rh = Math.round(box.height);
  const ex = Math.round(KEY_EXPAND * rw);
  const ey = Math.round(KEY_EXPAND * rh);
  const { minX, minY, maxX, maxY } = darkBounds(
    img,
    Math.max(0, rx - ex),
    Math.max(0, ry - ey),
    Math.min(img.width, rx + rw + ex),
    Math.min(img.height, ry + rh + ey),
  );
  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  if (maxX < 0 || width < 0.5 * rw || height < 0.5 * rh) return { x: rx, y: ry, width: rw, height: rh };
  return { x: minX, y: minY, width, height };
}

/** Mean grey (0..255) of the rectangle [x0,x1) x [y0,y1) of `img`, clipped to the picture; 0 when it holds no pixel. */
function cellMean(img, x0, x1, y0, y1) {
  const { width, height, data } = img;
  const ix0 = Math.max(0, Math.min(width, Math.round(x0)));
  const ix1 = Math.max(ix0, Math.min(width, Math.round(x1)));
  const iy0 = Math.max(0, Math.min(height, Math.round(y0)));
  const iy1 = Math.max(iy0, Math.min(height, Math.round(y1)));
  let sum = 0;
  let n = 0;
  for (let y = iy0; y < iy1; y++) {
    let p = (y * width + ix0) * 4;
    for (let x = ix0; x < ix1; x++, p += 4) {
      sum += (data[p] + data[p + 1] + data[p + 2]) / 3;
      n += 1;
    }
  }
  return n ? sum / n : 0;
}

/** The mean grey of each cell of an `n`×`n` grid over [x0,x0+w) x [y0,y0+h), row-major. */
function gridCells(img, x0, y0, w, h, n) {
  const rx0 = Math.round(x0);
  const ry0 = Math.round(y0);
  const rw = Math.round(w);
  const rh = Math.round(h);
  const cells = [];
  for (let j = 0; j < n; j++) {
    const cy0 = ry0 + Math.floor((j * rh) / n);
    const cy1 = ry0 + Math.floor(((j + 1) * rh) / n);
    for (let i = 0; i < n; i++) {
      const cx0 = rx0 + Math.floor((i * rw) / n);
      const cx1 = rx0 + Math.floor(((i + 1) * rw) / n);
      cells.push(cellMean(img, cx0, cx1, cy0, cy1));
    }
  }
  return cells;
}

/** The region a content key samples: the panel's top square (KEY_ASPECT of its width), inset by KEY_INSET a side. */
function sampleRegion(region) {
  const rx = Math.round(region.x);
  const ry = Math.round(region.y);
  const rw = Math.round(region.width);
  const rh = Math.round(region.height);
  const height = Math.max(1, Math.min(rh, Math.round(KEY_ASPECT * rw)));
  const insetX = Math.round(KEY_INSET * rw);
  const insetY = Math.round(KEY_INSET * height);
  return {
    x: rx + insetX,
    y: ry + insetY,
    width: Math.max(1, rw - 2 * insetX),
    height: Math.max(1, height - 2 * insetY),
  };
}

/** Mean grey (0..255) quantised into one of KEY_LEVELS levels: the digit a boxKey cell contributes. */
function greyLevel(grey) {
  return Math.min(KEY_LEVELS - 1, Math.floor(grey / (256 / KEY_LEVELS)));
}

/**
 * A content key for the panel `box` points at: KEY_GRID x KEY_GRID mean-grey cells over the panel's own top region,
 * each cell's mean quantised into KEY_LEVELS grey levels. Three things make it survive what the scanner actually sees:
 *
 * - the region is the panel's content (panelRegion), not the detector's box, so the box may drift;
 * - the region is anchored at the panel's top and its height is capped at KEY_ASPECT (1) of its width -- the item's
 *   header and first lines, which every appearance of that panel shows. A panel that runs past the bottom of the
 *   captured frame (a window smaller than the page, a resolution mismatch) has no bottom to compare, and a grid
 *   stretched over whatever is left of it would not line up: measured on the live frames of the 2026-10-07 run, the
 *   tall panel appeared 207 rows tall once and 159 rows tall the second time (the capture held 576 of the sim's 720
 *   rows), which moved 15 of 64 cells; over the top square it is 2 cells;
 * - the wide grey levels tolerate the encoder's noise: a cell's mean moves a little, its level rarely.
 *
 * Measured across the 35 truth screenshots and diagnostic frames: the same panel differs in 0..4 of the 64 cells
 * across positions and 0..10 under glyph slide/noise (up to 31 with dark neighbour interference), two different
 * panels in 6..47 (median 24..26). 64 digits.
 */
export function boxKey(img, box) {
  const region = panelRegion(img, box);
  const sample = sampleRegion(region);
  let key = "";
  for (const cell of gridCells(img, sample.x, sample.y, sample.width, sample.height, KEY_GRID)) {
    key += greyLevel(cell);
  }
  return key;
}

/** 8×8 mean-grey hash of `box` in `img` as a 64-char "0"/"1" string. */
export function boxHash(img, box) {
  const cells = gridCells(img, box.x, box.y, box.width, box.height, 8);
  // A tooltip panel is far darker than any fixed cut-off, so each cell is compared with the panel's
  // own mean: same crop -> same pattern, a moved line shifts which cells sit above it.
  const mean = cells.reduce((a, b) => a + b, 0) / cells.length;
  return cells.map((cell) => (cell >= mean ? "1" : "0")).join("");
}
