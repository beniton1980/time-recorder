import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("CSV is manager-scoped and limited to a sent closing period", async () => {
  const route = await source("app/api/manager/monthly-attendance/csv/route.ts");
  assert.match(route, /verifyLineIdToken\(body\.idToken\)/);
  assert.match(route, /st\.role = 'MANAGER'/);
  assert.match(route, /delivery_version = 'initial' AND status = 'SENT'/);
  assert.doesNotMatch(route, /body\.storeId/);
});

test("CSV uses effective punches, business dates, and includes inactive history", async () => {
  const route = await source("app/api/manager/monthly-attendance/csv/route.ts");
  const exportQuery = route.slice(route.indexOf("const rows = await sql"));
  assert.match(route, /FROM effective_punch_events epe/);
  assert.match(route, /epe\.business_date BETWEEN/);
  assert.match(route, /AT TIME ZONE \$\{store\.timezone\}/);
  assert.doesNotMatch(exportQuery, /st\.status = 'active'/);
});

test("CSV is Excel-friendly and formula-injection safe", async () => {
  const route = await source("app/api/manager/monthly-attendance/csv/route.ts");
  assert.match(route, /\^\[=\+\\-@\]/);
  assert.match(route, /\\uFEFF/);
  assert.match(route, /text\/csv; charset=utf-8/);
});

test("GPS reason remains separate and does not remove punches", async () => {
  const route = await source("app/api/manager/monthly-attendance/csv/route.ts");
  assert.match(route, /OUTSIDE_STORE_RADIUS/);
  assert.match(route, /LOW_GPS_ACCURACY/);
  assert.match(route, /CLIENT_LOCATION_UNAVAILABLE/);
  assert.match(route, /STORE_LOCATION_UNAVAILABLE/);
  assert.doesNotMatch(route, /validation_status = 'VALID'/);
});

