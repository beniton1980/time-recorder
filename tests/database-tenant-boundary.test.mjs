import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("every runtime database client supplies an explicit request context", async () => {
  const db = await source("lib/db.ts");
  assert.match(db, /app\.request_/);
  assert.match(db, /safeContextValue/);
  assert.match(db, /set_config\('app\.request_mode',[\s\S]*TRUE\)/);
  assert.match(db, /rawSql\.transaction/);
  assert.match(db, /contextQuery\(sql, context\)/);

  const files = [
    "lib/api-security.ts",
    "app/api/correction-requests/route.ts",
    "app/api/punch/route.ts",
    "app/api/session/bootstrap/route.ts",
    "app/api/staff/self-register/route.ts",
    "app/api/manager/session/route.ts",
    "app/api/manager/dashboard/route.ts",
    "app/api/manager/store-qr/route.ts",
    "app/api/manager/punch-corrections/route.ts",
    "app/api/manager/corrections/decision/route.ts",
    "app/api/manager/staff/status/route.ts",
    "app/api/manager/monthly-attendance/csv/route.ts",
    "app/api/manager/monthly-attendance/reports/route.ts",
    "app/api/manager/monthly-attendance/reissue/route.ts",
    "app/api/onboarding/requests/route.ts",
    "app/api/onboarding/manager-invite/claim/route.ts",
    "app/api/operator/onboarding/requests/route.ts",
    "app/api/operator/onboarding/requests/decision/route.ts",
    "app/api/operator/onboarding/requests/provision/route.ts",
    "app/api/operator/onboarding/requests/delete/route.ts",
    "app/api/cron/monthly-attendance/route.ts",
  ];

  for (const file of files) {
    const contents = await source(file);
    assert.doesNotMatch(contents, /getSql\(\)/, `${file} uses an unscoped database client`);
    assert.match(contents, /getSql\(\{/, `${file} does not declare its database scope`);
  }
});

test("tenant tables enforce row-level policies and security-invoker views", async () => {
  const migration = await source("db/migrations/0019_tenant_row_level_security.sql");
  for (const table of [
    "stores",
    "store_entry_tokens",
    "staff",
    "staff_states",
    "punch_events",
    "correction_requests",
    "onboarding_requests",
    "onboarding_manager_invites",
    "monthly_attendance_deliveries",
    "api_rate_limits",
  ]) {
    assert.match(migration, new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`));
  }
  assert.match(migration, /app_manager_store_allowed/);
  assert.match(migration, /app_token_store_allowed/);
  assert.match(migration, /ALTER VIEW public\.effective_punch_events SET \(security_invoker = TRUE\)/);
});

test("cross-store attendance references are rejected by database constraints", async () => {
  const migration = await source("db/migrations/0019_tenant_row_level_security.sql");
  assert.match(migration, /FOREIGN KEY \(staff_id, store_id\)[\s\S]*REFERENCES public\.staff\(id, store_id\)/);
  assert.match(migration, /FOREIGN KEY \(last_event_id, staff_id\)[\s\S]*REFERENCES public\.punch_events\(id, staff_id\)/);
  assert.match(migration, /FOREIGN KEY \(target_event_id, staff_id, store_id\)/);
  assert.match(migration, /FOREIGN KEY \(target_correction_id, staff_id, store_id\)/);
  assert.match(migration, /VALIDATE CONSTRAINT fk_punch_events_staff_store/);
});
