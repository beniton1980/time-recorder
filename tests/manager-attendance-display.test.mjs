import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { loadTs } from "./helpers/load-ts.mjs";
import { coManagerFixture } from "./helpers/co-manager-fixture.mjs";

const { attendanceDisplayTimes: display } = loadTs("lib/manager-attendance-display.ts");
const event = (businessDate, eventType, occurredAt) => ({ businessDate, eventType, occurredAt });
const plain = value => JSON.parse(JSON.stringify(value));
function times(day, values, timezone = "Asia/Tokyo") {
  return plain(display(values.map(([type, time]) => event(day, type, time)), timezone).get(day));
}

test("same-day clocks and break seconds stay unchanged; missing punches stay empty", () => {
  assert.deepEqual(times("2026-10-07", [
    ["CHECK_IN", "2026-10-07T09:00:00+09:00"], ["BREAK_START", "2026-10-07T12:00:05+09:00"],
    ["BREAK_END", "2026-10-07T13:00:07+09:00"], ["CHECK_OUT", "2026-10-07T17:00:00+09:00"],
  ]), { checkIn: "09:00", checkOut: "17:00", breakPeriods: ["12:00:05-13:00:07"] });
  assert.equal(times("2026-10-07", [["CHECK_IN", "2026-10-07T09:00:00+09:00"]]).checkOut, "");
});

test("actual timestamps distinguish overnight breaks, midnight and equal-clock 24-hour shifts", () => {
  assert.deepEqual(times("2026-10-08", [
    ["CHECK_IN", "2026-10-08T20:00:00+09:00"], ["BREAK_START", "2026-10-08T23:30:00+09:00"],
    ["BREAK_END", "2026-10-09T00:00:00+09:00"], ["CHECK_OUT", "2026-10-09T20:00:00+09:00"],
  ]), { checkIn: "20:00", checkOut: "翌日 20:00（10/9）", breakPeriods: ["23:30:00-翌日 00:00:00（10/9）"] });
});

test("month/year crossings, early-morning check-in and multi-day offsets use real dates", () => {
  assert.deepEqual(times("2026-09-30", [
    ["CHECK_IN", "2026-10-01T01:00:00+09:00"], ["BREAK_START", "2026-10-01T02:00:00+09:00"],
    ["BREAK_END", "2026-10-01T02:30:00+09:00"], ["CHECK_OUT", "2026-10-02T03:00:00+09:00"],
  ]), { checkIn: "翌日 01:00（10/1）", checkOut: "2日後 03:00（10/2）", breakPeriods: ["翌日 02:00:00（10/1）-翌日 02:30:00（10/1）"] });
  assert.equal(times("2025-12-31", [["CHECK_OUT", "2026-01-01T03:00:00+09:00"]]).checkOut, "翌日 03:00（2026/1/1）");
  assert.equal(times("2026-01-01", [["CHECK_IN", "2025-12-31T23:00:00+09:00"]]).checkIn, "前日 23:00（2025/12/31）");
});

test("store timezone and local calendar dates, not elapsed 24-hour periods, determine the label", () => {
  const punch = [["CHECK_OUT", "2026-10-08T17:00:00Z"]];
  assert.equal(times("2026-10-08", punch).checkOut, "翌日 02:00（10/9）");
  assert.equal(times("2026-10-08", punch, "UTC").checkOut, "17:00");
  assert.equal(times("2026-03-08", [["CHECK_OUT", "2026-03-09T00:30:00-04:00"]], "America/New_York").checkOut, "翌日 00:30（3/9）");
});

test("multiple and unclosed breaks retain report pairing without assigning a missing end", () => {
  assert.deepEqual(times("2026-10-08", [
    ["BREAK_START", "2026-10-08T21:00:00+09:00"], ["BREAK_END", "2026-10-08T21:15:00+09:00"],
    ["BREAK_START", "2026-10-09T01:00:00+09:00"],
  ]).breakPeriods, ["21:00:00-21:15:00", "翌日 01:00:00（10/9）-未終了"]);
});

test("missing timezone/events or invalid dates fall back instead of inventing a date", () => {
  const valid = [event("2026-10-08", "CHECK_OUT", "2026-10-09T02:00:00+09:00")];
  for (const zone of [undefined, "", "invalid/zone"]) assert.equal(display(valid, zone).size, 0);
  assert.equal(display(undefined, "Asia/Tokyo").size, 0);
  for (const events of [[event("2026-02-30", "CHECK_OUT", "2026-03-02T02:00:00Z")], [...valid, event("2026-10-08", "CHECK_IN", "invalid")]]) {
    assert.equal(display(events, "Asia/Tokyo").size, 0);
  }
});

test("real isolated attendance API exposes store timezone while preserving report clocks, totals and original punches", async () => {
  const f = await coManagerFixture();
  try {
    const staffId = await f.staff();
    for (const [type, time] of [["CHECK_IN", "2026-09-30T21:00:00+09:00"], ["BREAK_START", "2026-10-01T00:00:00+09:00"], ["BREAK_END", "2026-10-01T00:30:00+09:00"], ["CHECK_OUT", "2026-10-01T02:00:00+09:00"]]) {
      await f.db.query("INSERT INTO punch_events(id,store_id,staff_id,event_type,occurred_at,business_date,client_request_id) VALUES($1,$2,$3,$4,$5,'2026-09-30',$6)", [randomUUID(),f.store,staffId,type,time,randomUUID()]);
    }
    const read = () => f.call("staff-attendance", { staffId, month: "2026-09" });
    const before = await read();
    assert.equal(before.status, 200);
    const { body } = before;
    assert.equal(body.store.timezone, "Asia/Tokyo");
    assert.equal(body.summary.workDuration, "04:30");
    const day = body.days.find(day => day.businessDate === "2026-09-30");
    assert.equal(day.checkOut, "02:00");
    assert.equal(day.detailCheckOut, "02:00:00");
    assert.deepEqual(day.breakPeriods, ["00:00:00-00:30:00"]);
    assert.deepEqual(plain(display(body.events, body.store.timezone).get("2026-09-30")), {
      checkIn: "21:00", checkOut: "翌日 02:00（10/1）", breakPeriods: ["翌日 00:00:00（10/1）-翌日 00:30:00（10/1）"],
    });
    assert.deepEqual((await read()).body, body);
    assert.equal((await f.db.query("SELECT count(*)::int AS count FROM punch_events WHERE staff_id=$1", [staffId])).rows[0].count, 4);
    assert.equal((await f.call("staff-attendance", { staffId: f.otherStaff, month: "2026-09" })).status, 404);
  } finally { await f.db.close(); }
});
