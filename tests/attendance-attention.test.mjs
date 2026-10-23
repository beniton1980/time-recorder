import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture, token} from './helpers/recovery-database.mjs';
import {coManagerFixture} from './helpers/co-manager-fixture.mjs';
import {loadTs} from './helpers/load-ts.mjs';
import * as daily from '../lib/monthly-attendance.mjs';
const {buildAttendanceAttention} = loadTs('lib/attendance-attention.ts', {'./monthly-attendance.mjs':daily});
const reference = source => ({eventId:source.eventId, revision:source.revision});
const day = (date, types, current=false, today='2026-10-21') => ({
  source:{eventId:date,revision:'revision',businessDate:date,startedAt:date+'T09:00:00+09:00',current,today,canCorrect:true},
  events:types.map((event_type,i)=>({store_id:'store',staff_id:'staff',business_date:date,effective_id:date+i,event_type,occurred_at:date+`T${String(9+i).padStart(2,'0')}:00:00+09:00`}))
});
test('SSoT overlay: normal current work, overnight continuation, incomplete history, GPS and empty days',()=>{
  for(const types of [['CHECK_IN'],['CHECK_IN','BREAK_START']]) assert.equal(buildAttendanceAttention([day('2026-10-21',types,true)],[]).length,0);
  const previous=buildAttendanceAttention([day('2026-10-20',['CHECK_IN','BREAK_START'],true)],[]);
  assert.equal(previous.length,1);assert.equal(previous[0].continuing,true);assert.equal(previous[0].eventType,'BREAK_END');
  assert.equal(buildAttendanceAttention([day('2026-10-20',['CHECK_IN'])],[])[0].continuing,false);
  const complete=day('2026-10-20',['CHECK_IN','CHECK_OUT']);complete.events[0].location_status='WARNING';
  assert.equal(buildAttendanceAttention([complete],[]).length,0);assert.equal(buildAttendanceAttention([],[]).length,0);
  const malformed=day('2026-10-20',['CHECK_OUT']);assert.equal(buildAttendanceAttention([malformed],[])[0].eventType,null);
  const old=day('2026-01-01',['CHECK_IN']);old.source.canCorrect=false;assert.equal(buildAttendanceAttention([old],[])[0].eventType,null);
});
test('unlinked consultations do not suppress problems; saved corrections remain waiting; only matching rejection offers results',()=>{
  const d=day('2026-10-20',['CHECK_IN']);
  const legacy={id:'legacy',status:'PENDING',operation:'REVIEW'};
  assert.equal(buildAttendanceAttention([d],[legacy]).length,2);
  const linked={id:'linked',status:'PENDING',operation:'REVIEW',sourceEventId:d.source.eventId,hasSavedCorrections:true};
  let items=buildAttendanceAttention([d],[linked]);assert.equal(items.length,1);assert.match(items[0].message,/保存済み/);
  assert.equal(buildAttendanceAttention([day('2026-10-20',['CHECK_IN','CHECK_OUT'])],[linked])[0].bucket,'waiting');
  items=buildAttendanceAttention([d],[{...linked,status:'REJECTED'}]);assert.equal(items[0].requestId,'linked');
  assert.equal(buildAttendanceAttention([d],[{...linked,status:'RESOLVED'}])[0].requestId,null);
  const openBreak=day('2026-10-20',['CHECK_IN','BREAK_START']);openBreak.source.breakStartedAt='2026-10-20T10:00:00+09:00';
  const checkout={...linked,operation:'ADD',eventType:'CHECK_OUT',hasSavedCorrections:false};
  assert.equal(buildAttendanceAttention([openBreak],[checkout]).length,2,'a pending checkout does not hide a missing break end');
  const otherBreak={...checkout,eventType:'BREAK_END',breakStartedAt:'2026-10-20T09:30:00+09:00'};
  assert.equal(buildAttendanceAttention([openBreak],[otherBreak]).length,2,'an earlier break request cannot hide another open break');
  assert.equal(buildAttendanceAttention([openBreak],[{...otherBreak,breakStartedAt:openBreak.source.breakStartedAt}]).length,1);
  const cancelled=buildAttendanceAttention([],[{...linked,sourceSnapshot:d.source}]);
  assert.equal(cancelled[0].source.businessDate,d.source.businessDate);assert.doesNotMatch(cancelled[0].message,/対象未指定/);
});

async function seed(f, {age=2,breakOpen=false,complete=false}={}) {
  const staff=f.staff, id=randomUUID();
  const at=new Date(Date.now()-age*86400000);at.setUTCHours(1,0,0,0);
  const date=at.toISOString().slice(0,10);
  await f.db.query("INSERT INTO punch_events(id,store_id,staff_id,event_type,occurred_at,business_date,client_request_id) VALUES($1,$2,$3,'CHECK_IN',$4,$5,gen_random_uuid())",[id,f.store,staff,at.toISOString(),date]);
  let last=id,lastAt=at.toISOString();
  if(breakOpen||complete){last=randomUUID();lastAt=new Date(+at+3600000).toISOString();await f.db.query("INSERT INTO punch_events(id,store_id,staff_id,event_type,occurred_at,business_date,client_request_id) VALUES($1,$2,$3,$4,$5,$6,gen_random_uuid())",[last,f.store,staff,breakOpen?'BREAK_START':'CHECK_OUT',lastAt,date]);}
  await f.db.query("UPDATE staff_states SET state=$1,last_event_id=$2,last_event_at=$3,updated_at=clock_timestamp() WHERE staff_id=$4",[complete?'OFF_DUTY':breakOpen?'ON_BREAK':'WORKING',last,lastAt,staff]);
  return {id,at,date,last,lastAt};
}
const attention=async f=>{const r=await f.call(f.api('attendance-attention'),{});assert.equal(r.status,200,JSON.stringify(r));return r;};

test('atomic provenance, duplicate tabs, stale revision, replay after change, and direct history older than first page',async()=>{
  const f=await fixture();try {
    const s=await seed(f);let result=await attention(f);let item=result.items.find(x=>x.source?.eventId===s.id);assert.ok(item);assert.equal(item.continuing,true);
    const original=(await f.db.query('SELECT to_jsonb(e) v FROM punch_events e WHERE id=$1',[s.id])).rows[0].v;
    const body={clientRequestId:randomUUID(),category:'OTHER',reason:'Fictitious: exact time unknown',attentionSource:reference(item.source)};
    const submitted=await f.call(f.correction,body);assert.equal(submitted.ok,true,JSON.stringify(submitted));const requestId=submitted.correctionRequest.id;
    const source=(await f.db.query('SELECT snapshot FROM correction_attention_sources WHERE request_id=$1',[requestId])).rows[0].snapshot;
    assert.equal(source.businessDate,s.date);assert.equal(source.eventId,s.id);
    assert.equal((await f.call(f.correction,{...body,clientRequestId:randomUUID()})).code,'ATTENTION_ALREADY_PENDING');
    assert.equal((await f.db.query('SELECT count(*)::int n FROM correction_attention_sources')).rows[0].n,1);
    assert.equal((await attention(f)).items.find(x=>x.requestId===requestId).bucket,'waiting');
    await f.db.query("UPDATE punch_events SET occurred_at=occurred_at+interval '1 minute' WHERE id=$1",[s.id]);
    assert.equal((await f.call(f.correction,body)).correctionRequest.id,requestId);
    assert.equal((await f.call(f.correction,{...body,reason:'Different'})).code,'CLIENT_REQUEST_CONFLICT');
    assert.equal((await f.call(f.correction,{...body,attentionSource:undefined})).code,'CLIENT_REQUEST_CONFLICT');
    assert.equal((await f.call(f.correction,{...body,clientRequestId:randomUUID()})).code,'ATTENTION_CHANGED');
    for(let i=0;i<24;i++) await f.db.query("INSERT INTO correction_requests(store_id,staff_id,operation,reason) VALUES($1,$2,'REVIEW','Fictitious newer request')",[f.store,f.staff]);
    const history=f.api('correction-requests/history');let list=await f.call(history,{});assert.equal(list.requests.some(x=>x.id===requestId),false);
    const detail=await f.call(history,{requestId});assert.equal(detail.requests.length,1);assert.equal(detail.requests[0].source.businessDate,s.date);
    assert.equal((await attention(f)).items.length,20);assert.ok((await attention(f)).next);
    // No request path rewrites originals; the only modification above was explicit fixture setup.
    const after=(await f.db.query('SELECT to_jsonb(e) v FROM punch_events e WHERE id=$1',[s.id])).rows[0].v;
    assert.deepEqual({...after,occurred_at:original.occurred_at},original);
  }finally{await f.db.close();}
});

test('break end then checkout use existing approval; pending addition is not effective; invalid additions roll back relation',async()=>{
  const f=await fixture();try {
    const s=await seed(f,{breakOpen:true});let item=(await attention(f)).items.find(x=>x.source?.eventId===s.id);assert.equal(item.eventType,'BREAK_END');
    const ref=reference(item.source);
    const invalid=await f.call(f.correction,{clientRequestId:randomUUID(),category:'MISSED',eventType:'BREAK_END',occurredAt:new Date(Date.now()+86400000).toISOString(),attentionSource:ref});
    assert.equal(invalid.code,'OCCURRED_AT_IN_FUTURE');assert.equal((await f.db.query('SELECT count(*)::int n FROM correction_attention_sources')).rows[0].n,0);
    const body={clientRequestId:randomUUID(),category:'MISSED',eventType:'BREAK_END',occurredAt:new Date(Date.parse(s.lastAt)+3600000).toISOString(),attentionSource:ref};
    const r=await f.call(f.correction,body);assert.equal(r.ok,true,JSON.stringify(r));
    assert.equal((await f.db.query('SELECT count(*)::int n FROM effective_punch_events WHERE staff_id=$1',[f.staff])).rows[0].n,2);
    const manager=randomUUID();await f.db.query("INSERT INTO staff(id,store_id,line_user_id,legal_name,role) VALUES($1,$2,'fixture_manager','Fixture manager','MANAGER')",[manager,f.store]);
    const approved=await f.call(f.decision,{idToken:'fixture_manager',storeId:f.store,requestId:r.correctionRequest.id,decision:'APPROVED'});assert.equal(approved.status,200,JSON.stringify(approved));
    item=(await attention(f)).items.find(x=>x.source?.eventId===s.id);assert.equal(item.eventType,'CHECK_OUT');
    const checkout=await f.call(f.correction,{clientRequestId:randomUUID(),category:'MISSED',eventType:'CHECK_OUT',occurredAt:new Date(Date.parse(s.lastAt)+7200000).toISOString(),attentionSource:reference(item.source)});
    assert.equal(checkout.ok,true,JSON.stringify(checkout));
    assert.equal((await f.call(f.decision,{idToken:'fixture_manager',storeId:f.store,requestId:checkout.correctionRequest.id,decision:'APPROVED'})).status,200);
    assert.equal((await attention(f)).items.some(x=>x.source?.eventId===s.id),false);
  }finally{await f.db.close();}
});

test('every read/write requires active person, store and QR; source cannot cross tenant; old unresolved work stays visible',async()=>{
  const f=await fixture();try {
    const s=await seed(f,{age:90});let item=(await attention(f)).items.find(x=>x.source?.eventId===s.id);assert.equal(item.eventType,null);
    const body={clientRequestId:randomUUID(),category:'OTHER',reason:'Fictitious old work',attentionSource:reference(item.source)};
    assert.equal((await f.call(f.correction,body)).ok,true);
    const route=f.api('attendance-attention');
    assert.equal((await f.call(route,{idToken:'invalid'})).status,401);
    assert.equal((await f.call(route,{idToken:'fixture_other'})).status,404);
    assert.equal((await f.call(route,{storeToken:'invalid'})).status,404);
    const foreign=f.getSql({mode:'staff',lineIdentity:'fixture_other',storeTokenHash:(await f.db.query('SELECT token_hash FROM store_entry_tokens WHERE store_id=$1',[f.store])).rows[0].token_hash});
    assert.equal((await foreign`SELECT * FROM correction_attention_sources`).length,0);
    await assert.rejects(foreign`SELECT * FROM submit_staff_correction_with_source(${f.store}::uuid,${f.staff}::uuid,${randomUUID()}::uuid,'OTHER',NULL,NULL,NULL,NULL,'Fictitious',NULL,${JSON.stringify(body.attentionSource)}::jsonb)`,/STAFF_OR_STORE_NOT_FOUND/);
    await f.db.query("UPDATE staff SET status='inactive' WHERE id=$1",[f.staff]);
    assert.equal((await f.call(route,{})).status,404);assert.equal((await f.call(f.correction,{...body,clientRequestId:randomUUID()})).status,404);
  }finally{await f.db.close();}
});

test('linked consultation exposes target day separately from receipt and remains pending until explicit resolution',async()=>{
  const f=await coManagerFixture();try {
    const actor=(await f.db.query("SELECT id FROM staff WHERE line_user_id='fixture_actor'")).rows[0].id;
    const s=await seed({...f,staff:actor},{age:4});
    const callStaff=async(route,body={})=>{const response=await route.POST(new Request('http://fixture/api',{method:'POST',body:JSON.stringify({idToken:'fixture_actor',storeToken:token,...body})}));return {...await response.json(),status:response.status};};
    const a=await callStaff(f.api('attendance-attention'));const item=a.items.find(x=>x.source?.eventId===s.id);
    const r=await callStaff(f.correction,{clientRequestId:randomUUID(),category:'OTHER',reason:'Fictitious consultation',attentionSource:reference(item.source)});assert.equal(r.status,200,JSON.stringify(r));
    const id=r.correctionRequest.id;let d=await f.call('consultations',{action:'detail',requestId:id});assert.equal(d.body.consultation.source.businessDate,s.date);assert.notEqual(d.body.consultation.requestDay,s.date);
    const saved=await f.call('punch-corrections',{staffId:actor,consultationId:id,clientRequestId:randomUUID(),expectedVersion:d.body.consultation.version,operation:'ADD',eventType:'CHECK_OUT',occurredAt:new Date(+s.at+3600000).toISOString(),reason:'Fictitious repair'});assert.equal(saved.status,200,JSON.stringify(saved));
    assert.match((await callStaff(f.api('attendance-attention'))).items.find(x=>x.requestId===id).message,/保存済み/);
    d=await f.call('consultations',{action:'detail',requestId:id});assert.equal((await f.call('consultations',{action:'resolve',requestId:id,expectedVersion:d.body.consultation.version})).status,200);
    assert.equal((await callStaff(f.api('attendance-attention'))).items.some(x=>x.requestId===id),false);
    const history=await callStaff(f.api('correction-requests/history'),{requestId:id});assert.equal(history.requests[0].status,'RESOLVED');assert.equal(history.requests[0].outcome,'CORRECTED');
  }finally{await f.db.close();}
});
