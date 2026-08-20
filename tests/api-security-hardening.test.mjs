import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("all API responses are private and non-cacheable", async () => {
  const config = await read("next.config.ts");
  assert.match(config, /source: "\/api\/:path\*"/);
  assert.match(config, /private, no-store, max-age=0/);
});

test("database diagnostics are not exposed as a public API", async () => {
  await assert.rejects(
    access(new URL("../app/api/db-health/route.ts", import.meta.url)),
    { code: "ENOENT" },
  );
});

test("sensitive public operations use persistent rate limits", async () => {
  const routes = [
    "app/api/session/bootstrap/route.ts",
    "app/api/manager/session/route.ts",
    "app/api/punch/route.ts",
    "app/api/staff/self-register/route.ts",
    "app/api/correction-requests/route.ts",
    "app/api/manager/punch-corrections/route.ts",
    "app/api/manager/store-qr/route.ts",
    "app/api/manager/dashboard/route.ts",
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
  ];
  for (const route of routes) {
    const source = await read(route);
    assert.match(source, /enforceRateLimit/, `${route} is not rate limited`);
  }

  const migration = await read("db/migrations/0015_api_rate_limits.sql");
  assert.match(migration, /PRIMARY KEY \(scope, fingerprint_hash\)/);
  assert.match(migration, /ON CONFLICT \(scope, fingerprint_hash\) DO UPDATE/);
});

test("rate limit storage contains fingerprints, not raw tokens or IP addresses", async () => {
  const helper = await read("lib/api-security.ts");
  assert.match(helper, /createHash\("sha256"\)/);
  assert.match(helper, /policy\.limit \* 10/);
  assert.match(helper, /scope}:subject/);
  assert.doesNotMatch(helper, /INSERT INTO api_rate_limits/);
  assert.match(helper, /code: "RATE_LIMITED"/);
  assert.match(helper, /"Retry-After"/);
});

test("manager direct correction never returns internal error detail", async () => {
  const route = await read("app/api/manager/punch-corrections/route.ts");
  assert.doesNotMatch(route, /detail:\s*error/);
  assert.match(route, /code: "CORRECTION_UNAVAILABLE"/);
});

test("LINE verification and manager mutation inputs are bounded", async () => {
  const verifier = await read("lib/line/verify-id-token.ts");
  assert.match(verifier, /MAX_ID_TOKEN_LENGTH = 8192/);
  assert.match(verifier, /AbortSignal\.timeout\(LINE_VERIFY_TIMEOUT_MS\)/);

  const correction = await read("app/api/manager/punch-corrections/route.ts");
  assert.match(correction, /!uuidPattern\.test\(body\.staffId\)/);
  assert.match(correction, /reason\.length > 500/);
  assert.match(correction, /!uuidPattern\.test\(body\.targetEffectiveId\)/);

  const decision = await read("app/api/manager/corrections/decision/route.ts");
  assert.match(decision, /!uuidPattern\.test\(body\.requestId\)/);
});
