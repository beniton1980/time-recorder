import assert from "node:assert/strict";
import test from "node:test";
import * as jsxRuntime from "react/jsx-runtime";
import {randomUUID} from "node:crypto";
import {loadTs} from "./helpers/load-ts.mjs";
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const operations=loadTs("lib/attendance-operation.ts");
const staff=randomUUID(),store=randomUUID();
const member={staff_id:staff,store_id:store,legal_name:"Fixture",store_name:"Fixture",state:"OFF_DUTY",last_event_id:null,last_event_revision_id:null,last_event_at:null,last_event_type:null,recent_punches:[]};
function memory(){const map=new Map();return{map,getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};}
function screen(initial={kind:"ready",membership:member},storage=memory()){
 const states=[],refs=[],calls=[],requests=[],effects=[];let si=0,ri=0,resolveLocation;
 const reader={read:()=>new Promise(resolve=>{resolveLocation=resolve;}),clear(){}};
 const modules={"react/jsx-runtime":jsxRuntime,react:{
  useEffect(fn,deps){if(deps.length===0)effects.push(fn);},
  useState(value){const i=si++;if(!(i in states))states[i]=i===0?initial:value;return[states[i],v=>{states[i]=typeof v==="function"?v(states[i]):v;}];},
  useRef(value){const i=ri++;refs[i]??={current:i===0?"fixture-token":i===1?reader:value};return refs[i];}
 },"@line/liff":{default:{getIDToken:()=>"fixture-identity",init:async()=>{},isLoggedIn:()=>true}},
 "@/lib/attendance-operation":{...operations,tabOperationStorage:()=>storage},"@/lib/punch-location.mjs":{},"@/lib/punch-performance.mjs":{measurePunchStage:(_stage,task)=>task()}};
 const component=loadTs("app/page.tsx",modules,{crypto:{randomUUID},window:{location:{search:"?store_token=fixture-token"},setTimeout:()=>0,setInterval:()=>0},
 fetch:(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return new Promise((resolve,reject)=>requests.push({resolve,reject}));}});
 return{states,calls,storage,render(){si=ri=0;return component.default();},locate(value=null){resolveLocation(value);},
 respond(value,status=200){requests.shift().resolve({status,ok:status<400,json:async()=>value});},lose(){requests.shift().reject(new Error("fixture network"));},boot(){effects.forEach(fn=>fn());}};
}
function nodes(t,type){if(!t||typeof t!=="object")return[];if(Array.isArray(t))return t.flatMap(x=>nodes(x,type));return[...(t.type===type?[t]:[]),...nodes(t.props?.children,type)];}
const text=t=>typeof t==="string"?t:Array.isArray(t)?t.map(text).join(""):t?.props?text(t.props.children):"";
const button=(s,label)=>nodes(s.render(),"button").find(b=>text(b)===label);
const punch=s=>nodes(s.render(),"button").find(b=>b.props.className==="punch-button");
const response=(membership=member,operationResult=null)=>({ok:true,registered:true,memberships:[membership],operationResult});

test("double tap locks; lost response recovers state, history and result together",async()=>{
 const s=screen(),b=punch(s);b.props.onClick();b.props.onClick();assert.equal(punch(s).props.disabled,true);assert.equal(s.calls.length,0);
 s.locate();await settle();assert.equal(s.calls.length,1);assert.equal(s.calls[0].body.location,null);
 s.lose();await settle();assert.equal(s.calls[1].url,"/api/session/bootstrap");
 assert.equal(s.calls[1].body.pendingOperation.clientRequestId,s.calls[0].body.clientRequestId);
 const event={id:randomUUID(),event_type:"CHECK_IN",occurred_at:new Date().toISOString(),location_status:"UNAVAILABLE"};
 s.respond(response({...member,state:"WORKING",last_event_id:event.id,last_event_type:"CHECK_IN",recent_punches:[event]},event));await settle();
 assert.equal(s.states[0].membership.state,"WORKING");assert.equal(s.states[0].membership.recent_punches.length,1);
 assert.equal(punch(s).props.disabled,false);assert.equal(s.storage.map.size,0);assert.ok(s.states.some(x=>typeof x==="string"&&x.includes("出勤を記録しました")));
});
test("failure before saving retries identical intent and blocks unrelated actions",async()=>{
 const s=screen();punch(s).props.onClick();s.locate();await settle();s.lose();await settle();s.respond(response());await settle();
 assert.equal(punch(s).props.disabled,true);assert.equal(button(s,"打刻修正").props.disabled,true);
 const first=s.calls[0].body;button(s,"同じ内容で再試行").props.onClick();s.locate();await settle();
 assert.equal(s.calls[2].body.clientRequestId,first.clientRequestId);assert.equal(s.calls[2].body.eventType,first.eventType);
 s.respond({ok:true});await settle();s.respond(response({...member,state:"WORKING"},{id:randomUUID(),event_type:"CHECK_IN"}));await settle();assert.equal(s.storage.map.size,0);
});
test("reload reads pending result without creating any new punch",async()=>{
 const storage=memory(),pending={kind:"punch",eventType:"CHECK_IN",clientRequestId:randomUUID(),staffId:staff,storeId:store};
 operations.savePendingOperation(storage,pending);const s=screen({kind:"loading"},storage);s.render();s.boot();await settle();
 s.respond(response());await settle();assert.equal(s.calls[1].body.pendingOperation.clientRequestId,pending.clientRequestId);
 s.respond(response({...member,state:"WORKING"},{id:randomUUID(),event_type:"CHECK_IN"}));await settle();
 assert.ok(s.calls.every(c=>c.url==="/api/session/bootstrap"));assert.equal(storage.map.size,0);assert.equal(s.states[0].membership.state,"WORKING");
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
