import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { coManagerFixture } from "./helpers/co-manager-fixture.mjs";
import { loadTs } from "./helpers/load-ts.mjs";

let f, worker, outside;
const period = {periodStart:"2026-08-26",periodEnd:"2026-09-25"};
const request = (action,extra={},actor) => f.call("monthly-attendance/period",{...period,action,...extra},actor);
const count = async table => (await f.db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n;
before(async()=>{
  f=await coManagerFixture();worker=await f.staff();outside=await f.staff();
  await f.db.query("UPDATE staff SET status='departed' WHERE id=$1",[worker]);
  for(const [staff,date,start,end] of [[worker,"2026-08-26","10:00","16:00"],[worker,"2026-09-25","20:00","02:00"],[outside,"2026-08-25","09:00","17:00"],[outside,"2026-09-26","09:00","17:00"]]) {
    for(const [type,time] of [["CHECK_IN",date+"T"+start+":00+09:00"],["CHECK_OUT",(date==="2026-09-25"?"2026-09-26":date)+"T"+end+":00+09:00"]])
      await f.db.query("INSERT INTO punch_events(store_id,staff_id,event_type,occurred_at,business_date,client_request_id,source)VALUES($1,$2,$3,$4,$5,$6,'SYSTEM')",[f.store,staff,type,time,date,randomUUID()]);
  }
});
after(async()=>{await f?.db.close();});

test("unconfirmed recipients do not block past PDF/CSV, and downloads do not create deliveries or emails",async()=>{
  for(const actor of ["fixture_manager","fixture_delegate"]){
    const csv=await request("csv",{},actor);assert.equal(csv.status,200,JSON.stringify(csv));
    assert.match(csv.body,/"2026-08-26","Fixture worker","0:00","6:00","0:00","確定"/);
    assert.match(csv.body,/"2026-09-25","Fixture worker","0:00","6:00","4:00","確定"/);
    assert.doesNotMatch(csv.body,/"2026-08-25"|"2026-09-26"/);
    const pdf=await request("pdf",{},actor);assert.equal(pdf.status,200);assert.equal(pdf.body,"%PDF");
    const report=f.pdfReports.at(-1);assert.equal(report.staff.length,1);assert.equal(report.staff[0].workMinutes,720);
    assert.equal(report.staff[0].lateNightMinutes,240);
    assert.deepEqual(JSON.parse(JSON.stringify(report.period)),{start:period.periodStart,end:period.periodEnd});
  }
  assert.equal(await count("monthly_attendance_deliveries"),0);assert.equal(f.emails.length,0);
  const response=await f.routes["monthly-attendance/period"].POST(new Request("http://fixture.local",{method:"POST",body:JSON.stringify({idToken:"fixture_delegate",storeId:f.store,...period,action:"pdf"})}));
  assert.equal(response.headers.get("cache-control"),"private, no-store");
  assert.equal(response.headers.get("content-type"),"application/pdf");
  assert.match(response.headers.get("content-disposition"),/2026-08-26-2026-09-25\.pdf/);
  assert.equal((await request("send")).body.code,"MONTHLY_REPORT_RECIPIENT_NOT_CONFIRMED");
  assert.equal(await count("monthly_attendance_deliveries"),0);
});

test("period inputs reject invalid, reversed, future, today and overlong ranges without changing data",async()=>{
  const today=(await f.db.query("SELECT (NOW() AT TIME ZONE 'Asia/Tokyo')::date::text d")).rows[0].d;
  for(const extra of [{periodStart:"2026-02-30"},{periodEnd:"2026-13-01"},{periodStart:"2026-09-26"},{periodStart:"2026-08-25"},{periodStart:"0000-01-01"},{periodStart:null},{periodEnd:today},{periodEnd:"9999-12-31"}])
    assert.equal((await request("pdf",extra)).body.code,"INVALID_PERIOD");
  for(const action of [null,[],["send"],"unknown"])assert.equal((await request(action)).status,400);
  for(const body of ["null", "[]", '"invalid"', "{"]) {
    const result=await f.routes["monthly-attendance/period"].POST(new Request("http://fixture.local",{method:"POST",body}));
    assert.equal(result.status,400);
  }
  assert.equal((await request("csv",{periodStart:"2026-09-25"})).status,200);
  assert.equal((await request("csv",{periodStart:"2024-02-01",periodEnd:"2024-02-29"})).status,200);
  assert.equal(await count("monthly_attendance_deliveries"),0);
});

test("ordinary staff, other stores, invalid identities and revoked co-managers cannot obtain or send reports",async()=>{
  for(const action of ["pdf","csv","send"]){
    for(const actor of ["fixture_actor","fixture_other"])assert.equal((await request(action,{},actor)).status,403);
    assert.equal((await request(action,{storeId:f.otherStore})).status,403);
    assert.equal((await request(action,{},"invalid")).status,401);
  }
  await f.db.query("UPDATE staff_manager_access SET status='inactive' WHERE staff_id=$1",[f.delegate]);
  assert.equal((await request("pdf")).status,403);
  await f.db.query("UPDATE staff_manager_access SET status='active' WHERE staff_id=$1",[f.delegate]);
  assert.equal(f.emails.length,0);
});

test("past exports reuse corrected daily attendance without changing a departed staff membership",async()=>{
  const out=(await f.db.query("SELECT effective_id FROM effective_punch_events WHERE staff_id=$1 AND business_date='2026-09-25' AND event_type='CHECK_OUT'",[worker])).rows[0].effective_id;
  const result=await f.call("punch-corrections",{staffId:worker,operation:"REPLACE",targetEffectiveId:out,eventType:"CHECK_OUT",occurredAt:"2026-09-26T03:00:00+09:00",reason:"Fixture F08 correction"});
  assert.equal(result.status,200);
  assert.match((await request("csv")).body,/"2026-09-25","Fixture worker","0:00","7:00","5:00","確定","訂正あり"/);
  await request("pdf");assert.equal(f.pdfReports.at(-1).staff[0].workMinutes,780);
  assert.equal((await f.db.query("SELECT status FROM staff WHERE id=$1",[worker])).rows[0].status,"departed");
  assert.equal(await count("monthly_attendance_deliveries"),0);
});

test("a confirmed explicit send is shared with Cron's initial key, deduplicates concurrent requests and appears in history",async()=>{
  await f.seedReport(); // Also establishes the confirmed recipient generation.
  const send=f.modules["@/lib/monthly-attendance-email.mjs"].sendMonthlyAttendanceEmail;
  let release,entered;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  f.modules["@/lib/monthly-attendance-email.mjs"].sendMonthlyAttendanceEmail=async input=>{entered();await gate;return send(input);};
  const first=request("send",{recipient:"ignored@example.invalid"});await ready;
  assert.equal((await request("send")).body.status,"PROCESSING");
  const cronSql=f.getSql({mode:"cron"});
  const recipientId=(await f.db.query("SELECT monthly_report_recipient_version_id id FROM stores WHERE id=$1",[f.store])).rows[0].id;
  assert.equal((await cronSql`SELECT * FROM claim_monthly_attendance_delivery(${f.store}::uuid,${period.periodStart}::date,${period.periodEnd}::date,'initial',${recipientId}::uuid)`).length,0);
  release();assert.equal((await first).body.status,"SENT");
  f.modules["@/lib/monthly-attendance-email.mjs"].sendMonthlyAttendanceEmail=send;
  assert.equal((await request("send")).body.status,"ALREADY_SENT");
  assert.equal(f.emails.length,1);assert.equal(f.emails[0].recipient,"fixture@example.invalid");
  const rows=(await f.call("monthly-attendance/reports")).body.reports;
  const row=rows.find(r=>r.period_end===period.periodEnd);assert.ok(row?.id);
  const initial=(await f.db.query("SELECT * FROM monthly_attendance_deliveries WHERE id=$1",[row.id])).rows;
  await f.db.query("UPDATE stores SET closing_rule='day_15' WHERE id=$1",[f.store]);
  assert.equal((await f.call("monthly-attendance/csv",{reportId:row.id})).status,200);
  assert.equal((await f.call("monthly-attendance/reissue",{reportId:row.id,requestId:randomUUID()})).body.status,"SENT");
  assert.deepEqual((await f.db.query("SELECT * FROM monthly_attendance_deliveries WHERE id=$1",[row.id])).rows,initial);
});

test("failed explicit deliveries retain normalized history and can retry without a second initial record",async()=>{
  const range={periodStart:"2026-07-01",periodEnd:"2026-07-31"};
  const emailModule=f.modules["@/lib/monthly-attendance-email.mjs"],send=emailModule.sendMonthlyAttendanceEmail;
  emailModule.sendMonthlyAttendanceEmail=async()=>{throw new Error("fixture private provider detail");};
  assert.equal((await request("send",range)).status,503);
  let delivery=(await f.db.query("SELECT * FROM monthly_attendance_deliveries WHERE store_id=$1 AND period_end=$2",[f.store,range.periodEnd])).rows[0];
  assert.equal(delivery.status,"FAILED");assert.doesNotMatch(delivery.last_error_code,/private/);
  emailModule.sendMonthlyAttendanceEmail=send;
  assert.equal((await request("send",range)).body.status,"SENT");
  const attempts=(await f.db.query("SELECT status FROM monthly_attendance_delivery_attempts WHERE delivery_id=$1 ORDER BY attempt_number",[delivery.id])).rows;
  assert.deepEqual(attempts.map(x=>x.status),["FAILED","SENT"]);
  assert.equal((await request("send",range)).body.status,"ALREADY_SENT");
});

test("recipient confirmation and generation changes cannot be bypassed by an explicit period",async()=>{
  const range={periodStart:"2026-06-01",periodEnd:"2026-06-30"};
  const before=f.emails.length;
  await f.db.query("UPDATE stores SET monthly_report_email_verified_at=NULL,monthly_report_email_consented_at=NULL,monthly_report_email_consent_version=NULL WHERE id=$1",[f.store]);
  assert.equal((await request("send",range)).status,409);
  assert.equal((await request("csv",range)).status,200);
  await f.db.query("UPDATE stores SET monthly_report_email_verified_at=NOW(),monthly_report_email_consented_at=NOW(),monthly_report_email_consent_version='2026-08-21-v1' WHERE id=$1",[f.store]);
  const original=f.modules["@/lib/db"].getSql;
  f.modules["@/lib/db"].getSql=context=>{
    const sql=original(context);
    return async(strings,...values)=>{
      if(strings.join('').includes('claim_monthly_attendance_delivery'))await f.db.query("UPDATE monthly_report_recipient_versions SET status='REVOKED',revoked_at=NOW() WHERE store_id=$1",[f.store]);
      return sql(strings,...values);
    };
  };
  assert.equal((await request("send",range)).body.code,"MONTHLY_REPORT_RECIPIENT_CHANGED");
  f.modules["@/lib/db"].getSql=original;
  assert.equal(f.emails.length,before);
  assert.equal((await f.db.query("SELECT count(*)::int n FROM monthly_attendance_deliveries WHERE period_end=$1",[range.periodEnd])).rows[0].n,0);
  assert.deepEqual(f.errors,["monthly_attendance_period_failed"]);
  await f.db.query("UPDATE monthly_report_recipient_versions SET status='CONFIRMED',revoked_at=NULL WHERE store_id=$1",[f.store]);
});

test("recipient confirmation alone does not trigger historical bulk delivery",async()=>{
  const getSql=context=>{
    const sql=f.getSql(context);
    return (strings,...params)=>sql(strings.map(s=>s.includes("WITH candidates AS")?s.replaceAll("NOW()","TIMESTAMPTZ '2026-10-02T00:00:00Z'"):s),...params);
  };
  const cron=loadTs("app/api/cron/monthly-attendance/route.ts",{...f.modules,"@/lib/db":{getSql}},{process:{env:{CRON_SECRET:"fixture"}}});
  const before=f.emails.length;
  const response=await cron.GET(new Request("http://fixture.local",{headers:{authorization:"Bearer fixture"}}));
  assert.equal(response.status,200);assert.equal((await response.json()).processed,0);assert.equal(f.emails.length,before);
});
