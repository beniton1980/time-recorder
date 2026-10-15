import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { coManagerFixture } from "./helpers/co-manager-fixture.mjs";
import { tokenHash } from "./helpers/recovery-database.mjs";

let f;
before(async () => { f = await coManagerFixture(); });
after(async () => { await f?.db.close(); });
const jst = (date, time) => `${date}T${time}:00+09:00`;
async function seed(db, punches, day) {
  const staffId = await db.staff(), ids = [];
  for (const [type, time, businessDate = day] of punches) {
    const id = randomUUID(); ids.push(id);
    await db.db.query("INSERT INTO punch_events(id,store_id,staff_id,event_type,occurred_at,business_date,client_request_id) VALUES($1,$2,$3,$4,$5,$6,$7)", [id,db.store,staffId,type,time,businessDate,randomUUID()]);
  }
  return {staffId,ids};
}
const save = (s, index, eventType, occurredAt, db = f) => db.call("punch-corrections", {staffId:s.staffId,operation:"REPLACE",targetEffectiveId:s.ids[index],eventType,occurredAt,reason:"Fictitious boundary correction"});
const month = async (s, value, db = f) => {
  const r = await db.call("staff-attendance", {staffId:s.staffId,month:value});
  assert.equal(r.status,200); return r.body;
};
const snapshot = async (s, db = f) => {
  const result = {};
  for (const table of ["punch_events","correction_requests","staff_states"])
    result[table] = (await db.db.query(`SELECT * FROM ${table} WHERE staff_id=$1 ORDER BY ${table === "staff_states" ? "staff_id" : "id"}`, [s.staffId])).rows;
  return result;
};

for (const [end,minutes,night] of [["04:59",419,419],["05:00",420,420],["05:01",421,420]]) {
  test(`checkout changed to ${end} stays in September with ${minutes} independently calculated minutes`, async () => {
    const s = await seed(f,[["CHECK_IN",jst("2026-09-30","22:00")],["CHECK_OUT",jst("2026-10-01","04:58")]],"2026-09-30");
    const original = (await snapshot(s)).punch_events;
    assert.equal((await save(s,1,"CHECK_OUT",jst("2026-10-01",end))).status,200);
    const sep = await month(s,"2026-09"), oct = await month(s,"2026-10");
    assert.equal(sep.days[0].status,"CONFIRMED");
    assert.equal(sep.days[0].workedMinutes,minutes); assert.equal(sep.days[0].lateNightMinutes,night);
    assert.ok(sep.events.every(e=>e.businessDate === "2026-09-30"));
    assert.equal(sep.summary.workDays,1); assert.equal(oct.summary.workDays,0); assert.equal(oct.days.length,0);
    assert.deepEqual((await snapshot(s)).punch_events,original);
  });
}

test("moving check-in across 05:00 moves the entire shift between months in both directions",async()=>{
  const s=await seed(f,[["CHECK_IN",jst("2026-10-01","05:00")],["BREAK_START",jst("2026-10-01","06:00")],["BREAK_END",jst("2026-10-01","06:30")],["CHECK_OUT",jst("2026-10-01","09:00")]],"2026-10-01");
  for(const [time,targetMonth,emptyMonth,expected]of[["04:59","2026-09","2026-10",211],["05:01","2026-10","2026-09",209]]){
    assert.equal((await save(s,0,"CHECK_IN",jst("2026-10-01",time))).status,200);
    const a=await month(s,targetMonth),b=await month(s,emptyMonth);
    assert.equal(a.events.length,4); assert.equal(a.days[0].status,"CONFIRMED");
    assert.equal(a.days[0].workedMinutes,expected); assert.equal(a.days[0].breakMinutes,30);
    assert.equal(a.summary.workDays,1); assert.equal(b.days.length,0);
  }
});

test("changing either end of a break across 05:00 keeps one complete overnight shift",async()=>{
  const s=await seed(f,[["CHECK_IN",jst("2026-09-30","22:00")],["BREAK_START",jst("2026-10-01","04:30")],["BREAK_END",jst("2026-10-01","04:59")],["CHECK_OUT",jst("2026-10-01","06:00")]],"2026-09-30");
  assert.equal((await save(s,2,"BREAK_END",jst("2026-10-01","05:30"))).status,200);
  assert.equal((await month(s,"2026-09")).days[0].workedMinutes,420);
  assert.equal((await save(s,1,"BREAK_START",jst("2026-10-01","05:01"))).status,200);
  const a=await month(s,"2026-09");
  assert.equal(a.days[0].workedMinutes,451); assert.equal(a.days[0].breakMinutes,29); assert.equal(a.days[0].lateNightMinutes,420);
  assert.equal((await month(s,"2026-10")).days.length,0);
});

test("manager-added punches use the same shift day on add, replace, repeat replace and void",async()=>{
  const staffId=await f.staff(); const s={staffId,ids:[]};
  for(const [eventType,occurredAt]of[["CHECK_IN",jst("2026-09-30","22:00")],["CHECK_OUT",jst("2026-10-01","05:01")]]){
    const r=await f.call("punch-corrections",{staffId,operation:"ADD",eventType,occurredAt,reason:"Fictitious addition"});
    assert.equal(r.status,200); s.ids.push(r.body.correction.id);
  }
  assert.equal((await month(s,"2026-09")).days[0].workedMinutes,421);
  for(const end of ["04:59","05:00"]){
    assert.equal((await save(s,1,"CHECK_OUT",jst("2026-10-01",end))).status,200);
  }
  assert.equal((await month(s,"2026-09")).days[0].workedMinutes,420);
  assert.equal((await f.call("punch-corrections",{staffId,operation:"VOID",targetEffectiveId:s.ids[1],reason:"Fictitious void"})).status,200);
  assert.equal((await month(s,"2026-09")).days[0].status,"NEEDS_REVIEW");
});

test("crossing another shift or duplicating a timestamp rolls back history and state",async()=>{
  const s=await seed(f,[["CHECK_IN",jst("2026-09-30","22:00")],["CHECK_OUT",jst("2026-10-01","04:59")],["CHECK_IN",jst("2026-10-01","06:00"),"2026-10-01"],["CHECK_OUT",jst("2026-10-01","09:00"),"2026-10-01"]],"2026-09-30");
  const before=await snapshot(s);
  for(const [index,type,time,code]of[[1,"CHECK_OUT","06:01","INVALID_PUNCH_SEQUENCE"],[0,"CHECK_IN","07:00","INVALID_PUNCH_SEQUENCE"],[1,"CHECK_OUT","06:00","DUPLICATE_PUNCH_TIME"],[2,"CHECK_IN","04:58","INVALID_PUNCH_SEQUENCE"]]){
    const r=await save(s,index,type,jst("2026-10-01",time));
    assert.equal(r.status,422); assert.equal(r.body.code,code); assert.deepEqual(await snapshot(s),before);
  }
});

test("moving an incomplete check-in is still allowed; unrelated errors and orphan days stay separate",async()=>{
  const s=await seed(f,[["CHECK_IN",jst("2026-09-30","09:00")],["CHECK_OUT",jst("2026-09-30","17:00")],["CHECK_OUT",jst("2026-10-02","17:00"),"2026-10-02"],["CHECK_IN",jst("2026-10-04","05:00"),"2026-10-04"]],"2026-09-30");
  assert.equal((await save(s,3,"CHECK_IN",jst("2026-10-04","04:59"))).status,200);
  assert.equal((await month(s,"2026-09")).days[0].workedMinutes,480);
  const events=(await month(s,"2026-10")).events;
  assert.deepEqual(events.map(e=>e.businessDate),["2026-10-02","2026-10-03"]);
});

test("0046 preserves stored records, RLS/ACL and valid shifts while repairing historical split corrections",async()=>{
  const old=await coManagerFixture({throughMigration:"0045_pending_shift_start.sql"});
  try{
    const s=await seed(old,[["CHECK_IN",jst("2026-09-30","22:00")],["CHECK_OUT",jst("2026-10-01","04:59")]],"2026-09-30");
    assert.equal((await save(s,1,"CHECK_OUT",jst("2026-10-01","05:01"),old)).status,200);
    assert.equal((await old.db.query("SELECT DISTINCT business_date FROM effective_punch_events WHERE staff_id=$1",[s.staffId])).rows.length,2);
    const before=await snapshot(s,old);
    const acl=async()=>({view:(await old.db.query("SELECT reloptions,relacl::text FROM pg_class WHERE oid='effective_punch_events'::regclass")).rows,fn:(await old.db.query("SELECT proacl::text,prosecdef,proconfig FROM pg_proc WHERE proname='apply_manager_direct_correction'")).rows});
    const permissions=await acl();
    const migration=await readFile(new URL("../db/migrations/0046_correction_business_day.sql",import.meta.url),"utf8");
    const viewBefore=(await old.db.query("SELECT * FROM effective_punch_events ORDER BY effective_id")).rows;
    await assert.rejects(old.db.exec(migration.replace("COMMIT;","SELECT 1 / 0;\nCOMMIT;")),/division by zero/);
    await old.db.exec("ROLLBACK;");
    assert.deepEqual((await old.db.query("SELECT * FROM effective_punch_events ORDER BY effective_id")).rows,viewBefore);
    assert.deepEqual(await snapshot(s,old),before); assert.deepEqual(await acl(),permissions);
    await old.db.exec(migration);
    assert.deepEqual(await snapshot(s,old),before); assert.deepEqual(await acl(),permissions);
    // The current application additionally requires 0047; 0046 invariants were checked above.
    await old.db.exec(await readFile(new URL("../db/migrations/0047_consultation_resolution.sql",import.meta.url),"utf8"));
    assert.equal((await month(s,"2026-09",old)).days[0].workedMinutes,421);
    assert.equal((await month(s,"2026-10",old)).days.length,0);
    const foreign=old.getSql({mode:"manager",lineIdentity:"fixture_other",storeId:old.store});
    assert.equal((await foreign`SELECT * FROM effective_punch_events WHERE staff_id=${s.staffId}::uuid`).length,0);
  }finally{await old.db.close();}
});

test("pending corrections follow a moved check-in without changing the submitted request",async()=>{
  const s=await seed(f,[["CHECK_IN",jst("2026-10-01","05:00")],["CHECK_OUT",jst("2026-10-01","09:00")]],"2026-10-01");
  const request=await f.pending(s.staffId,"BREAK_START",jst("2026-10-01","06:00"));
  await f.db.query("UPDATE correction_requests SET requested_business_date='2026-10-01' WHERE id=$1",[request]);
  const requestBefore=(await f.db.query("SELECT * FROM correction_requests WHERE id=$1",[request])).rows;
  assert.equal((await save(s,0,"CHECK_IN",jst("2026-10-01","04:59"))).status,200);
  const sep=await month(s,"2026-09"),oct=await month(s,"2026-10");
  assert.ok(sep.days[0].attendanceReasons.includes("PENDING_CORRECTION"));
  assert.equal(sep.summary.workDuration,"00:00"); assert.equal(oct.days.length,0);
  assert.deepEqual((await f.db.query("SELECT * FROM correction_requests WHERE id=$1",[request])).rows,requestBefore);
  const response=await f.dashboard.POST(new Request("http://fixture.local",{method:"POST",body:JSON.stringify({idToken:"fixture_manager",storeId:f.store})}));
  assert.equal(response.status,200);
  const pending=(await response.json()).corrections.find(r=>r.id===request);
  assert.equal(pending.day_events.length,2);
});

test("pending next-shift eligibility follows a corrected check-in across months",async()=>{
  const staffId=(await f.db.query("SELECT id FROM staff WHERE line_user_id='fixture_actor' AND store_id=$1",[f.store])).rows[0].id;
  const id=randomUUID();
  await f.db.query("INSERT INTO punch_events(id,store_id,staff_id,event_type,occurred_at,business_date,client_request_id) VALUES($1,$2,$3,'CHECK_IN',$4,'2026-10-01',$5)",[id,f.store,staffId,jst("2026-10-01","05:00"),randomUUID()]);
  await f.db.query("UPDATE staff_states SET state='WORKING',last_event_id=$1,last_event_at=$2 WHERE staff_id=$3",[id,jst("2026-10-01","05:00"),staffId]);
  const request=await f.pending(staffId,"CHECK_OUT",jst("2026-10-01","09:00"));
  await f.db.query("UPDATE correction_requests SET requested_business_date='2026-10-01',client_request_payload=$2 WHERE id=$1",[request,{category:"MISSED"}]);
  assert.equal((await save({staffId,ids:[id]},0,"CHECK_IN",jst("2026-10-01","04:59"))).status,200);
  const staffSql=f.getSql({mode:"staff",lineIdentity:"fixture_actor",storeTokenHash:tokenHash});
  const eligible=await staffSql`SELECT * FROM staff_pending_shift_start(${staffId}::uuid)`;
  assert.equal(eligible[0].request_id,request);assert.equal(eligible[0].business_date,"2026-09-30");
});
