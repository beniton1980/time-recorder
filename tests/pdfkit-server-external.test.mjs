import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../next.config.ts", import.meta.url), "utf8");

test("PDFKit stays external so its runtime asset paths remain intact", () => {
  assert.match(source, /serverExternalPackages\s*:\s*\[["']pdfkit["']\]/);
  assert.match(source, /node_modules\/pdfkit\/js\/data\/\*\.afm/);
});
