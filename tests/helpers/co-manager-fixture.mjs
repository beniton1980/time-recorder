import { randomUUID, randomBytes, createHash } from "node:crypto";
import { fixture } from "./recovery-database.mjs";
import { loadTs } from "./load-ts.mjs";
import * as monthly from "../../lib/monthly-attendance.mjs";
import * as report from "../../lib/monthly-attendance-report.mjs";
import * as csv from "../../lib/monthly-attendance-csv.mjs";
import * as deliveryError from "../../lib/monthly-attendance-delivery-error.mjs";

export async function coManagerFixture(options) {
  const f = await fixture(options);
  const owner = randomUUID(), delegate = randomUUID();
  await f.db.query("INSERT INTO staff(id,store_id,line_user_id,legal_name,role) VALUES ($1,$3,'fixture_manager','Fixture owner','MANAGER'),($2,$3,'fixture_delegate','Fixture delegate','STAFF')", [owner,delegate,f.store]);
  await f.db.query("INSERT INTO staff_states(staff_id) VALUES ($1),($2)", [owner,delegate]);
  await f.db.query("INSERT INTO staff_manager_access(store_id,staff_id,granted_by_staff_id) VALUES ($1,$2,$3)",[f.store,delegate,owner]);
  const emails = [], errors = [], pdfReports = [];
  class LineTokenVerificationError extends Error {}
  const modules = {
    "next/server": { NextResponse: { json: (value,options) => Response.json(value,options) } },
    "node:crypto": { randomBytes },
    qrcode: { default: { toString: async () => "<svg/>", toDataURL: async () => "data:image/png;base64," } },
    "@/lib/db": { getSql: f.getSql },
    "@/lib/safe-log": { logServerError: event => errors.push(event) },
    "@/lib/api-security": { enforceRateLimit: async () => null },
    "@/lib/line/verify-id-token": { LineTokenVerificationError, verifyLineIdToken: async id => {
      if (!["fixture_manager","fixture_delegate","fixture_actor","fixture_other"].includes(id)) throw new LineTokenVerificationError();
      return { sub: id };
    } },
    "@/lib/monthly-attendance.mjs": monthly,
    "@/lib/monthly-attendance-report.mjs": report,
    "@/lib/monthly-attendance-csv.mjs": csv,
    "@/lib/monthly-attendance-query": loadTs("lib/monthly-attendance-query.ts", { "@/lib/monthly-attendance.mjs": monthly }),
    "@/lib/monthly-report-recipient": loadTs("lib/monthly-report-recipient.ts"),
    "@/lib/monthly-attendance-delivery-error.mjs": deliveryError,
    "@/lib/monthly-attendance-pdf.mjs": { generateMonthlyAttendancePdf: async input => { pdfReports.push(input); return new Uint8Array([37,80,68,70]); } },
    "@/lib/monthly-attendance-email.mjs": { sendMonthlyAttendanceEmail: async input => { emails.push(input); return { sent: true, emailId: "fixture-message" }; } },
    "@/lib/store-entry-token": { hashStoreEntryToken: value => createHash("sha256").update(value).digest("hex") },
    "@/lib/store-qr-encryption": { encryptStoreEntryToken: value => "fixture:" + value, decryptStoreEntryToken: value => value.slice(8) },
  };
  const routes = Object.fromEntries(["consultations","staff-attendance","punch-corrections","corrections/decision","monthly-attendance/reports","monthly-attendance/csv","monthly-attendance/reissue","monthly-attendance/period","monthly-attendance/acceptance-test","store-qr"].map(name => [name,loadTs("app/api/manager/"+name+"/route.ts", modules)]));
  const call = async (name, body = {}, actor = "fixture_delegate") => {
    const response = await routes[name].POST(new Request("http://fixture.local/api/manager/"+name,{method:"POST",body:JSON.stringify({idToken:actor,storeId:f.store,...body})}));
    const raw = await response.text();
    return { status:response.status, body: response.headers.get("content-type")?.includes("json") ? JSON.parse(raw) : raw };
  };
  const staff = async () => {
    const id = randomUUID();
    await f.db.query("INSERT INTO staff(id,store_id,line_user_id,legal_name) VALUES ($1,$2,$3,'Fixture worker')",[id,f.store,'fixture_'+id]);
    await f.db.query("INSERT INTO staff_states(staff_id) VALUES ($1)",[id]);
    return id;
  };
  const pending = async (staffId, eventType = "CHECK_IN", occurredAt = "2026-09-15T01:00:00Z") => {
    const id = randomUUID();
    await f.db.query("INSERT INTO correction_requests(id,store_id,staff_id,operation,requested_event_type,requested_occurred_at,reason) VALUES($1,$2,$3,'ADD',$4,$5,'Fixture request')",[id,f.store,staffId,eventType,occurredAt]);
    return id;
  };
  const seedReport = async () => {
    const recipient = randomUUID();
    await f.db.query("INSERT INTO monthly_report_recipient_versions(id,store_id,version_number,email,status,verified_at,consented_at,consent_version,requested_by_staff_id) VALUES($1,$2,1,'fixture@example.invalid','CONFIRMED',NOW(),NOW(),'2026-08-21-v1',$3)",[recipient,f.store,owner]);
    await f.db.query("UPDATE stores SET monthly_report_email='fixture@example.invalid',monthly_report_email_verified_at=NOW(),monthly_report_email_consented_at=NOW(),monthly_report_email_consent_version='2026-08-21-v1',monthly_report_recipient_version_id=$1 WHERE id=$2",[recipient,f.store]);
    await f.db.query("INSERT INTO monthly_attendance_deliveries(store_id,period_start,period_end,status,recipient,sent_at) VALUES($1,'2026-09-01','2026-09-30','SENT','fixture@example.invalid',NOW())",[f.store]);
  };
  const selfRegister = loadTs("app/api/staff/self-register/route.ts", modules);
  return {...f,owner,delegate,emails,errors,pdfReports,routes,call,staff,pending,seedReport,selfRegister,modules};
}
