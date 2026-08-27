import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("manager payroll entry stays inside current LIFF webview", async () => {
  const source = await readFile(new URL("../app/manager/PayrollLinkNormalizer.tsx", import.meta.url), "utf8");
  assert.match(source, /link\.href = "\/manager\/payroll"/);
  assert.doesNotMatch(source, /liff\.line\.me/);
});
