import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { coManagerFixture } from "./helpers/co-manager-fixture.mjs";

test("month lookup finds all saved periods beyond the latest 12 and does not replace them after closing changes", async () => {
  const f = await coManagerFixture();
  try {
    await f.seedReport();
    await f.db.query("UPDATE stores SET closing_rule='day_15' WHERE id=$1", [f.store]);
    for (let month = 1; month <= 12; month++) {
      const day = `2025-${String(month).padStart(2, "0")}-15`;
      await f.db.query("INSERT INTO monthly_attendance_deliveries(store_id,period_start,period_end,status,recipient,delivery_version,sent_at)VALUES($1,$2,$2,'SENT','fixture@example.invalid','initial',NOW())", [f.store, day]);
    }
    for (const [start, end] of [["2020-08-26", "2020-09-25"], ["2020-08-16", "2020-09-15"]]) {
      await f.db.query("INSERT INTO monthly_attendance_deliveries(store_id,period_start,period_end,status,recipient,delivery_version,sent_at)VALUES($1,$2,$3,'SENT','fixture@example.invalid','initial',NOW())", [f.store, start, end]);
    }
    await f.db.query("INSERT INTO monthly_attendance_deliveries(store_id,period_start,period_end,status,recipient,delivery_version,sent_at)VALUES($1,'2020-08-16','2020-09-15','SENT','fixture@example.invalid',$2,NOW())", [f.store, `reissue-${randomUUID()}`]);
    const latest = await f.call("monthly-attendance/reports");
    assert.equal(latest.body.reports.length, 12);
    assert.ok(latest.body.reports.every(r => !r.period_end.startsWith("2020")));
    for (const actor of ["fixture_manager", "fixture_delegate"]) {
      const response = await f.call("monthly-attendance/reports", { reportMonth: "2020-09" }, actor);
      assert.equal(response.status, 200);
      assert.equal(response.body.closingRule, "day_15");
      assert.equal(response.body.reportMonth, "2020-09");
      assert.match(response.body.today, /^\d{4}-\d{2}-\d{2}$/);
      assert.deepEqual(response.body.reports.map(r => [r.period_start, r.period_end]), [["2020-08-16", "2020-09-15"], ["2020-08-26", "2020-09-25"]]);
    }
    const absent = await f.call("monthly-attendance/reports", { reportMonth: "2024-02" });
    assert.deepEqual(absent.body.reports, []);
    assert.equal(absent.body.closingRule, "day_15");
    assert.equal(f.emails.length, 0);
  } finally { await f.db.close(); }
});

test("month lookup validates inputs and retains manager and store boundaries", async () => {
  const f = await coManagerFixture();
  try {
    for (const reportMonth of [null, [], "2026-9", "2026-00", "2026-13", "0000-01", "2026-09-01"]) {
      assert.equal((await f.call("monthly-attendance/reports", { reportMonth })).body.code, "INVALID_MONTH");
    }
    for (const actor of ["fixture_actor", "fixture_other"]) {
      assert.equal((await f.call("monthly-attendance/reports", { reportMonth: "2026-09" }, actor)).status, 403);
    }
    assert.equal((await f.call("monthly-attendance/reports", { reportMonth: "2026-09", storeId: f.otherStore })).status, 403);
    assert.equal((await f.call("monthly-attendance/reports", { reportMonth: "2026-09" }, "invalid")).status, 401);
    await f.db.query("UPDATE staff_manager_access SET status='inactive' WHERE staff_id=$1", [f.delegate]);
    assert.equal((await f.call("monthly-attendance/reports", { reportMonth: "2026-09" })).status, 403);
  } finally { await f.db.close(); }
});
