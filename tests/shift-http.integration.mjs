// Opt-in isolated fixture DB integration. Not imported by either deployed app.
// Run: node --env-file=build/shift-test.env tests/shift-http.integration.mjs
import assert from 'node:assert/strict';
import {neon} from '@neondatabase/serverless';
import {randomBytes} from 'node:crypto';
import {handleShiftHttp} from '../lib/shift-http.mjs';
const databaseUrl=process.env.SHIFT_TEST_DATABASE_URL;
if(!databaseUrl||new URL(databaseUrl).username!=='onogami_shift_runtime')throw new Error('Isolated shift test runtime is required');
const env={ONOGAMI_PRODUCT:'shift',SHIFT_DATABASE_URL:databaseUrl,SHIFT_ORIGIN:'https://shift.example.test',SHIFT_LINE_LOGIN_CHANNEL_ID:'9999999999',SHIFT_LIFF_ID:'9999999999-Fixture',SHIFT_RATE_LIMIT_SECRET:randomBytes(32).toString('hex')};
const storeId='10000000-0000-4000-8000-000000000090',periodId='30000000-0000-4000-8000-000000000090';
const fixtureIdentity={staff:'U_shift_fixture_concurrent',manager:'U_shift_fixture_manager_connect'};
async function request(actor,action,input={},scope=storeId){
  const response=await handleShiftHttp(new Request(env.SHIFT_ORIGIN+'/api/requests',{method:'POST',headers:{Origin:env.SHIFT_ORIGIN,'Content-Type':'application/json',Authorization:`Bearer ${actor}`},body:JSON.stringify({action,input,storeId:scope})}),{
    env,connect:neon,verify:async token=>{if(!fixtureIdentity[token])throw new Error('SHIFT_UNAUTHENTICATED');return fixtureIdentity[token];},
  });
  return {status:response.status,...await response.json()};
}
const memberships=await request('staff','memberships');assert.equal(memberships.status,200);assert.equal(memberships.data.length,1);assert.equal(memberships.data[0].storeId,storeId);
const self=await request('staff','self',{periodId});assert.equal(self.status,200);
const initial=self.data;
const payload=structuredClone(initial.draft.payload);payload.baseline.target=payload.baseline.target===2?3:2;
const save=await request('staff','saveDraft',{periodId,expectedDraftVersion:initial.draft.version,payload});assert.equal(save.status,200);
const managerBefore=await request('manager','manager',{periodId});assert.equal(managerBefore.status,200);assert.ok(managerBefore.data.people.every(p=>!Object.hasOwn(p,'draft')));
const submitted=await request('staff','submit',{periodId,expectedDraftVersion:save.data.version,expectedSubmissionVersion:initial.submitted?.version||0});assert.equal(submitted.status,200);
const managerAfter=await request('manager','manager',{periodId});assert.equal(managerAfter.status,200);const target=managerAfter.data.people.find(p=>p.id==='20000000-0000-4000-8000-000000000090');assert.deepEqual(target.submitted.payload,payload);
const reloaded=await request('staff','self',{periodId});assert.deepEqual(reloaded.data.draft.payload,payload);assert.deepEqual(reloaded.data.submitted.payload,payload);
const stale=await request('staff','saveDraft',{periodId,expectedDraftVersion:initial.draft.version,payload});assert.equal(stale.status,409);
assert.equal((await request('staff','manager',{periodId})).status,403);
assert.equal((await request('staff','self',{periodId},'10000000-0000-4000-8000-000000000099')).status,403);
assert.equal((await request('invalid','memberships')).status,401);
console.log('Real shift runtime: memberships, private draft, submission, manager sharing, reload, conflicts and authorization passed. LINE verification is fixture-only.');
