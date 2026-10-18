// Pure fallback tooltip clusterer and padder for the gear scanner: no DOM, node-testable.
// Given text boxes detected by PP-OCR det and frame dimensions, clusters text lines into
// a single tooltip panel rectangle and pads it to cover the panel body and borders.

const MIN_RUN = 0.08; // a panel is at least 8% of the frame width
const MIN_LINES = 3;  // at least 3 text lines to form a tooltip cluster

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 !== 0 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Clusters text line boxes into candidate tooltips, picks the best tooltip cluster,
 * and pads/grows it so the resulting box covers the entire panel (including outer borders).
 *
 * @param {Array<{x: number, y: number, width: number, height: number}>} boxes
 * @param {number} frameWidth
 * @param {number} frameHeight
 * @param {{ width: number, height: number, data: Uint8ClampedArray | Uint8Array } | null} img
 * @returns {{ x: number, y: number, width: number, height: number } | null}
 */
export function clusterAndPad(boxes, frameWidth, frameHeight, img = null) {
  if (!boxes || boxes.length === 0) return null;

  // Sort boxes from top to bottom
  const sorted = [...boxes].sort((a, b) => a.y - b.y);

  // Cluster overlapping or vertically adjacent lines (within ~1.5 line heights)
  const groups = []; // [{ x0, y0, x1, y1, count, lineHeights: [] }]
  for (const b of sorted) {
    const bx0 = b.x;
    const by0 = b.y;
    const bx1 = b.x + b.width;
    const by1 = b.y + b.height;
    const bH = b.height;

    let placed = false;
    for (const g of groups) {
      const lh = median(g.lineHeights) || bH;
      const vgap = by0 - g.y1;
      const hov = Math.min(g.x1, bx1) - Math.max(g.x0, bx0);

      // Vertically adjacent within 1.5 line heights, horizontally overlapping or within 2 line heights
      if (vgap <= 1.5 * Math.max(lh, bH) && hov > -Math.max(lh, bH) * 2.0 && by1 >= g.y0 - 0.2 * lh) {
        g.x0 = Math.min(g.x0, bx0);
        g.y0 = Math.min(g.y0, by0);
        g.x1 = Math.max(g.x1, bx1);
        g.y1 = Math.max(g.y1, by1);
        g.count++;
        g.lineHeights.push(bH);
        placed = true;
        break;
      }
    }
    if (!placed) {
      groups.push({
        x0: bx0,
        y0: by0,
        x1: bx1,
        y1: by1,
        count: 1,
        lineHeights: [bH],
      });
    }
  }

  // Filter valid clusters: at least MIN_LINES lines and width >= 5% of frame
  const valid = groups.filter((g) => g.count >= MIN_LINES && g.x1 - g.x0 >= 0.05 * frameWidth);
  if (valid.length === 0) return null;

  // Select the cluster with the highest line count (most tooltip-like)
  const best = valid.reduce((a, b) => (b.count > a.count ? b : a), valid[0]);
  const medLh = median(best.lineHeights) || 12;

  // Pad the text cluster so it covers the panel body and borders
  // (half to full median line height on sides and vertical edges)
  const padX = 1.0 * medLh;
  const padY = 0.8 * medLh;
  let x0 = Math.max(0, best.x0 - padX);
  let y0 = Math.max(0, best.y0 - padY);
  let x1 = Math.min(frameWidth, best.x1 + padX);
  let y1 = Math.min(frameHeight, best.y1 + padY);

  // Optional: if img is provided, grow outward up to 12 px while border pixels are panel-like (dark <= 65 or bright text >= 120)
  if (img && img.data) {
    const { width: W, height: H, data } = img;
    const maxCh = (x, y) => {
      const idx = (y * W + x) * 4;
      return Math.max(data[idx], data[idx + 1], data[idx + 2]);
    };

    for (let step = 0; step < 12; step++) {
      if (x0 > 0) {
        let dark = 0;
        const ix = Math.floor(x0) - 1;
        const total = Math.floor(y1) - Math.floor(y0);
        for (let y = Math.floor(y0); y < Math.floor(y1); y++) {
          const m = maxCh(ix, y);
          if (m <= 65 || m >= 120) dark++;
        }
        if (total > 0 && dark / total >= 0.35) x0 -= 1;
      }
      if (x1 < frameWidth) {
        let dark = 0;
        const ix = Math.floor(x1);
        const total = Math.floor(y1) - Math.floor(y0);
        for (let y = Math.floor(y0); y < Math.floor(y1); y++) {
          const m = maxCh(ix, y);
          if (m <= 65 || m >= 120) dark++;
        }
        if (total > 0 && dark / total >= 0.35) x1 += 1;
      }
      if (y0 > 0) {
        let dark = 0;
        const iy = Math.floor(y0) - 1;
        const total = Math.floor(x1) - Math.floor(x0);
        for (let x = Math.floor(x0); x < Math.floor(x1); x++) {
          const m = maxCh(x, iy);
          if (m <= 65 || m >= 120) dark++;
        }
        if (total > 0 && dark / total >= 0.35) y0 -= 1;
      }
      if (y1 < frameHeight) {
        let dark = 0;
        const iy = Math.floor(y1);
        const total = Math.floor(x1) - Math.floor(x0);
        for (let x = Math.floor(x0); x < Math.floor(x1); x++) {
          const m = maxCh(x, iy);
          if (m <= 65 || m >= 120) dark++;
        }
        if (total > 0 && dark / total >= 0.35) y1 += 1;
      }
    }
  }

  const width = Math.round(x1 - x0);
  const height = Math.round(y1 - y0);

  // Validity checks: minimum width and sensible aspect ratio
  if (width < MIN_RUN * frameWidth) return null;
  if (height < 16) return null;
  const aspect = width / height;
  if (aspect < 0.25 || aspect > 12) return null;

  return {
    x: Math.round(x0),
    y: Math.round(y0),
    width,
    height,
  };
}
