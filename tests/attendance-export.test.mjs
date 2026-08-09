import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("monthly export is manager-scoped and ignores client store ids", async () => {
  const route = await source("app/api/manager/attendance-export/route.ts");
  assert.match(route, /verifyLineIdToken\(body\.idToken\)/);
  assert.match(route, /st\.role = 'MANAGER'/);
  assert.match(route, /epe\.store_id = \$\{manager\.store_id\}/);
  assert.doesNotMatch(route, /body\.storeId/);
});

test("monthly export uses corrected effective punches and business dates", async () => {
  const route = await source("app/api/manager/attendance-export/route.ts");
  const exportQuery = route.slice(route.indexOf("const rows = await sql"));
  assert.match(route, /FROM effective_punch_events epe/);
  assert.match(route, /epe\.business_date >=/);
  assert.match(route, /INTERVAL '1 month'/);
  assert.match(route, /epe\.corrected/);
  assert.doesNotMatch(exportQuery, /st\.status = 'active'/);
});

test("CSV output is spreadsheet-safe and Japanese Excel friendly", async () => {
  const route = await source("app/api/manager/attendance-export/route.ts");
  const page = await source("app/manager/page.tsx");
  assert.match(route, /\^\[=\+\\-@\]/);
  assert.match(route, /\\uFEFF/);
  assert.match(route, /text\/csv; charset=utf-8/);
  assert.match(page, /type="month"/);
  assert.match(page, /CSVを保存/);
});

