import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const storeId = 'a0000000-0000-4000-8000-000000000001';
const source = readFileSync(new URL('../app/api/manager/store-settings/route.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText;
function handlers({allowed=true, validToken=true, stale=false}={}) {
  const calls=[]; const contexts=[];
  class LineTokenVerificationError extends Error {}
  const store={id:storeId,name:'検証店舗',closing_rule:'month_end',business_day_start_minute:300,monthly_report_email:null};
  const modules={
    'next/server': {NextResponse:{json:(body,options)=>Response.json(body,options)}},
    '@/lib/db': {getSql:context=>{contexts.push(context);return async (strings,...params)=>{calls.push({query:strings.join('?'),params});return strings.join('').includes('set_manager_store_settings') ? (stale?[]:[{id:storeId,name:store.name,closing_rule:params[2]}]) : (allowed?[store]:[]);};}},
    '@/lib/api-security': {enforceRateLimit:async()=>null},
    '@/lib/safe-log': {logServerError:()=>{}},
    '@/lib/line/verify-id-token': {LineTokenVerificationError,verifyLineIdToken:async()=>{if(!validToken)throw new LineTokenVerificationError();return {sub:'verified-line-identity'};}},
  };
  const exports={};vm.runInNewContext(compiled,{exports,require:name=>{assert.ok(modules[name],name);return modules[name];},Response});
  return {...exports,calls,contexts};
}
const request=(method,body)=>new Request('http://localhost/api/manager/store-settings',{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const payload={storeId,idToken:'fixture-token',closingRule:'day_25',expectedClosingRule:'month_end'};

test('read and save use verified identity and explicit store scope',async()=>{
  const api=handlers();const res=await api.PATCH(request('PATCH',payload));assert.equal(res.status,200);
  const body=await res.json();assert.equal(body.store.closing_rule,'day_25');assert.equal(body.store.business_day_start_minute,300);
  assert.deepEqual(JSON.parse(JSON.stringify(api.contexts[0])),{mode:'manager',lineIdentity:'verified-line-identity',storeId});
  assert.deepEqual(api.calls[1].params,['verified-line-identity',storeId,'day_25','month_end']);
});
for(const method of ['POST','PATCH']){
  test(`${method} rejects missing membership without a write`,async()=>{const api=handlers({allowed:false});const res=await api[method](request(method,payload));assert.equal(res.status,403);assert.equal(api.calls.length,1);});
  test(`${method} rejects expired identity without a query`,async()=>{const api=handlers({validToken:false});assert.equal((await api[method](request(method,payload))).status,401);assert.equal(api.calls.length,0);});
  test(`${method} rejects malformed body`,async()=>{for(const value of [null,[],{}, {...payload,storeId:'invalid'}]){const api=handlers();assert.equal((await api[method](request(method,value))).status,400);assert.equal(api.calls.length,0);}});
}
test('stale settings return a conflict, never a success',async()=>{const api=handlers({stale:true});const res=await api.PATCH(request('PATCH',payload));assert.equal(res.status,409);assert.equal((await res.json()).code,'STORE_SETTINGS_CHANGED');});
test('invalid or missing closing rules are rejected before SQL',async()=>{for(const changes of [{closingRule:'day_99'},{expectedClosingRule:null}]){const api=handlers();assert.equal((await api.PATCH(request('PATCH',{...payload,...changes}))).status,400);assert.equal(api.calls.length,0);}});
