// The recognition worker. It loads the unmodified Tesseract.js worker after quieting three kinds of harmless notes that
// the Tesseract engine prints on its own and Chrome would list under the extension's errors:
//   "Warning: Parameter not found: <name>"        legacy-engine settings stored inside the model files; the text-only
//                                                  core has no such settings and skips them
//   "Image too small to scale!! (2x48 vs ...)"    a stray speck the page layout step mistook for a text line
//   "Line cannot be recognized!!"                 the same speck
// Everything else (real errors included) is passed on to the console untouched.
const HARMLESS = [/^Warning: Parameter not found: /u, /^Image too small to scale!!/u, /^Line cannot be recognized!!/u];

for (const level of ["error", "warn"]) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    if (typeof args[0] === "string" && HARMLESS.some((pattern) => pattern.test(args[0]))) return;
    original(...args);
  };
}

importScripts("../vendor/tesseract/worker.min.js");
