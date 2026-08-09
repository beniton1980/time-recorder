import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { assessAttendance, calculateClosingPeriod } from "../lib/monthly-attendance.mjs";

test("closing periods follow month-end, 15th, and 25th rules", () => {
  assert.deepEqual(calculateClosingPeriod("month_end", "2024-02-29"), { start: "2024-02-01", end: "2024-02-29" });
  assert.deepEqual(calculateClosingPeriod("day_15", "2026-08-15"), { start: "2026-07-16", end: "2026-08-15" });
  assert.deepEqual(calculateClosingPeriod("day_25", "2026-08-25"), { start: "2026-07-26", end: "2026-08-25" });
});

test("attendance issues are grouped by staff and business date", () => {
  const days = assessAttendance([
    { staff_id: "inactive", business_date: "2026-08-25", occurred_at: "2026-08-25T22:00:00Z", effective_id: "1", event_type: "CHECK_IN", validation_code: null, source: "LIFF" },
    { staff_id: "inactive", business_date: "2026-08-25", occurred_at: "2026-08-26T02:00:00Z", effective_id: "2", event_type: "BREAK_START", validation_code: null, source: "LIFF" },
  ], [{ staff_id: "inactive", business_date: "2026-08-25" }]);
  assert.deepEqual(days[0].attendanceReasons.sort(), ["PENDING_CORRECTION", "UNCLOSED_BREAK", "UNCLOSED_SHIFT"]);
});

test("logical contradictions are detected without discarding GPS-warning punches", () => {
  const days = assessAttendance([
    { staff_id: "s1", business_date: "2026-08-10", occurred_at: "1", effective_id: "1", event_type: "CHECK_OUT", validation_code: "OUTSIDE_STORE_RADIUS", location_status: "WARNING", source: "LIFF" },
  ]);
  assert.deepEqual(days[0].attendanceReasons, ["LOGICAL_CONTRADICTION"]);
  assert.equal(days[0].gpsIssues[0].reason, "OUTSIDE_STORE_RADIUS");
});

test("store location absence and manager corrections are not staff GPS issues", () => {
  const days = assessAttendance([
    { staff_id: "s1", business_date: "2026-08-10", occurred_at: "1", effective_id: "1", event_type: "CHECK_IN", validation_code: "STORE_LOCATION_UNAVAILABLE", source: "LIFF" },
    { staff_id: "s1", business_date: "2026-08-10", occurred_at: "2", effective_id: "2", event_type: "CHECK_OUT", validation_code: "APPROVED_CORRECTION_ADD", source: "CORRECTION" },
  ]);
  assert.equal(days[0].gpsIssues.length, 0);
});

test("query uses effective events and does not filter inactive staff", async () => {
  const source = await readFile(new URL("../lib/monthly-attendance-query.ts", import.meta.url), "utf8");
  assert.match(source, /FROM effective_punch_events epe/);
  assert.match(source, /epe\.business_date BETWEEN/);
  assert.match(source, /cr\.status = 'PENDING'/);
  assert.doesNotMatch(source, /st\.status = 'active'/);
});

