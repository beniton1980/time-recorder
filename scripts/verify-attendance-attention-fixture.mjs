// Run only against a newly created disposable Neon database. No production URL
// fallback, real LINE tokens, email services or app environment changes.
import {Client, neonConfig} from '@neondatabase/serverless';
import {readFile,readdir} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {loadTs} from '../tests/helpers/load-ts.mjs';
import * as attendance from '../lib/monthly-attendance.mjs';
neonConfig.webSocketConstructor=WebSocket;
const connectionString=process.env.P0_FIXTURE_DATABASE_URL;
if(!connectionString || !/^\/onogami_p0_attention_fixture(?:_final)?$/.test(new URL(connectionString).pathname)) throw Error('Dedicated fixture database required');
const databaseName=new URL(connectionString).pathname.slice(1);
const client=new Client({connectionString});
await client.connect();
try {
  const exists=await client.query("SELECT to_regclass('public.correction_attention_sources') AS relation");
  const dir=new URL('../db/migrations/',import.meta.url);
  for(const file of exists.rows[0].relation ? [] : (await readdir(dir)).filter(f=>f.endsWith('.sql')).sort()) {
    await client.query((await readFile(new URL(file,dir),'utf8')).replaceAll('DATABASE neondb','DATABASE '+databaseName));
  }
  // This role grant is confined to the explicitly selected disposable branch.
  await client.query('GRANT onogami_app TO CURRENT_USER');
  const store=randomUUID(),staff=randomUUID(),otherStore=randomUUID(),otherStaff=randomUUID();
  const token='FICTITIOUS_P0_QR_ONLY_'+randomUUID(),hash=createHash('sha256').update(token).digest('hex');
  await client.query("INSERT INTO stores(id,name) VALUES($1,'Fixture P0'),($2,'Fixture Other')",[store,otherStore]);
  await client.query("INSERT INTO staff(id,store_id,line_user_id,legal_name) VALUES($1,$2,'fixture_actor','Fixture'),($3,$4,'fixture_other','Other')",[staff,store,otherStaff,otherStore]);
  await client.query('INSERT INTO staff_states(staff_id) VALUES($1),($2)',[staff,otherStaff]);
  await client.query('INSERT INTO store_entry_tokens(store_id,token_hash) VALUES($1,$2)',[store,hash]);
  const eventId=randomUUID();
  await client.query("INSERT INTO punch_events(id,staff_id,store_id,event_type,occurred_at,business_date,client_request_id) VALUES($1,$2,$3,'CHECK_IN',date_trunc('day',NOW())-interval '2 days'+interval '10 hours',(NOW()-interval '2 days')::date,gen_random_uuid())",[eventId,staff,store]);
  await client.query("UPDATE staff_states SET state='WORKING',last_event_id=$1,last_event_at=(SELECT occurred_at FROM punch_events WHERE id=$1) WHERE staff_id=$2",[eventId,staff]);
  function getSql(context) {
    return async(strings,...params)=>{
      const c=new Client({connectionString});await c.connect();
      try {
        await c.query('BEGIN');await c.query('SET LOCAL ROLE onogami_app');
        for(const [k,v] of Object.entries({mode:context.mode,line_user_id:context.lineIdentity??'',store_token_hash:context.storeTokenHash??''}))
          await c.query('SELECT set_config($1,$2,true)',['app.request_'+k,v]);
        const result=await c.query(strings.reduce((s,v,i)=>s+(i?'$'+i:'')+v,''),params);
        await c.query('COMMIT');return result.rows;
      }catch(error){await c.query('ROLLBACK');console.error(JSON.stringify({stage:'fixture_query',code:error.code,message:error.message}));throw error;}finally{await c.end();}
    };
  }
  class LineTokenVerificationError extends Error {}
  const modules={
    'next/server':{NextResponse:{json:(body,options)=>Response.json(body,options)}},
    '@/lib/db':{getSql}, '@/lib/safe-log':{logServerError:()=>{}},
    '@/lib/line/verify-id-token':{LineTokenVerificationError,verifyLineIdToken:async token=>{if(!['fixture_actor','fixture_other'].includes(token))throw new LineTokenVerificationError();return{sub:token};}},
    '@/lib/store-entry-token':{hashStoreEntryToken:v=>typeof v==='string'?createHash('sha256').update(v).digest('hex'):null},
    '@/lib/api-security':{enforceRateLimit:async()=>null},
    '@/lib/attendance-attention':loadTs('lib/attendance-attention.ts',{'./monthly-attendance.mjs':attendance}),
  };
  const routes=Object.fromEntries(['attendance-attention','correction-requests','correction-requests/history'].map(path=>[path,loadTs('app/api/'+path+'/route.ts',modules)]));
  const call=async(path,body={})=>{const r=await routes[path].POST(new Request('http://fixture/api',{method:'POST',body:JSON.stringify({idToken:'fixture_actor',storeToken:token,...body})}));return{body:await r.json(),status:r.status};};
  const initial=await call('attendance-attention');assert.equal(initial.status,200);assert.equal(initial.body.items.length,1);
  const source=initial.body.items[0].source, attentionSource={eventId:source.eventId,revision:source.revision};
  const body={clientRequestId:randomUUID(),category:'OTHER',reason:'Fictitious P0 consultation',attentionSource};
  const race=await Promise.all([call('correction-requests',body),call('correction-requests',{...body,clientRequestId:randomUUID()})]);
  assert.deepEqual(race.map(r=>r.status).sort(),[200,409]);
  const saved=race.find(r=>r.status===200).body.correctionRequest.id;
  const lookup=await call('correction-requests/history',{requestId:saved});assert.equal(lookup.body.requests[0].source.eventId,eventId);
  assert.equal((await call('attendance-attention')).body.items[0].bucket,'waiting');
  assert.equal((await call('attendance-attention',{idToken:'fixture_other'})).status,404);
  const rls=await client.query("SELECT relrowsecurity FROM pg_class WHERE oid='correction_attention_sources'::regclass");assert.equal(rls.rows[0].relrowsecurity,true);
  const permission=await client.query("SELECT has_table_privilege('onogami_app','correction_attention_sources','UPDATE') AS update, has_table_privilege('onogami_app','correction_attention_sources','DELETE') AS delete");assert.equal(permission.rows[0].update,false);assert.equal(permission.rows[0].delete,false);
  assert.equal((await client.query('SELECT count(*)::int n FROM correction_attention_sources WHERE store_id=$1',[store])).rows[0].n,1);
  console.log(JSON.stringify({ok:true,migrations:48,concurrentSubmissions:'one_saved_one_existing',rls:true,updateDeleteDenied:true,ownHistory:true,foreignDenied:true,fixtureOnly:true}));
}catch(error){console.error(JSON.stringify({ok:false,code:error.code??'FIXTURE_FAILED',message:String(error.message).replace(/postgres(?:ql)?:\/\/\S+/g,'[redacted]')}));process.exitCode=1;}
finally{await client.end();}
