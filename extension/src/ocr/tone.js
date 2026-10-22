// What the colour of an item's name line says about its quality. Pure functions: no chrome.*, no I/O.
//
// D2R prints a name in the colour of the item's quality: unique gold, set green, rare yellow, magic blue, normal white.
// A unique's or set item's name is fixed (it is in the item table); a rare or magic item's printed name is random and can
// collide with a catalogue name, so only a gold or green name line is evidence that a table name is really the item.
// `tone` is the [r, g, b] of the line's lettering (ppocrlib.js inkTone). The bands were measured on the truth pictures
// (docs/design.md): unique gold is tan (about 198,178,120) in the game and a paler cream (about 253,250,187) in
// some captures, rare yellow is 248,248,100 to 253,253,150 and stays above a saturation of 0.31.

const BRIGHT_MIN = 150; // a dimmer lettering is not read: the line was dark or the pixels were not text
const GREY_MAX = 0.15; // below this saturation the lettering is white or grey
const CREAM_MAX = 0.31; // a pale yellow below this saturation is gold, above it rare yellow

/** "gold" | "green" | "yellow" | "blue" | "white", or null when the tone is missing, too dark or none of those. */
export function toneQuality(tone) {
  if (!Array.isArray(tone) || tone.length !== 3 || tone.some((v) => !Number.isFinite(v))) return null;
  const [r, g, b] = tone;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max < BRIGHT_MIN) return null;
  const delta = max - min;
  const saturation = delta / max;
  if (saturation < GREY_MAX) return "white";
  let hue;
  if (max === r) hue = (((g - b) / delta) % 6) * 60;
  else if (max === g) hue = ((b - r) / delta + 2) * 60;
  else hue = ((r - g) / delta + 4) * 60;
  if (hue < 0) hue += 360;
  if (hue >= 190 && hue <= 270 && saturation >= 0.3) return "blue";
  if (hue >= 80 && hue <= 160 && saturation >= 0.4) return "green";
  if (hue >= 30 && hue <= 52 && saturation <= 0.6) return "gold"; // 0.6 and up is crafted orange
  if (hue > 52 && hue <= 65) return saturation < CREAM_MAX ? "gold" : "yellow";
  return null;
}

/** Whether the line's lettering is the colour of a fixed-name item (unique, runeword gold or set green). */
export const isFixedName = (quality) => quality === "gold" || quality === "green";
