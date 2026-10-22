// The listing defaults (上架預設): the four required Traderie properties every D2R listing carries, chosen once on the
// settings screen and shown editable on the listing form. Pure logic, no DOM or chrome.* here: tested under node.
// The values are Traderie's own option strings (measured 2026-10-21, docs/design.md "Listing on Traderie"): Platform
// and Mode and Game version are string properties, Ladder is a bool property whose two options are only labels.

export const LISTING_DEFAULTS_KEY = "listingDefaults";

export const LISTING_FIELDS = [
  {
    key: "platform",
    label: "平台",
    property: "Platform",
    options: [
      { value: "PC", label: "PC" },
      { value: "playstation", label: "PlayStation" },
      { value: "xbox", label: "Xbox" },
      { value: "switch", label: "Switch" },
    ],
  },
  {
    key: "mode",
    label: "模式",
    property: "Mode",
    options: [
      { value: "softcore", label: "軟核" },
      { value: "hardcore", label: "硬核" },
    ],
  },
  {
    key: "ladder",
    label: "天梯",
    property: "Ladder",
    options: [
      { value: "ladder", label: "天梯" },
      { value: "nonladder", label: "非天梯" },
    ],
  },
  {
    key: "version",
    label: "版本",
    property: "Game version",
    options: [
      { value: "lord of destruction", label: "毀滅之王（LoD）" },
      { value: "reign of the warlock", label: "Reign of the Warlock" },
      { value: "classic (base game)", label: "經典版" },
    ],
  },
];

export const DEFAULT_LISTING = Object.freeze({ platform: "PC", mode: "softcore", ladder: "ladder", version: "reign of the warlock" });

/**
 * A fresh object with exactly the four keys; a key missing, non-string or not one of that field's options becomes
 * that field's default (so stale or damaged chrome.storage content is safe). Never mutates its input.
 */
export function normalizeListingDefaults(saved) {
  const result = { ...DEFAULT_LISTING };
  if (typeof saved !== "object" || saved === null) return result;
  for (const { key, options } of LISTING_FIELDS) {
    const value = saved[key];
    if (typeof value === "string" && options.some((option) => option.value === value)) result[key] = value;
  }
  return result;
}

/** The value Traderie's property takes for a field: Ladder is a bool, the rest are the option string itself. */
export function propertyValue(key, value) {
  return key === "ladder" ? value === "ladder" : value;
}
