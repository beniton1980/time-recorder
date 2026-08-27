import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildPayrollPreviewContext, calculateStaffPayrollPreview } from "../lib/payroll-preview.mjs";

const baseSettings = {
  workTimeSystem: "STANDARD_40H",
  overtimeMonthRule: "PAY_PERIOD",
  statutoryHolidayRule: "FIXED_WEEKDAY",
  statutoryHolidayWeekday: 0,
};

test("calendar default week starts on Sunday", () => {
  const context = buildPayrollPreviewContext({
    payPeriodStart: "2026-08-01",
    payPeriodEnd: "2026-08-31",
    settings: { ...baseSettings, weekStartRule: "CALENDAR_DEFAULT", weekStartsOn: 5 },
  });
  assert.equal(context.weekStartsOn, 0);
  assert.equal(context.weekRuleSupported, true);
});

test("explicit week boundary uses selected weekday", () => {
  const context = buildPayrollPreviewContext({
    payPeriodStart: "2026-08-01",
    payPeriodEnd: "2026-08-31",
    settings: { ...baseSettings, weekStartRule: "EXPLICIT_WEEKDAY", weekStartsOn: 1 },
  });
  assert.equal(context.weekStartsOn, 1);
  assert.equal(context.weekRuleSupported, true);
});

test("unconfirmed week boundary is fail closed", () => {
  const settings = { ...baseSettings, weekStartRule: "OTHER_REVIEW_REQUIRED", weekStartsOn: 1 };
  const context = buildPayrollPreviewContext({ payPeriodStart: "2026-08-01", payPeriodEnd: "2026-08-31", settings });
  const result = calculateStaffPayrollPreview({
    attendanceDays: [],
    compensationTerms: [],
    settings,
    context,
  });
  assert.equal(context.weekRuleSupported, false);
  assert.equal(result.status, "NEEDS_REVIEW");
  assert.ok(result.reviewReasons.includes("WEEK_START_RULE_MISSING"));
});

test("migration does not trust legacy Monday default", async () => {
  const migration = await readFile(new URL("../db/migrations/0033_payroll_week_boundary.sql", import.meta.url), "utf8");
  assert.match(migration, /week_start_rule/);
  assert.match(migration, /OTHER_REVIEW_REQUIRED/);
});

test("week boundary is part of the existing payroll settings flow", async () => {
  const api = await readFile(new URL("../app/api/manager/payroll/week-boundary/route.ts", import.meta.url), "utf8");
  const page = await readFile(new URL("../app/manager/payroll/page.tsx", import.meta.url), "utf8");
  const layout = await readFile(new URL("../app/manager/payroll/layout.tsx", import.meta.url), "utf8");
  assert.match(api, /CALENDAR_DEFAULT/);
  assert.match(api, /EXPLICIT_WEEKDAY/);
  assert.match(page, /特に定めなし（日曜日〜土曜日）/);
  assert.match(page, /就業規則等で曜日を定めている/);
  assert.match(page, /weekBoundaryApi\(storeId, "save"\)/);
  assert.match(page, /店舗ルールと週の区切りを保存/);
  assert.doesNotMatch(layout, /PayrollWeekBoundaryCard/);
});
