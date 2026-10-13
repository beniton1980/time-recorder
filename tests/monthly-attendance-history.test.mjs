import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { coManagerFixture } from "./helpers/co-manager-fixture.mjs";

let f, worker, checkoutId;
const histories = [
  { start: "2026-08-26", end: "2026-09-25" },
  { start: "2026-08-16", end: "2026-09-15" },
  { start: "2026-09-01", end: "2026-09-30" },
];
const request = (action, body, actor) => f.call("monthly-attendance/" + action, body, actor);
const saved = async (period, store = f.store, status = "SENT", version = "initial") => {
  const id = randomUUID();
  await f.db.query("INSERT INTO monthly_attendance_deliveries(id,store_id,period_start,period_end,status,delivery_version,recipient,sent_at) VALUES($1,$2,$3,$4,$5,$6,'fixture@example.invalid',CASE WHEN $5='SENT' THEN NOW() ELSE NULL END)", [id,store,period.start,period.end,status,version]);
  return id;
};
before(async () => {
  f = await coManagerFixture();
  await f.seedReport();
  histories[2].id = (await request("reports")).body.reports[0].id;
  for (const period of histories.slice(0, 2)) period.id = await saved(period);
  worker = await f.staff();
  for (const [date,start,end] of [["2026-08-25","09:00","17:00"],["2026-08-26","10:00","16:00"],["2026-09-25","20:00","02:00"],["2026-09-26","10:00","18:00"]]) {
    const endDate = date === "2026-09-25" ? "2026-09-26" : date;
    for (const [type,time] of [["CHECK_IN",date+"T"+start+":00+09:00"],["CHECK_OUT",endDate+"T"+end+":00+09:00"]]) {
      const id = randomUUID();
      await f.db.query("INSERT INTO punch_events(id,store_id,staff_id,event_type,occurred_at,business_date,client_request_id,source) VALUES($1,$2,$3,$4,$5,$6,$7,'SYSTEM')",[id,f.store,worker,type,time,date,randomUUID()]);
      if (date === "2026-09-25" && type === "CHECK_OUT") checkoutId = id;
    }
  }
});
after(async () => { await f?.db.close(); });

test("sent report IDs preserve their saved periods across all supported closing-rule changes", async () => {
  const listed = (await request("reports")).body.reports;
  assert.equal(listed.length, 3);
  assert.ok(listed.every(row => typeof row.id === "string"));
  for (const rule of ["month_end", "day_15", "day_25"]) {
    await f.db.query("UPDATE stores SET closing_rule=$1 WHERE id=$2", [rule,f.store]);
    for (const {id,start,end} of histories) {
      for (const actor of ["fixture_manager","fixture_delegate"]) {
        // A supplied current period must not override the selected history ID.
        assert.equal((await request("csv",{reportId:id,periodEnd:"2026-01-31"},actor)).status,200);
        assert.equal((await request("csv",{periodEnd:end},actor)).status,200);
      }
      const result = await request("reissue", {reportId:id,requestId:randomUUID()});
      assert.equal(result.status,200,JSON.stringify(result));
      assert.deepEqual(result.body.period,{start,end});
      assert.deepEqual(f.emails.at(-1).period,{start,end});
      assert.deepEqual(f.pdfReports.at(-1).period,{start,end});
    }
  }
});

test("historical CSV includes both saved boundaries and overnight work, excluding adjacent business days", async () => {
  const result = await request("csv",{reportId:histories[0].id});
  assert.equal(result.status,200);
  assert.match(result.body,/"2026-08-26","Fixture worker","0:00","6:00","0:00","確定"/);
  assert.match(result.body,/"2026-09-25","Fixture worker","0:00","6:00","4:00","確定"/);
  assert.doesNotMatch(result.body,/"2026-08-25"|"2026-09-26"/);
});

test("historical reissue uses current corrections, preserves the initial log and deduplicates concurrent retries", async () => {
  const original = (await f.db.query("SELECT * FROM monthly_attendance_deliveries WHERE id=$1",[histories[0].id])).rows;
  const changed = await f.call("punch-corrections", {staffId:worker,operation:"REPLACE",targetEffectiveId:checkoutId,eventType:"CHECK_OUT",occurredAt:"2026-09-26T03:00:00+09:00",reason:"Fixture correction"});
  assert.equal(changed.status,200,JSON.stringify(changed));
  const body = {reportId:histories[0].id,requestId:randomUUID(),recipient:"ignored@example.invalid"};
  const before = f.emails.length;
  const retries = await Promise.all([request("reissue",body),request("reissue",body)]);
  assert.deepEqual(retries.map(r=>r.body.status).sort(),["ALREADY_PROCESSED","SENT"]);
  assert.equal(f.emails.length,before+1);
  assert.equal(f.emails.at(-1).recipient,"fixture@example.invalid");
  const days = f.pdfReports.at(-1).staff.find(row=>row.name==="Fixture worker").dailyAttendance;
  const day = days.find(row=>row.businessDate==="2026-09-25");
  assert.equal(day.workedMinutes,420); assert.equal(day.lateNightMinutes,300); assert.equal(day.hasCorrection,true);
  const csv = await request("csv",{reportId:histories[0].id});
  assert.match(csv.body,/"2026-09-25","Fixture worker","0:00","7:00","5:00","確定","訂正あり"/);
  assert.deepEqual((await f.db.query("SELECT * FROM monthly_attendance_deliveries WHERE id=$1",[histories[0].id])).rows,original);
  const persisted = (await f.db.query("SELECT period_start,period_end,status FROM monthly_attendance_deliveries WHERE delivery_version=$1",["reissue-"+body.requestId])).rows;
  assert.deepEqual(persisted,[{period_start:"2026-08-26",period_end:"2026-09-25",status:"SENT"}]);
  // Legacy open clients also reissue the persisted period after a closing change.
  await f.db.query("UPDATE stores SET closing_rule='month_end' WHERE id=$1",[f.store]);
  assert.equal((await request("reissue",{periodEnd:"2026-09-25",requestId:randomUUID()})).body.status,"SENT");
});

test("history lookup cannot select another store, an unsent initial, or a reissue record", async () => {
  const other = await saved(histories[0],f.otherStore);
  const failed = await saved({start:"2026-07-26",end:"2026-08-25"},f.store,"FAILED");
  const reissue = await saved(histories[0],f.store,"SENT","reissue-"+randomUUID());
  const before = f.emails.length;
  for (const action of ["csv","reissue"]) {
    for (const id of [other,failed,reissue,randomUUID()]) {
      const result = await request(action,{reportId:id,periodEnd:"2026-09-25",requestId:randomUUID()});
      assert.equal(result.status,404,JSON.stringify(result));
    }
    for (const actor of ["fixture_actor","fixture_other"]) assert.equal((await request(action,{reportId:histories[0].id,requestId:randomUUID()},actor)).status,403);
    assert.equal((await request(action,{storeId:f.otherStore,reportId:other,requestId:randomUUID()})).status,403);
    for (const reference of [{},{reportId:"bad",periodEnd:"2026-09-25"},{reportId:null},{periodEnd:"2026-02-30"},{periodEnd:"2026-13-01"}]) assert.equal((await request(action,{...reference,requestId:randomUUID()})).status,400);
  }
  assert.equal(f.emails.length,before);
  assert.equal((await request("reports")).body.reports.length,3);
});

test("an ambiguous legacy end date is rejected while each exact history remains selectable", async () => {
  const id = await saved({start:"2026-09-01",end:"2026-09-25"});
  const before = f.emails.length;
  for (const action of ["csv","reissue"]) {
    assert.equal((await request(action,{periodEnd:"2026-09-25",requestId:randomUUID()})).status,404);
    assert.equal((await request(action,{reportId:id,requestId:randomUUID()})).status,200);
  }
  assert.equal(f.emails.length,before+1);
  assert.deepEqual(f.emails.at(-1).period,{start:"2026-09-01",end:"2026-09-25"});
  await f.db.query("UPDATE stores SET monthly_report_email_verified_at=NULL,monthly_report_email_consented_at=NULL,monthly_report_email_consent_version=NULL WHERE id=$1",[f.store]);
  const denied = await request("reissue",{reportId:id,requestId:randomUUID()});
  assert.equal(denied.status,409); assert.equal(denied.body.code,"MONTHLY_REPORT_RECIPIENT_NOT_CONFIRMED");
  assert.equal(f.emails.length,before+1);
  assert.deepEqual(f.errors,[]);
});
