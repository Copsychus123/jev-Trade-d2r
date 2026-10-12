// A test that imports a shipped extension module meets specifiers that only exist in the built package: build.py
// copies src/jev_ultrafast/static/csv.js into dist as csv.js, writes dist/config.js, and bundles the OCR vendor file.
// Four test files install the same resolve hook for that, so it lives here once.

import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// The file build.py copies into dist as csv.js, so the shipped module runs the very code the test imports elsewhere.
const csvUrl = pathToFileURL(fileURLToPath(new URL("../../../src/jev_ultrafast/static/csv.js", import.meta.url))).href;

/**
 * Install a resolve hook in this test process: every specifier ending in csv.js -- whether a module names it
 * "./csv.js" or "../csv.js" -- resolves to the repo's csv source, and each rule { specifier, parent, url } resolves
 * exactly that specifier to `url` while the importing module's URL contains `parent`. Anything else falls through to
 * the real resolver, so the hook only stands in for the built package.
 */
export function installStubResolver(rules = []) {
  const rewrites = rules.map(
    ({ specifier, parent, url }) =>
      `  if (specifier === ${JSON.stringify(specifier)} && context.parentURL?.includes(${JSON.stringify(parent)})) {\n` +
      `    return { url: ${JSON.stringify(url)}, shortCircuit: true };\n  }`,
  );
  const loader = `export async function resolve(specifier, context, next) {
  if (specifier.endsWith("csv.js")) return { url: ${JSON.stringify(csvUrl)}, shortCircuit: true };
${rewrites.join("\n")}
  return next(specifier, context);
}`;
  register(new URL("data:text/javascript;base64," + Buffer.from(loader).toString("base64")));
}
