import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("manager correction mutations and state refresh run inside database functions", async () => {
  const migration = await source("db/migrations/0020_atomic_correction_state.sql");
  const direct = await source("app/api/manager/punch-corrections/route.ts");
  const decision = await source("app/api/manager/corrections/decision/route.ts");

  assert.match(migration, /^BEGIN;/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.apply_manager_direct_correction/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.decide_manager_correction/);
  assert.match(migration, /FOR UPDATE;/);
  assert.match(migration, /INSERT INTO public\.correction_requests[\s\S]*UPDATE public\.staff_states/);
  assert.match(migration, /UPDATE public\.correction_requests[\s\S]*UPDATE public\.staff_states/);
  assert.match(migration, /COMMIT;\s*$/);

  assert.match(direct, /FROM public\.apply_manager_direct_correction\(/);
  assert.doesNotMatch(direct, /INSERT INTO correction_requests/);
  assert.doesNotMatch(direct, /INSERT INTO staff_states/);

  assert.match(decision, /FROM public\.decide_manager_correction\(/);
  assert.doesNotMatch(decision, /UPDATE correction_requests/);
  assert.doesNotMatch(decision, /INSERT INTO staff_states/);
});

test("zero effective events reset the cached staff state to OFF_DUTY", async () => {
  const migration = await source("db/migrations/0020_atomic_correction_state.sql");

  const zeroEventFallbacks = migration.match(
    /WHEN latest_event_type IS NULL OR latest_event_type = 'CHECK_OUT' THEN 'OFF_DUTY'/g,
  );
  assert.equal(zeroEventFallbacks?.length, 2);
  assert.match(migration, /last_event_id = latest_original_event_id/);
  assert.match(migration, /last_event_at = latest_event_at/);
});

test("atomic correction functions retain RLS and least-privilege boundaries", async () => {
  const migration = await source("db/migrations/0020_atomic_correction_state.sql");

  assert.equal((migration.match(/SECURITY INVOKER/g) ?? []).length, 2);
  assert.match(migration, /public\.app_manager_store_allowed\(p_store_id\)/);
  assert.match(migration, /public\.app_manager_staff_allowed\(p_staff_id\)/);
  assert.equal((migration.match(/REVOKE ALL ON FUNCTION/g) ?? []).length, 2);
  assert.equal((migration.match(/GRANT EXECUTE ON FUNCTION/g) ?? []).length, 2);
  assert.doesNotMatch(migration, /SECURITY DEFINER/);
});
