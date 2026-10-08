// Keyboard logic for the result tabs. No DOM or chrome.* here: it is also tested under node.

/** The tab to select after `key` is pressed on `current`, or null when the key does nothing. Wraps around. */
export function nextTab(keys, current, key) {
  const at = keys.indexOf(current);
  if (at < 0) return null;
  if (key === "ArrowRight") return keys[(at + 1) % keys.length];
  if (key === "ArrowLeft") return keys[(at - 1 + keys.length) % keys.length];
  if (key === "Home") return keys[0];
  if (key === "End") return keys[keys.length - 1];
  return null;
}
