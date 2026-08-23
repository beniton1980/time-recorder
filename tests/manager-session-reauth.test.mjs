import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("manager screen handles an expired LINE token without an invalid in-LIFF login", async () => {
  const page = await source("app/manager/page.tsx");
  assert.match(page, /data\.code === "INVALID_ID_TOKEN"/);
  assert.match(page, /LINE認証の有効期限が切れました/);
  assert.doesNotMatch(page, /liff\.logout\(\)/);
});
