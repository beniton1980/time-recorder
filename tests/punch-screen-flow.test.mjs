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
function screen(initial={kind:"ready",membership:member},storage=memory(),env={}){
 const states=[],refs=[],calls=[],requests=[],effects=[],liffInits=[];let si=0,ri=0,resolveLocation;
 const reader={read:()=>new Promise(resolve=>{resolveLocation=resolve;}),clear(){}};
 const timers=new Map();let timerId=0;
 const deadlines=loadTs("lib/attendance-request.ts",{}, {AbortController,
  setTimeout(fn,ms){const id=++timerId;timers.set(id,{fn,ms});return id;},clearTimeout(id){timers.delete(id);}});
 const modules={"react/jsx-runtime":jsxRuntime,react:{
  useEffect(fn,deps){if(deps.length===0)effects.push(fn);},
  useState(value){const i=si++;if(!(i in states))states[i]=i===0?initial:value;return[states[i],v=>{states[i]=typeof v==="function"?v(states[i]):v;}];},
  useRef(value){const i=ri++;refs[i]??={current:i===0?"fixture-token":i===1?reader:value};return refs[i];}
 },"@line/liff":{default:{getIDToken:()=>"fixture-identity",init:async options=>{liffInits.push(options);},isLoggedIn:()=>true}},
 "@/lib/attendance-request":deadlines,"@/lib/attendance-operation":{...operations,tabOperationStorage:()=>storage},"@/lib/punch-location.mjs":{},"@/lib/punch-performance.mjs":{measurePunchStage:(_stage,task)=>task()}};
 const component=loadTs("app/page.tsx",modules,{process:{env},crypto:{randomUUID},window:{location:{search:"?store_token=fixture-token"},setTimeout:()=>0,setInterval:()=>0},
 fetch:(url,options)=>{calls.push({url,body:JSON.parse(options.body),signal:options.signal});return new Promise((resolve,reject)=>requests.push({resolve,reject}));}});
 return{states,calls,storage,liffInits,render(){si=ri=0;return component.default();},locate(value=null){resolveLocation(value);},
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
