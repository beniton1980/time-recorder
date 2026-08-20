import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const config = await readFile(new URL("../next.config.ts", import.meta.url), "utf8");

test("browser security headers apply to every route", () => {
  assert.match(config, /source: "\/:path\*"/);
  for (const header of [
    "Content-Security-Policy",
    "Referrer-Policy",
    "X-Content-Type-Options",
    "X-Frame-Options",
    "Permissions-Policy",
    "Cross-Origin-Opener-Policy",
  ]) {
    assert.match(config, new RegExp(`key: "${header}"`));
  }
});

test("CSP denies dangerous defaults while preserving LIFF and GPS", () => {
  assert.match(config, /default-src 'self'/);
  assert.match(config, /object-src 'none'/);
  assert.match(config, /frame-ancestors 'none'/);
  assert.match(config, /connect-src 'self' https:\/\/\*\.line\.me https:\/\/\*\.line-scdn\.net/);
  assert.match(config, /geolocation=\(self\)/);
  assert.doesNotMatch(config, /connect-src 'self' https:(?:;|\")/);
  assert.doesNotMatch(config, /script-src[^\n]*'unsafe-eval'/);
});

test("API cache protection remains in addition to browser headers", () => {
  assert.match(config, /source: "\/api\/:path\*"/);
  assert.match(config, /private, no-store, max-age=0/);
});

test("referrer headers never forward bearer tokens from QR and invite URLs", () => {
  assert.match(config, /key: "Referrer-Policy", value: "no-referrer"/);
  assert.doesNotMatch(config, /strict-origin-when-cross-origin/);
});
