import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../lib/monthly-attendance-pdf.mjs", import.meta.url), "utf8");

test("monthly PDF resolves bundled fonts from the application root", () => {
  assert.match(source, /process\.cwd\(\)/);
  assert.match(source, /assets[\\\/]fonts[\\\/]NotoSansJP-Regular\.otf/);
  assert.match(source, /assets[\\\/]fonts[\\\/]NotoSansJP-Bold\.otf/);
  assert.doesNotMatch(source, /fileURLToPath\(new URL\("\.\.\/assets\/fonts/);
});
