import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { coManagerFixture } from './helpers/co-manager-fixture.mjs';
import { token } from './helpers/recovery-database.mjs';
let f;
before(async()=>{ f=await coManagerFixture(); });
after(async()=>{ await f?.db.close(); });
async function seed(staffId) {
  const staff=staffId ?? await f.staff(), requestId=randomUUID(), inId=randomUUID(), outId=randomUUID();
  await f.db.query("INSERT INTO punch_events(id,store_id,staff_id,event_type,occurred_at,business_date,client_request_id) VALUES($1,$3,$4,'CHECK_IN','2026-08-31T20:00:00+09:00','2026-08-31',gen_random_uuid()),($2,$3,$4,'CHECK_OUT','2026-09-01T02:00:00+09:00','2026-08-31',gen_random_uuid())",[inId,outId,f.store,staff]);
  await f.db.query("INSERT INTO correction_requests(id,store_id,staff_id,operation,reason,requested_at,client_request_id,client_request_payload) VALUES($1,$2,$3,'REVIEW','Fictitious consultation','2026-09-02T10:00:00+09:00',$1,$4)",[requestId,f.store,staff,{category:'OTHER',targetEventId:null,expectedRevisionId:null,eventType:null,occurredAt:null,reason:'Fictitious consultation'}]);
  return {staff,requestId,inId,outId};
}
const detail=async requestId=>{const r=await f.call('consultations',{action:'detail',requestId});assert.equal(r.status,200,JSON.stringify(r));return r.body;};
const save=async(s,operation,targetEffectiveId,extra={})=>f.call('punch-corrections',{staffId:s.staff,consultationId:s.requestId,clientRequestId:randomUUID(),expectedVersion:(await detail(s.requestId)).consultation.version,operation,targetEffectiveId,reason:'Fictitious correction',...extra});

test('consultation repair keeps source history, stays pending until explicit completion, and agrees across readers',async()=>{
  const s=await seed((await f.db.query("SELECT id FROM staff WHERE line_user_id='fixture_actor'")).rows[0].id);
  const original=(await f.db.query('SELECT to_jsonb(cr) AS row FROM correction_requests cr WHERE id=$1',[s.requestId])).rows[0].row;
  const before=await detail(s.requestId);assert.equal(before.consultation.targetDay,null);assert.equal(before.consultation.requestDay,'2026-09-02');
  const nonce=randomUUID(), version=before.consultation.version;
  const body={staffId:s.staff,consultationId:s.requestId,clientRequestId:nonce,expectedVersion:version,operation:'REPLACE',targetEffectiveId:s.outId,eventType:'CHECK_OUT',occurredAt:'2026-09-01T03:00:00+09:00',reason:'Fictitious correction'};
  const first=await f.call('punch-corrections',body);assert.equal(first.status,200,JSON.stringify(first));
  const replay=await f.call('punch-corrections',body);assert.equal(replay.body.correction.id,first.body.correction.id);
  assert.equal((await f.call('punch-corrections',{...body,reason:'Different'})).status,409);
  const mid=await detail(s.requestId);assert.equal(mid.consultation.status,'PENDING');assert.equal(mid.consultation.changes.length,1);
  assert.equal(mid.consultation.changes[0].before.day,'2026-08-31');assert.match(mid.consultation.changes[0].after.at,/03:00:00\+09:00|18:00:00\+00:00|18:00:00Z/);
  assert.equal((await f.call('corrections/decision',{requestId:s.requestId,decision:'REJECTED'})).status,409);
  assert.equal((await f.call('consultations',{action:'resolve',requestId:s.requestId,expectedVersion:version})).body.code,'ATTENDANCE_CHANGED');
  const history=f.api('correction-requests/history');
  let h=await f.call('consultations',{action:'detail',requestId:s.requestId});
  const resolved=await f.call('consultations',{action:'resolve',requestId:s.requestId,expectedVersion:h.body.consultation.version});assert.equal(resolved.status,200,JSON.stringify(resolved));
  assert.equal((await detail(s.requestId)).consultation.status,'RESOLVED');
  assert.equal((await f.call('consultations',{action:'resolve',requestId:s.requestId,expectedVersion:version})).status,200);
  assert.equal((await f.call('punch-corrections',body)).body.correction.id,first.body.correction.id);
  assert.equal((await f.call('corrections/decision',{requestId:s.requestId,decision:'APPROVED',resolvedEventType:'CHECK_IN',resolvedOccurredAt:'2026-08-30T09:00:00+09:00'})).status,409);
  const runtime=f.getSql({mode:'manager',lineIdentity:'fixture_delegate',storeId:f.store});
  await assert.rejects(runtime`SELECT * FROM decide_manager_correction(${f.store}::uuid,${s.requestId}::uuid,'REJECTED',NULL,NULL)`,/REQUEST_NOT_PENDING/);
  const request=new Request('http://fixture/api',{method:'POST',body:JSON.stringify({idToken:'fixture_actor',storeToken:token})});
  const hr=await (await history.POST(request)).json();const item=hr.requests.find(x=>x.id===s.requestId);assert.equal(item.status,'RESOLVED');assert.equal(item.outcome,'CORRECTED');assert.equal('resolutionReason' in item,false);assert.equal('resolved_by' in item,false);
  const recovered=await f.bootstrap.POST(new Request('http://fixture/api',{method:'POST',body:JSON.stringify({idToken:'fixture_actor',storeToken:token,pendingOperation:{kind:'correction',clientRequestId:s.requestId}})}));
  assert.equal((await recovered.json()).operationResult.status,'RESOLVED');
  const submitted=await f.correction.POST(new Request('http://fixture/api',{method:'POST',body:JSON.stringify({idToken:'fixture_actor',storeToken:token,clientRequestId:s.requestId,category:'OTHER',reason:'Fictitious consultation'})}));
  assert.equal((await submitted.json()).correctionRequest.status,'RESOLVED');
  h=await detail(s.requestId);assert.equal(h.days.find(d=>d.businessDate==='2026-09-02').reasons.includes('PENDING_CORRECTION'),false);
  assert.deepEqual((await f.db.query('SELECT to_jsonb(cr) AS row FROM correction_requests cr WHERE id=$1',[s.requestId])).rows[0].row,original);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM punch_events WHERE staff_id=$1',[s.staff])).rows[0].n,2);
});

test('no-change completion needs a reason, retains other pending requests and contradictory punches',async()=>{
  const s=await seed();await f.pending(s.staff,'CHECK_IN','2026-09-02T01:00:00Z');
  await f.db.query("INSERT INTO punch_events(store_id,staff_id,event_type,occurred_at,business_date,client_request_id) VALUES($1,$2,'CHECK_IN','2026-08-31T20:30:00+09:00','2026-08-31',gen_random_uuid())",[f.store,s.staff]);
  const v=(await detail(s.requestId)).consultation.version;
  assert.equal((await f.call('consultations',{action:'resolve',requestId:s.requestId,expectedVersion:v})).body.code,'RESOLUTION_REASON_REQUIRED');
  const r=await f.call('consultations',{action:'resolve',requestId:s.requestId,expectedVersion:v,reason:'Already checked'});assert.equal(r.body.resolution.outcome,'NO_CHANGE');
  assert.ok((await detail(s.requestId)).days.find(d=>d.businessDate==='2026-09-02').reasons.includes('PENDING_CORRECTION'));
  const attendance=await f.call('staff-attendance',{staffId:s.staff,month:'2026-08'});assert.equal(attendance.body.days.find(d=>d.businessDate==='2026-08-31').status,'NEEDS_REVIEW');
});

test('source/target boundaries, stale saves, stopped staff and atomic validation',async()=>{
  const s=await seed();const other=await seed();
  assert.equal((await f.call('consultations',{action:'detail',requestId:s.requestId},'fixture_actor')).status,403);
  assert.equal((await f.call('consultations',{action:'detail',storeId:f.otherStore,requestId:s.requestId})).status,403);
  assert.equal((await save(s,'VOID',other.outId)).status,404);
  const invalid=await save(s,'REPLACE',s.outId,{eventType:'CHECK_IN',occurredAt:'2026-09-01T03:00:00+09:00'});assert.equal(invalid.status,422);assert.equal((await detail(s.requestId)).consultation.changes.length,0);
  const version=(await detail(s.requestId)).consultation.version;
  await f.db.query("UPDATE staff SET status='departed' WHERE id=$1",[s.staff]);
  assert.equal((await save(s,'REPLACE',s.outId,{eventType:'CHECK_OUT',occurredAt:'2026-09-01T03:00:00+09:00'})).status,200);
  assert.equal((await save(s,'VOID',s.inId,{expectedVersion:version})).body.code,'ATTENDANCE_CHANGED');
  assert.equal((await f.db.query('SELECT status FROM staff WHERE id=$1',[s.staff])).rows[0].status,'departed');
});

test('ADD and VOID can be linked to one consultation, and retry after VOID is safe',async()=>{
  const s=await seed();const v=(await detail(s.requestId)).consultation.version;
  const add=await save(s,'ADD',undefined,{eventType:'CHECK_IN',occurredAt:'2026-09-03T10:00:00+09:00'});assert.equal(add.status,200);
  const updated=(await detail(s.requestId)).consultation.version;assert.notEqual(v,updated);
  const body={staffId:s.staff,consultationId:s.requestId,clientRequestId:randomUUID(),expectedVersion:updated,operation:'VOID',targetEffectiveId:add.body.correction.id,reason:'Fixture undo'};
  const removed=await f.call('punch-corrections',body);assert.equal(removed.status,200,JSON.stringify(removed));assert.equal((await f.call('punch-corrections',body)).body.correction.id,removed.body.correction.id);
  const d=await detail(s.requestId);assert.equal(d.consultation.changes.length,2);assert.equal(d.consultation.changes[1].after,null);
});

test('completed consultation pagination is stable at the same microsecond and excludes pending and foreign records',async()=>{
  const ids=[];
  for(let i=0;i<23;i++){
    const s=await seed();ids.push(s.requestId);
    const r=await f.call('consultations',{action:'resolve',requestId:s.requestId,expectedVersion:(await detail(s.requestId)).consultation.version,reason:'Fixture checked'});assert.equal(r.status,200);
  }
  await f.db.query("UPDATE consultation_resolutions SET resolved_at='2026-10-15T01:00:00.123456Z' WHERE request_id=ANY($1::uuid[])",[ids]);
  const seen=[];let before=null,pages=0;
  do{const r=await f.call('consultations',{action:'list',before});assert.equal(r.status,200);assert.ok(r.body.items.length<=20);seen.push(...r.body.items.map(i=>i.id));before=r.body.next;pages++;}while(before&&pages<10);
  assert.ok(pages>=2);assert.equal(new Set(seen).size,seen.length);assert.ok(ids.every(id=>seen.includes(id)));
  assert.equal((await f.call('consultations',{action:'list',before:{id:ids[0],at:'invalid'}})).status,400);
  assert.equal((await f.call('consultations',{action:'list'},'fixture_other')).status,403);
});
