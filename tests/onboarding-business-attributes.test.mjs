import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("onboarding form collects the three required and two optional business attributes", async () => {
  const page = await source("app/onboarding/apply/page.tsx");

  assert.match(page, /業種<select required/);
  assert.match(page, /事業所で働く人数規模<select required/);
  assert.match(page, /導入前の勤怠管理方法<select required/);
  assert.match(page, /運営事業所数（任意）<select/);
  assert.match(page, /ONOGAMIを知ったきっかけ（任意）<select/);
  assert.match(page, /storeCountRange: form\.storeCountRange \|\| null/);
  assert.match(page, /reportedAcquisitionSource: form\.reportedAcquisitionSource \|\| null/);
});

test("onboarding API validates and persists coded attribute values", async () => {
  const validation = await source("lib/onboarding/validation.ts");
  const route = await source("app/api/onboarding/requests/route.ts");

  assert.match(validation, /INVALID_BUSINESS_ATTRIBUTE/);
  assert.match(validation, /isOptionValue\(businessCategoryOptions/);
  assert.match(validation, /isOptionValue\(staffCountRangeOptions/);
  assert.match(validation, /isOptionValue\(priorAttendanceMethodOptions/);
  assert.match(route, /business_category/);
  assert.match(route, /reported_acquisition_source/);
});

test("business attributes use additive nullable columns and follow provisioning", async () => {
  const migration = await source("db/migrations/0029_onboarding_business_attributes.sql");

  assert.match(migration, /ALTER TABLE public\.onboarding_requests/);
  assert.match(migration, /ALTER TABLE public\.stores/);
  assert.doesNotMatch(migration, /ADD COLUMN (business_category|staff_count_range|store_count_range|prior_attendance_method|reported_acquisition_source) TEXT NOT NULL/);
  assert.doesNotMatch(migration, /UPDATE public\.(onboarding_requests|stores)[\\s\\S]*SET[\\s\\S]*(business_category|staff_count_range|store_count_range|prior_attendance_method|reported_acquisition_source)/);
  assert.match(migration, /request_row\.business_category/);
  assert.match(migration, /request_row\.staff_count_range/);
  assert.match(migration, /request_row\.prior_attendance_method/);
});

test("operator review displays all business attributes", async () => {
  const route = await source("app/api/operator/onboarding/requests/route.ts");
  const page = await source("app/operator/onboarding/page.tsx");

  for (const column of [
    "business_category",
    "staff_count_range",
    "store_count_range",
    "prior_attendance_method",
    "reported_acquisition_source",
  ]) {
    assert.match(route, new RegExp(column));
    assert.match(page, new RegExp(column));
  }
});
