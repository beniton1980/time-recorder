import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("monthly email verification uses a dedicated mobile-safe layout", async () => {
  const page = await source("app/monthly-attendance/verify-email/page.tsx");
  const css = await source("app/monthly-attendance/verify-email/verify-email.module.css");
  assert.match(page, /\.\/verify-email\.module\.css/);
  assert.match(page, /月次勤怠表の送信先確認/);
  assert.match(css, /text-wrap: balance/);
  assert.match(css, /@media \(max-width: 560px\)/);
  assert.match(css, /font-size: 28px/);
  assert.match(css, /align-items: flex-start/);
});
