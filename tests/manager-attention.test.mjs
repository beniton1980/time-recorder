import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { coManagerFixture } from "./helpers/co-manager-fixture.mjs";

let f;
before(async () => { f = await coManagerFixture(); });
after(async () => { await f?.db.close(); });

async function punch(staffId, type, daysAgo, hours = 0, storeId = f.store) {
  const id = randomUUID();
  const [{ occurred_at: at, business_date: date }] = (await f.db.query(`
    INSERT INTO punch_events(id, store_id, staff_id, event_type, occurred_at, business_date, client_request_id)
    SELECT $1,$2,$3,$4,
      (CASE WHEN $5 = 0 THEN NOW() ELSE (date_trunc('day',NOW() AT TIME ZONE timezone) + interval '12 hours') AT TIME ZONE timezone END) - make_interval(days => $5, hours => $6),
      ((NOW() AT TIME ZONE timezone) - make_interval(days => $5, mins => business_day_start_minute))::date,$7
    FROM stores WHERE id=$2 RETURNING occurred_at,business_date`, [id, storeId, staffId, type, daysAgo, hours, randomUUID()])).rows;
  await f.db.query("UPDATE staff_states SET state=$1,last_event_id=$2,last_event_at=$3 WHERE staff_id=$4", [type === "CHECK_OUT" ? "OFF_DUTY" : type === "BREAK_START" ? "ON_BREAK" : "WORKING", id, at, staffId]);
  return { id, at, date };
}
const items = async (body = {}, actor) => {
  const r = await f.call("dashboard", body, actor);
  assert.equal(r.status, 200, JSON.stringify(r));
  return r.body.attendanceAttention;
};

test("manager finds retained gaps and departed staff, but excludes ordinary work, empty days and GPS-only issues", async () => {
  const normal = await f.staff(), empty = await f.staff(), old = await f.staff(), carried = await f.staff(), complete = await f.staff();
  await punch(normal, "CHECK_IN", 0);
  const historical = await punch(old, "CHECK_IN", 90);
  await punch(old, "CHECK_IN", 3, 1); await punch(old, "CHECK_OUT", 3);
  await f.db.query("UPDATE staff SET status='departed' WHERE id=$1", [old]);
  const overnight = await punch(carried, "CHECK_IN", 2);
  await punch(complete, "CHECK_IN", 3, 1); await punch(complete, "CHECK_OUT", 3);
  await f.db.query("UPDATE punch_events SET location_status='WARNING',validation_code='OUTSIDE_STORE_RADIUS' WHERE staff_id=$1", [complete]);
  // Selecting a historical dashboard date must not classify today's normal work as a gap.
  const result = await items({ businessDate: "2026-01-01" });
  assert.equal(result.some(x => [normal, empty, complete].includes(x.staffId)), false);
  assert.deepEqual(result.filter(x => x.staffId === old).map(x => [x.businessDate, x.staffStatus, x.continuing]), [[historical.date, "departed", false]]);
  assert.deepEqual(result.filter(x => x.staffId === carried).map(x => [x.businessDate, x.continuing]), [[overnight.date, true]]);
  assert.match(result.find(x => x.staffId === old).message, /退勤の記録がありません/);
});

test("only a matching pending request covers a gap; rejection or an uncovered break keeps it visible", async () => {
  const worker = await f.staff();
  const start = await punch(worker, "CHECK_IN", 4);
  const request = await f.pending(worker, "CHECK_OUT", new Date(Date.parse(start.at) + 60000).toISOString());
  assert.equal((await items()).some(x => x.staffId === worker), false);
  await f.db.query("UPDATE correction_requests SET status='REJECTED' WHERE id=$1", [request]);
  assert.equal((await items()).some(x => x.staffId === worker), true);

  const breakWorker = await f.staff();
  await punch(breakWorker, "CHECK_IN", 2, 1);
  const pause = await punch(breakWorker, "BREAK_START", 2);
  await f.pending(breakWorker, "CHECK_OUT", new Date(Date.parse(pause.at) + 3600000).toISOString());
  assert.equal((await items()).some(x => x.staffId === breakWorker), true, "checkout request does not cover an open break");
  await f.pending(breakWorker, "BREAK_END", new Date(Date.parse(pause.at) + 1800000).toISOString());
  assert.equal((await items()).some(x => x.staffId === breakWorker), false);

  // An unassigned consultation never hides a gap; validated provenance does.
  const actor = (await f.db.query("SELECT id FROM staff WHERE line_user_id='fixture_actor'")).rows[0].id;
  const anchor = await punch(actor, "CHECK_IN", 5);
  assert.equal((await items()).some(x => x.staffId === actor), true);
  const consultation = (await f.db.query("SELECT id FROM correction_requests WHERE staff_id=$1 AND operation='REVIEW'", [actor])).rows[0].id;
  await f.db.query(`INSERT INTO correction_attention_sources(request_id,staff_id,store_id,source_event_id,source_reference,snapshot)
    VALUES($1,$2,$3,$4,$5,$6)`, [consultation, actor, f.store, anchor.id, { eventId: anchor.id, revision: "fixture" }, { businessDate: anchor.date }]);
  assert.equal((await items()).some(x => x.staffId === actor), false);
});

test("attention preserves manager and co-manager authorization and returns no other-store records", async () => {
  await punch(f.otherStaff, "CHECK_IN", 2, 0, f.otherStore);
  const owner = await items({}, "fixture_manager"), delegate = await items({}, "fixture_delegate");
  assert.deepEqual(delegate, owner);
  assert.equal(delegate.some(x => x.staffId === f.otherStaff), false);
  for (const actor of ["fixture_actor", "fixture_other"]) assert.equal((await f.call("dashboard", {}, actor)).status, 403);
  assert.equal((await f.call("dashboard", { storeId: f.otherStore })).status, 403);
  for (const status of ["inactive", "departed"]) {
    await f.db.query("UPDATE staff SET status=$1 WHERE id=$2", [status, f.delegate]);
    assert.equal((await f.call("dashboard")).status, 403);
  }
  await f.db.query("UPDATE staff SET status='active' WHERE id=$1", [f.delegate]);
  await f.db.query("UPDATE staff_manager_access SET status='inactive' WHERE staff_id=$1", [f.delegate]);
  assert.equal((await f.call("dashboard")).status, 403);
  await f.db.query("UPDATE staff_manager_access SET status='active' WHERE staff_id=$1", [f.delegate]);
});
