import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("store location update is manager-scoped and validates GPS accuracy", async () => {
  const [route, migration] = await Promise.all([
    read("app/api/manager/store-location/route.ts"),
    read("db/migrations/0026_manager_store_location.sql"),
  ]);
  assert.match(route, /MAX_REGISTRATION_ACCURACY_METERS = 100/);
  assert.match(route, /mode: "manager"/);
  assert.match(route, /storeId: body\.storeId/);
  assert.match(migration, /app_manager_store_allowed\(p_store_id\)/);
  assert.match(migration, /app_request_setting\(''store_id''\)/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.set_manager_store_location/);
});

test("manager registers the current location only after a store-specific confirmation", async () => {
  const page = await read("app/manager/page.tsx");
  assert.match(page, /enableHighAccuracy: true/);
  assert.match(page, /maximumAge: 0/);
  assert.match(page, /の打刻位置を、現在地/);
  assert.match(page, /現在地を店舗位置に登録/);
});
