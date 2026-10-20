import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, after, test } from "node:test";
import { coManagerFixture } from "./helpers/co-manager-fixture.mjs";
import { token } from "./helpers/recovery-database.mjs";

let f;
before(async () => { f = await coManagerFixture(); });
after(async () => { await f?.db.close(); });

async function formerStaff(status) {
  const staffId = await f.staff();
  await f.db.query("UPDATE staff SET status=$1 WHERE id=$2", [status, staffId]);
  return staffId;
}
async function event(staffId, type, time, day = "2026-09-15") {
  const id = randomUUID();
  await f.db.query("INSERT INTO punch_events(id,store_id,staff_id,event_type,occurred_at,business_date,client_request_id) SELECT $1,store_id,id,$3,$4,$5,$6 FROM staff WHERE id=$2", [id,staffId,type,time,day,randomUUID()]);
  return id;
}
const attendance = (staffId, actor = "fixture_delegate", extra = {}) =>
  f.call("staff-attendance", {staffId,month:"2026-09",...extra}, actor);
const correct = (staffId, body, actor = "fixture_delegate") =>
  f.call("punch-corrections", {staffId,reason:"Fixture past attendance",...body}, actor);
const counts = async () => (await f.db.query("SELECT (SELECT count(*)::int FROM punch_events) punches,(SELECT count(*)::int FROM correction_requests) corrections")).rows[0];

test("active managers and co-managers can read inactive/departed attendance including the last overnight shift", async () => {
  for (const status of ["inactive","departed"]) {
    const staffId = await formerStaff(status);
    await event(staffId,"CHECK_IN","2026-09-15T11:00:00Z");
    await event(staffId,"CHECK_OUT","2026-09-15T17:00:00Z");
    for (const actor of ["fixture_manager","fixture_delegate"]) {
      const r = await attendance(staffId,actor);
      assert.equal(r.status,200,JSON.stringify(r));
      assert.equal(r.body.summary.workDuration,"06:00");
      assert.equal(r.body.events.length,2);
      assert.equal(r.body.staffOptions.find(s=>s.id===staffId).status,status);
      assert.ok(r.body.staffOptions.every(s=>s.id!==f.otherStaff));
      assert.equal((await attendance(staffId,actor,{month:"2026-08"})).body.summary.workDays,0);
    }
  }
});

test("former staff ADD/REPLACE/VOID preserves original punches, membership and approval audit", async () => {
  for (const status of ["inactive","departed"]) for (const actor of ["fixture_manager","fixture_delegate"]) {
    const staffId = await formerStaff(status);
    await event(staffId,"CHECK_IN","2026-09-15T01:00:00Z");
    const out = await event(staffId,"CHECK_OUT","2026-09-15T07:00:00Z");
    const original = (await f.db.query("SELECT * FROM punch_events WHERE staff_id=$1 ORDER BY id",[staffId])).rows;
    assert.equal((await correct(staffId,{operation:"REPLACE",targetEffectiveId:out,eventType:"CHECK_OUT",occurredAt:"2026-09-15T08:00:00Z"},actor)).status,200);
    assert.equal((await attendance(staffId,actor)).body.summary.workDuration,"07:00");
    const added = await correct(staffId,{operation:"ADD",eventType:"CHECK_IN",occurredAt:"2026-09-16T01:00:00Z"},actor);
    assert.equal(added.status,200,JSON.stringify(added));
    const addedId = (await f.db.query("SELECT effective_id FROM effective_punch_events WHERE staff_id=$1 AND business_date='2026-09-16'",[staffId])).rows[0].effective_id;
    assert.equal((await correct(staffId,{operation:"VOID",targetEffectiveId:addedId},actor)).status,200);
    const audit = (await f.db.query("SELECT operation,approved_by,status FROM correction_requests WHERE staff_id=$1 ORDER BY created_at",[staffId])).rows;
    assert.deepEqual(audit.map(r=>r.operation),["REPLACE","ADD","VOID"]);
    assert.ok(audit.every(r=>r.status==="APPROVED"&&r.approved_by===(actor==="fixture_manager"?f.owner:f.delegate)));
    assert.deepEqual((await f.db.query("SELECT * FROM punch_events WHERE staff_id=$1 ORDER BY id",[staffId])).rows,original);
    assert.equal((await f.db.query("SELECT status FROM staff WHERE id=$1",[staffId])).rows[0].status,status);
    assert.equal((await f.db.query("SELECT state FROM staff_states WHERE staff_id=$1",[staffId])).rows[0].state,"OFF_DUTY");
    assert.equal((await attendance(staffId,actor)).body.summary.workDuration,"07:00");
  }
});

test("future, invalid sequence, and foreign targets remain rejected without writing", async () => {
  for (const status of ["inactive","departed"]) {
    const staffId = await formerStaff(status);
    const own = await event(staffId,"CHECK_IN","2026-09-15T01:00:00Z");
    const foreign = await event(f.otherStaff,"CHECK_OUT","2026-09-15T07:00:00Z");
    const before = await counts();
    const future = new Date(Date.now()+3600000).toISOString();
    for(const body of [{operation:"ADD",eventType:"CHECK_IN",occurredAt:future},{operation:"REPLACE",targetEffectiveId:own,eventType:"CHECK_IN",occurredAt:future}]) {
      const r = await correct(staffId,body);
      assert.equal(r.status,400); assert.equal(r.body.code,"OCCURRED_AT_IN_FUTURE");
    }
    assert.equal((await correct(staffId,{operation:"ADD",eventType:"CHECK_IN",occurredAt:"2026-09-15T02:00:00Z"})).body.code,"INVALID_PUNCH_SEQUENCE");
    assert.equal((await correct(staffId,{operation:"VOID",targetEffectiveId:foreign})).body.code,"TARGET_NOT_FOUND");
    assert.equal((await correct(f.otherStaff,{operation:"VOID",targetEffectiveId:foreign})).body.code,"STAFF_NOT_FOUND");
    assert.equal((await attendance(f.otherStaff)).body.code,"STAFF_NOT_FOUND");
    assert.deepEqual(await counts(),before);
  }
});

test("actor authorization remains active and same-store even when the target is departed", async () => {
  const staffId = await formerStaff("departed"), before = await counts();
  for(const c of [
    {actor:"fixture_actor"},{actor:"fixture_other"},{actor:"invalid"},
    {actor:"fixture_delegate",status:"inactive"},{actor:"fixture_delegate",status:"departed"},
    {actor:"fixture_delegate",access:"inactive"},{actor:"fixture_delegate",storeStatus:"suspended"},
    {actor:"fixture_delegate",storeId:f.otherStore},
    {actor:"fixture_manager",status:"inactive"},{actor:"fixture_manager",status:"departed"},
  ]) {
    await f.db.query("UPDATE staff SET status='active' WHERE id IN ($1,$2)",[f.owner,f.delegate]);
    const actorId=c.actor==="fixture_manager"?f.owner:f.delegate;
    if(c.status) await f.db.query("UPDATE staff SET status=$1 WHERE id=$2",[c.status,actorId]);
    await f.db.query("UPDATE staff_manager_access SET status=$1 WHERE staff_id=$2",[c.access??"active",f.delegate]);
    await f.db.query("UPDATE stores SET status=$1 WHERE id=$2",[c.storeStatus??"active",f.store]);
    const payload={storeId:c.storeId??f.store};
    for(const r of [await attendance(staffId,c.actor,payload),await correct(staffId,{...payload,operation:"ADD",eventType:"CHECK_IN",occurredAt:"2026-09-18T01:00:00Z"},c.actor)]) {
      assert.equal(r.status,c.actor==="invalid"?401:403,JSON.stringify({c,r}));
    }
  }
  await f.db.query("UPDATE staff SET status='active' WHERE id IN ($1,$2)",[f.owner,f.delegate]);
  await f.db.query("UPDATE staff_manager_access SET status='active' WHERE staff_id=$1",[f.delegate]);
  await f.db.query("UPDATE stores SET status='active' WHERE id=$1",[f.store]);
  assert.deepEqual(await counts(),before);
});

test("stopped/departed people still cannot punch or self-register through bootstrap after manager corrections", async () => {
  const staffId=(await f.db.query("SELECT id FROM staff WHERE line_user_id='fixture_actor'")).rows[0].id;
  for(const [index,status] of ["inactive","departed"].entries()){
    await f.db.query("UPDATE staff SET status=$1 WHERE id=$2",[status,staffId]);
    assert.equal((await correct(staffId,{operation:"ADD",eventType:"CHECK_IN",occurredAt:`2026-09-${20+index}T01:00:00Z`})).status,200);
    const before = await counts();
    const body={idToken:"fixture_actor",storeToken:token};
    const bootstrap = await f.bootstrap.POST(new Request("http://fixture.local/api",{method:"POST",body:JSON.stringify(body)}));
    const state=await bootstrap.json();
    assert.equal(state.code,"STAFF_INACTIVE",JSON.stringify(state));
    const punch=await f.punch.POST(new Request("http://fixture.local/api",{method:"POST",body:JSON.stringify({...body,eventType:"CHECK_OUT",clientRequestId:randomUUID(),expectedStateVersion:"0"})}));
    const punchResult=await punch.json();
    assert.equal(punch.status,404,JSON.stringify(punchResult));
    assert.equal(punchResult.code,"STAFF_NOT_REGISTERED");
    const register = await f.selfRegister.POST(new Request("http://fixture.local/api",{method:"POST",body:JSON.stringify({...body,legalName:"Fixture duplicate"})}));
    assert.equal(register.status,409);
    assert.equal((await register.json()).code,"STAFF_ALREADY_REGISTERED");
    assert.deepEqual(await counts(),before);
    assert.equal((await f.db.query("SELECT status FROM staff WHERE id=$1",[staffId])).rows[0].status,status);
  }
});

test("the existing pending-approval path still handles departed staff and monthly CSV includes their history", async () => {
  const staffId = await formerStaff("departed"), requestId=await f.pending(staffId);
  await f.db.query("UPDATE staff SET legal_name='Departed CSV fixture' WHERE id=$1",[staffId]);
  assert.equal((await f.call("corrections/decision",{requestId,decision:"APPROVED"})).status,200);
  assert.equal((await correct(staffId,{operation:"ADD",eventType:"CHECK_OUT",occurredAt:"2026-09-15T07:00:00Z"})).status,200);
  await f.seedReport();
  const csv=await f.call("monthly-attendance/csv",{periodEnd:"2026-09-30"});
  assert.equal(csv.status,200); assert.match(csv.body,/"2026-09-15","Departed CSV fixture","0:00","6:00","0:00"/);
  assert.equal((await f.db.query("SELECT status FROM staff WHERE id=$1",[staffId])).rows[0].status,"departed");
});

