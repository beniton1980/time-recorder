import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { fixture } from "./helpers/recovery-database.mjs";
import { deriveDailyAttendanceRecords } from "../lib/monthly-attendance.mjs";
import { loadTs } from "./helpers/load-ts.mjs";

const { loadMonthlyAttendance } = loadTs("lib/monthly-attendance-query.ts", {
  "@/lib/monthly-attendance.mjs": { deriveDailyAttendanceRecords },
});

const day = new Date(Date.now() + 9 * 3600000 - 86400000).toISOString().slice(0, 10);
const at = time => `${day}T${time}:00+09:00`;
const missed = (type, time) => ({ category: "MISSED", eventType: type, occurredAt: at(time) });
const pair = () => ({ category: "MISSED_BREAK", eventType: "BREAK_START", occurredAt: at("12:00"), breakEndedAt: at("13:00") });
async function seed(f, type, time, businessDay = day) {
  const id = randomUUID();
  await f.db.query("INSERT INTO punch_events(id,store_id,staff_id,event_type,occurred_at,business_date,client_request_id) VALUES ($1,$2,$3,$4,$5,$6,$7)", [id,f.store,f.staff,type,at(time),businessDay,randomUUID()]);
  await f.db.query("UPDATE staff_states SET state=$1,last_event_id=$2,last_event_at=$3 WHERE staff_id=$4", [type === "CHECK_OUT" ? "OFF_DUTY" : type === "BREAK_START" ? "ON_BREAK" : "WORKING",id,at(time),f.staff]);
}
async function manager(f) {
  await f.db.query("INSERT INTO staff(id,store_id,line_user_id,legal_name,role) VALUES ($1,$2,'fixture_manager','Fictitious manager','MANAGER')", [randomUUID(),f.store]);
}
const submit = (f, intent) => f.call(f.correction, { ...intent, clientRequestId: randomUUID() });
const decision = (f, id, choice = "APPROVED", extra = {}) => f.call(f.decision, { idToken: "fixture_manager", storeId: f.store, requestId: id, decision: choice, ...extra });
const count = async f => (await f.db.query("SELECT count(*)::int AS n FROM correction_requests")).rows[0].n;

test("future dates cannot pass preflight, direct submission, or manager approval", async () => {
  const f = await fixture();
  try {
    await manager(f);
    const future = new Date(Date.now() + 120000).toISOString();
    const before = await count(f);
    const intent = { category:"MISSED", eventType:"CHECK_IN", occurredAt:future };
    for (const result of [await f.call(f.validate,intent), await submit(f,intent)]) {
      assert.equal(result.status,400);
      assert.equal(result.code,"OCCURRED_AT_IN_FUTURE");
    }
    assert.equal(await count(f),before);
    const legacyId = randomUUID();
    await f.db.query("INSERT INTO correction_requests(id,store_id,staff_id,operation,requested_event_type,requested_occurred_at,reason) VALUES ($1,$2,$3,'ADD','CHECK_IN',$4,'Future legacy fixture')",[legacyId,f.store,f.staff,future]);
    const result = await decision(f,legacyId);
    assert.equal(result.status,400);
    assert.equal(result.code,"OCCURRED_AT_IN_FUTURE");
    assert.equal((await f.db.query("SELECT status FROM correction_requests WHERE id=$1",[legacyId])).rows[0].status,"PENDING");
    assert.equal((await f.db.query("SELECT count(*)::int n FROM effective_punch_events WHERE staff_id=$1",[f.staff])).rows[0].n,0);
  } finally { await f.db.close(); }
});

test("a past break start with a future end cannot be submitted", async () => {
  const f = await fixture();
  try {
    await seed(f,"CHECK_IN","09:00");
    const before = await count(f);
    const intent = {...pair(), breakEndedAt:new Date(Date.now()+120000).toISOString()};
    for (const result of [await f.call(f.validate,intent),await submit(f,intent)]) {
      assert.equal(result.status,400);
      assert.equal(result.code,"OCCURRED_AT_IN_FUTURE");
    }
    assert.equal(await count(f),before);
    assert.equal((await f.db.query("SELECT count(*)::int n FROM effective_punch_events WHERE staff_id=$1",[f.staff])).rows[0].n,1);
  } finally { await f.db.close(); }
});

test("preflight and direct submission reject a lone break end without writing", async () => {
  const f = await fixture();
  try {
    const malformed = await f.validate.POST(new Request("http://fixture.local/api", { method: "POST", body: "null" }));
    assert.equal(malformed.status,400);
    assert.equal((await malformed.json()).code,"INVALID_REQUEST");
    await seed(f,"CHECK_IN","09:00");
    const before = await count(f);
    for (const result of [await f.call(f.validate,missed("BREAK_END","13:00")), await submit(f,missed("BREAK_END","13:00"))]) {
      assert.equal(result.status,409);
      assert.equal(result.code,"CORRECTION_BREAK_START_REQUIRED");
    }
    assert.equal(await count(f),before);
    assert.equal((await f.call(f.validate,{...pair(),idToken:"invalid"})).status,401);
    assert.equal((await f.call(f.validate,{...pair(),idToken:"fixture_other"})).status,404);
    assert.equal((await f.call(f.validate,{...pair(),storeToken:null})).status,400);
    await f.db.query("UPDATE staff SET status='inactive' WHERE id=$1",[f.staff]);
    assert.equal((await f.call(f.validate,pair())).status,404);
    assert.equal(await count(f),before);
  } finally { await f.db.close(); }
});

test("a past break pair is one visible request and one approval yields a coherent daily record", async () => {
  const f = await fixture();
  try {
    await manager(f);
    await seed(f,"CHECK_IN","09:00");
    await seed(f,"CHECK_OUT","18:00");
    const before = await count(f);
    assert.equal((await f.call(f.validate,pair())).ok,true);
    assert.equal(await count(f),before,"validation must not create pending requests");
    const response = await submit(f,pair());
    assert.equal(response.ok,true);
    assert.equal(response.correctionRequest.status,"PENDING");
    assert.equal(await count(f),before+2);
    const dashboard = await f.call(f.dashboard,{idToken:"fixture_manager",storeId:f.store,businessDate:day});
    assert.equal(dashboard.ok,true);
    const shown = dashboard.corrections.filter(row=>row.group_id);
    assert.equal(shown.length,1);
    assert.equal(shown[0].id,response.correctionRequest.id);
    assert.equal(Date.parse(shown[0].requested_break_ended_at),Date.parse(at("13:00")));
    const approved = await decision(f,shown[0].id);
    assert.equal(approved.ok,true);
    const group = (await f.db.query("SELECT status FROM correction_requests WHERE group_id=$1",[shown[0].id])).rows;
    assert.deepEqual(group.map(row=>row.status),["APPROVED","APPROVED"]);
    const events = (await f.db.query("SELECT * FROM effective_punch_events WHERE staff_id=$1",[f.staff])).rows;
    const daily = deriveDailyAttendanceRecords(events)[0];
    assert.equal(daily.status,"CONFIRMED");
    assert.equal(daily.workedMinutes,480);
    assert.equal(daily.breakMinutes,60);
    assert.equal((await decision(f,shown[0].id)).status,409);
  } finally { await f.db.close(); }
});

test("an after-boundary break remains on the check-in day in pending history and monthly results", async () => {
  const f = await fixture();
  try {
    await manager(f);
    const businessDay = new Date(Date.parse(`${day}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
    await seed(f,"CHECK_IN","04:30",businessDay);
    await seed(f,"CHECK_OUT","06:30",businessDay);
    const response = await submit(f,{category:"MISSED_BREAK",eventType:"BREAK_START",occurredAt:at("05:15"),breakEndedAt:at("05:45")});
    assert.equal(response.ok,true);
    const dashboard = await f.call(f.dashboard,{idToken:"fixture_manager",storeId:f.store,businessDate:day});
    const shown = dashboard.corrections.find(row=>row.id === response.correctionRequest.id);
    assert.deepEqual(shown.day_events.map(row=>row.event_type),["CHECK_IN","CHECK_OUT"]);
    const sql = f.getSql({mode:"manager",lineIdentity:"fixture_manager",storeId:f.store});
    const pending = await loadMonthlyAttendance(sql,f.store,{start:businessDay,end:businessDay});
    assert.equal(pending.days.length,1);
    assert.equal(pending.days[0].status,"NEEDS_REVIEW");
    assert.ok(pending.days[0].attendanceReasons.includes("PENDING_CORRECTION"));
    assert.equal((await decision(f,response.correctionRequest.id)).ok,true);
    const result = await loadMonthlyAttendance(sql,f.store,{start:businessDay,end:businessDay});
    assert.equal(result.days.length,1);
    assert.equal(result.days[0].status,"CONFIRMED");
    assert.equal(result.days[0].workedMinutes,90);
    assert.equal(result.days[0].breakMinutes,30);
    assert.equal((await loadMonthlyAttendance(sql,f.store,{start:day,end:day})).days.length,0);
  } finally { await f.db.close(); }
});

test("approval rechecks changed history, retains both pending rows, and allows a grouped rejection", async () => {
  const f = await fixture();
  try {
    await manager(f);
    await seed(f,"CHECK_IN","09:00");
    const saved = await submit(f,pair());
    assert.equal(saved.ok,true);
    await seed(f,"BREAK_START","12:00");
    const result = await decision(f,saved.correctionRequest.id);
    assert.equal(result.status,409);
    assert.equal(result.code,"CORRECTION_TIME_CONFLICT");
    assert.deepEqual((await f.db.query("SELECT status FROM correction_requests WHERE group_id=$1",[saved.correctionRequest.id])).rows.map(row=>row.status),["PENDING","PENDING"]);
    assert.equal((await f.db.query("SELECT state FROM staff_states WHERE staff_id=$1",[f.staff])).rows[0].state,"ON_BREAK");
    assert.equal((await decision(f,saved.correctionRequest.id,"REJECTED")).ok,true);
    assert.deepEqual((await f.db.query("SELECT status FROM correction_requests WHERE group_id=$1",[saved.correctionRequest.id])).rows.map(row=>row.status),["REJECTED","REJECTED"]);
  } finally { await f.db.close(); }
});

test("old pending ADD and resolved REVIEW requests cannot bypass the approval guard", async () => {
  const f = await fixture();
  try {
    await manager(f);
    await seed(f,"CHECK_IN","09:00");
    const legacyId = randomUUID();
    await f.db.query("INSERT INTO correction_requests(id,store_id,staff_id,operation,requested_event_type,requested_occurred_at,reason) VALUES ($1,$2,$3,'ADD','BREAK_END',$4,'Legacy fictitious request')",[legacyId,f.store,f.staff,at("13:00")]);
    assert.equal((await decision(f,legacyId)).code,"CORRECTION_BREAK_START_REQUIRED");
    const reviewId = (await f.db.query("SELECT id FROM correction_requests WHERE reason='Legacy fixture'")).rows[0].id;
    assert.equal((await decision(f,reviewId,"APPROVED",{resolvedEventType:"BREAK_END",resolvedOccurredAt:at("14:00")})).code,"CORRECTION_BREAK_START_REQUIRED");
    assert.equal((await f.call(f.decision,{idToken:"fixture_other",storeId:f.store,requestId:legacyId,decision:"APPROVED"})).status,403);
    assert.equal((await f.db.query("SELECT count(*)::int n FROM correction_requests WHERE status='APPROVED'")).rows[0].n,0);
  } finally { await f.db.close(); }
});
