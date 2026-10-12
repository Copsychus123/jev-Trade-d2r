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
      for (let x = 0; x < resizedW; x++) {
        pad[ch * plane + y * targetW + x] = chw[ch * srcPlane + y * resizedW + x];
      }
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

// pid: component labels; returns {points: [[x,y],...]} lists in raster order; the ascending-index
// scan already yields them ordered by `first`, so nothing re-sorts here (the caller orders the merged list).
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
export function sortedBoxes(boxes) {
  const order = boxes.map((_, i) => i).sort((a, b) => boxes[a][0][1] - boxes[b][0][1] || a - b);
  const ys = order.map((i) => boxes[i][0][1]);
  const lineIds = [];
  let cur = 0;
  for (let i = 0; i < order.length; i++) {
    if (i > 0 && ys[i] - ys[i - 1] >= 10) cur++;
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
    out[di] = src[(cy * sw + cx) * 3];
    out[di + 1] = src[(cy * sw + cx) * 3 + 1];
    out[di + 2] = src[(cy * sw + cx) * 3 + 2];
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

// np.rot90 (counter-clockwise): (h, w) -> (w, h) with (x, y) -> (y, h - 1 - x).
function rotate90(img) {
  const { data, w, h } = img;
  const out = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = y;
      const ny = h - 1 - x;
      const si = (y * w + x) * 3;
      const di = (ny * h + nx) * 3;
      out[di] = data[si];
      out[di + 1] = data[si + 1];
      out[di + 2] = data[si + 2];
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
    out[i * 3] = data[j * 3];
    out[i * 3 + 1] = data[j * 3 + 1];
    out[i * 3 + 2] = data[j * 3 + 2];
  }
  return { data: out, w, h };
}

// ------------------------------------------------------- global preprocess

// utils/process_img.py: reduce_max_side / increase_min_side / resize_image_within_bounds
const roundTo32 = (v) => pyRound(v / 32) * 32;

// Resize by `ratio`, rounding both sides to a multiple of 32 (the two bounds branches below).
function resizedBy(img, ratio) {
  const rh = roundTo32(trunc(img.h * ratio));
  const rw = roundTo32(trunc(img.w * ratio));
  return { img: resizeLinear(img, rw, rh), rh, rw };
}

function resizeWithinBounds(img, minSide, maxSide) {
  let { w, h } = img;
  let ratioH = 1;
  let ratioW = 1;
  if (Math.max(h, w) > maxSide) {
    const r = resizedBy(img, maxSide / Math.max(h, w));
    img = r.img;
    ratioH = h / r.rh;
    ratioW = w / r.rw;
    w = r.rw;
    h = r.rh;
  }
  if (Math.min(h, w) < minSide) {
    const r = resizedBy(img, minSide / Math.min(h, w));
    img = r.img;
    ratioH = h / r.rh;
    ratioW = w / r.rw;
  }
  return { img, ratioH, ratioW };
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

// DetPreProcess.resize: limit_type "min", limit_side_len
function detInputSize(h, w) {
  const { limit_side_len, limit_type } = CFG.det;
  let ratio = 1;
  if (limit_type === "max") {
    if (Math.max(h, w) > limit_side_len) ratio = limit_side_len / Math.max(h, w);
  } else {
    if (Math.min(h, w) < limit_side_len) ratio = limit_side_len / Math.min(h, w);
  }
  const rh = roundTo32(trunc(h * ratio));
  const rw = roundTo32(trunc(w * ratio));
  return { rh, rw };
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

// build_final_output: drop blank texts, then filter_by_text_score
function finalLines(recOut) {
  const lines = [];
  for (let i = 0; i < recOut.length; i++) {
    const t = recOut[i]?.text ?? "";
    if (!t.trim()) continue;
    if (recOut[i].score < CFG.text_score) continue;
    lines.push({ text: t, score: recOut[i].score });
  }
  return lines;
}

export class OcrPipeline {
  constructor(ort, sessions, characters, progress) {
    this.ort = ort;
    this.sessions = sessions; // {det, cls, rec}
    this.characters = characters;
    this.progress = progress || (() => {});
  }

  async runSession(session, tensor) {
    const name = session.inputNames[0];
    const out = await session.run({ [name]: tensor });
    return out[session.outputNames[0]];
  }

  // [N, ic, ih, w] float tensor from the batch's padded planes, laid out contiguously.
  batchTensor(batch, ic, ih, w) {
    const flat = new Float32Array(batch.length * ic * ih * w);
    batch.forEach((b, i) => flat.set(b, i * ic * ih * w));
    return new this.ort.Tensor("float32", flat, [batch.length, ic, ih, w]);
  }

  async detect(img) {
    const { rh, rw } = detInputSize(img.h, img.w);
    const resized = resizeLinear(img, rw, rh);
    const chw = toNormalizedCHW(resized, CFG.det.mean, CFG.det.std);
    const t = new this.ort.Tensor("float32", chw, [1, 3, rh, rw]);
    const out = await this.runSession(this.sessions.det, t);
    const dims = out.dims;
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
      const batch = [];
      for (let i = beg; i < end; i++) {
        batch.push(padCrop(crops[idx[i]], ic, ih, iw));
      }
      const t = this.batchTensor(batch, ic, ih, iw);
      const preds = await this.runSession(this.sessions.cls, t);
      const n = batch.length;
      for (let i = 0; i < n; i++) {
        const a = preds.data[i * 2];
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
        const c = crops[idx[i]];
        const r = c.w / c.h;
        if (r > maxWhRatio) maxWhRatio = r;
      }
      const imgW = trunc(ih * maxWhRatio);
      const batch = [];
      for (let i = beg; i < end; i++) {
        batch.push(padCrop(crops[idx[i]], ic, ih, imgW));
      }
      const t = this.batchTensor(batch, ic, ih, imgW);
      const preds = await this.runSession(this.sessions.rec, t);
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

  async recognizeImage(bgr) {
    const tPre = performance.now();
    const pre = resizeWithinBounds(bgr, CFG.min_side_len, CFG.max_side_len);
    let img = pre.img;
    let padTop = 0;
    if (CFG.use_vertical_padding) {
      const padded = applyVerticalPadding(img, CFG.width_height_ratio, CFG.min_height);
      img = padded.img;
      padTop = padded.top;
    }
    const tDet0 = performance.now();
    const boxes = await this.detect(img);
    const tDet1 = performance.now();
    const crops = boxes.map((b) => getRotateCropImage(img, b));
    const tCls0 = performance.now();
    const clsCrops = await this.classify(crops);
    const tCls1 = performance.now();
    const recOut = await this.recognize(clsCrops);
    const tRec1 = performance.now();

    const lines = finalLines(recOut);
    return {
      lines,
      preMs: tDet0 - tPre,
      detMs: tDet1 - tDet0,
      clsMs: tCls1 - tCls0,
      recMs: tRec1 - tCls1,
      detBoxes: boxes.length,
      crops: crops.length,
      paddedTop: padTop,
      inputSize: [img.w, img.h],
      debug: {
        boxes,
        cropSizes: crops.map((c) => [c.w, c.h]),
        recRaw: recOut.map((r) => [r?.text ?? null, r?.score ?? null]),
      },
    };
  }
}
