import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const DIR = new URL("../src/vendor/ort/", import.meta.url);
const VENDOR = new URL("../src/vendor/", import.meta.url);
const versions = JSON.parse(await readFile(new URL("VERSIONS.json", DIR), "utf8"));
const read = (name) => readFile(new URL(name, DIR));

test("every vendored ORT file has the size and SHA-256 recorded in VERSIONS.json", async () => {
  for (const [name, entry] of Object.entries(versions.files)) {
    const bytes = await read(name);
    assert.equal(bytes.length, entry.bytes, `${name}: size`);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256, `${name}: sha256`);
  }
});

test("the ORT vendor folder holds exactly the recorded files plus its licence and VERSIONS.json", async () => {
  const found = (await readdir(DIR)).sort();
  const expected = [...Object.keys(versions.files), "LICENSE", "VERSIONS.json"].sort();
  assert.deepEqual(found, expected);
  const license = (await read("LICENSE")).toString("utf8");
  assert.match(license, /MIT License/u);
});

test("the recorded tarball is the pinned onnxruntime-web release", async () => {
  assert.equal(versions["onnxruntime-web"], "1.30.0");
  assert.equal(versions.tarball.url, "https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-1.30.0.tgz");
  assert.equal(versions.tarball.bytes, 33106585);
  assert.equal(versions.tarball.sha256, "d2228df7e4616bc3348bf504ee888f3bec43789a273f0a63f3e68d203ce3bf71");
  const main = (await read("ort.min.mjs")).toString("utf8");
  assert.ok(main.includes(`"${versions["onnxruntime-web"]}"`), "ort.min.mjs carries its own version string");
});

test("the Tesseract vendor folder is gone", async () => {
  assert.deepEqual((await readdir(VENDOR)).sort(), ["ort"]);
});

test("the manifest allows wasm but never unsafe-eval", async () => {
  const manifest = JSON.parse(await readFile(new URL("../../../manifest.json", DIR), "utf8"));
  const csp = manifest.content_security_policy.extension_pages;
  assert.match(csp, /'wasm-unsafe-eval'/u);
  assert.doesNotMatch(csp, /'unsafe-eval'/u);
});
