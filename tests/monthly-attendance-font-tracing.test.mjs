import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../next.config.ts", import.meta.url), "utf8");

test("monthly PDF fonts are traced into every server function", () => {
  assert.match(source, /outputFileTracingIncludes/);
  assert.match(source, /["']\/\*["']\s*:\s*\[/);
  assert.match(source, /\.\/assets\/fonts\/\*\*\/\*\.otf/);
});
