import assert from "node:assert/strict";
import {test, before, after} from "node:test";
import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {fixture, tokenHash} from "./helpers/recovery-database.mjs";
import {deriveDailyAttendanceRecords} from "../lib/monthly-attendance.mjs";

let f, manager;
before(async () => {
  f = await fixture();
  await f.db.query("UPDATE staff SET role='MANAGER' WHERE id=$1", [f.staff]);
  manager = f.getSql({mode: "manager", lineIdentity: "fixture_actor", storeId: f.store});
});
after(async () => { await f?.db.close(); });
const at = (time, daysAgo = 3) => `${new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10)}T${time}:00+09:00`;
const migration = () => readFile(new URL("../db/migrations/0041_missed_correction_consistency.sql", import.meta.url), "utf8");

async function scenario() {
  const staff = randomUUID(), actor = `fixture_${staff}`;
  await f.db.query("INSERT INTO staff(id,store_id,line_user_id,legal_name) VALUES ($1,$2,$3,'Fixture')", [staff, f.store, actor]);
  await f.db.query("INSERT INTO staff_states(staff_id) VALUES ($1)", [staff]);
  const sql = f.getSql({mode: "staff", lineIdentity: actor, storeTokenHash: tokenHash});
  return {
    staff, actor, sql,
    async add(type, time) {
      const id = randomUUID();
      await f.db.query(`INSERT INTO punch_events(id,store_id,staff_id,event_type,occurred_at,business_date,client_request_id)
        SELECT $1,id,$2,$3,$4,
          CASE WHEN $3='CHECK_IN' THEN ((($4::timestamptz) AT TIME ZONE timezone)-make_interval(mins=>business_day_start_minute))::date
          ELSE COALESCE((SELECT epe.business_date FROM effective_punch_events epe
            WHERE epe.staff_id=$2 AND epe.event_type='CHECK_IN' AND epe.occurred_at <= $4::timestamptz
            ORDER BY epe.occurred_at DESC,epe.effective_id DESC LIMIT 1),
            ((($4::timestamptz) AT TIME ZONE timezone)-make_interval(mins=>business_day_start_minute))::date) END,$5
        FROM stores WHERE id=$6`, [id, staff, type, time, randomUUID(), f.store]);
      await f.db.query(`UPDATE staff_states SET state=latest.state,last_event_id=latest.id,last_event_at=latest.occurred_at FROM (
        SELECT id,occurred_at,CASE WHEN event_type='CHECK_OUT' THEN 'OFF_DUTY' WHEN event_type='BREAK_START' THEN 'ON_BREAK' ELSE 'WORKING' END state
        FROM punch_events WHERE staff_id=$1 ORDER BY occurred_at DESC LIMIT 1) latest WHERE staff_id=$1`, [staff]);
      return id;
    },
    async submit(type, time, end = null, id = randomUUID(), legacy = false) {
      const category = end ? "MISSED_BREAK" : "MISSED";
      const rows = legacy
        ? await sql`SELECT * FROM submit_staff_correction(${f.store}::uuid,${staff}::uuid,${id}::uuid,${category},NULL,NULL,${type},${time}::timestamptz,NULL)`
        : await sql`SELECT * FROM submit_staff_correction(${f.store}::uuid,${staff}::uuid,${id}::uuid,${category},NULL,NULL,${type},${time}::timestamptz,NULL,${end}::timestamptz)`;
      return rows[0];
    },
    preflight: (type, time, end = null) => sql`SELECT validate_correction_addition(${f.store}::uuid,${staff}::uuid,${type},${time}::timestamptz,${end}::timestamptz)`,
    rows: async () => (await f.db.query("SELECT * FROM correction_requests WHERE staff_id=$1 ORDER BY requested_occurred_at,id", [staff])).rows,
    events: async () => (await f.db.query("SELECT * FROM effective_punch_events WHERE staff_id=$1 ORDER BY occurred_at", [staff])).rows,
    state: async () => (await f.db.query("SELECT state FROM staff_states WHERE staff_id=$1", [staff])).rows[0].state,
  };
}
const decide = (id, decision = "APPROVED", type = null, time = null) => manager`
  SELECT * FROM decide_manager_correction(${f.store}::uuid,${id}::uuid,${decision},${type},${time}::timestamptz)`;

test("check-in alone cannot support a missed break end through preflight or either submission signature", async () => {
  const s = await scenario(); await s.add("CHECK_IN", at("09:00"));
  await assert.rejects(s.preflight("BREAK_END", at("13:00")), /CORRECTION_BREAK_START_REQUIRED/);
  await assert.rejects(s.submit("BREAK_END", at("13:00")), /CORRECTION_BREAK_START_REQUIRED/);
  await assert.rejects(s.submit("BREAK_END", at("13:00"), null, randomUUID(), true), /CORRECTION_BREAK_START_REQUIRED/);
  assert.equal((await s.rows()).length, 0);
  assert.equal((await s.events()).length, 1);
  assert.equal(await s.state(), "WORKING");
});

test("a missing first check-in remains requestable without any existing punch", async () => {
  const s = await scenario();
  await s.preflight("CHECK_IN", at("09:00"));
  assert.equal((await s.rows()).length, 0, "preflight does not save a request");
  const result = await s.submit("CHECK_IN", at("09:00"));
  assert.equal(result.correction_request.status, "PENDING");
  assert.equal(await s.state(), "OFF_DUTY");
  assert.equal((await s.events()).length, 0);
});

test("insertion uses historical neighbors and repairs a break before an already recorded checkout", async () => {
  const s = await scenario();
  await s.add("CHECK_IN", at("09:00")); await s.add("BREAK_START", at("12:00")); await s.add("CHECK_OUT", at("18:00"));
  assert.equal(await s.state(), "OFF_DUTY");
  const result = await s.submit("BREAK_END", at("13:00"));
  await decide(result.correction_request.id);
  const daily = deriveDailyAttendanceRecords(await s.events());
  assert.equal(daily[0].status, "CONFIRMED");
  assert.equal(daily[0].workedMinutes, 480);
  assert.equal(daily[0].breakMinutes, 60);
  assert.equal(await s.state(), "OFF_DUTY");
});

test("a candidate cannot break a correct following event, while unrelated existing errors do not forbid a valid pair", async () => {
  const s = await scenario();
  await s.add("CHECK_OUT", at("06:00")); // Existing unrelated contradiction.
  await s.add("CHECK_IN", at("09:00")); await s.add("CHECK_OUT", at("18:00"));
  await assert.rejects(s.submit("BREAK_START", at("12:00")), /CORRECTION_SEQUENCE_INVALID/);
  const result = await s.submit("BREAK_START", at("12:00"), at("13:00"));
  assert.equal(result.correction_request.status, "PENDING");
  await decide(result.correction_request.id);
  assert.equal((await s.events()).length, 5);
  assert.deepEqual(deriveDailyAttendanceRecords(await s.events())[0].attendanceReasons, ["LOGICAL_CONTRADICTION"]);
});

test("a paired break saves two linked rows once and approval preserves original history and complete daily totals", async () => {
  const s = await scenario();
  await s.add("CHECK_IN", at("09:00")); await s.add("CHECK_OUT", at("18:00"));
  const id = randomUUID();
  const [first, repeated] = await Promise.all([
    s.submit("BREAK_START", at("12:00"), at("13:00"), id), s.submit("BREAK_START", at("12:00"), at("13:00"), id),
  ]);
  assert.equal(first.correction_request.id, repeated.correction_request.id);
  const leader = first.correction_request.id;
  let rows = await s.rows();
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.status === "PENDING" && row.group_id === leader));
  assert.equal(rows.filter(row => row.client_request_id !== null).length, 1);
  assert.equal(new Date(first.correction_request.requested_break_ended_at).toISOString(), new Date(at("13:00")).toISOString());
  await assert.rejects(s.submit("BREAK_START", at("12:00"), at("14:00"), id), /CLIENT_REQUEST_CONFLICT/);
  assert.equal((await s.events()).length, 2);
  await decide(leader);
  rows = await s.rows();
  assert.ok(rows.every(row => row.status === "APPROVED"));
  assert.equal(rows[0].approved_at, rows[1].approved_at);
  assert.equal((await s.events()).length, 4);
  const originalCount = await f.db.query("SELECT count(*)::int n FROM punch_events WHERE staff_id=$1", [s.staff]);
  assert.equal(originalCount.rows[0].n, 2);
  const day = deriveDailyAttendanceRecords(await s.events())[0];
  assert.equal(day.status, "CONFIRMED"); assert.equal(day.workedMinutes, 480); assert.equal(day.breakMinutes, 60);
  assert.equal((await s.submit("BREAK_START", at("12:00"), at("13:00"), id)).result_status, "already_received");
  assert.equal((await decide(leader)).length, 0, "repeat decisions cannot apply the group twice");
});

test("rejecting via a paired child rejects both members and retry keeps the original decision", async () => {
  const s = await scenario(); await s.add("CHECK_IN", at("09:00"));
  const id = randomUUID(), result = await s.submit("BREAK_START", at("12:00"), at("13:00"), id);
  const child = (await s.rows()).find(row => row.id !== result.correction_request.id);
  await decide(child.id, "REJECTED");
  assert.ok((await s.rows()).every(row => row.status === "REJECTED"));
  assert.equal((await s.events()).length, 1);
  assert.equal(await s.state(), "WORKING");
  assert.equal((await s.submit("BREAK_START", at("12:00"), at("13:00"), id)).correction_request.status, "REJECTED");
});

test("same-time effective punches and distinct pending requests are rejected without treating pending as attendance", async () => {
  const s = await scenario(); await s.add("CHECK_IN", at("09:00"));
  await assert.rejects(s.submit("BREAK_START", at("09:00")), /CORRECTION_TIME_CONFLICT/);
  const pending = await s.submit("BREAK_START", at("12:00"));
  await assert.rejects(s.submit("BREAK_START", at("12:00")), /CORRECTION_PENDING_CONFLICT/);
  await assert.rejects(s.submit("BREAK_START", at("12:00"), at("13:00")), /CORRECTION_PENDING_CONFLICT/);
  await assert.rejects(s.submit("BREAK_END", at("13:00")), /CORRECTION_BREAK_START_REQUIRED/);
  assert.equal((await s.rows()).length, 1);
  await decide(pending.correction_request.id, "REJECTED");
  await s.submit("BREAK_START", at("12:00"), at("13:00"));
  await assert.rejects(s.submit("BREAK_END", at("13:00")), /CORRECTION_PENDING_CONFLICT/);
});

test("approval revalidates latest events and leaves both pending members unchanged after a conflicting punch", async () => {
  const s = await scenario(); await s.add("CHECK_IN", at("09:00")); await s.add("CHECK_OUT", at("18:00"));
  const result = await s.submit("BREAK_START", at("12:00"), at("13:00"));
  await s.add("BREAK_START", at("11:00"));
  await assert.rejects(decide(result.correction_request.id), /CORRECTION_SEQUENCE_INVALID/);
  assert.ok((await s.rows()).every(row => row.status === "PENDING" && row.approved_at === null));
  assert.equal((await s.events()).length, 3);
  await decide(result.correction_request.id, "REJECTED");
  assert.ok((await s.rows()).every(row => row.status === "REJECTED"));
});

test("approval rechecks against another approved correction rather than trusting the earlier preflight", async () => {
  const s = await scenario(); await s.add("CHECK_IN", at("09:00"));
  const first = await s.submit("BREAK_START", at("12:00"), at("13:00"));
  const second = await s.submit("BREAK_START", at("12:30"), at("13:30"));
  await decide(first.correction_request.id);
  await assert.rejects(decide(second.correction_request.id), /CORRECTION_SEQUENCE_INVALID/);
  assert.equal((await s.rows()).filter(row => row.status === "APPROVED").length, 2);
  assert.equal((await s.rows()).filter(row => row.status === "PENDING").length, 2);
});

test("OTHER cannot bypass consistency when its manager resolution adds an event", async () => {
  const s = await scenario(); await s.add("CHECK_IN", at("09:00"));
  const result = await s.sql`SELECT * FROM submit_staff_correction(${f.store}::uuid,${s.staff}::uuid,${randomUUID()}::uuid,'OTHER',NULL,NULL,NULL,NULL,'Fixture review')`;
  const id = result[0].correction_request.id;
  await assert.rejects(decide(id, "APPROVED", "BREAK_END", at("13:00")), /CORRECTION_BREAK_START_REQUIRED/);
  assert.equal((await s.rows())[0].status, "PENDING");
  await decide(id, "APPROVED", "CHECK_OUT", at("18:00"));
  assert.equal(deriveDailyAttendanceRecords(await s.events())[0].status, "CONFIRMED");
});

test("breaks inherit the check-in business day across 05:00 without depending on another incomplete day", async () => {
  const s = await scenario();
  await s.add("CHECK_IN", at("09:00", 6)); // Another incomplete day must not prevent this day's repair.
  await s.add("CHECK_IN", at("03:00"));
  await s.preflight("BREAK_START", at("04:00"), at("04:30"));
  await s.preflight("BREAK_START", at("04:00"), at("05:30"));
  await s.preflight("BREAK_START", at("05:30"), at("06:00"));
  await assert.rejects(s.preflight("BREAK_END", at("05:30")), /CORRECTION_BREAK_START_REQUIRED/);
  await s.preflight("CHECK_IN", at("05:30"));
  await assert.rejects(s.preflight("BREAK_START", at("04:30"), at("04:00")), /INVALID_CORRECTION_REQUEST/);
  await assert.rejects(s.preflight("CHECK_IN", at("09:00", 63)), /OCCURRED_AT_OUT_OF_RANGE/);
});

for (const [start, end] of [["04:45", "05:15"], ["05:30", "06:00"]]) {
  test(`a ${start}-${end} paired break within a 04:30-06:30 shift stays in one business day after approval`, async () => {
    const s = await scenario();
    await s.add("CHECK_IN", at("04:30")); await s.add("CHECK_OUT", at("06:30"));
    const originals = await s.events(), businessDate = originals[0].business_date;
    assert.equal(originals[1].business_date, businessDate, "ordinary checkout inherits the check-in's business day");
    const check = await s.preflight("BREAK_START", at(start), at(end));
    assert.equal(check[0].validate_correction_addition, businessDate);
    const request = await s.submit("BREAK_START", at(start), at(end));
    assert.ok((await s.rows()).every(row => row.requested_business_date === businessDate));
    await decide(request.correction_request.id);
    const events = await s.events();
    assert.equal(events.length, 4);
    assert.ok(events.every(event => event.business_date === businessDate));
    const days = deriveDailyAttendanceRecords(events);
    assert.equal(days.length, 1); assert.equal(days[0].status, "CONFIRMED");
    assert.equal(days[0].workedMinutes, 90); assert.equal(days[0].breakMinutes, 30);
  });
}

test("single break-end and checkout additions after 05:00 inherit their preceding check-in on approval", async () => {
  const endingBreak = await scenario();
  await endingBreak.add("CHECK_IN", at("04:30")); await endingBreak.add("BREAK_START", at("04:45"));
  await endingBreak.add("CHECK_OUT", at("06:30"));
  const end = await endingBreak.submit("BREAK_END", at("05:15"));
  await decide(end.correction_request.id);
  const breakDays = deriveDailyAttendanceRecords(await endingBreak.events());
  assert.equal(breakDays.length, 1); assert.equal(breakDays[0].status, "CONFIRMED");
  assert.equal(breakDays[0].workedMinutes, 90); assert.equal(breakDays[0].breakMinutes, 30);

  const endingWork = await scenario(); await endingWork.add("CHECK_IN", at("04:30"));
  const out = await endingWork.submit("CHECK_OUT", at("06:30")); await decide(out.correction_request.id);
  const workDays = deriveDailyAttendanceRecords(await endingWork.events());
  assert.equal(workDays.length, 1); assert.equal(workDays[0].status, "CONFIRMED");
  assert.equal(workDays[0].workedMinutes, 120);
});

test("a paired break crossing midnight retains its shift day and valid working minutes", async () => {
  const s = await scenario();
  await s.add("CHECK_IN", at("22:00", 4)); await s.add("CHECK_OUT", at("02:00", 3));
  const result = await s.submit("BREAK_START", at("23:45", 4), at("00:15", 3));
  await decide(result.correction_request.id);
  const events = await s.events();
  assert.ok(events.every(event => event.business_date === events[0].business_date));
  const days = deriveDailyAttendanceRecords(events);
  assert.equal(days.length, 1); assert.equal(days[0].status, "CONFIRMED");
  assert.equal(days[0].workedMinutes, 210); assert.equal(days[0].breakMinutes, 30);
});

test("a paired break cannot span a separate shift that starts after the business-day boundary", async () => {
  const s = await scenario();
  await s.add("CHECK_IN", at("04:30"));
  await s.add("CHECK_IN", at("06:30")); await s.add("CHECK_OUT", at("18:00"));
  await assert.rejects(s.submit("BREAK_START", at("04:45"), at("07:00")), /CORRECTION_SEQUENCE_INVALID/);
  assert.equal((await s.rows()).length, 0);
});

test("manager replacement of a paired break time keeps the business day of its check-in", async () => {
  const s = await scenario();
  await s.add("CHECK_IN", at("04:30")); await s.add("CHECK_OUT", at("06:30"));
  const result = await s.submit("BREAK_START", at("05:30"), at("06:00"));
  await decide(result.correction_request.id);
  const child = (await s.rows()).find(row => row.requested_event_type === "BREAK_END");
  await manager`SELECT * FROM apply_manager_direct_correction(${f.store}::uuid,${s.staff}::uuid,
    'REPLACE',NULL,${child.id}::uuid,'BREAK_END',${at("06:05")}::timestamptz,'Fixture time correction')`;
  const days = deriveDailyAttendanceRecords(await s.events());
  assert.equal(days.length, 1); assert.equal(days[0].status, "CONFIRMED");
  assert.equal(days[0].workedMinutes, 85); assert.equal(days[0].breakMinutes, 35);
});

test("preflight and submission fail closed for mismatched staff/store, absent context, and inactive membership", async () => {
  const s = await scenario(); await s.add("CHECK_IN", at("09:00"));
  await assert.rejects(s.sql`SELECT validate_correction_addition(${f.otherStore}::uuid,${s.staff}::uuid,'BREAK_START',${at("12:00")}::timestamptz,NULL)`, /STAFF_OR_STORE_NOT_FOUND/);
  await assert.rejects(s.sql`SELECT validate_correction_addition(${f.store}::uuid,${f.staff}::uuid,'CHECK_IN',${at("12:00")}::timestamptz,NULL)`, /STAFF_OR_STORE_NOT_FOUND/);
  const wrong = f.getSql({mode: "manager", lineIdentity: s.actor, storeId: f.store});
  await assert.rejects(wrong`SELECT validate_correction_addition(${f.store}::uuid,${s.staff}::uuid,'BREAK_START',${at("12:00")}::timestamptz,NULL)`, /MANAGER_ACCESS_REQUIRED/);
  const noContext = f.getSql({});
  await assert.rejects(noContext`SELECT validate_correction_addition(${f.store}::uuid,${s.staff}::uuid,'CHECK_IN',${at("12:00")}::timestamptz,NULL)`, /MANAGER_ACCESS_REQUIRED/);
  await f.db.query("UPDATE staff SET status='inactive' WHERE id=$1", [s.staff]);
  await assert.rejects(s.preflight("BREAK_START", at("12:00")), /STAFF_OR_STORE_NOT_FOUND/);
  await assert.rejects(s.submit("BREAK_START", at("12:00")), /STAFF_OR_STORE_NOT_FOUND/);
  assert.equal((await s.rows()).length, 0);
});

test("0040 saved MISSED, OTHER and MISTAKE intents remain replayable after upgrade even if newly invalid", async () => {
  const old = await fixture({throughMigration: "0040_staff_correction_idempotency.sql"});
  try {
    const sql = old.getSql({mode: "staff", lineIdentity: "fixture_actor", storeTokenHash: tokenHash});
    const missedId = randomUUID(), otherId = randomUUID(), mistakeId = randomUUID();
    const missed = () => sql`SELECT * FROM submit_staff_correction(${old.store}::uuid,${old.staff}::uuid,${missedId}::uuid,'MISSED',NULL,NULL,'BREAK_END',${at("13:00")}::timestamptz,NULL)`;
    const other = () => sql`SELECT * FROM submit_staff_correction(${old.store}::uuid,${old.staff}::uuid,${otherId}::uuid,'OTHER',NULL,NULL,NULL,NULL,'Legacy fixture review')`;
    const savedMissed = (await missed())[0], savedOther = (await other())[0];
    const target = await old.add("CHECK_OUT");
    const mistake = () => sql`SELECT * FROM submit_staff_correction(${old.store}::uuid,${old.staff}::uuid,${mistakeId}::uuid,'MISTAKE',${target}::uuid,${target}::uuid,'BREAK_START',NULL,NULL)`;
    const savedMistake = (await mistake())[0];
    const before = (await old.db.query("SELECT * FROM correction_requests ORDER BY id")).rows;
    const viewBefore = (await old.db.query("SELECT * FROM effective_punch_events ORDER BY effective_id")).rows;
    const permissionsBefore = (await old.db.query("SELECT reloptions,relacl::text FROM pg_class WHERE oid='public.effective_punch_events'::regclass")).rows;
    await old.db.exec(await migration());
    for (const [retry, original] of [[missed, savedMissed], [other, savedOther], [mistake, savedMistake]]) {
      const result = (await retry())[0];
      assert.equal(result.result_status, "already_received");
      assert.equal(result.correction_request.id, original.correction_request.id);
    }
    const afterRows = (await old.db.query("SELECT * FROM correction_requests ORDER BY id")).rows;
    assert.deepEqual(afterRows.map(({group_id, requested_business_date, ...row}) => {
      assert.equal(group_id, null); assert.equal(requested_business_date, null); return row;
    }), before);
    assert.deepEqual((await old.db.query("SELECT * FROM effective_punch_events ORDER BY effective_id")).rows, viewBefore);
    assert.deepEqual((await old.db.query("SELECT reloptions,relacl::text FROM pg_class WHERE oid='public.effective_punch_events'::regclass")).rows, permissionsBefore);
  } finally { await old.db.close(); }
});
