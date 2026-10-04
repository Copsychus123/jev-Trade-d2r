// Image preparation for OCR. Pure functions on { width, height, data } where data is RGBA bytes (an ImageData works).
// Order matters and is fixed: enlarge -> colour enhance -> grey -> invert/threshold -> close gaps in strokes.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function makeImage(width, height, data = new Uint8ClampedArray(width * height * 4)) {
  return { width, height, data };
}

/** Enlarge with nearest neighbour (hard pixel fonts stay sharp) or shrink by averaging the covered pixels. */
export function resize(img, scale) {
  const width = Math.max(1, Math.round(img.width * scale));
  const height = Math.max(1, Math.round(img.height * scale));
  const out = makeImage(width, height);
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.floor((y * img.height) / height);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * img.height) / height));
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.floor((x * img.width) / width);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * img.width) / width));
      const o = (y * width + x) * 4;
      if (scale >= 1) {
        const i = (y0 * img.width + x0) * 4;
        out.data[o] = img.data[i];
        out.data[o + 1] = img.data[i + 1];
        out.data[o + 2] = img.data[i + 2];
        out.data[o + 3] = 255;
        continue;
      }
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy += 1) {
        for (let xx = x0; xx < x1; xx += 1) {
          const i = (yy * img.width + xx) * 4;
          r += img.data[i];
          g += img.data[i + 1];
          b += img.data[i + 2];
          n += 1;
        }
      }
      out.data[o] = r / n;
      out.data[o + 1] = g / n;
      out.data[o + 2] = b / n;
      out.data[o + 3] = 255;
    }
  }
  return out;
}

/** Colour enhance: stretch every channel between its 2nd and 98th percentile so text colours separate from the
 * background, then lift mid tones. Returns a new image. */
export function enhanceColor(img) {
  const out = makeImage(img.width, img.height);
  const lut = [];
  for (let c = 0; c < 3; c += 1) {
    const hist = new Uint32Array(256);
    for (let i = c; i < img.data.length; i += 4) hist[img.data[i]] += 1;
    const total = img.width * img.height;
    let low = 0;
    let high = 255;
    for (let acc = 0, v = 0; v < 256; v += 1) {
      acc += hist[v];
      if (acc >= total * 0.02) {
        low = v;
        break;
      }
    }
    for (let acc = 0, v = 255; v >= 0; v -= 1) {
      acc += hist[v];
      if (acc >= total * 0.02) {
        high = v;
        break;
      }
    }
    if (high <= low) high = low + 1;
    const table = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v += 1) table[v] = 255 * ((clamp((v - low) / (high - low), 0, 1)) ** 0.8);
    lut.push(table);
  }
  for (let i = 0; i < img.data.length; i += 4) {
    out.data[i] = lut[0][img.data[i]];
    out.data[i + 1] = lut[1][img.data[i + 1]];
    out.data[i + 2] = lut[2][img.data[i + 2]];
    out.data[i + 3] = 255;
  }
  return out;
}

/** Grey using the brightest channel: coloured text (blue, gold, red) stays bright instead of dropping to dark grey. */
export function toGray(img) {
  const out = makeImage(img.width, img.height);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.max(img.data[i], img.data[i + 1], img.data[i + 2]);
    out.data[i] = out.data[i + 1] = out.data[i + 2] = v;
    out.data[i + 3] = 255;
  }
  return out;
}

function otsu(gray) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.data.length; i += 4) hist[gray.data[i]] += 1;
  const total = gray.width * gray.height;
  let sum = 0;
  for (let v = 0; v < 256; v += 1) sum += v * hist[v];
  let sumB = 0;
  let weightB = 0;
  let bestVariance = -1;
  let threshold = 128;
  for (let v = 0; v < 256; v += 1) {
    weightB += hist[v];
    if (!weightB) continue;
    const weightF = total - weightB;
    if (!weightF) break;
    sumB += v * hist[v];
    const diff = sumB / weightB - (sum - sumB) / weightF;
    const variance = weightB * weightF * diff * diff;
    if (variance > bestVariance) {
      bestVariance = variance;
      threshold = v;
    }
  }
  return threshold;
}

/** Black text on white: invert when the picture is mostly dark (game tooltips are light text on dark), then threshold. */
export function binarize(gray) {
  const threshold = otsu(gray);
  let bright = 0;
  for (let i = 0; i < gray.data.length; i += 4) if (gray.data[i] > threshold) bright += 1;
  const textIsBright = bright < (gray.width * gray.height) / 2;
  const out = makeImage(gray.width, gray.height);
  for (let i = 0; i < gray.data.length; i += 4) {
    const isText = textIsBright ? gray.data[i] > threshold : gray.data[i] <= threshold;
    out.data[i] = out.data[i + 1] = out.data[i + 2] = isText ? 0 : 255;
    out.data[i + 3] = 255;
  }
  return out;
}

/** Closing on the black text: thicken strokes by one pixel, then thin them back, so tiny gaps inside a stroke fill in. */
export function closeGaps(bw) {
  const { width, height } = bw;
  const morph = (src, dilate) => {
    const dst = makeImage(width, height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let any = false;
        let all = true;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const black = src.data[(clamp(y + dy, 0, height - 1) * width + clamp(x + dx, 0, width - 1)) * 4] === 0;
            any ||= black;
            all &&= black;
          }
        }
        const o = (y * width + x) * 4;
        dst.data[o] = dst.data[o + 1] = dst.data[o + 2] = (dilate ? any : all) ? 0 : 255;
        dst.data[o + 3] = 255;
      }
    }
    return dst;
  };
  return morph(morph(bw, true), false);
}

/** Scale that brings an image to about `target` pixels wide, never enlarging more than `maxScale`. */
export function chooseScale(width, { target = 1600, maxScale = 3, minScale = 0.4 } = {}) {
  return clamp(target / width, minScale, maxScale);
}

// Measured on the 24 test screenshots: colour enhance, threshold and closing all lowered the match rate, so the
// default is enlarge + grey only. The steps stay available (and tested) so the choice can be re-measured.
export const DEFAULT_STEPS = { enhance: false, binarize: false, close: false };

export function preprocess(img, { scale = chooseScale(img.width), steps = DEFAULT_STEPS } = {}) {
  let out = resize(img, scale);
  if (steps.enhance) out = enhanceColor(out);
  out = toGray(out);
  if (steps.binarize) out = binarize(out);
  if (steps.close && steps.binarize) out = closeGaps(out);
  return out;
}
