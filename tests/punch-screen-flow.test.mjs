import assert from "node:assert/strict";
import test from "node:test";
import * as jsxRuntime from "react/jsx-runtime";
import {randomUUID} from "node:crypto";
import {loadTs} from "./helpers/load-ts.mjs";
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const operations=loadTs("lib/attendance-operation.ts");
const staff=randomUUID(),store=randomUUID();
const member={staff_id:staff,store_id:store,legal_name:"Fixture",store_name:"Fixture",state:"OFF_DUTY",state_version:"1791619200.123456",last_event_id:null,last_event_revision_id:null,last_event_at:null,last_event_type:null,recent_punches:[]};
function memory(){const map=new Map();return{map,getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};}
function screen(initial={kind:"ready",membership:member},storage=memory(),env={},clock=Date){
 const states=[],refs=[],calls=[],requests=[],effects=[],liffInits=[];let si=0,ri=0,resolveLocation;
 const uiCalls={lineClose:0,browserClose:0};
 const reader={read:()=>new Promise(resolve=>{resolveLocation=resolve;}),clear(){}};
 const timers=new Map();let timerId=0;
 const deadlines=loadTs("lib/attendance-request.ts",{}, {AbortController,
  setTimeout(fn,ms){const id=++timerId;timers.set(id,{fn,ms});return id;},clearTimeout(id){timers.delete(id);}});
 const modules={"react/jsx-runtime":jsxRuntime,react:{
  useEffect(fn,deps){if(deps.length===0)effects.push(fn);},
  useState(value){const i=si++;if(!(i in states))states[i]=i===0?initial:value;return[states[i],v=>{states[i]=typeof v==="function"?v(states[i]):v;}];},
  useRef(value){const i=ri++;refs[i]??={current:i===0?"fixture-token":i===1?reader:value};return refs[i];}
 },"@line/liff":{default:{getIDToken:()=>"fixture-identity",init:async options=>{liffInits.push(options);},isLoggedIn:()=>true,
  isInClient:()=>true,closeWindow:()=>{uiCalls.lineClose++;}}},
 "./correction-history":{default:()=>null},
 "@/lib/correction-validation":loadTs("lib/correction-validation.ts"),
 "@/lib/attendance-request":deadlines,"@/lib/attendance-operation":{...operations,tabOperationStorage:()=>storage},"@/lib/punch-location.mjs":{},"@/lib/punch-performance.mjs":{measurePunchStage:(_stage,task)=>task()}};
 const component=loadTs("app/page.tsx",modules,{Date:clock,process:{env},crypto:{randomUUID},window:{location:{search:"?store_token=fixture-token"},setTimeout:()=>0,setInterval:()=>0,close:()=>{uiCalls.browserClose++;}},
 fetch:(url,options)=>{calls.push({url,body:JSON.parse(options.body),signal:options.signal});return new Promise((resolve,reject)=>requests.push({resolve,reject}));}});
 return{states,calls,storage,liffInits,uiCalls,render(){si=ri=0;return component.default();},locate(value=null){resolveLocation(value);},
 expire(){const active=[...timers.values()];assert.equal(active.length,1,"one bounded request must be active");assert.equal(active[0].ms,15000);active[0].fn();},
 discardHung(){requests.shift();},
 hangBody(){requests.shift().resolve({status:200,ok:true,json:()=>new Promise(()=>{})});},
 respond(value,status=200){requests.shift().resolve({status,ok:status<400,json:async()=>value});},lose(){requests.shift().reject(new Error("fixture network"));},boot(){effects.forEach(fn=>fn());}};
}
function nodes(t,type){if(!t||typeof t!=="object")return[];if(Array.isArray(t))return t.flatMap(x=>nodes(x,type));return[...(t.type===type?[t]:[]),...nodes(t.props?.children,type)];}
const text=t=>typeof t==="string"?t:Array.isArray(t)?t.map(text).join(""):t?.props?text(t.props.children):"";
const button=(s,label)=>nodes(s.render(),"button").find(b=>text(b)===label);
const punch=s=>nodes(s.render(),"button").find(b=>b.props.className==="punch-button");
const response=(membership=member,operationResult=null)=>({ok:true,registered:true,memberships:[membership],operationResult});
function clockAt(instant){
 let now=Date.parse(instant);
 return class extends Date {
  constructor(...args){super(...(args.length?args:[now]));}
  static now(){return now;}
  static advanceTo(value){now=Date.parse(value);}
 };
}
function missedForm(s,eventType="BREAK_PAIR"){
 button(s,"打刻修正").props.onClick();
 nodes(s.render(),"select")[0].props.onChange({target:{value:"MISSED"}});
 nodes(s.render(),"select")[1].props.onChange({target:{value:eventType}});
}
function enterTimes(s,values){
 values.forEach((value,index)=>nodes(s.render(),"input")[index].props.onChange({target:{value}}));
}
const review=s=>nodes(s.render(),"form")[0].props.onSubmit({preventDefault(){}});

test("an earlier shift's last punch keeps its Japanese calendar date when today's history is empty",()=>{
 const s=screen({kind:"ready",membership:{...member,state:"WORKING",last_event_id:randomUUID(),
  last_event_type:"CHECK_IN",last_event_at:"2026-10-13T11:00:00.000Z"}},memory(),{},clockAt("2026-10-14T04:00:00.000Z"));
 assert.match(text(s.render()),/2026\/10\/13 20:00 に出勤/);
 assert.match(text(s.render()),/本日の打刻はありません/);
 assert.equal(button(s,"出勤"),undefined,"display must not allow a new shift on its own");
});

test("pending checkout offers a separate next shift, keeps continuation controls and recovers a lost response",async()=>{
 const id=randomUUID(),storage=memory();
 const pendingMember={...member,state:"WORKING",last_event_id:randomUUID(),last_event_type:"CHECK_IN",
  last_event_at:"2026-10-13T11:00:00Z",pending_shift_start:{request_id:id,checkout_at:"2026-10-13T14:00:00Z",business_date:"2026-10-13"}};
 const s=screen({kind:"ready",membership:pendingMember},storage);
 assert.match(text(s.render()),/前回の退勤が確認待ち/);
 assert.match(text(s.render()),/2026\/10\/13 23:00 の退勤を申請済み/);
 assert.match(text(s.render()),/前回分は管理者の承認まで未確定/);
 assert.ok(button(s,"退勤"));assert.ok(button(s,"休憩開始"));
 button(s,"次の勤務を開始").props.onClick();button(s,"次の勤務を開始")?.props.onClick();s.locate();await settle();
 assert.equal(s.calls.length,1);assert.equal(s.calls[0].body.previousCheckoutRequestId,id);
 assert.equal(operations.readPendingOperation(storage,staff,store).previousCheckoutRequestId,id);
 s.lose();await settle();s.respond(response({...pendingMember,pending_shift_start:null}));await settle();
 button(s,"同じ内容で再試行").props.onClick();s.locate();await settle();
 assert.equal(s.calls[2].body.previousCheckoutRequestId,id,"retry keeps original request even after eligibility changes");
 assert.equal(s.calls[2].body.clientRequestId,s.calls[0].body.clientRequestId);
 s.respond({ok:true});await settle();
 s.respond(response({...member,state:"WORKING",pending_shift_start:null},{id:randomUUID(),event_type:"CHECK_IN"}));await settle();
 assert.equal(storage.map.size,0);assert.equal(button(s,"次の勤務を開始"),undefined);assert.ok(button(s,"退勤"));
});

test("rejection before the next shift refreshes the screen without silently resending or clearing the old shift",async()=>{
 const s=screen({kind:"ready",membership:{...member,state:"WORKING",pending_shift_start:{request_id:randomUUID(),checkout_at:"2026-10-13T14:00:00Z",business_date:"2026-10-13"}}});
 button(s,"次の勤務を開始").props.onClick();s.locate();await settle();
 s.respond({ok:false,code:"INVALID_STATE_TRANSITION"},409);await settle();
 s.respond(response({...member,state:"WORKING",pending_shift_start:null}));await settle();
 assert.equal(s.calls.filter(c=>c.url==="/api/punch").length,1);assert.equal(s.storage.map.size,0);
 assert.equal(button(s,"次の勤務を開始"),undefined);assert.ok(button(s,"退勤"));
});

for(const [name,env,expected] of [
 ["default",{},"2010761826-6FNSE1PD"],
 ["isolated Preview",{NEXT_PUBLIC_ATTENDANCE_LIFF_ID:"2010761826-fixture"},"2010761826-fixture"],
]){
 test(`staff screen and entry initialize the ${name} LIFF`,async()=>{
  const s=screen({kind:"loading"},memory(),env);s.render();s.boot();await settle();
  assert.deepEqual(s.liffInits.map(options=>options.liffId),[expected]);
  s.respond(response());await settle();
  const effects=[],inits=[],redirects=[];
  const entry=loadTs("app/liff-entry/page.tsx",{
   "react/jsx-runtime":jsxRuntime,
   react:{useState:()=>["",()=>{}],useEffect:fn=>effects.push(fn)},
   "@line/liff":{default:{init:async options=>{inits.push(options);},isLoggedIn:()=>true}},
  },{process:{env},URLSearchParams,window:{location:{search:"?store_token=fixture-token&untrusted=drop",replace:url=>redirects.push(url)}}});
  entry.default();effects.forEach(fn=>fn());await settle();
  assert.deepEqual(inits.map(options=>options.liffId),[expected]);
  assert.deepEqual(redirects,["/?store_token=fixture-token"]);
 });
}

test("double tap locks; lost response recovers state, history and result together",async()=>{
 const s=screen(),b=punch(s);b.props.onClick();b.props.onClick();assert.equal(punch(s).props.disabled,true);assert.equal(s.calls.length,0);
 assert.equal(text(s.render()).includes("送信結果が未確認です"),false,"permission wait is not a failed response");
 assert.equal(s.storage.map.size,1,"retain the same operation while waiting for location");
 s.locate();await settle();assert.equal(s.calls.length,1);assert.equal(s.calls[0].body.location,null);
 assert.equal(text(s.render()).includes("送信結果が未確認です"),false,"in-flight send only shows progress");
 s.lose();await settle();assert.equal(s.calls[1].url,"/api/session/bootstrap");
 assert.equal(s.calls[1].body.pendingOperation.clientRequestId,s.calls[0].body.clientRequestId);
 const event={id:randomUUID(),event_type:"CHECK_IN",occurred_at:new Date().toISOString(),location_status:"UNAVAILABLE"};
 s.respond(response({...member,state:"WORKING",last_event_id:event.id,last_event_type:"CHECK_IN",recent_punches:[event]},event));await settle();
 assert.equal(s.states[0].membership.state,"WORKING");assert.equal(s.states[0].membership.recent_punches.length,1);
 assert.equal(punch(s).props.disabled,false);assert.equal(s.storage.map.size,0);assert.ok(s.states.some(x=>typeof x==="string"&&x.includes("出勤を記録しました")));
});
test("failure before saving retries identical intent and blocks unrelated actions",async()=>{
 const s=screen();punch(s).props.onClick();s.locate();await settle();s.lose();await settle();s.respond(response({...member,state_version:"1791619300.654321"}));await settle();
 assert.equal(punch(s).props.disabled,true);assert.equal(button(s,"打刻修正").props.disabled,true);
 const first=s.calls[0].body;button(s,"同じ内容で再試行").props.onClick();s.locate();await settle();
 assert.equal(s.calls[2].body.clientRequestId,first.clientRequestId);assert.equal(s.calls[2].body.eventType,first.eventType);
 assert.equal(first.expectedStateVersion,member.state_version);assert.equal(s.calls[2].body.expectedStateVersion,first.expectedStateVersion);
 s.respond({ok:true});await settle();s.respond(response({...member,state:"WORKING"},{id:randomUUID(),event_type:"CHECK_IN"}));await settle();assert.equal(s.storage.map.size,0);
});
test("hung write and result lookup release recovery buttons and preserve the same operation",async()=>{
 const s=screen();punch(s).props.onClick();s.locate();await settle();
 const first=s.calls[0].body;
 s.expire();await settle();assert.equal(s.calls[0].signal.aborted,true);s.discardHung();
 assert.equal(s.calls[1].url,"/api/session/bootstrap");
 s.expire();await settle();s.discardHung();
 assert.equal(s.calls.length,2);assert.equal(button(s,"結果を確認").props.disabled,false);
 assert.equal(text(s.render()).includes("送信結果が未確認です"),true,"failed lookup must retain recovery controls");
 assert.equal(button(s,"同じ内容で再試行").props.disabled,false);assert.equal(punch(s).props.disabled,true);
 button(s,"同じ内容で再試行").props.onClick();s.locate();await settle();
 assert.equal(s.calls[2].body.clientRequestId,first.clientRequestId);
 assert.equal(s.calls[2].body.expectedStateVersion,first.expectedStateVersion);
 s.respond({ok:true});await settle();s.respond(response({...member,state:"WORKING"},{id:randomUUID(),event_type:"CHECK_IN"}));await settle();
 assert.equal(s.storage.map.size,0);assert.equal(punch(s).props.disabled,false);
});
test("reload reads pending result without creating any new punch",async()=>{
 const storage=memory(),pending={kind:"punch",eventType:"CHECK_IN",clientRequestId:randomUUID(),staffId:staff,storeId:store};
 operations.savePendingOperation(storage,pending);const s=screen({kind:"loading"},storage);s.render();s.boot();await settle();
 s.respond(response());await settle();assert.equal(s.calls[1].body.pendingOperation.clientRequestId,pending.clientRequestId);
 s.respond(response({...member,state:"WORKING"},{id:randomUUID(),event_type:"CHECK_IN"}));await settle();
 assert.ok(s.calls.every(c=>c.url==="/api/session/bootstrap"));assert.equal(storage.map.size,0);assert.equal(s.states[0].membership.state,"WORKING");
});
test("a stalled bootstrap response body also returns to retry controls",async()=>{
 const s=screen();punch(s).props.onClick();s.locate();await settle();s.respond({ok:true});await settle();
 s.hangBody();await settle();s.expire();await settle();
 assert.equal(button(s,"結果を確認").props.disabled,false);assert.equal(s.storage.map.size,1);
});
for(const [validationCode,explanation,otherExplanation] of [
 ["STORE_LOCATION_UNAVAILABLE",/店舗の位置が未設定/,/端末の位置情報を取得できません/],
 ["CLIENT_LOCATION_UNAVAILABLE",/端末の位置情報を取得できません/,/店舗の位置が未設定/],
]){
 test(`recovered ${validationCode} stays in GPS details without implying a failed punch`,async()=>{
  const s=screen();punch(s).props.onClick();s.locate();await settle();s.lose();await settle();
  const result={id:randomUUID(),event_type:"CHECK_IN",occurred_at:"2026-10-09T18:47:00.000Z",
   location_status:"UNAVAILABLE",validation_code:validationCode};
  s.respond(response({...member,state:"WORKING",last_event_id:result.id,last_event_at:result.occurred_at,last_event_type:"CHECK_IN"},result));await settle();
  const tree=s.render(),feedback=nodes(tree,"div").find(n=>n.props.className==="punch-feedback");
  assert.equal(text(feedback),"03:47の出勤を記録しました");
  assert.doesNotMatch(text(feedback),/位置|未確認/);
  const details=nodes(tree,"details").find(n=>n.props.className==="location-guide");
  assert.notEqual(details.props.open,true,"the optional explanation must stay collapsed");
  assert.match(text(details),explanation);assert.doesNotMatch(text(details),otherExplanation);
  assert.equal(punch(s).props.disabled,false);assert.equal(s.storage.map.size,0);
 });
}

for(const [previousType,nextType,previousLabel,nextLabel,state] of [
 ["CHECK_OUT","BREAK_START","退勤","休憩開始","OFF_DUTY"],
 ["BREAK_START","CHECK_OUT","休憩開始","退勤","ON_BREAK"],
]){
 test(`${previousType} mistake uses the previous record without date or time entry`,async()=>{
  const previousId=randomUUID(),revisionId=randomUUID(),previousAt="2026-10-09T18:47:00.000Z";
  const membership={...member,state,last_event_id:previousId,last_event_revision_id:revisionId,
   last_event_at:previousAt,last_event_type:previousType};
  const s=screen({kind:"ready",membership});button(s,"打刻修正").props.onClick();
  assert.equal(nodes(s.render(),"select")[0].props.value,"MISTAKE");
  assert.equal(nodes(s.render(),"input").length,0,"a mistake correction must not ask the user to reconstruct its date or time");
  const preview=nodes(s.render(),"div").find(n=>n.props.className==="last-punch-correction");
  assert.match(text(preview),new RegExp(`2026/10/10 03:47 ${previousLabel}→2026/10/10 03:47 ${nextLabel}`));
  nodes(s.render(),"form")[0].props.onSubmit({preventDefault(){}});
  assert.equal(nodes(s.render(),"input").length,0);
  assert.match(text(s.render()),new RegExp(`2026/10/10 03:47 ${previousLabel} → ${nextLabel}`));
  button(s,"この内容で申請").props.onClick();await settle();
  assert.equal(s.calls[0].url,"/api/correction-requests");
  assert.equal(s.calls[0].body.category,"MISTAKE");assert.equal(s.calls[0].body.targetEventId,previousId);
  assert.equal(s.calls[0].body.expectedRevisionId,revisionId);assert.equal(s.calls[0].body.eventType,nextType);
  assert.equal("occurredAt" in s.calls[0].body,false,"the server keeps the referenced record's original date and time");
  s.respond({ok:true});await settle();
  s.respond(response({...membership,last_event_type:nextType},{id:randomUUID(),status:"APPROVED"}));await settle();
  assert.equal(s.storage.map.size,0);
 });
}

test("an unsupported previous punch does not silently switch a mistake into a missed-punch request",()=>{
 const s=screen({kind:"ready",membership:{...member,state:"WORKING",last_event_id:randomUUID(),
  last_event_revision_id:randomUUID(),last_event_at:"2026-10-09T18:47:00.000Z",last_event_type:"CHECK_IN"}});
 button(s,"打刻修正").props.onClick();
 assert.equal(nodes(s.render(),"select")[0].props.value,"MISTAKE");
 assert.equal(nodes(s.render(),"input").length,0);
 assert.match(text(s.render()),/前回の打刻は種類の押し間違いとして修正できません/);
 nodes(s.render(),"form")[0].props.onSubmit({preventDefault(){}});
 assert.equal(button(s,"この内容で申請"),undefined);assert.equal(s.calls.length,0);
 nodes(s.render(),"select")[0].props.onChange({target:{value:"MISSED"}});
 assert.deepEqual(nodes(s.render(),"input").map(n=>n.props.type),["date","time"],
  "date and time are requested only after the user explicitly chooses a missed punch");
});

test("missed punches after all four punch types require the actual time even after choosing a date",()=>{
 for(const [last_event_type,state] of [["CHECK_IN","WORKING"],["BREAK_START","ON_BREAK"],["BREAK_END","WORKING"],["CHECK_OUT","OFF_DUTY"]]){
  const membership={...member,state,last_event_type,last_event_id:randomUUID(),last_event_revision_id:randomUUID(),last_event_at:"2026-10-09T18:47:00.000Z"};
  const s=screen({kind:"ready",membership},memory(),{},clockAt("2026-10-10T15:01:00.000Z"));
  button(s,"打刻修正").props.onClick();nodes(s.render(),"select")[0].props.onChange({target:{value:"MISSED"}});
  assert.deepEqual(nodes(s.render(),"input").map(n=>n.props.value),["",""],last_event_type);
  for(const [label,expectedDate] of [["今日","2026-10-11"],["昨日","2026-10-10"]]){
   const shortcut=button(s,label);assert.equal(shortcut.props.type,"button");shortcut.props.onClick();
   assert.deepEqual(nodes(s.render(),"input").map(n=>n.props.value),[expectedDate,""],"date selection must not guess the missing time");
   nodes(s.render(),"form")[0].props.onSubmit({preventDefault(){}});
   assert.equal(button(s,"この内容で申請"),undefined);assert.match(text(s.render()),/追加する打刻の時刻を選択してください/);
   assert.equal(s.calls.length,0);assert.equal(s.storage.map.size,0);
  }
 }
});

test("today and yesterday use Japan's calendar across midnight, month and year boundaries in either device time zone",()=>{
 const originalTZ=process.env.TZ;
 try{
  for(const [zone,offset] of [["Pacific/Honolulu",600],["Pacific/Kiritimati",-840]]){
   process.env.TZ=zone;
   assert.equal(new Date("2026-01-31T15:00:00.000Z").getTimezoneOffset(),offset,"the device clock must actually use the requested zone");
   for(const [instant,today,yesterday] of [
    ["2026-01-31T14:59:59.999Z","2026-01-31","2026-01-30"],
    ["2026-01-31T15:00:00.000Z","2026-02-01","2026-01-31"],
    ["2026-12-31T15:00:00.000Z","2027-01-01","2026-12-31"],
   ]){
    const s=screen(undefined,memory(),{},clockAt(instant));button(s,"打刻修正").props.onClick();
    nodes(s.render(),"select")[0].props.onChange({target:{value:"MISSED"}});
    nodes(s.render(),"input").find(n=>n.props.type==="time").props.onChange({target:{value:"03:47"}});
    for(const [label,expectedDate] of [["今日",today],["昨日",yesterday]]){
     button(s,label).props.onClick();
     assert.deepEqual(nodes(s.render(),"input").map(n=>n.props.value),[expectedDate,"03:47"],`${zone}: ${instant} ${label}; keep the user's actual time`);
    }
   }
  }
 }finally{if(originalTZ===undefined)delete process.env.TZ;else process.env.TZ=originalTZ;}
});

test("a missed punch sends the entered Japan time and keeps that intent when retrying on a later day",async()=>{
 const clock=clockAt("2026-10-10T15:01:00.000Z"),s=screen(undefined,memory(),{},clock);
 button(s,"打刻修正").props.onClick();nodes(s.render(),"select")[0].props.onChange({target:{value:"MISSED"}});
 nodes(s.render(),"select")[1].props.onChange({target:{value:"BREAK_END"}});
 button(s,"昨日").props.onClick();
 // A different date remains editable; its actual time is interpreted as JST, even before the business-day cutoff.
 nodes(s.render(),"input").find(n=>n.props.type==="date").props.onChange({target:{value:"2026-10-09"}});
 nodes(s.render(),"input").find(n=>n.props.type==="time").props.onChange({target:{value:"03:47"}});
 nodes(s.render(),"form")[0].props.onSubmit({preventDefault(){}});
 assert.equal(s.calls.length,1);assert.equal(s.calls[0].url,"/api/correction-requests/validate");
 assert.equal(s.storage.map.size,0);s.respond({ok:true});await settle();
 assert.match(text(s.render()),/2026\/10\/09 03:47/);
 button(s,"この内容で申請").props.onClick();await settle();
 const originalRequest=s.calls[1].body;
 assert.equal(originalRequest.category,"MISSED");assert.equal(originalRequest.eventType,"BREAK_END");
 assert.equal(originalRequest.occurredAt,"2026-10-08T18:47:00.000Z");
 clock.advanceTo("2026-10-11T15:01:00.000Z");s.lose();await settle();s.respond(response());await settle();
 button(s,"同じ内容で再試行").props.onClick();await settle();
 assert.deepEqual(s.calls[3].body,originalRequest,"retry cannot substitute today's date or the send time for the entered event");
 s.respond({ok:true});await settle();s.respond(response(member,{id:randomUUID(),status:"PENDING"}));await settle();
 assert.equal(s.storage.map.size,0);assert.equal(s.states[0].membership.state,member.state,"request submission does not apply the missing punch before approval");
});

test("pair validation is read-only, locks duplicate checks and input changes, and keeps both Japan dates through retry and reload",async()=>{
 const s=screen();missedForm(s);
 assert.deepEqual(nodes(s.render(),"input").map(n=>n.props.value),["","","",""],"neither timestamp is inferred");
 enterTimes(s,["2026-10-10","23:55","2026-10-11","00:10"]);
 const form=nodes(s.render(),"form")[0],oldInputs=nodes(s.render(),"input"),oldToday=button(s,"今日");
 form.props.onSubmit({preventDefault(){}});form.props.onSubmit({preventDefault(){}});
 oldInputs[1].props.onChange({target:{value:"12:00"}});oldToday.props.onClick();
 assert.equal(s.calls.length,1);assert.equal(s.calls[0].url,"/api/correction-requests/validate");
 assert.equal("clientRequestId" in s.calls[0].body,false);assert.equal(s.storage.map.size,0);
 assert.equal(nodes(s.render(),"fieldset")[0].props.disabled,true);assert.equal(button(s,"キャンセル").props.disabled,false);
 assert.deepEqual(nodes(s.render(),"input").map(n=>n.props.value),["2026-10-10","23:55","2026-10-11","00:10"]);
 assert.deepEqual(s.calls[0].body,{idToken:"fixture-identity",storeToken:"fixture-token",category:"MISSED_BREAK",eventType:"BREAK_START",
  occurredAt:"2026-10-10T14:55:00.000Z",breakEndedAt:"2026-10-10T15:10:00.000Z"});
 s.respond({ok:true});await settle();
 assert.match(text(s.render()),/休憩開始2026\/10\/10 23:55/);assert.match(text(s.render()),/休憩終了2026\/10\/11 00:10/);
 button(s,"この内容で申請").props.onClick();await settle();const original=s.calls[1].body;
 const pending=operations.readPendingOperation(s.storage,staff,store);
 assert.equal(pending.intent.breakEndedAt,original.breakEndedAt);assert.equal(pending.intent.occurredAt,original.occurredAt);
 s.lose();await settle();s.respond(response());await settle();
 button(s,"同じ内容で再試行").props.onClick();await settle();assert.deepEqual(s.calls[3].body,original);
 s.lose();await settle();s.respond(response());await settle();
 const reopened=screen({kind:"loading"},s.storage);reopened.render();reopened.boot();await settle();reopened.respond(response());await settle();
 assert.equal(reopened.calls[1].body.pendingOperation.clientRequestId,original.clientRequestId);
 reopened.respond(response());await settle();button(reopened,"同じ内容で再試行").props.onClick();await settle();
 assert.deepEqual(reopened.calls[2].body,original,"reload must preserve the entire break as one request");
 reopened.respond({ok:true});await settle();reopened.respond(response(member,{id:randomUUID(),status:"PENDING"}));await settle();
 assert.equal(s.storage.map.size,0);assert.equal(reopened.states[0].membership.state,member.state);
});

test("pair input requires both actual timestamps and checks their order before any validation request",()=>{
 const s=screen();missedForm(s);enterTimes(s,["2026-10-10","23:55"]);review(s);
 assert.match(text(s.render()),/休憩終了の日付と実際の時刻/);assert.equal(s.calls.length,0);
 enterTimes(s,["2026-10-10","23:55","2026-10-10","23:55"]);review(s);
 assert.match(text(s.render()),/休憩終了は、休憩開始より後/);assert.equal(s.calls.length,0);
 enterTimes(s,["2026-10-10","23:55","2026-10-09","23:59"]);review(s);assert.equal(s.calls.length,0);
 assert.equal(s.storage.map.size,0);assert.equal(button(s,"この内容で申請"),undefined);
});

test("server future-time rejection keeps single and paired inputs editable without relying on the device clock",async()=>{
 for(const eventType of ["CHECK_IN","BREAK_PAIR"]){
  const s=screen({kind:"ready",membership:member},memory(),{},clockAt("2026-10-12T00:00:00.000Z"));
  missedForm(s,eventType);
  const entered=eventType==="BREAK_PAIR"?["2026-10-11","12:00","2026-10-11","13:00"]:["2026-10-11","12:00"];
  enterTimes(s,entered);review(s);
  assert.equal(s.calls.length,1);assert.equal(s.calls[0].url,"/api/correction-requests/validate");
  s.respond({ok:false,code:"OCCURRED_AT_IN_FUTURE"},400);await settle();
  assert.match(text(s.render()),/未来の日時は申請できません。実際に勤務した日時を入力してください。/);
  assert.deepEqual(nodes(s.render(),"input").map(n=>n.props.value),entered);
  assert.equal(nodes(s.render(),"fieldset")[0].props.disabled,false);
  assert.equal(button(s,"この内容で申請"),undefined);assert.equal(s.storage.map.size,0);
  const corrected=entered.map(value=>value==="2026-10-11"?"2026-10-10":value);
  enterTimes(s,corrected);review(s);
  assert.equal(s.calls.length,2);assert.equal(s.calls[1].url,"/api/correction-requests/validate");
  s.respond({ok:true});await settle();assert.ok(button(s,"この内容で申請"));
  assert.doesNotMatch(text(s.render()),/未来の日時は申請できません/);
 }
});

test("cancelled validation cannot confirm or unlock a newer form, whether its old result succeeds or fails",async()=>{
 for(const staleResult of [{ok:true},{ok:false,code:"CORRECTION_TIME_CONFLICT"}]){
  const s=screen();missedForm(s,"BREAK_END");enterTimes(s,["2026-10-10","23:50"]);review(s);
  button(s,"キャンセル").props.onClick();assert.equal(s.storage.map.size,0);assert.equal(punch(s).props.disabled,false);
  missedForm(s);enterTimes(s,["2026-10-10","23:55","2026-10-11","00:10"]);review(s);
  s.respond(staleResult,staleResult.ok?200:409);await settle();
  assert.equal(nodes(s.render(),"fieldset")[0].props.disabled,true);assert.equal(button(s,"この内容で申請"),undefined);
  assert.doesNotMatch(text(s.render()),/同じ時刻の打刻がすでに/);assert.equal(s.calls.length,2);
  s.respond({ok:true});await settle();assert.match(text(s.render()),/休憩終了2026\/10\/11 00:10/);
  const oldSubmit=button(s,"この内容で申請");button(s,"入力に戻る").props.onClick();oldSubmit.props.onClick();
  assert.equal(s.calls.length,2,"returning to input invalidates the old confirmation immediately");
  enterTimes(s,["2026-10-10","23:56","2026-10-11","00:11"]);review(s);
  assert.equal(s.calls.length,3);assert.equal(s.calls[2].url,"/api/correction-requests/validate");
  assert.equal(button(s,"この内容で申請"),undefined,"editing requires another server check");
  s.respond({ok:true});await settle();button(s,"キャンセル").props.onClick();assert.equal(s.storage.map.size,0);
 }
});

test("stalled validation and its response body return to editable inputs without an uncertain-write journal",async()=>{
 for(const stalledBody of [false,true]){
  const s=screen();missedForm(s);enterTimes(s,["2026-10-10","23:55","2026-10-11","00:10"]);review(s);
  if(stalledBody){s.hangBody();await settle();}
  s.expire();await settle();if(!stalledBody)s.discardHung();
  assert.equal(nodes(s.render(),"fieldset")[0].props.disabled,false);assert.equal(button(s,"内容を確認").props.disabled,false);
  assert.match(text(s.render()),/まだ申請は送信していません/);assert.equal(s.storage.map.size,0);
  assert.equal(button(s,"結果を確認"),undefined);assert.equal(button(s,"この内容で申請"),undefined);
 }
});

test("missing break start offers a pair without inventing its start, a type change, or the existing consultation form",async()=>{
 for(const action of ["開始・終了をまとめて申請","種類を選び直す","時刻が分からないので相談"]){
  const s=screen();missedForm(s,"BREAK_END");enterTimes(s,["2026-10-11","00:10"]);review(s);
  s.respond({ok:false,code:"CORRECTION_BREAK_START_REQUIRED"},409);await settle();
  assert.match(text(s.render()),/休憩開始の記録がありません/);assert.equal(button(s,"この内容で申請"),undefined);
  button(s,action).props.onClick();assert.equal(s.storage.map.size,0);assert.equal(s.calls.length,1);
  if(action==="開始・終了をまとめて申請"){
   assert.equal(nodes(s.render(),"select")[1].props.value,"BREAK_PAIR");
   assert.deepEqual(nodes(s.render(),"input").map(n=>n.props.value),["","","2026-10-11","00:10"]);
   review(s);assert.equal(s.calls.length,1);
  }else if(action==="時刻が分からないので相談"){
   assert.equal(nodes(s.render(),"select")[0].props.value,"OTHER");assert.equal(nodes(s.render(),"textarea").length,1);
   review(s);assert.equal(button(s,"この内容で申請"),undefined,"consultation still needs the user's explanation");
  }else assert.equal(nodes(s.render(),"select")[1].props.value,"BREAK_END","focusing the type selector does not guess a replacement");
 }
});

test("a final rejection restores both timestamps only after an authoritative lookup, including a delayed lookup",async()=>{
 for(const delayedLookup of [false,true]){
 for(const [code,status,message] of [["CORRECTION_SEQUENCE_INVALID",409,"前後の打刻とつながりません"],["OCCURRED_AT_IN_FUTURE",400,"未来の日時は申請できません"]]){
  const s=screen();missedForm(s);enterTimes(s,["2026-10-10","23:55","2026-10-11","00:10"]);review(s);
  s.respond({ok:true});await settle();button(s,"この内容で申請").props.onClick();await settle();
  s.respond({ok:false,code},status);await settle();
  assert.equal(s.storage.map.size,1);assert.equal(nodes(s.render(),"form").length,0);
  if(delayedLookup){
   s.lose();await settle();assert.equal(s.storage.map.size,1);assert.equal(nodes(s.render(),"form").length,0);
   button(s,"結果を確認").props.onClick();await settle();
  }
  s.respond(response());await settle();assert.equal(s.storage.map.size,0);
  assert.ok(text(s.render()).includes("申請は追加されていません。"+message));
  assert.deepEqual(nodes(s.render(),"input").map(n=>n.props.value),["2026-10-10","23:55","2026-10-11","00:10"]);
  assert.equal(button(s,"内容を確認").props.disabled,false);assert.equal(button(s,"キャンセル").props.disabled,false);
 }
 }
});

test("a saved pair found after a rejected response takes precedence over the rejection",async()=>{
 const s=screen();missedForm(s);enterTimes(s,["2026-10-10","23:55","2026-10-11","00:10"]);review(s);
 s.respond({ok:true});await settle();button(s,"この内容で申請").props.onClick();await settle();
 s.respond({ok:false,code:"CORRECTION_PENDING_CONFLICT"},409);await settle();
 s.respond(response(member,{id:randomUUID(),status:"PENDING"}));await settle();
 assert.equal(s.storage.map.size,0);assert.equal(nodes(s.render(),"form").length,0);
 assert.match(text(s.render()),/承認待ち/);assert.doesNotMatch(text(s.render()),/申請は追加されていません/);
});

test("pair journals preserve only the two valid ordered timestamps and reject incomplete or reversed intents",()=>{
 const identity={kind:"correction",clientRequestId:randomUUID(),staffId:staff,storeId:store};
 const intent={category:"MISSED_BREAK",eventType:"BREAK_START",occurredAt:"2026-10-10T23:55:00+09:00",breakEndedAt:"2026-10-11T00:10:00+09:00"};
 for(const invalid of [{...intent,breakEndedAt:undefined},{...intent,breakEndedAt:"invalid"},{...intent,breakEndedAt:intent.occurredAt},
  {...intent,breakEndedAt:"2026-10-10T23:54:00+09:00"},{...intent,eventType:"BREAK_END"}]){
  const storage=memory();operations.savePendingOperation(storage,{...identity,intent:invalid});assert.equal(storage.map.size,0);
 }
 const storage=memory();operations.savePendingOperation(storage,{...identity,intent:{...intent,idToken:"private-fixture",location:{latitude:1}}});
 const pending=operations.readPendingOperation(storage,staff,store);
 assert.equal(pending.intent.occurredAt,"2026-10-10T14:55:00.000Z");assert.equal(pending.intent.breakEndedAt,"2026-10-10T15:10:00.000Z");
 assert.deepEqual(Object.keys(pending.intent).sort(),["breakEndedAt","category","eventType","occurredAt"]);
 assert.equal([...storage.map.values()][0].includes("private-fixture"),false);
});

for(const phase of ["input","confirmation"]){
 test(`cancelling correction from ${phase} returns to punching without saving or closing LINE`,()=>{
  const s=screen();button(s,"打刻修正").props.onClick();
  nodes(s.render(),"select")[0].props.onChange({target:{value:"OTHER"}});
  nodes(s.render(),"textarea")[0].props.onChange({target:{value:"Fixture unsent correction"}});
  if(phase==="confirmation") nodes(s.render(),"form")[0].props.onSubmit({preventDefault(){}});
  const oldSubmit=button(s,"この内容で申請");
  assert.equal(button(s,"打刻画面を閉じる"),undefined,"closing the app is not an editing action");
  assert.equal(nodes(s.render(),"button").filter(b=>text(b)==="キャンセル").length,1);
  const cancel=button(s,"キャンセル");
  assert.equal(cancel.props.type,"button");assert.equal(cancel.props.disabled,false);
  cancel.props.onClick();
  oldSubmit?.props.onClick();
  assert.equal(nodes(s.render(),"form").length,0);assert.equal(punch(s).props.disabled,false);
  assert.equal(button(s,"打刻画面を閉じる").props.disabled,false);
  assert.deepEqual(s.states[0],{kind:"ready",membership:member});
  assert.equal(s.calls.length,0);assert.equal(s.storage.map.size,0);
  assert.deepEqual(s.uiCalls,{lineClose:0,browserClose:0});
 });
}

test("sent and unconfirmed corrections cannot be cancelled or replaced during recovery",async()=>{
 const s=screen();button(s,"打刻修正").props.onClick();
 nodes(s.render(),"select")[0].props.onChange({target:{value:"OTHER"}});
 nodes(s.render(),"textarea")[0].props.onChange({target:{value:"Fixture pending correction"}});
 nodes(s.render(),"form")[0].props.onSubmit({preventDefault(){}});
 const oldCancel=button(s,"キャンセル"),oldBack=button(s,"入力に戻る");
 button(s,"この内容で申請").props.onClick();await settle();
 const originalRequest=s.calls[0].body;
 const assertLocked=()=>{
  oldCancel.props.onClick();oldBack.props.onClick();
  assert.equal(button(s,"キャンセル"),undefined);assert.equal(button(s,"入力に戻る"),undefined);
  assert.equal(button(s,"打刻修正").props.disabled,true);assert.equal(punch(s).props.disabled,true);
  assert.equal(button(s,"打刻画面を閉じる").props.disabled,true);
  assert.equal(s.storage.map.size,1);assert.deepEqual(s.uiCalls,{lineClose:0,browserClose:0});
 };
 assertLocked();assert.equal(s.calls.length,1);
 s.lose();await settle();assertLocked();
 s.lose();await settle();assertLocked();assert.equal(button(s,"結果を確認").props.disabled,false);
 button(s,"結果を確認").props.onClick();await settle();assertLocked();
 s.respond(response());await settle();assertLocked();
 button(s,"同じ内容で再試行").props.onClick();await settle();assertLocked();
 assert.deepEqual(s.calls[3].body,originalRequest,"recovery must resend the original correction intent");
 s.respond({ok:true});await settle();
 s.respond(response(member,{id:randomUUID(),status:"PENDING"}));await settle();
 assert.equal(s.storage.map.size,0);assert.equal(punch(s).props.disabled,false);
 assert.equal(button(s,"打刻画面を閉じる").props.disabled,false);
 assert.deepEqual(s.uiCalls,{lineClose:0,browserClose:0});
});

test("correction submission shows progress until result confirmation completes",async()=>{
 const s=screen();button(s,"打刻修正").props.onClick();
 nodes(s.render(),"select")[0].props.onChange({target:{value:"OTHER"}});
 nodes(s.render(),"textarea")[0].props.onChange({target:{value:"Fixture correction"}});
 nodes(s.render(),"form")[0].props.onSubmit({preventDefault(){}});
 button(s,"この内容で申請").props.onClick();await settle();
 assert.match(text(s.render()),/修正申請を送信・確認しています/);
 assert.equal(text(s.render()).includes("送信結果が未確認です"),false);
 assert.equal(s.calls[0].url,"/api/correction-requests");
 s.respond({ok:true});await settle();
 assert.match(text(s.render()),/修正申請を送信・確認しています/);
 s.respond(response(member,{id:randomUUID(),status:"PENDING"}));await settle();
 assert.equal(text(s.render()).includes("修正申請を送信・確認しています"),false);
 assert.equal(s.storage.map.size,0);
});
test("registration timeout still checks membership and enables a retry when offline",async()=>{
 const s=screen({kind:"unregistered",storeName:"Fixture"});nodes(s.render(),"input")[0].props.onChange({target:{value:"Fixture Name"}});
 nodes(s.render(),"form")[0].props.onSubmit({preventDefault(){}});
 s.expire();await settle();s.discardHung();assert.equal(s.calls[1].url,"/api/session/bootstrap");
 s.expire();await settle();s.discardHung();
 assert.equal(nodes(s.render(),"button").find(b=>b.props.type==="submit").props.disabled,false);
});
test("registration double-submit and lost response resolve active membership",async()=>{
 const s=screen({kind:"unregistered",storeName:"Fixture"});nodes(s.render(),"input")[0].props.onChange({target:{value:"Fixture Name"}});
 const form=nodes(s.render(),"form")[0];form.props.onSubmit({preventDefault(){}});form.props.onSubmit({preventDefault(){}});
 assert.equal(s.calls.length,1);s.lose();await settle();s.respond(response());await settle();assert.equal(s.states[0].kind,"ready");
});
test("pending storage is scoped, validated and excludes credentials and GPS",()=>{
 const storage=memory(),pending={kind:"punch",eventType:"CHECK_IN",clientRequestId:randomUUID(),staffId:staff,storeId:store};
 operations.savePendingOperation(storage,{...pending,idToken:"secret",location:{latitude:1},legalName:"private"});
 assert.equal([...storage.map.values()][0].includes("secret"),false);assert.equal([...storage.map.values()][0].includes("latitude"),false);
 assert.equal(operations.readPendingOperation(storage,randomUUID(),store),null);assert.equal(operations.readPendingOperation(storage,staff,store).clientRequestId,pending.clientRequestId);
 storage.map.set([...storage.map.keys()][0],"{");assert.equal(operations.readPendingOperation(storage,staff,store),null);
 operations.savePendingOperation(null,pending);operations.clearPendingOperation(null,pending);
});
