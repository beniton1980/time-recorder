import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../next.config.ts", import.meta.url), "utf8");

test("Vercel traces PDFKit AFM runtime assets into server functions", () => {
  assert.match(source, /node_modules\/pdfkit\/js\/data\/\*\.afm/);
});
