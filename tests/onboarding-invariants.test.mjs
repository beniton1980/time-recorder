import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("onboarding requests are pending, auditable, and idempotent", async () => {
  const schema = await source("db/migrations/0006_onboarding_requests.sql");
  const route = await source("app/api/onboarding/requests/route.ts");

  assert.match(schema, /client_request_id UUID NOT NULL UNIQUE/);
  assert.match(schema, /status TEXT NOT NULL DEFAULT 'PENDING'/);
  assert.match(schema, /reviewed_by_line_user_id TEXT/);
  assert.match(schema, /terms_accepted_at TIMESTAMPTZ NOT NULL/);
  assert.match(route, /ON CONFLICT \(client_request_id\) DO NOTHING/);
  assert.match(route, /duplicate: inserted\.length === 0/);
});

test("public onboarding cannot provision a store or manager", async () => {
  const route = await source("app/api/onboarding/requests/route.ts");

  assert.doesNotMatch(route, /INSERT INTO stores/);
  assert.doesNotMatch(route, /INSERT INTO staff/);
  assert.doesNotMatch(route, /store_entry_tokens/);
});

test("operator access uses a LINE identity allowlist", async () => {
  const guard = await source("lib/onboarding/verify-operator.ts");
  const listing = await source("app/api/operator/onboarding/requests/route.ts");
  const decision = await source(
    "app/api/operator/onboarding/requests/decision/route.ts",
  );

  assert.match(guard, /verifyLineIdToken\(idToken\)/);
  assert.match(guard, /ONOGAMI_OPERATOR_LINE_USER_IDS/);
  assert.match(guard, /allowed\.has\(identity\.sub\)/);
  assert.match(listing, /await verifyOperator\(body\.idToken\)/);
  assert.match(decision, /await verifyOperator\(body\.idToken\)/);
});

test("review is single-use and rejection requires a reason", async () => {
  const decision = await source(
    "app/api/operator/onboarding/requests/decision/route.ts",
  );

  assert.match(decision, /AND status = 'PENDING'/);
  assert.match(decision, /REJECTION_REASON_REQUIRED/);
  assert.match(decision, /ONBOARDING_REQUEST_ALREADY_REVIEWED/);
  assert.doesNotMatch(decision, /INSERT INTO stores/);
});
