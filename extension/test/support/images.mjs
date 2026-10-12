// The two primitives every scan test needs to synthesise a picture: grey noise and a solid rectangle. They lived
// verbatim in scan-tooltip, scan-session and scan-panel; each file keeps its own higher builders (a tooltip panel with
// antialiasing, a dashed frame, a cropped panel), because those differ per test on purpose.

/** Deterministic grey noise: the same seed gives the same picture, so a detector test cannot flake on its input. */
export function noise(width, height, { min = 70, max = 160, seed = 12345 } = {}) {
  const data = new Uint8ClampedArray(width * height * 4);
  let s = seed >>> 0;
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  for (let i = 0; i < width * height; i++) {
    const v = min + Math.floor(rand() * (max - min + 1));
    data[i * 4] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

/** A solid grey rectangle inside `img`, alpha-opaque. */
export function fill(img, x, y, w, h, value) {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      const i = (yy * img.width + xx) * 4;
      img.data[i] = value;
      img.data[i + 1] = value;
      img.data[i + 2] = value;
      img.data[i + 3] = 255;
    }
  }
}
