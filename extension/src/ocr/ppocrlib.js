// 本檔是 extension/src/ocr/ 的 PP-OCRv6 det/cls/rec 管線實作；原始移植與量測見 artifacts/ocr-spike/（git-ignored）。
//
// Ported by hand from the installed reference implementation, reading its source at
//   C:\.ppocr-bench\Lib\site-packages\rapidocr\
//     main.py               (preprocess_img / detect_and_crop / cls_and_rotate /
//                            recognize_txt / build_final_output / filter_by_text_score)
//     ch_ppocr_det/main.py  (TextDetector, get_preprocess, sorted_boxes)
//     ch_ppocr_det/utils.py (DetPreProcess, DBPostProcess)
//     ch_ppocr_cls/main.py  (TextClassifier, resize_norm_img)
//     ch_ppocr_cls/utils.py (ClsPostProcess)
//     ch_ppocr_rec/main.py  (TextRecognizer, resize_norm_img, batch loop)
//     ch_ppocr_rec/utils.py (CTCLabelDecode)
//     utils/process_img.py  (get_rotate_crop_image, apply_vertical_padding, ...)
//     utils/load_image.py   (PIL -> ndarray -> cv2.cvtColor(RGB2BGR))
//     config.yaml           (all thresholds / shapes)
// Reference project: RapidOCR (Apache-2.0), https://github.com/RapidAI/RapidOCR
//
// OpenCV primitives re-implemented here (no OpenCV in the browser):
//   cv2.resize INTER_LINEAR / INTER_CUBIC, cv2.dilate 2x2 anchor (1,1),
//   cv2.findContours RETR_LIST (via connected components + hull, which is
//   equivalent for minAreaRect), cv2.minAreaRect, cv2.boxPoints,
//   cv2.fillPoly, cv2.mean(mask), cv2.getPerspectiveTransform,
//   cv2.warpPerspective(INTER_CUBIC, BORDER_REPLICATE), np.rot90,
//   pyclipper round-offset of a rectangle (== inflate by d on both axes),
//   shapely Polygon area/length.
//
// Config used (rapidocr config.yaml, PP-OCRv6 small det/rec + v2.0 mobile cls):
//   Global: text_score 0.5, min_side_len 30, max_side_len 2000,
//           use_vertical_padding true, min_height 30, width_height_ratio 8
//   Det: limit_side_len 736, limit_type min, mean/std 0.5, thresh 0.3,
//        box_thresh 0.5, max_candidates 1000, unclip_ratio 1.6, use_dilation true,
//        score_mode fast
//   Cls: cls_image_shape [3,48,192], cls_batch_num 6, cls_thresh 0.9, labels 0/180
//   Rec: rec_img_shape [3,48,320], rec_batch_num 6

const CFG = {
  text_score: 0.5,
  min_side_len: 30,
  max_side_len: 2000,
  use_vertical_padding: true,
  min_height: 30,
  width_height_ratio: 8,
  det: {
    limit_side_len: 736,
    large_picture_side: 1500, // over this many pixels a side, a read that asked for it detects on a capped copy
    large_picture_limit: { limit_type: "max", limit_side_len: 736 },
    limit_type: "min",
    mean: 0.5,
    std: 0.5,
    thresh: 0.3,
    box_thresh: 0.5,
    max_candidates: 1000,
    unclip_ratio: 1.6,
    use_dilation: true,
    score_mode: "fast",
    min_size: 3,
  },
  cls: { shape: [3, 48, 192], batch_num: 6, thresh: 0.9, labels: ["0", "180"] },
  rec: { shape: [3, 48, 320], batch_num: 6 },
};

// ---------------------------------------------------------------- basics

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const pyRound = (x) => {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1; // Python round(): half to even
};
const trunc = (x) => (x < 0 ? Math.ceil(x) : Math.floor(x));

// One 3-channel pixel copied unchanged from `si` in `src` to `di` in `out` (replicate, rot90 and rot180 all copy).
const copy3 = (out, di, src, si) => {
  out[di] = src[si];
  out[di + 1] = src[si + 1];
  out[di + 2] = src[si + 2];
};

// PIL np.array -> cv2.cvtColor(RGB2BGR): interleaved BGR bytes.
export function imageDataToBgr(imageData) {
  const { data, width, height } = imageData;
  const out = new Uint8Array(width * height * 3);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    out[j] = data[i + 2];
    out[j + 1] = data[i + 1];
    out[j + 2] = data[i];
  }
  return { data: out, w: width, h: height };
}

// cv2.resize INTER_LINEAR sample table for one axis: for each destination sample, the source index to read and the
// blend fraction toward the next source sample. Clamped to the source bounds (srcLen < 2 -> index 0, fraction 0).
function axisSamples(dstLen, srcLen) {
  const idx = new Int32Array(dstLen);
  const frac = new Float32Array(dstLen);
  const scale = srcLen / dstLen;
  for (let i = 0; i < dstLen; i++) {
    let f = (i + 0.5) * scale - 0.5;
    let j = Math.floor(f);
    f -= j;
    if (srcLen < 2) {
      j = 0;
      f = 0;
    } else if (j < 0) {
      j = 0;
      f = 0;
    } else if (j >= srcLen - 1) {
      j = srcLen - 2;
      f = 1;
    }
    idx[i] = j;
    frac[i] = f;
  }
  return { idx, frac };
}

// cv2.resize(..., INTER_LINEAR) on an 8-bit 3-channel interleaved image.
export function resizeLinear(img, dw, dh) {
  const { data: src, w: sw, h: sh } = img;
  if (dw === sw && dh === sh) return { data: src.slice(), w: dw, h: dh };
  const dst = new Uint8Array(dw * dh * 3);
  const { idx: xs, frac: xf } = axisSamples(dw, sw);
  const { idx: ys, frac: yf } = axisSamples(dh, sh);
  for (let y = 0; y < dh; y++) {
    const iy = ys[y];
    const fy = yf[y];
    const r0 = iy * sw * 3;
    const r1 = (iy + 1) * sw * 3;
    const dr = y * dw * 3;
    for (let x = 0; x < dw; x++) {
      const ix = xs[x];
      const fx = xf[x];
      const c0 = ix * 3;
      const c1 = (ix + 1) * 3;
      const w00 = (1 - fx) * (1 - fy);
      const w01 = fx * (1 - fy);
      const w10 = (1 - fx) * fy;
      const w11 = fx * fy;
      for (let c = 0; c < 3; c++) {
        const v =
          src[r0 + c0 + c] * w00 + src[r0 + c1 + c] * w01 + src[r1 + c0 + c] * w10 + src[r1 + c1 + c] * w11;
        dst[dr + x * 3 + c] = Math.round(v);
      }
    }
  }
  return { data: dst, w: dw, h: dh };
}

// (px/255 - mean) / std, then HWC -> CHW. Returns Float32Array of 1*3*h*w.
function toNormalizedCHW(img, mean, std) {
  const { data, w, h } = img;
  const out = new Float32Array(3 * h * w);
  const n = h * w;
  const inv255 = 1 / 255;
  for (let i = 0; i < n; i++) {
    const b = data[i * 3];
    const g = data[i * 3 + 1];
    const r = data[i * 3 + 2];
    out[i] = (b * inv255 - mean) / std;
    out[n + i] = (g * inv255 - mean) / std;
    out[2 * n + i] = (r * inv255 - mean) / std;
  }
  return out;
}

// One crop as a padded [C, ih, targetW] plane for batching: the crop is resized to its own aspect ratio (capped at
// `targetW`), normalised with mean/std 0.5, and written into a zero-padded plane of the batch's width.
// `classify` caps the width at the model's own input width; `recognize` uses the widest crop of the batch.
function padCrop(crop, ic, ih, targetW) {
  const ratio = crop.w / crop.h;
  const wantW = Math.ceil(ih * ratio);
  const resizedW = wantW > targetW ? targetW : trunc(wantW);
  const rs = resizeLinear(crop, resizedW, ih);
  const chw = toNormalizedCHW({ data: rs.data, w: resizedW, h: ih }, 0.5, 0.5);
  const pad = new Float32Array(ic * ih * targetW);
  const plane = ih * targetW;
  const srcPlane = ih * resizedW;
  for (let ch = 0; ch < ic; ch++) {
    for (let y = 0; y < ih; y++) {
      const from = ch * srcPlane + y * resizedW;
      pad.set(chw.subarray(from, from + resizedW), ch * plane + y * targetW);
    }
  }
  return pad;
}

// ------------------------------------------------------ geometry / minAreaRect

function convexHull(points) {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length <= 2) return pts;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

// cv2.minAreaRect over a point set, expressed as center + axes + half sizes.
function minAreaRect(points) {
  const hull = convexHull(points);
  const n = hull.length;
  let best = null;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = hull[i];
    const [x1, y1] = hull[(i + 1) % n];
    let ex = x1 - x0;
    let ey = y1 - y0;
    const len = Math.hypot(ex, ey);
    if (len === 0) continue;
    ex /= len;
    ey /= len;
    const vx = -ey;
    const vy = ex;
    let minT = Infinity;
    let maxT = -Infinity;
    let minS = Infinity;
    let maxS = -Infinity;
    for (const [px, py] of hull) {
      const t = px * ex + py * ey;
      const s = px * vx + py * vy;
      if (t < minT) minT = t;
      if (t > maxT) maxT = t;
      if (s < minS) minS = s;
      if (s > maxS) maxS = s;
    }
    const w = maxT - minT;
    const h = maxS - minS;
    const area = w * h;
    if (!best || area < best.area) {
      const cx = ((minT + maxT) / 2) * ex + ((minS + maxS) / 2) * vx;
      const cy = ((minT + maxT) / 2) * ey + ((minS + maxS) / 2) * vy;
      best = { area, cx, cy, w, h, ux: ex, uy: ey };
    }
  }
  if (!best) {
    const [x, y] = points[0] || [0, 0];
    best = { area: 0, cx: x, cy: y, w: 0, h: 0, ux: 1, uy: 0 };
  }
  return best;
}

// 4 corners of a rect (center, angle u, sizes w/h) in cyclic order.
function rectCorners(r, w = r.w, h = r.h) {
  const ax = (w / 2) * r.ux;
  const ay = (w / 2) * r.uy;
  const bx = (h / 2) * -r.uy;
  const by = (h / 2) * r.ux;
  return [
    [r.cx - ax - bx, r.cy - ay - by],
    [r.cx + ax - bx, r.cy + ay - by],
    [r.cx + ax + bx, r.cy + ay + by],
    [r.cx - ax + bx, r.cy - ay + by],
  ];
}

// cv2.fillPoly + cv2.mean(bitmap, mask) restricted to the box window.
// Pixel centres inside the quad (even-odd) are counted.
function boxScoreFast(prob, w, h, quad) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of quad) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const xmin = clamp(Math.floor(minX), 0, w - 1);
  const xmax = clamp(Math.ceil(maxX), 0, w - 1);
  const ymin = clamp(Math.floor(minY), 0, h - 1);
  const ymax = clamp(Math.ceil(maxY), 0, h - 1);
  const shifted = quad.map(([x, y]) => [trunc(x - xmin), trunc(y - ymin)]);
  let sum = 0;
  let count = 0;
  for (let yy = ymin; yy <= ymax; yy++) {
    for (let xx = xmin; xx <= xmax; xx++) {
      if (pointInPoly(shifted, xx - xmin + 0.5, yy - ymin + 0.5)) {
        sum += prob[yy * w + xx];
        count++;
      }
    }
  }
  return count ? sum / count : 0;
}

function pointInPoly(poly, x, y) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y) {
      const xc = ((xj - xi) * (y - yi)) / (yj - yi) + xi;
      if (x < xc) inside = !inside;
    }
  }
  return inside;
}

// --------------------------------------------------------- det postprocess

// One depth-first flood of the `want` pixels from `seed`. In `visited`, this component's
// pixels start at `from` and every pixel this flood reaches becomes `to`, so the caller can
// first walk the component (0 -> 1) just to mark it and learn whether it reaches the bitmap
// border, then walk it again (1 -> 2) and collect the points. Two same-label neighbours are
// always one component, so the `from` test never leaks into a neighbouring component; `pts`
// receives an [x, y] per pixel, in the same pop order as the original single-pass flood.
function floodComponent(bin, visited, w, h, want, seed, from, to, pts) {
  const stack = [seed];
  visited[seed] = to;
  let touch = false;
  while (stack.length) {
    const cur = stack.pop();
    const cy = (cur / w) | 0;
    const cx = cur - cy * w;
    if (pts) pts.push([cx, cy]);
    if (cx === 0 || cy === 0 || cx === w - 1 || cy === h - 1) touch = true;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const ni = ny * w + nx;
        if (visited[ni] !== from || bin[ni] !== want) continue;
        visited[ni] = to;
        stack.push(ni);
      }
    }
  }
  return touch;
}

// One component per entry, as {first, pts, touch}: the ascending-index scan already yields them ordered by `first`,
// so nothing re-sorts here (the caller orders the merged list).
// `keep` is given only a component's `touch` flag, so a component the caller discards (the
// border-touching background blob, which is the whole bitmap when the map has no text) is
// flooded once to mark it and learn `touch`, and never allocates an [x, y] pair. The kept
// components are flooded a second time to collect their points. This is a deviation from the
// reference's single ready-made flood: upstream collect every point first and filters after.
// Discarding a blob changes no output either way (its box always scores below `det.box_thresh`);
// it only spares the allocation and one `max_candidates` slot.
function componentsOf(bin, w, h, want, keep = () => true) {
  const visited = new Uint8Array(w * h);
  const out = [];
  for (let idx0 = 0; idx0 < w * h; idx0++) {
    if (visited[idx0] || bin[idx0] !== want) continue;
    const touch = floodComponent(bin, visited, w, h, want, idx0, 0, 1, null);
    if (!keep(touch)) continue;
    const pts = [];
    floodComponent(bin, visited, w, h, want, idx0, 1, 2, pts);
    out.push({ first: idx0, pts, touch });
  }
  return out;
}

function orderPointsClockwise(pts) {
  const xs = pts.slice().sort((a, b) => a[0] - b[0]);
  const left = xs.slice(0, 2).sort((a, b) => a[1] - b[1]);
  const right = xs.slice(2, 4).sort((a, b) => a[1] - b[1]);
  return [left[0], right[0], right[1], left[1]];
}

// cv2.dilate, kernel 2x2, default anchor (1,1); 0/1 values so the uint8 border value 0 is equivalent to "ignore".
function dilate2x2(bin, w, h) {
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = bin[y * w + x];
      if (x > 0 && bin[y * w + x - 1] > m) m = bin[y * w + x - 1];
      if (y > 0 && bin[(y - 1) * w + x] > m) m = bin[(y - 1) * w + x];
      if (x > 0 && y > 0 && bin[(y - 1) * w + x - 1] > m) m = bin[(y - 1) * w + x - 1];
      mask[y * w + x] = m;
    }
  }
  return mask;
}

// One contour as a destination-space quad plus its score, or null when it fails a size/score test:
// get_mini_boxes, box_score_fast, unclip, and the scaling back to the destination image.
function detCandidateBox(contour, prob, mapW, mapH, destW, destH) {
  const cfg = CFG.det;
  const rect0 = minAreaRect(contour.pts);
  if (Math.min(rect0.w, rect0.h) < cfg.min_size) return null;
  const quad0 = rectCorners(rect0);
  // config.yaml sets score_mode: fast -> box_score_fast over the minAreaRect quad
  const score = boxScoreFast(prob, mapW, mapH, quad0);
  if (cfg.box_thresh > score) return null;

  // unclip: pyclipper round offset of a rectangle by d == rect inflated by d
  // on both axes (corners rounded, so minAreaRect == w+2d x h+2d, same centre).
  const area = rect0.w * rect0.h;
  const perim = 2 * (rect0.w + rect0.h);
  const d = (area * cfg.unclip_ratio) / perim;
  const w2 = rect0.w + 2 * d;
  const h2 = rect0.h + 2 * d;
  if (Math.min(w2, h2) < cfg.min_size + 2) return null;

  const quad = rectCorners(rect0, w2, h2).map(([x, y]) => [
    clamp(pyRound((x / mapW) * destW), 0, destW),
    clamp(pyRound((y / mapH) * destH), 0, destH),
  ]);
  return { quad, score };
}

// filter_det_res: round each box back to integer destination pixels and drop the ones too thin to be text.
function filterDetBoxes(boxes, scores, destW, destH) {
  const outBoxes = [];
  const outScores = [];
  for (let i = 0; i < boxes.length; i++) {
    const b = orderPointsClockwise(boxes[i]).map(([x, y]) => [
      clamp(trunc(x), 0, destW - 1),
      clamp(trunc(y), 0, destH - 1),
    ]);
    const rw = Math.hypot(b[0][0] - b[1][0], b[0][1] - b[1][1]);
    const rh = Math.hypot(b[0][0] - b[3][0], b[0][1] - b[3][1]);
    if (rw <= 3 || rh <= 3) continue;
    outBoxes.push(b);
    outScores.push(scores[i]);
  }
  return { boxes: outBoxes, scores: outScores };
}

// DBPostProcess.__call__ / boxes_from_bitmap / get_mini_boxes / unclip / filter_det_res
export function dbPostprocess(prob, mapW, mapH, destW, destH) {
  const cfg = CFG.det;
  const bin = new Uint8Array(mapW * mapH);
  for (let i = 0; i < bin.length; i++) bin[i] = prob[i] > cfg.thresh ? 1 : 0;

  const mask = cfg.use_dilation ? dilate2x2(bin, mapW, mapH) : bin;

  const fg = componentsOf(mask, mapW, mapH, 1);
  const bg = componentsOf(mask, mapW, mapH, 0, (touch) => !touch); // holes, as RETR_LIST yields them
  const contours = fg.concat(bg).sort((a, b) => a.first - b.first);

  const boxes = [];
  const scores = [];
  const maxCand = Math.min(contours.length, cfg.max_candidates);
  for (let i = 0; i < maxCand; i++) {
    const found = detCandidateBox(contours[i], prob, mapW, mapH, destW, destH);
    if (!found) continue;
    boxes.push(found.quad);
    scores.push(found.score);
  }
  return filterDetBoxes(boxes, scores, destW, destH);
}

// TextDetector.sorted_boxes (y bands of 10 px, then x within a band)
const Y_BAND = 10;
export function sortedBoxes(boxes) {
  const order = boxes.map((_, i) => i).sort((a, b) => boxes[a][0][1] - boxes[b][0][1] || a - b);
  const ys = order.map((i) => boxes[i][0][1]);
  const lineIds = [];
  let cur = 0;
  for (let i = 0; i < order.length; i++) {
    if (i > 0 && ys[i] - ys[i - 1] >= Y_BAND) cur++;
    lineIds.push(cur);
  }
  const pairs = order.map((oi, i) => ({ oi, line: lineIds[i], x: boxes[oi][0][0] }));
  pairs.sort((a, b) => a.line - b.line || a.x - b.x);
  return pairs.map((p) => boxes[p.oi]);
}

// ------------------------------------------------------------- crop / warp

function perspectiveTransform(src, dst) {
  // cv2.getPerspectiveTransform: solve the 8x8 system for the homography.
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  for (let c = 0; c < 8; c++) {
    let piv = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    [b[c], b[piv]] = [b[piv], b[c]];
    const d0 = A[c][c] || 1e-12;
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / d0;
      if (f === 0) continue;
      for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const h = b.map((v, i) => v / (A[i][i] || 1e-12));
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

function invert3x3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (det === 0) return m.slice();
  return [
    A / det,
    -(b * i - c * h) / det,
    (b * f - c * e) / det,
    B / det,
    (a * i - c * g) / det,
    -(a * f - c * d) / det,
    C / det,
    -(a * h - b * g) / det,
    (a * e - b * d) / det,
  ];
}

function cubicWeight(x) {
  const a = -0.75;
  const ax = Math.abs(x);
  if (ax <= 1) return ((a + 2) * ax - (a + 3)) * ax * ax + 1;
  if (ax < 2) return ((a * ax - 5 * a) * ax + 8 * a) * ax - 4 * a;
  return 0;
}

// Writes one destination pixel (3 channels at `di`) by inverse-mapping `sx`, `sy` into the source:
// cubic sampling when the source point is near the picture, the nearest border pixel when it is far
// outside (BORDER_REPLICATE).
function warpPixel(out, di, src, sw, sh, sx, sy) {
  if (!(sx > -1 && sy > -1 && sx < sw + 1 && sy < sh + 1)) {
    // far outside: replicate the nearest border pixel
    const cx = clamp(Math.round(sx), 0, sw - 1);
    const cy = clamp(Math.round(sy), 0, sh - 1);
    copy3(out, di, src, (cy * sw + cx) * 3);
    return;
  }
  const ix = Math.floor(sx);
  const iy = Math.floor(sy);
  const fx = sx - ix;
  const fy = sy - iy;
  for (let c = 0; c < 3; c++) {
    let acc = 0;
    for (let m = -1; m <= 2; m++) {
      const wy = cubicWeight(m - fy);
      if (wy === 0) continue;
      const yy = clamp(iy + m, 0, sh - 1);
      for (let n = -1; n <= 2; n++) {
        const wx = cubicWeight(n - fx);
        if (wx === 0) continue;
        const xx = clamp(ix + n, 0, sw - 1);
        acc += wy * wx * src[(yy * sw + xx) * 3 + c];
      }
    }
    out[di + c] = clamp(Math.round(acc), 0, 255);
  }
}

// cv2.getRotateCropImage: warpPerspective INTER_CUBIC + BORDER_REPLICATE, then
// np.rot90 when the crop is at least 1.5x taller than wide.
export function getRotateCropImage(img, points) {
  const { data: src, w: sw, h: sh } = img;
  const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  const cw = trunc(Math.max(dist(points[0], points[1]), dist(points[2], points[3])));
  const ch = trunc(Math.max(dist(points[0], points[3]), dist(points[1], points[2])));
  if (cw <= 0 || ch <= 0) return { data: new Uint8Array(0), w: 0, h: 0 };
  const dstPts = [
    [0, 0],
    [cw, 0],
    [cw, ch],
    [0, ch],
  ];
  const M = invert3x3(perspectiveTransform(points, dstPts));
  const out = new Uint8Array(cw * ch * 3);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const den = M[6] * x + M[7] * y + M[8];
      const sx = (M[0] * x + M[1] * y + M[2]) / den;
      const sy = (M[3] * x + M[4] * y + M[5]) / den;
      warpPixel(out, (y * cw + x) * 3, src, sw, sh, sx, sy);
    }
  }
  const res = { data: out, w: cw, h: ch };
  if (ch / cw >= 1.5) return rotate90(res);
  return res;
}

// np.rot90 (counter-clockwise): (h, w) -> (w, h) with (x, y) -> (y, w - 1 - x).
function rotate90(img) {
  const { data, w, h } = img;
  const out = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = y;
      const ny = w - 1 - x;
      const si = (y * w + x) * 3;
      const di = (ny * h + nx) * 3;
      copy3(out, di, data, si);
    }
  }
  return { data: out, w: h, h: w };
}

function rotate180(img) {
  const { data, w, h } = img;
  const out = new Uint8Array(data.length);
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const j = n - 1 - i;
    copy3(out, i * 3, data, j * 3);
  }
  return { data: out, w, h };
}

// ------------------------------------------------------- global preprocess

// utils/process_img.py: reduce_max_side / increase_min_side / resize_image_within_bounds
const roundTo32 = (v) => pyRound(v / 32) * 32;

// Both sides scaled by `ratio`, rounded to a multiple of 32 (the two bounds branches below).
const roundSize = (h, w, ratio) => ({ rh: roundTo32(trunc(h * ratio)), rw: roundTo32(trunc(w * ratio)) });

// Resize by `ratio`, both sides rounded to a multiple of 32.
function resizedBy(img, ratio) {
  const { rh, rw } = roundSize(img.h, img.w, ratio);
  return resizeLinear(img, rw, rh);
}

// utils/process_img.py resize_image_within_bounds (reduce_max_side then increase_min_side). Upstream also returns the
// two ratios for mapping boxes back to the original image; this port measures in the resized image instead, so only
// the resized image is kept.
function resizeWithinBounds(img, minSide, maxSide) {
  if (Math.max(img.h, img.w) > maxSide) img = resizedBy(img, maxSide / Math.max(img.h, img.w));
  if (Math.min(img.h, img.w) < minSide) img = resizedBy(img, minSide / Math.min(img.h, img.w));
  return img;
}

function applyVerticalPadding(img, widthHeightRatio, minHeight) {
  const { w, h } = img;
  const useLimitRatio = widthHeightRatio === -1 ? false : w / h > widthHeightRatio;
  if (h <= minHeight || useLimitRatio) {
    const newH = Math.max(trunc(w / widthHeightRatio), minHeight) * 2;
    const paddingH = trunc(Math.abs(newH - h) / 2);
    const out = new Uint8Array(w * (h + 2 * paddingH) * 3);
    out.fill(0);
    out.set(img.data, paddingH * w * 3);
    return { img: { data: out, w, h: h + 2 * paddingH }, top: paddingH };
  }
  return { img, top: 0 };
}

/**
 * The detector's input policy for one read: the model's own, unless this read asked to cap it and the picture is a
 * large one. Small pictures (screenshots, a cropped tooltip) are untouched -- they are what the accuracy sets measure.
 */
export function detLimitFor(h, w, capDet) {
  if (!capDet || Math.max(h, w) <= CFG.det.large_picture_side) return null;
  return CFG.det.large_picture_limit;
}

// DetPreProcess.resize: limit_type "min", limit_side_len. `limit` overrides the model's own policy for one read.
export function detInputSize(h, w, limit = CFG.det) {
  const { limit_side_len, limit_type } = limit;
  let ratio = 1;
  if (limit_type === "max") {
    if (Math.max(h, w) > limit_side_len) ratio = limit_side_len / Math.max(h, w);
  } else if (Math.min(h, w) < limit_side_len) {
    ratio = limit_side_len / Math.min(h, w);
  }
  return roundSize(h, w, ratio);
}

// ------------------------------------------------------------- recogniser

export function buildCharacterList(dictText) {
  const chars = String(dictText).replace(/\n$/u, "").split("\n");
  chars.push(" "); // insert_special_char(character_list, " ", len)
  chars.unshift("blank"); // insert_special_char(character_list, "blank", 0)
  return chars;
}

// The highest-scoring column (character class) of one CTC time step, and its probability.
function argmaxColumn(data, off, C) {
  let index = 0;
  let prob = data[off];
  for (let c = 1; c < C; c++) {
    const v = data[off + c];
    if (v > prob) {
      prob = v;
      index = c;
    }
  }
  return { index, prob };
}

// Both the classifier and the recogniser process crops shortest-wide-first.
const sortedByAspect = (crops) =>
  crops.map((_, i) => i).sort((a, b) => crops[a].w / crops[a].h - crops[b].w / crops[b].h);

// The [beg, end) slices a batch loop runs over: `batchNum` crops at a time (cls_batch_num / rec_batch_num).
function* batchRanges(count, batchNum) {
  for (let beg = 0; beg < count; beg += batchNum) yield [beg, Math.min(count, beg + batchNum)];
}

/**
 * The colour of a line's lettering as [r, g, b], or null for an empty crop. D2R prints an item's name in the colour of
 * its quality (unique gold, set green, rare yellow, magic blue), so the matcher uses it as evidence (tone.js).
 * Only the brightest pixels count (the top 5% by their strongest channel, and those within 15% of that level), so the
 * dark tooltip background and the anti-aliased edges do not; only the left 40% of the line counts, because a name
 * stands first and a tag in another colour ("[120ED]") follows it; and red pixels are left out unless they are all
 * there is.
 */
export function inkTone(crop) {
  const { data, w, h } = crop;
  const width = Math.ceil(w * 0.4);
  if (!w || !h) return null;
  const histogram = new Uint32Array(256);
  const strongest = (i) => Math.max(data[i * 3], data[i * 3 + 1], data[i * 3 + 2]);
  for (let y = 0; y < h; y++) for (let x = 0; x < width; x++) histogram[strongest(y * w + x)]++;
  let level = 255;
  for (let seen = 0; level > 0; level--) {
    seen += histogram[level];
    if (seen >= width * h * 0.05) break;
  }
  const floor = level * 0.85;
  const sums = { red: [0, 0, 0, 0], other: [0, 0, 0, 0] }; // r, g, b, count
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * w + x;
      if (strongest(i) < floor) continue;
      const [b, g, r] = [data[i * 3], data[i * 3 + 1], data[i * 3 + 2]];
      const sum = g < r * 0.7 && b < r * 0.7 ? sums.red : sums.other;
      sum[0] += r;
      sum[1] += g;
      sum[2] += b;
      sum[3]++;
    }
  }
  const chosen = sums.other[3] * 4 >= sums.red[3] + sums.other[3] ? sums.other : sums.red;
  return chosen[3] ? chosen.slice(0, 3).map((v) => Math.round(v / chosen[3])) : null;
}

// build_final_output: drop blank texts, then filter_by_text_score. `tone` rides along (see inkTone).
function finalLines(recOut) {
  const lines = [];
  for (const line of recOut) {
    const text = line?.text ?? "";
    if (!text.trim() || line.score < CFG.text_score) continue;
    lines.push({ text, score: line.score, tone: line.tone ?? null });
  }
  return lines;
}

export class OcrPipeline {
  constructor(ort, sessions, characters) {
    this.ort = ort;
    this.sessions = sessions; // {det, cls, rec}
    this.characters = characters;
  }

  async runSession(session, tensor) {
    const name = session.inputNames[0];
    const out = await session.run({ [name]: tensor });
    return out[session.outputNames[0]];
  }
  /** Runs a minimal synthetic inference through det/cls/rec sessions so WebGPU shaders compile before real crops arrive. */
  async warmup() {
    const log = [];
    if (!this.sessions) return log;
    const t0 = performance.now();
    try {
      if (this.sessions.det) {
        const td0 = performance.now();
        try {
          const detTensor = new this.ort.Tensor("float32", new Float32Array(1 * 3 * 736 * 960), [1, 3, 736, 960]);
          await this.runSession(this.sessions.det, detTensor);
          log.push(`det 736x960 ok: ${Math.round(performance.now() - td0)}ms`);
        } catch (e1) {
          log.push(`det 736x960 err: ${e1?.message}`);
          const td1 = performance.now();
          const detTensor = new this.ort.Tensor("float32", new Float32Array(1 * 3 * 64 * 64), [1, 3, 64, 64]);
          await this.runSession(this.sessions.det, detTensor);
          log.push(`det 64x64 ok: ${Math.round(performance.now() - td1)}ms`);
        }
      }
    } catch (e) {
      log.push(`det fatal: ${e?.message}`);
    }
    try {
      if (this.sessions.cls) {
        const tc0 = performance.now();
        const [ic, ih, iw] = CFG.cls.shape;
        const clsTensor = new this.ort.Tensor("float32", new Float32Array(1 * ic * ih * iw), [1, ic, ih, iw]);
        await this.runSession(this.sessions.cls, clsTensor);
        log.push(`cls ok: ${Math.round(performance.now() - tc0)}ms`);
      }
    } catch (e) {
      log.push(`cls err: ${e?.message}`);
    }
    try {
      if (this.sessions.rec) {
        const tr0 = performance.now();
        const [ic, ih, iw] = CFG.rec.shape;
        const recTensor = new this.ort.Tensor("float32", new Float32Array(1 * ic * ih * iw), [1, ic, ih, iw]);
        await this.runSession(this.sessions.rec, recTensor);
        log.push(`rec ok: ${Math.round(performance.now() - tr0)}ms`);
      }
    } catch (e) {
      log.push(`rec err: ${e?.message}`);
    }
    log.push(`total warmup: ${Math.round(performance.now() - t0)}ms`);
    return log;
  }

  // [N, ic, ih, w] float tensor from the batch's padded planes, laid out contiguously.
  batchTensor(batch, ic, ih, w) {
    const flat = new Float32Array(batch.length * ic * ih * w);
    batch.forEach((b, i) => flat.set(b, i * ic * ih * w));
    return new this.ort.Tensor("float32", flat, [batch.length, ic, ih, w]);
  }

  /** Runs the sorted crops at `idx[beg..end)` through `session` as one batch padded to `width`; the planes and output. */
  async runBatch({ session, crops, idx, beg, end, ic, ih, width }) {
    const batch = [];
    for (let i = beg; i < end; i++) batch.push(padCrop(crops[idx[i]], ic, ih, width));
    const preds = await this.runSession(session, this.batchTensor(batch, ic, ih, width));
    return { batch, preds };
  }

  async detect(img, limit = null) {
    const { rh, rw } = detInputSize(img.h, img.w, limit ?? CFG.det);
    const resized = resizeLinear(img, rw, rh);
    const chw = toNormalizedCHW(resized, CFG.det.mean, CFG.det.std);
    const t = new this.ort.Tensor("float32", chw, [1, 3, rh, rw]);
    const out = await this.runSession(this.sessions.det, t);
    const dims = out.dims; // [N, C, H, W]
    const mapH = dims[2];
    const mapW = dims[3];
    const prob = out.data.subarray(0, mapW * mapH);
    const { boxes } = dbPostprocess(prob, mapW, mapH, img.w, img.h);
    return sortedBoxes(boxes);
  }

  async classify(crops) {
    const idx = sortedByAspect(crops);
    const [ic, ih, iw] = CFG.cls.shape;
    const out = crops.slice();
    for (const [beg, end] of batchRanges(idx.length, CFG.cls.batch_num)) {
      const { batch, preds } = await this.runBatch({ session: this.sessions.cls, crops, idx, beg, end, ic, ih, width: iw });
      for (let i = 0; i < batch.length; i++) {
        const a = preds.data[i * 2]; // preds.dims: [N, 2] — the class order is [0, 180]
        const b = preds.data[i * 2 + 1];
        const label = b > a ? CFG.cls.labels[1] : CFG.cls.labels[0];
        const score = b > a ? b : a;
        if (label.includes("180") && score > CFG.cls.thresh) {
          out[idx[beg + i]] = rotate180(crops[idx[beg + i]]);
        }
      }
    }
    return out;
  }

  async recognize(crops) {
    const idx = sortedByAspect(crops);
    const [ic, ih, iwBase] = CFG.rec.shape;
    const results = new Array(crops.length);
    for (const [beg, end] of batchRanges(idx.length, CFG.rec.batch_num)) {
      let maxWhRatio = iwBase / ih;
      for (let i = beg; i < end; i++) {
        const r = crops[idx[i]].w / crops[idx[i]].h;
        if (r > maxWhRatio) maxWhRatio = r;
      }
      const imgW = trunc(ih * maxWhRatio);
      const { batch, preds } = await this.runBatch({ session: this.sessions.rec, crops, idx, beg, end, ic, ih, width: imgW });
      const dims = preds.dims; // [N, T, C]
      const T = dims[1];
      const C = dims[2];
      for (let i = 0; i < batch.length; i++) {
        const { text, score } = this.ctcDecode(preds.data, i, T, C);
        results[idx[beg + i]] = { text, score };
      }
    }
    return results;
  }

  ctcDecode(data, n, T, C) {
    const off = n * T * C;
    const chars = [];
    const probs = [];
    let prev = -1;
    for (let t = 0; t < T; t++) {
      const { index: best, prob: bestP } = argmaxColumn(data, off + t * C, C);
      if (best === prev) continue; // remove_duplicate
      prev = best;
      if (best === 0) continue; // ignored token (ctc blank)
      chars.push(this.characters[best]);
      probs.push(bestP);
    }
    if (!probs.length) return { text: "", score: 0 };
    const mean = probs.reduce((a, b) => a + b, 0) / probs.length;
    return { text: chars.join(""), score: Math.round(mean * 1e5) / 1e5 };
  }

  async recognizeImage(bgr, { nameRegionOnly = false, capDet = false } = {}) {
    const t0 = performance.now();
    let img = resizeWithinBounds(bgr, CFG.min_side_len, CFG.max_side_len);
    let padTop = 0;
    if (CFG.use_vertical_padding) {
      const padded = applyVerticalPadding(img, CFG.width_height_ratio, CFG.min_height);
      img = padded.img;
      padTop = padded.top;
    }
    const tResize = performance.now();
    // A large picture (a phone photo: over 1500 px a side) is detected on a copy capped at the model's own side, so
    // det costs about a sixth of what the full-size picture costs it. The boxes come back in this picture's own
    // coordinates, so the crops the recogniser reads are still cut from the picture, at its own resolution.
    const boxes = await this.detect(img, detLimitFor(img.h, img.w, capDet));
    const tDet = performance.now();
    const allCrops = boxes.map((b) => getRotateCropImage(img, b));

    let crops = allCrops;
    let recOut = [];
    let tCls = tDet;
    let tRec = tDet;

    if (nameRegionOnly) {
      // Progressively classify and recognize line by line until first real stat line
      const STAT_LINE = /[%+:：]|[(（][A-Za-z]/u;
      const isStatLine = (txt) => {
        if (/出售[價价][格錢]/u.test(txt)) return false;
        const untagged = txt.replace(/[[［].*$|【(?=精英|卓越|普通|[A-Za-z0-9]).*$/u, "");
        const mark = untagged.search(STAT_LINE);
        return mark !== -1 && /\d/u.test(untagged.slice(mark));
      };

      recOut = [];
      crops = [];
      for (let i = 0; i < allCrops.length; i++) {
        const [classified] = await this.classify([allCrops[i]]);
        const [recResult] = await this.recognize([classified]);
        if (isStatLine(recResult?.text ?? "")) {
          break;
        }
        crops.push(allCrops[i]);
        recOut.push(recResult);
      }
      tCls = performance.now();
      tRec = tCls;
    } else {
      const clsCrops = await this.classify(crops);
      tCls = performance.now();
      recOut = await this.recognize(clsCrops);
      tRec = performance.now();
    }

    const lines = finalLines(recOut.map((line, i) => ({ ...line, tone: inkTone(crops[i]) })));
    const tTotal = performance.now();
    const stages = {
      resize: Math.round(tResize - t0),
      det: Math.round(tDet - tResize),
      cls: Math.round(tCls - tDet),
      rec: Math.round(tRec - tCls),
      total: Math.round(tTotal - t0),
      nameRegionOnly,
    };
    return {
      lines,
      stages,
      detBoxes: boxes.length,
      crops: crops.length,
      paddedTop: padTop,
      inputSize: [img.w, img.h],
    };
  }
}
