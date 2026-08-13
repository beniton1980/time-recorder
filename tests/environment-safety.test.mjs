import assert from "node:assert/strict";
import test from "node:test";

import {
  assertDatabaseEnvironmentSafety,
  isEmailDeliveryAllowed,
} from "../lib/environment-safety.mjs";
import { readFile } from "node:fs/promises";

const MANAGED_KEYS = [
  "VERCEL_ENV",
  "ONOGAMI_PREVIEW_DATABASE_ISOLATED",
  "ONOGAMI_PRODUCTION_DATABASE_HOST",
  "ONOGAMI_PREVIEW_EMAIL_ENABLED",
];

function withEnvironment(values, action) {
  const previous = Object.fromEntries(MANAGED_KEYS.map((key) => [key, process.env[key]]));
  for (const key of MANAGED_KEYS) delete process.env[key];
  Object.assign(process.env, values);
  try {
    return action();
  } finally {
    for (const key of MANAGED_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test("production database access is unchanged", () => {
  withEnvironment({ VERCEL_ENV: "production" }, () => {
    assert.doesNotThrow(() => assertDatabaseEnvironmentSafety(
      "postgresql://user:secret@production.example/db",
    ));
  });
});

test("preview database access fails closed without isolation settings", () => {
  withEnvironment({ VERCEL_ENV: "preview" }, () => {
    assert.throws(
      () => assertDatabaseEnvironmentSafety("postgresql://user:secret@preview.example/db"),
      /PREVIEW_DATABASE_NOT_ISOLATED/,
    );
  });
});

test("preview rejects the production database host", () => {
  withEnvironment({
    VERCEL_ENV: "preview",
    ONOGAMI_PREVIEW_DATABASE_ISOLATED: "true",
    ONOGAMI_PRODUCTION_DATABASE_HOST: "production.example",
  }, () => {
    assert.throws(
      () => assertDatabaseEnvironmentSafety("postgresql://user:secret@production.example/db"),
      /PREVIEW_DATABASE_NOT_ISOLATED/,
    );
  });
});

test("preview accepts an explicitly isolated database host", () => {
  withEnvironment({
    VERCEL_ENV: "preview",
    ONOGAMI_PREVIEW_DATABASE_ISOLATED: "true",
    ONOGAMI_PRODUCTION_DATABASE_HOST: "production.example",
  }, () => {
    assert.doesNotThrow(() => assertDatabaseEnvironmentSafety(
      "postgresql://user:secret@preview.example/db",
    ));
  });
});

test("preview email delivery is disabled unless explicitly enabled", () => {
  withEnvironment({ VERCEL_ENV: "preview" }, () => {
    assert.equal(isEmailDeliveryAllowed(), false);
  });
  withEnvironment({
    VERCEL_ENV: "preview",
    ONOGAMI_PREVIEW_EMAIL_ENABLED: "true",
  }, () => {
    assert.equal(isEmailDeliveryAllowed(), true);
  });
});

test("database access fails closed instead of falling back to integration owner credentials", async () => {
  const databaseModule = await readFile(new URL("../lib/db.ts", import.meta.url), "utf8");
  assert.match(databaseModule, /const databaseUrl = process\.env\.DATABASE_URL/);
  assert.doesNotMatch(databaseModule, /time_recorder_POSTGRES_URL_NON_POOLING/);
  assert.match(databaseModule, /DATABASE_URL is not configured/);
});
