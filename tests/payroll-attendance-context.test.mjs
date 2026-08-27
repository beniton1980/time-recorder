import test from "node:test";
import assert from "node:assert/strict";
import { planPayrollAttendanceContext } from "../lib/payroll-attendance-context.mjs";

test("month-end payroll loads from the earlier of overtime month and statutory week", () => {
  const result = planPayrollAttendanceContext({
    payPeriodStart: "2026-08-01",
    payPeriodEnd: "2026-08-31",
    overtimeMonthStart: "2026-08-01",
    overtimeMonthEnd: "2026-08-31",
    weekStartsOn: 1,
  });
  assert.deepEqual(result.queryPeriod, { start: "2026-07-27", end: "2026-08-31" });
  assert.equal(result.weekContextComplete, true);
  assert.equal(result.overtimeMonthContextComplete, true);
});

test("mid-month payroll includes the overtime-month history before the pay period", () => {
  const result = planPayrollAttendanceContext({
    payPeriodStart: "2026-08-01",
    payPeriodEnd: "2026-08-15",
    overtimeMonthStart: "2026-07-16",
    overtimeMonthEnd: "2026-08-15",
    weekStartsOn: 1,
  });
  assert.deepEqual(result.queryPeriod, { start: "2026-07-16", end: "2026-08-15" });
  assert.equal(result.payPeriodInsideOvertimeMonth, true);
});

test("pay period crossing an overtime-month boundary is not declared complete", () => {
  const result = planPayrollAttendanceContext({
    payPeriodStart: "2026-08-01",
    payPeriodEnd: "2026-08-31",
    overtimeMonthStart: "2026-08-16",
    overtimeMonthEnd: "2026-09-15",
    weekStartsOn: 1,
  });
  assert.equal(result.overtimeMonthContextComplete, false);
  assert.equal(result.payPeriodInsideOvertimeMonth, false);
});

test("Sunday week start changes only the weekly boundary", () => {
  const result = planPayrollAttendanceContext({
    payPeriodStart: "2026-08-03",
    payPeriodEnd: "2026-08-31",
    overtimeMonthStart: "2026-08-03",
    overtimeMonthEnd: "2026-09-02",
    weekStartsOn: 0,
  });
  assert.equal(result.weekContextStart, "2026-08-02");
  assert.deepEqual(result.queryPeriod, { start: "2026-08-02", end: "2026-08-31" });
});
