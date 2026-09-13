import test from 'node:test';
import assert from 'node:assert/strict';
import {handleShiftHttp} from '../lib/shift-http.mjs';
import {editorPayload,payloadEquals,newPeriodInput,EMPTY_SHIFT_PAYLOAD} from '../lib/shift-connected.mjs';
const env={ONOGAMI_PRODUCT:'shift',SHIFT_DATABASE_URL:'postgresql://fixture:fake@dev.example.test/neondb',SHIFT_ORIGIN:'https://shift.example.test',SHIFT_LINE_LOGIN_CHANNEL_ID:'9999999999',SHIFT_LIFF_ID:'9999999999-Fixture',SHIFT_RATE_LIMIT_SECRET:'fixture'.repeat(8)};
const request=(body={action:'memberships',input:{}},headers={})=>new Request(env.SHIFT_ORIGIN+'/api/requests',{method:'POST',headers:{Origin:env.SHIFT_ORIGIN,'Content-Type':'application/json',Authorization:'Bearer fixture-token',...headers},body:JSON.stringify(body)});
const dependencies=(overrides={})=>({env,connect:()=>({}),verify:async()=> 'U_fixture_verified',limit:async()=>{},execute:async()=>[],...overrides});

test('HTTP authenticates, limits and uses only the verified LINE identity',async()=>{
  const calls=[];
  const response=await handleShiftHttp(request({action:'self',storeId:'fixture',input:{},lineIdentity:'U_forged',manager:true}),dependencies({
    limit:async(sql,scope,key)=>{assert.match(key,/^[0-9a-f]{64}$/);calls.push(scope);},
    verify:async()=>{calls.push('verify');return 'U_verified';},
    execute:async command=>{assert.equal(command.lineIdentity,'U_verified');assert.equal(command.manager,undefined);calls.push('execute');return {shared:true};},
  }));
  assert.equal(response.status,200);assert.deepEqual(calls,['global','client','verify','subject','execute']);
  assert.match(response.headers.get('cache-control'),/no-store/);assert.deepEqual((await response.json()).data,{shared:true});
});
test('origin, token, content type, malformed JSON and streamed size fail before authentication',async()=>{
  const deps=dependencies({verify:async()=>assert.fail('must not authenticate'),execute:async()=>assert.fail('must not execute')});
  for(const [req,status] of [
    [request(undefined,{Origin:'https://other.example.test'}),403],[request(undefined,{Authorization:''}),401],
    [request(undefined,{'Content-Type':'text/plain'}),400],[request({action:'memberships',input:{huge:'x'.repeat(33000)}}),413],
    [new Request(env.SHIFT_ORIGIN,{method:'POST',headers:{Origin:env.SHIFT_ORIGIN,'Content-Type':'application/json',Authorization:'Bearer fixture'},body:'{broken'}),400],
  ])assert.equal((await handleShiftHttp(req,deps)).status,status);
});
test('rate limit and unavailable configuration stop work, and safe errors hide raw DB data',async()=>{
  let response=await handleShiftHttp(request(),dependencies({limit:async()=>{throw new Error('SHIFT_RATE_LIMITED');},verify:async()=>assert.fail('must not authenticate')}));
  assert.equal(response.status,429);assert.equal(response.headers.get('retry-after'),'60');
  response=await handleShiftHttp(request(),dependencies({env:{...env,SHIFT_LIFF_ID:''},connect:()=>assert.fail('must not connect')}));assert.equal(response.status,503);
  for(const [error,status,code] of [[new Error('SHIFT_CONFLICT'),409,'SHIFT_CONFLICT'],[new Error('SHIFT_CLOSED'),409,'SHIFT_CLOSED'],[new Error('SHIFT_FORBIDDEN'),403,'SHIFT_FORBIDDEN'],[Object.assign(new Error('staff name / SQL / token'),{code:'23505'}),409,'SHIFT_CONFLICT'],[new Error('secret database credential'),503,'SHIFT_UNAVAILABLE']]){
    response=await handleShiftHttp(request(),dependencies({execute:async()=>{throw error;}}));assert.equal(response.status,status);const body=await response.json();assert.equal(body.code,code);assert.doesNotMatch(JSON.stringify(body),/credential|staff name|SQL|token/);
  }
});
test('editor keeps private saved drafts ahead of submitted/proxy snapshots and ignores JSON key order',()=>{
  const draft=structuredClone(EMPTY_SHIFT_PAYLOAD);draft.baseline.target=3;
  assert.deepEqual(editorPayload({draft:{payload:draft},submitted:{payload:EMPTY_SHIFT_PAYLOAD}}),draft);
  assert.ok(payloadEquals({baseline:draft.baseline,days:{}},{days:{},baseline:{...draft.baseline}}));
  const copy=editorPayload({draft:{payload:draft},submitted:null});copy.baseline.target=4;assert.equal(draft.baseline.target,3);
  assert.deepEqual(newPeriodInput('month','2028-02-01','2028-01-25T20:00'),{unit:'month',startsOn:'2028-02-01',endsOn:'2028-02-29',deadline:'2028-01-25T20:00:00+09:00'});
  assert.equal(newPeriodInput('week','2028-02-28','2028-02-25T20:00').endsOn,'2028-03-05');
  assert.throws(()=>newPeriodInput('month','2028-02-02','2028-01-25T20:00'));
});
