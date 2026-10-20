import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { coManagerFixture } from "./helpers/co-manager-fixture.mjs";

let f;
before(async () => { f = await coManagerFixture(); });
after(async () => { await f?.db.close(); });
const correction = staffId => ({staffId,operation:"ADD",eventType:"CHECK_IN",occurredAt:"2026-09-15T01:00:00Z",reason:"Fixture correction"});

test("co-managers can add, replace and void attendance with their own audit identity", async () => {
  const staffId = await f.staff();
  let r = await f.call("punch-corrections",correction(staffId));
  assert.equal(r.status,200,JSON.stringify(r));
  const added = (await f.db.query("SELECT id FROM correction_requests WHERE staff_id=$1",[staffId])).rows[0].id;
  r = await f.call("punch-corrections",{...correction(staffId),operation:"REPLACE",targetEffectiveId:added,occurredAt:"2026-09-15T01:10:00Z"});
  assert.equal(r.status,200);
  r = await f.call("punch-corrections",{staffId,operation:"VOID",targetEffectiveId:added,reason:"Fixture void"});
  assert.equal(r.status,200);
  const audit = (await f.db.query("SELECT approved_by FROM correction_requests WHERE staff_id=$1",[staffId])).rows;
  assert.equal(audit.length,3); assert.ok(audit.every(row=>row.approved_by===f.delegate));
  assert.equal((await f.db.query("SELECT state FROM staff_states WHERE staff_id=$1",[staffId])).rows[0].state,"OFF_DUTY");
  const future = await f.call("punch-corrections",{...correction(staffId),occurredAt:new Date(Date.now()+3600000).toISOString()});
  assert.equal(future.status,400); assert.equal(future.body.code,"OCCURRED_AT_IN_FUTURE");
});

test("co-managers approve and reject requests while future approval remains forbidden", async () => {
  const staffId = await f.staff(), requestId = await f.pending(staffId);
  const result = await f.call("corrections/decision",{requestId,decision:"APPROVED"});
  assert.equal(result.status,200,JSON.stringify(result));
  assert.equal((await f.db.query("SELECT approved_by FROM correction_requests WHERE id=$1",[requestId])).rows[0].approved_by,f.delegate);
  const rejectId = await f.pending(await f.staff());
  assert.equal((await f.call("corrections/decision",{requestId:rejectId,decision:"REJECTED"})).status,200);
  const futureId = await f.pending(await f.staff(),"CHECK_IN",new Date(Date.now()+3600000).toISOString());
  const future = await f.call("corrections/decision",{requestId:futureId,decision:"APPROVED"});
  assert.equal(future.status,400); assert.equal(future.body.code,"OCCURRED_AT_IN_FUTURE");
  assert.equal((await f.db.query("SELECT status FROM correction_requests WHERE id=$1",[futureId])).rows[0].status,"PENDING");
});

test("report authorization distinguishes an empty authorized store from denied access", async () => {
  assert.deepEqual((await f.call("monthly-attendance/reports")).body.reports,[]);
  const denied = await f.call("monthly-attendance/reports",{},"fixture_actor");
  assert.equal(denied.status,403); assert.equal(denied.body.code,"MANAGER_ACCESS_REQUIRED");
  await f.seedReport();
  const owner = await f.call("monthly-attendance/reports",{},"fixture_manager"), delegate = await f.call("monthly-attendance/reports");
  assert.equal(delegate.body.reports.length,1); assert.deepEqual(delegate.body,owner.body);
  for (const actor of ["fixture_manager","fixture_delegate"]) {
    const result = await f.call("monthly-attendance/csv",{periodEnd:"2026-09-30"},actor);
    assert.equal(result.status,200); assert.match(result.body,/Fixture worker/);
  }
});

test("co-manager reissue and test email use the confirmed recipient; retry sends once", async () => {
  const requestId = randomUUID(), body = {periodEnd:"2026-09-30",requestId};
  const before = f.emails.length;
  const result = await f.call("monthly-attendance/reissue",body);
  assert.equal(result.status,200,JSON.stringify(result)); assert.equal(result.body.status,"SENT");
  assert.equal((await f.call("monthly-attendance/reissue",body)).body.status,"ALREADY_PROCESSED");
  assert.equal(f.emails.length,before+1); assert.equal(f.emails.at(-1).recipient,"fixture@example.invalid");
  assert.equal((await f.call("monthly-attendance/acceptance-test",{...body,requestId:randomUUID()})).status,200);
  await f.db.query("UPDATE stores SET monthly_report_email_verified_at=NULL,monthly_report_email_consented_at=NULL,monthly_report_email_consent_version=NULL WHERE id=$1",[f.store]);
  for (const name of ["monthly-attendance/reissue","monthly-attendance/acceptance-test"]) {
    const denied = await f.call(name,{...body,requestId:randomUUID()});
    assert.equal(denied.status,409); assert.equal(denied.body.code,"MONTHLY_REPORT_RECIPIENT_NOT_CONFIRMED");
  }
  assert.equal(f.emails.length,before+2);
  await f.db.query("UPDATE stores SET monthly_report_email_verified_at=NOW(),monthly_report_email_consented_at=NOW(),monthly_report_email_consent_version='2026-08-21-v1' WHERE id=$1",[f.store]);
});

test("co-manager QR operations preserve store boundaries and rotation revokes only the old fixture QR", async () => {
  const beforeOther = (await f.db.query("SELECT * FROM store_entry_tokens WHERE store_id=$1",[f.otherStore])).rows;
  for (const action of ["STATUS","ROTATE","DISPLAY","REVOKE"]) {
    const result = await f.call("store-qr",{action}); assert.equal(result.status,200,action+JSON.stringify(result));
  }
  assert.deepEqual((await f.db.query("SELECT * FROM store_entry_tokens WHERE store_id=$1",[f.otherStore])).rows,beforeOther);
  assert.equal((await f.db.query("SELECT count(*)::int n FROM store_entry_tokens WHERE store_id=$1 AND active",[f.store])).rows[0].n,0);
});

test("all affected APIs deny ordinary, revoked, stopped, departed and cross-store actors", async () => {
  const staffId = await f.staff(), requestId = await f.pending(staffId);
  const operations = [["punch-corrections",correction(staffId)],["corrections/decision",{requestId,decision:"REJECTED"}],["monthly-attendance/reports",{}],["monthly-attendance/csv",{periodEnd:"2026-09-30"}],["monthly-attendance/reissue",{periodEnd:"2026-09-30",requestId:randomUUID()}],["monthly-attendance/acceptance-test",{periodEnd:"2026-09-30",requestId:randomUUID()}],["store-qr",{action:"ROTATE"}]];
  const cases = [
    {actor:"fixture_actor"},
    {actor:"fixture_other"},
    {actor:"fixture_delegate",storeId:f.otherStore},
    {actor:"fixture_delegate",access:"inactive"},
    {actor:"fixture_delegate",status:"inactive"},
    {actor:"fixture_delegate",status:"departed"},
    {actor:"fixture_delegate",storeStatus:"suspended"},
  ];
  const snapshot = async () => ({corrections:(await f.db.query("SELECT * FROM correction_requests ORDER BY id")).rows,tokens:(await f.db.query("SELECT * FROM store_entry_tokens ORDER BY id")).rows,deliveries:(await f.db.query("SELECT * FROM monthly_attendance_deliveries ORDER BY id")).rows,emails:f.emails.length});
  const before = await snapshot();
  for (const c of cases) {
    await f.db.query("UPDATE staff_manager_access SET status=$1 WHERE staff_id=$2",[c.access??"active",f.delegate]);
    await f.db.query("UPDATE staff SET status=$1 WHERE id=$2",[c.status??"active",f.delegate]);
    await f.db.query("UPDATE stores SET status=$1 WHERE id=$2",[c.storeStatus??"active",f.store]);
    for (const [name,body] of operations) {
      const result = await f.call(name,{...body,storeId:c.storeId??f.store},c.actor);
      assert.equal(result.status,403,JSON.stringify({name,c,result}));
      assert.equal(result.body.code,"MANAGER_ACCESS_REQUIRED");
    }
  }
  assert.deepEqual(await snapshot(),before);
  await f.db.query("UPDATE stores SET status='active' WHERE id=$1",[f.store]);
  assert.equal((await f.call("punch-corrections",{...correction(staffId),staffId:f.otherStaff})).status,404);
  assert.equal((await f.call("corrections/decision",{requestId:randomUUID(),decision:"REJECTED"})).status,409);
});

test("0043 upgrades only the two authorization predicates and preserves data and function privileges", async () => {
  const old = await coManagerFixture({throughMigration:"0042_manager_correction_time.sql"});
  try {
    const sql = old.getSql({mode:"manager",lineIdentity:"fixture_delegate",storeId:old.store});
    const staffId = await old.staff(), requestId = await old.pending(staffId);
    const apply = () => sql`SELECT * FROM apply_manager_direct_correction(${old.store}::uuid,${staffId}::uuid,'ADD',NULL,NULL,'CHECK_IN','2026-09-16T01:00:00Z'::timestamptz,'Fixture')`;
    const decide = () => sql`SELECT * FROM decide_manager_correction(${old.store}::uuid,${requestId}::uuid,'REJECTED',NULL,NULL)`;
    await assert.rejects(apply(),/MANAGER_ACCESS_REQUIRED/); await assert.rejects(decide(),/MANAGER_ACCESS_REQUIRED/);
    const funcs = async () => (await old.db.query("SELECT proname,proacl::text,prosecdef,proconfig,prosrc FROM pg_proc WHERE proname IN ('apply_manager_direct_correction','decide_manager_correction') ORDER BY proname")).rows;
    const data = async () => (await old.db.query("SELECT row_to_json(c) value FROM correction_requests c ORDER BY id")).rows;
    const beforeFuncs = await funcs(), beforeData = await data();
    await old.db.exec(await readFile(new URL("../db/migrations/0043_co_manager_operations.sql",import.meta.url),"utf8"));
    assert.deepEqual(await data(),beforeData);
    const afterFuncs = await funcs();
    for(let i=0;i<beforeFuncs.length;i++) {
      assert.deepEqual({...afterFuncs[i],prosrc:""},{...beforeFuncs[i],prosrc:""});
      assert.equal(afterFuncs[i].prosrc,beforeFuncs[i].prosrc.replace("st.role = 'MANAGER'","public.app_manager_store_allowed(st.store_id)"));
      assert.equal(afterFuncs[i].prosecdef,false);
    }
    assert.equal((await decide())[0].status,"REJECTED"); assert.equal((await apply())[0].status,"APPROVED");
    for(const context of [{mode:"staff",lineIdentity:"fixture_delegate",storeId:old.store},{mode:"manager",lineIdentity:"fixture_actor",storeId:old.store},{mode:"manager",lineIdentity:"fixture_delegate",storeId:old.otherStore}]) {
      const denied = old.getSql(context);
      await assert.rejects(denied`SELECT * FROM apply_manager_direct_correction(${old.store}::uuid,${staffId}::uuid,'ADD',NULL,NULL,'CHECK_OUT',NOW(),'Fixture')`,/MANAGER_ACCESS_REQUIRED/);
      await assert.rejects(denied`SELECT * FROM decide_manager_correction(${old.store}::uuid,${requestId}::uuid,'REJECTED',NULL,NULL)`,/MANAGER_ACCESS_REQUIRED/);
    }
  } finally { await old.db.close(); }
});
