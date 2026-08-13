import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const routePath = new URL("../app/api/punch/route.ts", import.meta.url);
const migrationPath = new URL("../db/migrations/0016_minimize_punch_location_data.sql", import.meta.url);

test("punches classify location without persisting exact telemetry", async () => {
  const route = await readFile(routePath, "utf8");
  const insertColumns = route.match(/INSERT INTO punch_events \(([\s\S]*?)\)\s*SELECT/)?.[1] ?? "";

  assert.match(route, /AS client_latitude/);
  assert.match(route, /AS distance_m/);
  assert.doesNotMatch(insertColumns, /\blatitude\b/);
  assert.doesNotMatch(insertColumns, /\blongitude\b/);
  assert.doesNotMatch(insertColumns, /gps_accuracy_m/);
  assert.doesNotMatch(insertColumns, /distance_from_store_m/);
});

test("punch responses do not expose exact distance", async () => {
  const route = await readFile(routePath, "utf8");
  assert.doesNotMatch(route, /pe\.distance_from_store_m/);
  assert.doesNotMatch(route, /ie\.distance_from_store_m/);
});

test("location minimization migration scrubs historical telemetry only", async () => {
  const migration = await readFile(migrationPath, "utf8");
  assert.match(migration, /UPDATE punch_events/);
  assert.match(migration, /latitude = NULL/);
  assert.match(migration, /longitude = NULL/);
  assert.match(migration, /gps_accuracy_m = NULL/);
  assert.match(migration, /distance_from_store_m = NULL/);
  assert.doesNotMatch(migration, /DELETE FROM punch_events|DROP TABLE|TRUNCATE/i);
});
