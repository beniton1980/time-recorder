import assert from 'node:assert/strict';
import {test, before, beforeEach, after} from 'node:test';
import {randomUUID} from 'node:crypto';
import {fixture, tokenHash} from './helpers/recovery-database.mjs';
import {deriveDailyAttendanceRecords} from '../lib/monthly-attendance.mjs';

let f, manager;
before(async()=>{
  f=await fixture();
  manager=randomUUID();
  await f.db.query("INSERT INTO staff(id,store_id,line_user_id,legal_name,role) VALUES ($1,$2,'fixture_manager','Fixture manager','MANAGER')",[manager,f.store]);
});
beforeEach(async()=>{
  await f.db.exec('TRUNCATE punch_events,correction_requests CASCADE');
  await f.db.query("INSERT INTO staff_states(staff_id) VALUES ($1),($2) ON CONFLICT DO NOTHING",[f.staff,f.otherStaff]);
  await f.db.exec("UPDATE staff_states SET state='OFF_DUTY',last_event_id=NULL,last_event_at=NULL,updated_at=clock_timestamp(); UPDATE staff SET status='active'; UPDATE stores SET status='active',business_day_start_minute=0; UPDATE store_entry_tokens SET revoked_at=NULL");
});
after(async()=>{await f?.db.close();});
const call=(api,body={})=>f.call(f[api],body);
const session=async()=>(await call('bootstrap')).memberships[0];
async function add(type,at,{staff=f.staff,store=f.store}={}) {
  const row=(await f.db.query(`INSERT INTO punch_events(store_id,staff_id,event_type,occurred_at,business_date,client_request_id)
    VALUES ($1,$2,$3,$4,($4::timestamptz AT TIME ZONE 'Asia/Tokyo')::date,$5) RETURNING *`,[store,staff,type,at,randomUUID()])).rows[0];
  await f.db.query('UPDATE staff_states SET state=$1,last_event_id=$2,last_event_at=$3,updated_at=clock_timestamp() WHERE staff_id=$4',
    [type==='CHECK_OUT'?'OFF_DUTY':type==='BREAK_START'?'ON_BREAK':'WORKING',row.id,at,staff]);
  return row;
}
async function times() {
  return (await f.db.query(`SELECT
    ((NOW() AT TIME ZONE 'Asia/Tokyo')::date-1+TIME '20:00') AT TIME ZONE 'Asia/Tokyo' AS start,
    ((NOW() AT TIME ZONE 'Asia/Tokyo')::date-1+TIME '23:00') AT TIME ZONE 'Asia/Tokyo' AS finish`)).rows[0];
}
async function pending() {
  const t=await times();await add('CHECK_IN',t.start);
  const r=await call('correction',{category:'MISSED',eventType:'CHECK_OUT',occurredAt:t.finish,clientRequestId:randomUUID()});
  assert.equal(r.status,'submitted');assert.equal(r.correctionRequest.status,'PENDING');
  return r.correctionRequest.id;
}
const startBody=async(requestId)=>({eventType:'CHECK_IN',previousCheckoutRequestId:requestId,
  expectedStateVersion:(await session()).state_version,clientRequestId:randomUUID(),location:null});
const decide=(requestId,decision)=>call('decision',{idToken:'fixture_manager',storeId:f.store,requestId,decision});
const events=async()=>(await f.db.query('SELECT * FROM effective_punch_events WHERE staff_id=$1 ORDER BY occurred_at',[f.staff])).rows;

test('pending checkout permits one linked new shift; approval preserves current state and old originals',async()=>{
  const id=await pending(),before=await events(),member=await session();
  assert.equal(member.state,'WORKING');assert.equal(member.recent_punches.length,0);
  assert.equal(member.pending_shift_start.request_id,id);
  const body=await startBody(id),r=await call('punch',body);
  assert.equal(r.status,'applied');assert.equal((await session()).pending_shift_start,null);
  const saved=(await f.db.query('SELECT * FROM punch_events WHERE client_request_id=$1',[body.clientRequestId])).rows[0];
  assert.equal(saved.previous_checkout_request_id,id);
  assert.equal((await f.db.query('SELECT status FROM correction_requests WHERE id=$1',[id])).rows[0].status,'PENDING');
  let daily=deriveDailyAttendanceRecords(await events());
  assert.equal(daily.length,2);assert.equal(daily[0].workedMinutes,null);assert.equal(daily[0].status,'NEEDS_REVIEW');
  const current=await session();assert.equal(current.last_event_id,saved.id);
  assert.equal((await decide(id,'APPROVED')).status,200);
  assert.equal((await session()).last_event_id,saved.id);assert.equal((await session()).state,'WORKING');
  daily=deriveDailyAttendanceRecords(await events());
  assert.equal(daily[0].workedMinutes,180);assert.equal(daily[0].status,'CONFIRMED');
  assert.deepEqual((await events()).filter(e=>e.effective_id===before[0].effective_id),before);
  assert.equal((await call('punch',body)).status,'already_applied');
  assert.equal((await call('punch',{...body,previousCheckoutRequestId:id.toUpperCase()})).status,'already_applied');
  assert.equal((await call('punch',{...body,previousCheckoutRequestId:randomUUID()})).code,'CLIENT_REQUEST_CONFLICT');
  assert.equal((await call('punch',{...body,previousCheckoutRequestId:undefined})).code,'CLIENT_REQUEST_CONFLICT');
});

test('rejection preserves the new shift, its checkout and independent daily totals',async()=>{
  const id=await pending(),body=await startBody(id);assert.equal((await call('punch',body)).status,'applied');
  const started=await session();
  assert.equal((await decide(id,'REJECTED')).status,200);
  assert.equal((await session()).last_event_id,started.last_event_id);
  assert.equal((await call('punch',{eventType:'CHECK_OUT',expectedStateVersion:(await session()).state_version,clientRequestId:randomUUID()})).status,'applied');
  const daily=deriveDailyAttendanceRecords(await events());
  assert.equal(daily[0].status,'NEEDS_REVIEW');assert.equal(daily[0].workedMinutes,null);
  assert.equal(daily[1].status,'CONFIRMED');assert.equal(daily[1].workedMinutes,0);
  assert.equal((await session()).state,'OFF_DUTY');
  assert.equal((await f.db.query('SELECT count(*)::int n FROM punch_events WHERE previous_checkout_request_id=$1',[id])).rows[0].n,1);
});

for(const decision of ['APPROVED','REJECTED']) test(`${decision} before start rejects stale intent without inserting; reload chooses the correct next action`,async()=>{
  const id=await pending(),body=await startBody(id);assert.equal((await decide(id,decision)).status,200);
  assert.equal((await call('punch',body)).code,'INVALID_STATE_TRANSITION');
  assert.equal((await session()).pending_shift_start,null);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM punch_events')).rows[0].n,1);
  if(decision==='APPROVED') assert.equal((await call('punch',{...body,previousCheckoutRequestId:undefined,expectedStateVersion:(await session()).state_version})).status,'applied');
  else assert.equal((await session()).state,'WORKING');
});

test('retry and simultaneous double taps cannot create two new shifts; result lookup recovers the saved one',async()=>{
  const id=await pending(),body=await startBody(id);
  await Promise.all([call('punch',body),call('punch',{...body,clientRequestId:randomUUID()})]);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM punch_events WHERE previous_checkout_request_id=$1',[id])).rows[0].n,1);
  const result=await call('bootstrap',{pendingOperation:{kind:'punch',clientRequestId:body.clientRequestId}});
  assert.equal(result.operationResult.event_type,'CHECK_IN');
  assert.equal((await call('punch',body)).status,'already_applied');
  assert.equal((await call('punch',{...body,clientRequestId:randomUUID(),expectedStateVersion:(await session()).state_version})).code,'INVALID_STATE_TRANSITION');
});

test('no request or unknown-time consultation cannot reset an overnight shift',async()=>{
  await add('CHECK_IN',(await times()).start);
  assert.equal((await session()).pending_shift_start,null);
  const r=await call('correction',{category:'OTHER',reason:'Fixture unknown time',clientRequestId:randomUUID()});
  assert.equal((await call('punch',await startBody(r.correctionRequest.id))).code,'INVALID_STATE_TRANSITION');
  assert.equal((await call('punch',{...(await startBody()),previousCheckoutRequestId:undefined})).code,'INVALID_STATE_TRANSITION');
  assert.equal((await call('punch',{eventType:'CHECK_OUT',expectedStateVersion:(await session()).state_version,clientRequestId:randomUUID()})).status,'applied');
  const e=await events();assert.equal(e[0].business_date,e[1].business_date);
});

test('same-business-day repeated check-in is not enabled by a pending checkout',async()=>{
  await add('CHECK_IN',new Date(Date.now()-120000).toISOString());
  const r=await call('correction',{category:'MISSED',eventType:'CHECK_OUT',occurredAt:new Date(Date.now()-60000).toISOString(),clientRequestId:randomUUID()});
  assert.equal(r.status,'submitted');assert.equal((await session()).pending_shift_start,null);
  assert.equal((await call('punch',await startBody(r.correctionRequest.id))).code,'INVALID_STATE_TRANSITION');
});

test('eligibility follows the store business day, not calendar midnight',async()=>{
  const id=await pending();
  await f.db.query("UPDATE stores SET business_day_start_minute=EXTRACT(HOUR FROM NOW() AT TIME ZONE 'Asia/Tokyo')::int*60+EXTRACT(MINUTE FROM NOW() AT TIME ZONE 'Asia/Tokyo')::int+1 WHERE id=$1",[f.store]);
  assert.equal((await session()).pending_shift_start,null);
  assert.equal((await call('punch',await startBody(id))).code,'INVALID_STATE_TRANSITION');
});

test('open break, newer actual event and multiple conflicting checkout requests block the shortcut',async()=>{
  const id=await pending(),t=await times();
  const breakAt=new Date(Date.parse(t.finish)-60000).toISOString();await add('BREAK_START',breakAt);
  assert.equal((await session()).pending_shift_start,null);
  await add('BREAK_END',new Date(Date.parse(t.finish)+60000).toISOString());
  assert.equal((await call('punch',await startBody(id))).code,'INVALID_STATE_TRANSITION');
  await f.db.query('UPDATE staff_states SET last_event_id=NULL WHERE staff_id=$1',[f.staff]);
  await f.db.query('DELETE FROM punch_events WHERE event_type IN (\'BREAK_START\',\'BREAK_END\')');
  await f.db.query("INSERT INTO correction_requests(store_id,staff_id,operation,requested_event_type,requested_occurred_at,requested_business_date,client_request_payload) SELECT store_id,staff_id,operation,requested_event_type,requested_occurred_at-INTERVAL '1 minute',requested_business_date,client_request_payload FROM correction_requests WHERE id=$1",[id]);
  assert.equal((await session()).pending_shift_start,null);
});

test('cross-staff, cross-store, revoked QR and inactive memberships cannot use a pending request',async()=>{
  const id=await pending(),body=await startBody(id);
  assert.equal((await call('punch',{...body,idToken:'fixture_other'})).status,404);
  assert.equal((await call('punch',{...body,storeToken:'bad'})).status,404);
  await f.db.query('UPDATE store_entry_tokens SET revoked_at=NOW()');assert.equal((await call('punch',body)).status,404);
  await f.db.query('UPDATE store_entry_tokens SET revoked_at=NULL');
  for(const status of ['inactive','departed']) {await f.db.query('UPDATE staff SET status=$1 WHERE id=$2',[status,f.staff]);assert.equal((await call('punch',body)).status,404);}
  const other=f.getSql({mode:'staff',lineIdentity:'fixture_other',storeTokenHash:tokenHash});
  assert.equal((await other`SELECT * FROM staff_pending_shift_start(${f.staff}::uuid)`).length,0);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM punch_events')).rows[0].n,1);
});

test('an active shift at another store still prevents this check-in',async()=>{
  const id=await pending(),body=await startBody(id);
  await f.db.query("UPDATE staff SET line_user_id='fixture_actor' WHERE id=$1",[f.otherStaff]);
  await add('CHECK_IN',(await times()).start,{staff:f.otherStaff,store:f.otherStore});
  assert.equal((await call('punch',body)).code,'ACTIVE_AT_OTHER_STORE');
  await f.db.query("UPDATE staff SET line_user_id='fixture_other' WHERE id=$1",[f.otherStaff]);
});

test('malformed links and links attached to non-check-in events are rejected before writing',async()=>{
  const id=await pending(),body=await startBody(id);
  assert.equal((await call('punch',{...body,previousCheckoutRequestId:'bad'})).status,400);
  assert.equal((await call('punch',{...body,eventType:'CHECK_OUT'})).status,400);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM punch_events')).rows[0].n,1);
});

test('direct correction of the old day and its later approval preserve the new shift and original punches',async()=>{
  const id=await pending(),original=(await events())[0];
  assert.equal((await call('punch',await startBody(id))).status,'applied');
  const latest=(await session()).last_event_id;
  const sql=f.getSql({mode:'manager',lineIdentity:'fixture_manager',storeId:f.store});
  const revised=new Date(Date.parse(original.occurred_at)-3600000).toISOString();
  await sql`SELECT * FROM apply_manager_direct_correction(${f.store}::uuid,${f.staff}::uuid,
    'REPLACE',${original.original_event_id}::uuid,NULL,'CHECK_IN',${revised}::timestamptz,'Fixture revised start')`;
  assert.equal((await session()).last_event_id,latest);
  assert.equal((await decide(id,'APPROVED')).status,200);
  assert.equal((await session()).last_event_id,latest);assert.equal((await session()).state,'WORKING');
  assert.equal(deriveDailyAttendanceRecords(await events())[0].workedMinutes,240);
  assert.equal((await f.db.query('SELECT occurred_at FROM punch_events WHERE id=$1',[original.original_event_id])).rows[0].occurred_at,original.occurred_at);
});

test('a legacy pending future checkout never authorizes a new check-in',async()=>{
  const id=await pending();
  await f.db.query("UPDATE correction_requests SET requested_occurred_at=NOW()+INTERVAL '1 hour' WHERE id=$1",[id]);
  assert.equal((await session()).pending_shift_start,null);
  assert.equal((await call('punch',await startBody(id))).code,'INVALID_STATE_TRANSITION');
  assert.equal((await f.db.query('SELECT count(*)::int n FROM punch_events')).rows[0].n,1);
});
