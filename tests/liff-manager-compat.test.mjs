import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const cases = [
  ["app/liff-entry/manager/page.tsx", "/manager"],
  ["app/liff-entry/manager/clock-poster/page.tsx", "/manager/clock-poster"],
  ["app/liff-entry/manager/qr/page.tsx", "/manager/qr"],
];

for (const [path, destination] of cases) {
  test(`${path} initializes LIFF before redirecting`, () => {
    const source = fs.readFileSync(path, "utf8");
    const initIndex = source.indexOf("await liff.init");
    const redirectIndex = source.indexOf(`window.location.replace(\"${destination}\")`);
    assert.ok(initIndex >= 0, "LIFF init must exist");
    assert.ok(redirectIndex > initIndex, "redirect must follow LIFF init");
  });
}
