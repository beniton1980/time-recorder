import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("punch state transitions remain explicit and ordered", async () => {
  const punch = await source("app/api/punch/route.ts");

  assert.match(punch, /CHECK_IN:\s*{\s*from:\s*"OFF_DUTY",\s*to:\s*"WORKING"\s*}/);
  assert.match(punch, /BREAK_START:\s*{\s*from:\s*"WORKING",\s*to:\s*"ON_BREAK"\s*}/);
  assert.match(punch, /BREAK_END:\s*{\s*from:\s*"ON_BREAK",\s*to:\s*"WORKING"\s*}/);
  assert.match(punch, /CHECK_OUT:\s*{\s*from:\s*"WORKING",\s*to:\s*"OFF_DUTY"\s*}/);
});

test("CHECK_IN remains serialized per LINE identity and guarded across stores", async () => {
  const punch = await source("app/api/punch/route.ts");

  assert.match(
    punch,
    /pg_advisory_xact_lock\(hashtextextended\(\$\{identity\.sub},\s*0\)\)/,
  );
  assert.match(punch, /eventType === "CHECK_IN"/);
  assert.match(punch, /active_staff\.line_user_id = \$\{identity\.sub}/);
  assert.match(punch, /active_staff\.store_id <> st\.store_id/);
  assert.match(punch, /active_state\.state IN \('WORKING', 'ON_BREAK'\)/);
  assert.match(punch, /code: "ACTIVE_AT_OTHER_STORE"/);
});

test("opening another store QR keeps the active-store conflict UX", async () => {
  const bootstrap = await source("app/api/session/bootstrap/route.ts");
  const page = await source("app/page.tsx");

  assert.match(bootstrap, /activeStoreConflict:/);
  assert.match(bootstrap, /active_state\.state IN \('WORKING', 'ON_BREAK'\)/);
  assert.match(page, /kind: "active_store_conflict"/);
  assert.match(page, /別の店舗で勤務中です/);
});

test("business dates remain store-timezone based with a configurable boundary", async () => {
  const punch = await source("app/api/punch/route.ts");
  const bootstrap = await source("app/api/session/bootstrap/route.ts");
  const schema = await source("db/migrations/0001_initial_schema.sql");

  assert.match(punch, /NOW\(\) AT TIME ZONE l\.timezone/);
  assert.match(punch, /make_interval\(mins => l\.business_day_start_minute\)/);
  assert.match(bootstrap, /NOW\(\) AT TIME ZONE s\.timezone/);
  assert.match(bootstrap, /make_interval\(mins => s\.business_day_start_minute\)/);
  assert.match(schema, /timezone TEXT NOT NULL DEFAULT 'Asia\/Tokyo'/);
  assert.match(schema, /business_day_start_minute INTEGER NOT NULL DEFAULT 300/);
});

function jstBusinessDate(isoTimestamp, businessDayStartMinute = 300) {
  const jstOffsetMinutes = 9 * 60;
  const shifted = new Date(
    new Date(isoTimestamp).getTime()
      + (jstOffsetMinutes - businessDayStartMinute) * 60_000,
  );
  return shifted.toISOString().slice(0, 10);
}

test("05:00 cutoff keeps midnight punches together and advances at the boundary", () => {
  assert.equal(jstBusinessDate("2026-08-08T14:59:00.000Z"), "2026-08-08");
  assert.equal(jstBusinessDate("2026-08-08T15:01:00.000Z"), "2026-08-08");
  assert.equal(jstBusinessDate("2026-08-08T19:59:59.000Z"), "2026-08-08");
  assert.equal(jstBusinessDate("2026-08-08T20:00:00.000Z"), "2026-08-09");
});

test("an active shift keeps its CHECK_IN business date after the cutoff", async () => {
  const punch = await source("app/api/punch/route.ts");

  assert.match(punch, /WHEN \${eventType} = 'CHECK_IN' THEN/);
  assert.match(punch, /SELECT active_check_in\.business_date/);
  assert.match(punch, /active_check_in\.staff_id = l\.staff_id/);
  assert.match(punch, /active_check_in\.event_type = 'CHECK_IN'/);
  assert.match(punch, /ORDER BY active_check_in\.occurred_at DESC/);
});

test("manager dashboard warns when an active shift carries into a later business day", async () => {
  const dashboard = await source("app/api/manager/dashboard/route.ts");
  const managerPage = await source("app/manager/page.tsx");

  assert.match(dashboard, /COALESCE\(ss\.state, 'OFF_DUTY'\) AS current_state/);
  assert.match(dashboard, /active_shift\.business_date < \$\{businessDate}::date/);
  assert.match(dashboard, /AS carried_over_active/);
  assert.match(managerPage, /staff\.carried_over_active/);
  assert.match(managerPage, /前営業日から/);
  assert.match(managerPage, /が継続中です/);
});
