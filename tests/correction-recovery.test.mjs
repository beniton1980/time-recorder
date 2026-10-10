import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { randomUUID } from "node:crypto";
import { fixture } from "./helpers/recovery-database.mjs";
let f;
before(async()=>{f=await fixture();});
after(async()=>{await f?.db.close();});
const request=(category,extra={})=>({category,clientRequestId:randomUUID(),...extra});
const count=async()=>Number((await f.db.query("SELECT count(*) AS n FROM correction_requests")).rows[0].n);

test("four punches remain valid and replay refreshes saved result without another event",async()=>{
 const before=Number((await f.db.query("SELECT count(*) n FROM punch_events")).rows[0].n);
 for(const [eventType,state] of [["CHECK_IN","WORKING"],["BREAK_START","ON_BREAK"],["BREAK_END","WORKING"],["CHECK_OUT","OFF_DUTY"]]){
  const current=await f.call(f.bootstrap,{});
  const body={eventType,clientRequestId:randomUUID(),location:null,expectedStateVersion:current.memberships[0].state_version};
  assert.match(body.expectedStateVersion,/^\d+\.\d{6}$/);
  assert.equal((await f.call(f.punch,body)).ok,true);
  assert.equal((await f.call(f.punch,body)).status,"already_applied");
  assert.equal((await f.call(f.punch,{...body,expectedStateVersion:undefined})).status,"already_applied");
  const session=await f.call(f.bootstrap,{pendingOperation:{kind:"punch",clientRequestId:body.clientRequestId}});
  assert.equal(session.memberships[0].state,state);assert.equal(session.operationResult.event_type,eventType);
  assert.equal(session.memberships[0].last_event_id,session.operationResult.id);
  assert.equal((await f.call(f.punch,{...body,eventType:eventType==="CHECK_IN"?"CHECK_OUT":"CHECK_IN"})).code,"CLIENT_REQUEST_CONFLICT");
 }
 assert.equal(Number((await f.db.query("SELECT count(*) n FROM punch_events")).rows[0].n),before+4);
});

test("saved mistake retries return one correction and never reverse it",async()=>{
 const before=await count();
 const target=await f.add("CHECK_OUT");
 const body=request("MISTAKE",{targetEventId:target,expectedRevisionId:target,eventType:"BREAK_START"});
 const first=await f.call(f.correction,body), again=await f.call(f.correction,body);
 assert.equal(first.status,"applied"); assert.equal(again.status,"already_received");
 assert.equal(first.correctionRequest.id,again.correctionRequest.id);
 assert.equal(await count(),before+1);
 const session=await f.call(f.bootstrap,{pendingOperation:{kind:"correction",clientRequestId:body.clientRequestId}});
 assert.equal(session.status,200); assert.equal(session.memberships[0].state,"ON_BREAK");
 assert.equal(session.memberships[0].last_event_type,"BREAK_START");
 assert.equal(session.memberships[0].last_event_revision_id,first.correctionRequest.id);
 assert.equal(session.operationResult.id,first.correctionRequest.id);
 const stale=await f.call(f.correction,{...body,clientRequestId:randomUUID()});
 assert.equal(stale.code,"LAST_PUNCH_CHANGED");
 const conflict=await f.call(f.correction,{...body,eventType:"CHECK_OUT"});
 assert.equal(conflict.code,"CLIENT_REQUEST_CONFLICT");
 // A fresh, explicit inverse intent is still allowed; replaying the older request doesn't undo it.
 const reverse=await f.call(f.correction,request("MISTAKE",{targetEventId:target,expectedRevisionId:first.correctionRequest.id,eventType:"CHECK_OUT"}));
 assert.equal(reverse.status,"applied");
 assert.equal((await f.call(f.correction,body)).status,"already_received");
 assert.equal((await f.call(f.bootstrap,{})).memberships[0].state,"OFF_DUTY");
});

test("an unsaved punch from an older shift cannot reopen work after another screen completed it",async()=>{
 const initial=await f.call(f.bootstrap,{});
 assert.equal(typeof initial.memberships[0].state_version,"string");
 const stale={eventType:"CHECK_IN",clientRequestId:randomUUID(),expectedStateVersion:initial.memberships[0].state_version};
 for(const eventType of ["CHECK_IN","CHECK_OUT"]){
  const current=await f.call(f.bootstrap,{});
  assert.equal((await f.call(f.punch,{eventType,clientRequestId:randomUUID(),expectedStateVersion:current.memberships[0].state_version})).ok,true);
 }
 const before=Number((await f.db.query("SELECT count(*) n FROM punch_events")).rows[0].n);
 assert.equal((await f.call(f.punch,stale)).status,409);
 assert.equal(Number((await f.db.query("SELECT count(*) n FROM punch_events")).rows[0].n),before);
 assert.equal((await f.call(f.bootstrap,{})).memberships[0].state,"OFF_DUTY");
});

test("unsaved legacy and malformed punch versions cannot create an event",async()=>{
 const before=Number((await f.db.query("SELECT count(*) n FROM punch_events")).rows[0].n);
 for(const expectedStateVersion of [undefined,null,123,"invalid"]){
  assert.equal((await f.call(f.punch,{eventType:"CHECK_IN",clientRequestId:randomUUID(),expectedStateVersion})).status,400);
 }
 assert.equal(Number((await f.db.query("SELECT count(*) n FROM punch_events")).rows[0].n),before);
});

test("migration preserves legacy correction history without inventing operation IDs",async()=>{
 const legacy=(await f.db.query("SELECT status,client_request_id,client_request_payload FROM correction_requests WHERE reason='Legacy fixture'")).rows;
 assert.equal(legacy.length,1);assert.equal(legacy[0].status,"PENDING");
 assert.equal(legacy[0].client_request_id,null);assert.equal(legacy[0].client_request_payload,null);
});

test("a later punch prevents stale corrections and preserves the new state",async()=>{
 const target=await f.add("CHECK_OUT"); await f.add("CHECK_IN");
 const before=await count();
 const result=await f.call(f.correction,request("MISTAKE",{targetEventId:target,expectedRevisionId:target,eventType:"BREAK_START"}));
 assert.equal(result.code,"LAST_PUNCH_CHANGED");assert.equal(await count(),before);
 assert.equal((await f.call(f.bootstrap,{})).memberships[0].state,"WORKING");
});

test("ordinary and missed requests are idempotent, including after a decision",async()=>{
 for(const body of [request("OTHER",{reason:"Fixture review"}),request("MISSED",{eventType:"CHECK_OUT",occurredAt:new Date(Date.now()-60000).toISOString()})]){
  const before=await count();
  const results=await Promise.all([f.call(f.correction,body),f.call(f.correction,body)]);
  assert.equal(results[0].correctionRequest.id,results[1].correctionRequest.id);
  assert.equal(await count(),before+1);
  await f.db.query("UPDATE correction_requests SET status='REJECTED',rejected_at=NOW() WHERE id=$1",[results[0].correctionRequest.id]);
  const again=await f.call(f.correction,body);
  assert.equal(again.status,"already_received");assert.equal(again.correctionRequest.status,"REJECTED");
 }
});

test("invalid, old unidentifiable, and stale missed requests fail without writes",async()=>{
 const before=await count();
 for(const body of [
  {category:"MISTAKE"}, request("MISTAKE"),
  request("MISSED",{eventType:"CHECK_OUT",occurredAt:"2000-01-01T00:00:00Z"}),
  request("OTHER",{reason:" "}),request("OTHER",{reason:"x".repeat(501)}),
 ]){
  const response=await f.call(f.correction,body);assert.equal(response.status,400);
 }
 assert.equal(await count(),before);
});

test("result lookup and writes remain scoped to active identity, store and QR",async()=>{
 const body=request("OTHER",{reason:"Fixture only"}), saved=await f.call(f.correction,body);
 const pendingOperation={kind:"correction",clientRequestId:body.clientRequestId};
 assert.equal((await f.call(f.bootstrap,{pendingOperation})).operationResult.id,saved.correctionRequest.id);
 const other=await f.call(f.bootstrap,{idToken:"fixture_other",pendingOperation});
 assert.equal(other.registered,false);assert.equal(other.operationResult,undefined);
 for(const status of ["inactive","departed"]){
  await f.db.query("UPDATE staff SET status=$1 WHERE id=$2",[status,f.staff]);
  assert.equal((await f.call(f.bootstrap,{pendingOperation})).code,"STAFF_INACTIVE");
  assert.equal((await f.call(f.correction,body)).status,404);
 }
 await f.db.query("UPDATE staff SET status='active' WHERE id=$1",[f.staff]);
 await f.db.query("UPDATE store_entry_tokens SET active=false");
 assert.equal((await f.call(f.bootstrap,{pendingOperation})).code,"STORE_TOKEN_INVALID");
 assert.equal((await f.call(f.correction,body)).status,404);
 await f.db.query("UPDATE store_entry_tokens SET active=true");
});

test("reopening a shift cannot create active work at two stores",async()=>{
 const target=await f.add("CHECK_OUT");
 await f.db.query("UPDATE staff SET line_user_id='fixture_actor' WHERE id=$1",[f.otherStaff]);
 await f.db.query("UPDATE staff_states SET state='WORKING' WHERE staff_id=$1",[f.otherStaff]);
 const before=await count();
 assert.equal((await f.call(f.correction,request("MISTAKE",{targetEventId:target,expectedRevisionId:target,eventType:"BREAK_START"}))).code,"ACTIVE_AT_OTHER_STORE");
 assert.equal(await count(),before);
});

test("DB invoker guards reject wrong mode and mismatched staff even with a valid QR",async()=>{
 for(const context of [{mode:"manager",lineIdentity:"fixture_actor"},{mode:"staff",lineIdentity:"fixture_other"}]){
  const sql=f.getSql({...context,storeTokenHash:(await import("./helpers/recovery-database.mjs")).tokenHash});
  await assert.rejects(sql`SELECT * FROM submit_staff_correction(${f.store}::uuid,${f.staff}::uuid,${randomUUID()}::uuid,'OTHER',NULL,NULL,NULL,NULL,'Fixture')`,/STAFF_OR_STORE_NOT_FOUND/);
 }
});
