// Page text is untrusted, and three modules say so in their own headers (`panel-dom.js`, `scan/scan-panel.js`,
// `sidepanel.js`): every value is written with textContent, never innerHTML. Nothing checked it, so a later edit
// could introduce a markup sink and only a careful reader would notice.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const SINKS = ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write("];

/** Every shipped module: the vendored bundle is someone else's code, pinned by its own hash test. */
function sources(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "vendor") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sources(path));
    else if (entry.name.endsWith(".js")) found.push(path);
  }
  return found;
}

/** The code of a module without its full-line comments: the headers name innerHTML while promising not to use it. */
const codeOf = (text) =>
  text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");

test("no shipped module writes page text as markup", () => {
  const offenders = [];
  for (const file of sources(SRC)) {
    const code = codeOf(readFileSync(file, "utf8"));
    for (const sink of SINKS) if (code.includes(sink)) offenders.push(`${relative(SRC, file)}: ${sink}`);
  }
  assert.deepEqual(offenders, []);
});

test("the panel modules that promise it do write their values as text", () => {
  for (const name of ["panel-dom.js", "scan/scan-panel.js", "sidepanel.js"]) {
    assert.match(readFileSync(join(SRC, name), "utf8"), /textContent/, name);
  }
});
