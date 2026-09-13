// Local-only UI fixture. The deployment allowlist does not include this harness.
import {cp,readFile,writeFile,chmod} from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const dest=path.join(root,'build/shift-ui-fixture');
await cp(path.join(root,'build/shift-deployment'),dest,{recursive:true});
await writeFile(path.join(dest,'app/page.tsx'),`'use client';
import {useCallback,useState} from 'react';
import ShiftWorkspace from './shift-workspace';
export default function Fixture(){
 const [actor,setActor]=useState('staff');
 const call=useCallback(async(action:string,input:Record<string,unknown>={},storeId='')=>{const r=await fetch('/api/requests',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+actor},body:JSON.stringify({action,input,storeId})});const d=await r.json();if(!d.ok)throw Object.assign(new Error(d.message),{code:d.code});return d.data;},[actor]);
 return <><label style={{display:'block',padding:16}}>架空データの検証対象<select value={actor} onChange={e=>setActor(e.target.value)}><option value="staff">スタッフ</option><option value="manager">管理者</option></select></label><ShiftWorkspace key={actor} members={[{storeId:'10000000-0000-4000-8000-000000000090',storeName:'接続検証食堂',staffId:actor==='staff'?'20000000-0000-4000-8000-000000000090':'20000000-0000-4000-8000-000000000091',name:actor==='staff'?'検証スタッフ':'検証管理者',manager:actor==='manager'}]} call={call}/></>;
}`);
await writeFile(path.join(dest,'app/api/requests/route.ts'),`import {neon} from '@neondatabase/serverless';
import {handleShiftHttp} from '@shared/shift-http.mjs';
import {randomBytes} from 'node:crypto';
const rateSecret=randomBytes(32).toString('hex');
export async function POST(request:Request){
 if(process.env.VERCEL||process.env.NODE_ENV!=='development')return new Response('Local development only',{status:403});
 const headers=new Headers(request.headers);headers.set('origin','https://shift.example.test');
 const fixtureRequest=new Request('https://shift.example.test/api/requests',{method:'POST',headers,body:await request.text()});
 const env={ONOGAMI_PRODUCT:'shift',SHIFT_DATABASE_URL:process.env.SHIFT_TEST_DATABASE_URL,SHIFT_ORIGIN:'https://shift.example.test',SHIFT_LINE_LOGIN_CHANNEL_ID:'9999999999',SHIFT_LIFF_ID:'9999999999-Fixture',SHIFT_RATE_LIMIT_SECRET:rateSecret};
 const ids:Record<string,string>={staff:'U_shift_fixture_concurrent',manager:'U_shift_fixture_manager_connect'};
 return handleShiftHttp(fixtureRequest,{env,connect:neon,verify:async(token:string)=>{if(!ids[token])throw new Error('SHIFT_UNAUTHENTICATED');return ids[token];}} as Parameters<typeof handleShiftHttp>[1]);
}`);
const env=await readFile(path.join(root,'build/shift-test.env'),'utf8');
await writeFile(path.join(dest,'.env.local'),env,{mode:0o600});await chmod(path.join(dest,'.env.local'),0o600);
console.log(dest);
