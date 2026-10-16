import test from 'node:test';
import assert from 'node:assert/strict';
import * as jsxRuntime from 'react/jsx-runtime';
import {loadTs} from './helpers/load-ts.mjs';
const settle=async()=>{for(let i=0;i<5;i++)await new Promise(r=>setImmediate(r));};
const text=t=>typeof t==='string'?t:Array.isArray(t)?t.map(text).join(''):t?.props?text(t.props.children):'';
const nodes=(t,type)=>!t||typeof t!=='object'?[]:Array.isArray(t)?t.flatMap(n=>nodes(n,type)):[...(t.type===type?[t]:[]),...nodes(t.props?.children,type)];
const consultation={id:'fixture-consultation',storeId:'fixture-store',staffId:'fixture-staff',staffName:'架空スタッフ',storeName:'架空店舗',reason:'架空の相談',requestedAt:'2026-09-02T01:00:00Z',requestDay:'2026-09-02',targetDay:null,status:'PENDING',version:'1000.123456',changes:[]};
function screen(initial={...consultation},days=[]){
 const slots=[],effects=[],calls=[];let index=0,mounted=false,cleanup;
 let response=async()=>({ok:true,json:async()=>({ok:true,consultation:initial,days})});
 const component=loadTs('app/manager/consultations/page.tsx',{
  'react/jsx-runtime':jsxRuntime,react:{
   useState(initial){const i=index++;if(!(i in slots))slots[i]=initial;return[slots[i],v=>{slots[i]=typeof v==='function'?v(slots[i]):v;}];},
   useRef(initial){const i=index++;if(!(i in slots))slots[i]={current:initial};return slots[i];},
   useCallback:fn=>fn,useSyncExternalStore:()=>'?store_id=fixture-store&id=fixture-consultation',
   useEffect(fn){if(!mounted)effects.push(fn);},
  },
  '@line/liff':{default:{init:async()=>{},isLoggedIn:()=>true,getIDToken:()=> 'fixture'}},
  '@/lib/attendance-request':{withAttendanceDeadline:fn=>fn(new AbortController().signal)},
  './consultations.module.css':{default:{}},
 },{process:{env:{}},fetch:async(url,options)=>{const body=JSON.parse(options.body);calls.push(body);return response(body);}});
 return{calls,render(){index=0;const t=component.default();if(!mounted){mounted=true;cleanup=effects[0]?.();}return t;},respond(fn){response=fn;},unmount(){cleanup?.();}};
}
const button=(s,label)=>nodes(s.render(),'button').find(n=>text(n)===label);
const click=async(s,label)=>{button(s,label).props.onClick();await settle();};
test('saving is not closing; uncertain completion is recovered by reloading the authoritative result',async()=>{
 const saved={...consultation,changes:[{id:'correction',operation:'REPLACE',before:null,after:null,reason:'架空訂正',at:'2026-10-15T01:00:00Z'}]};
 const s=screen(saved);s.render();await settle();
 assert.match(text(s.render()),/修正保存済み・未完了/);assert.equal(s.calls.some(c=>c.action==='resolve'),false);
 s.respond(async()=>{throw Error('connection lost after commit');});await click(s,'対応済みにする');
 assert.match(text(s.render()),/完了したか確認できません/);assert.doesNotMatch(text(s.render()),/相談を対応済みにしました/);
 s.respond(async()=>({ok:true,json:async()=>({ok:true,consultation:{...saved,status:'RESOLVED',outcome:'CORRECTED',resolvedAt:'2026-10-15T02:00:00Z'},days:[]})}));
 await click(s,'最新の状態を確認');assert.match(text(s.render()),/対応済み/);assert.equal(button(s,'対応済みにする'),undefined);assert.equal(s.calls.filter(c=>c.action==='resolve').length,1);
});
test('no-change close requires a reason and a failed refresh removes stale actionable content',async()=>{
 const s=screen();s.render();await settle();assert.equal(button(s,'対応済みにする'),undefined);
 await click(s,'修正せず確認を終える');
 const close=nodes(s.render(),'button').find(n=>text(n).includes('対応済み'));assert.equal(close.props.disabled,true);
 nodes(s.render(),'textarea')[0].props.onChange({target:{value:'すでに修正済みと確認'}});
 s.respond(async body=>({ok:true,json:async()=>body.action==='resolve'?{ok:true}:{ok:true,consultation:{...consultation,status:'RESOLVED',outcome:'NO_CHANGE',resolutionReason:'すでに修正済みと確認',resolvedAt:'2026-10-15T02:00:00Z'},days:[]}}));
 nodes(s.render(),'button').find(n=>text(n).includes('対応済み')).props.onClick();await settle();
 assert.equal(s.calls.find(c=>c.action==='resolve').reason,'すでに修正済みと確認');assert.match(text(s.render()),/打刻の変更はありません/);
 s.respond(async()=>{throw Error('offline');});await click(s,'最新の状態を確認');assert.match(text(s.render()),/取得できません/);assert.doesNotMatch(text(s.render()),/相談内容|対象の打刻を確認・修正/);
});
test('a late detail response cannot update an unmounted consultation',async()=>{
 const s=screen();let finish;s.respond(()=>new Promise(r=>{finish=r;}));s.render();await settle();s.unmount();
 finish({ok:true,json:async()=>({ok:true,consultation,days:[]})});await settle();assert.doesNotMatch(text(s.render()),/相談内容|架空の相談/);
});

const workSection=s=>nodes(s.render(),'section').find(n=>text(nodes(n,'h2')).includes('対象・修正した勤務'));
const requestSection=s=>nodes(s.render(),'section').find(n=>text(nodes(n,'h2'))==='申請待ちの表示日');
test('an untargeted request day is not presented as the work being corrected',async()=>{
 const s=screen(consultation,[{businessDate:'2026-09-02',status:'NEEDS_REVIEW',reasons:['PENDING_CORRECTION']}]);s.render();await settle();
 assert.equal(nodes(workSection(s),'a').length,0);
 assert.match(text(workSection(s)),/未指定/);
 assert.match(text(requestSection(s)),/対象の勤務日とは限りません/);
 assert.equal(new URL(nodes(requestSection(s),'a')[0].props.href,'https://fixture.invalid').searchParams.get('focus'),'2026-09-02');
});
test('both sides of a work-day move remain linked while the request day is separate',async()=>{
 const changed={...consultation,changes:[{id:'correction',operation:'REPLACE',before:{day:'2026-08-31'},after:{day:'2026-09-01'},reason:'架空訂正',at:'2026-10-15T01:00:00Z'}]};
 const days=['2026-08-31','2026-09-01','2026-09-02'].map(businessDate=>({businessDate,status:'NEEDS_REVIEW',reasons:['PENDING_CORRECTION']}));
 const s=screen(changed,days);s.render();await settle();
 assert.deepEqual(nodes(workSection(s),'a').map(a=>new URL(a.props.href,'https://fixture.invalid').searchParams.get('focus')),['2026-08-31','2026-09-01']);
 assert.match(text(requestSection(s)),/2026-09-02/);
 const sameDay=screen({...consultation,targetDay:consultation.requestDay},days);sameDay.render();await settle();
 assert.equal(nodes(workSection(sameDay),'a').length,1);assert.equal(requestSection(sameDay),undefined);
});
test('resolved untargeted requests omit an empty display day but retain other review issues',async()=>{
 const resolved={...consultation,status:'RESOLVED',outcome:'NO_CHANGE',resolutionReason:'8/31の勤務を確認済み'};
 const s=screen(resolved,[{businessDate:'2026-09-02',status:null,reasons:[]}]);s.render();await settle();
 assert.equal(requestSection(s),undefined);assert.equal(nodes(workSection(s),'a').length,0);
 assert.match(text(s.render()),/この相談では打刻を変更していません/);assert.doesNotMatch(text(s.render()),/修正はまだありません/);
 const other=screen(resolved,[{businessDate:'2026-09-02',status:'NEEDS_REVIEW',reasons:['LOGICAL_CONTRADICTION']}]);other.render();await settle();
 assert.match(text(requestSection(other)),/他の要確認事項が残っています/);assert.match(text(requestSection(other)),/打刻の順序・時刻/);
});
