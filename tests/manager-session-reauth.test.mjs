import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("manager screen refreshes an expired LINE token exactly once", async () => {
  const page = await source("app/manager/page.tsx");
  assert.match(page, /data\.code === "INVALID_ID_TOKEN"/);
  assert.match(page, /sessionStorage\.getItem\(REAUTH_SESSION_KEY\) === "1"/);
  assert.match(page, /liff\.logout\(\)/);
  assert.match(page, /liff\.login\(\{ redirectUri: window\.location\.href \}\)/);
  assert.match(page, /if \(!memberships\) return/);
});
