import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fixture } from "./helpers/recovery-database.mjs";
import { loadTs } from "./helpers/load-ts.mjs";

let f, manager, api;
const at = minutes => new Date(Date.now() + minutes * 60000).toISOString();
const signature = "public.apply_manager_direct_correction(uuid,uuid,text,uuid,uuid,text,timestamptz,text)";
const migration = () => readFile(new URL("../db/migrations/0042_manager_correction_time.sql", import.meta.url), "utf8");

async function setup(options) {
  const db = await fixture(options);
  await db.db.query("INSERT INTO staff(id,store_id,line_user_id,legal_name,role) VALUES ($1,$2,'fixture_manager','Fictitious manager','MANAGER')", [randomUUID(), db.store]);
  return db;
}

function directApi(db) {
  class LineTokenVerificationError extends Error {}
  return loadTs("app/api/manager/punch-corrections/route.ts", {
    "next/server": { NextResponse: { json: (body, options) => Response.json(body, options) } },
    "@/lib/db": { getSql: db.getSql },
    "@/lib/safe-log": { logServerError() {} },
    "@/lib/api-security": { enforceRateLimit: async () => null },
    "@/lib/line/verify-id-token": { LineTokenVerificationError, verifyLineIdToken: async token => {
      if (!["fixture_manager", "fixture_actor"].includes(token)) throw new LineTokenVerificationError();
      return { sub: token };
    } },
  });
}

before(async () => {
  f = await setup();
  manager = f.getSql({ mode: "manager", lineIdentity: "fixture_manager", storeId: f.store });
  api = directApi(f);
});
after(async () => { await f?.db.close(); });

async function scenario(db = f) {
  const staff = randomUUID();
  await db.db.query("INSERT INTO staff(id,store_id,line_user_id,legal_name) VALUES ($1,$2,$3,'Fictitious staff')", [staff, db.store, `fixture_${staff}`]);
  await db.db.query("INSERT INTO staff_states(staff_id) VALUES ($1)", [staff]);
  return staff;
}

function apply(staff, operation, time, { type = "CHECK_IN", original = null, addition = null, sql = manager, store = f.store } = {}) {
  return sql`SELECT * FROM public.apply_manager_direct_correction(
    ${store}::uuid, ${staff}::uuid, ${operation}, ${original}::uuid, ${addition}::uuid,
    ${operation === "VOID" ? null : type}, ${time}::timestamptz, 'Fictitious correction')`;
}

async function seedOriginal(staff, time, db = f) {
  const id = randomUUID();
  await db.db.query(`INSERT INTO punch_events(id,store_id,staff_id,event_type,occurred_at,business_date,client_request_id)
    SELECT $1,id,$2,'CHECK_IN',$3,(($3::timestamptz AT TIME ZONE timezone)-make_interval(mins=>business_day_start_minute))::date,$4
    FROM stores WHERE id=$5`, [id, staff, time, randomUUID(), db.store]);
  await db.db.query("UPDATE staff_states SET state='WORKING',last_event_id=$1,last_event_at=$2 WHERE staff_id=$3", [id, time, staff]);
  return id;
}

async function snapshot(staff, db = f) {
  const read = async table => (await db.db.query(`SELECT * FROM ${table} WHERE staff_id=$1 ORDER BY ${table === "staff_states" ? "staff_id" : table === "effective_punch_events" ? "effective_id" : "id"}`, [staff])).rows;
  return { original: await read("punch_events"), corrections: await read("correction_requests"), effective: await read("effective_punch_events"), state: await read("staff_states") };
}

async function call(staff, operation, time, extra = {}, db = f, route = api) {
  const response = await route.POST(new Request("http://fixture.local/api/manager/punch-corrections", {
    method: "POST", body: JSON.stringify({ idToken: "fixture_manager", storeId: db.store, staffId: staff, operation,
      eventType: operation === "VOID" ? undefined : "CHECK_IN", occurredAt: time ?? undefined, reason: "Fictitious correction", ...extra }),
  }));
  return { status: response.status, body: await response.json() };
}

test("future direct ADD and REPLACE are rejected without changing history or staff state", async () => {
  for (const type of ["CHECK_IN", "BREAK_START", "BREAK_END", "CHECK_OUT"]) {
    const staff = await scenario(), before = await snapshot(staff);
    await assert.rejects(apply(staff, "ADD", at(2), { type }), /OCCURRED_AT_IN_FUTURE/);
    assert.deepEqual(await snapshot(staff), before);
  }
  for (const target of ["original", "addition"]) {
    const staff = await scenario();
    const id = target === "original" ? await seedOriginal(staff, at(-10)) : (await apply(staff, "ADD", at(-10)))[0].correction_id;
    const before = await snapshot(staff);
    await assert.rejects(apply(staff, "REPLACE", at(2), { [target]: id }), /OCCURRED_AT_IN_FUTURE/);
    assert.deepEqual(await snapshot(staff), before);
  }
});

test("the database clock accepts now and the past but rejects even one microsecond ahead", async () => {
  const futureStaff = await scenario();
  await assert.rejects(manager`SELECT * FROM public.apply_manager_direct_correction(
    ${f.store}::uuid, ${futureStaff}::uuid, 'ADD', NULL, NULL, 'CHECK_IN', NOW()+INTERVAL '1 microsecond', 'Fictitious future')`, /OCCURRED_AT_IN_FUTURE/);
  for (const offset of ["0 microseconds", "-1 microsecond"]) {
    const staff = await scenario();
    const rows = await manager`SELECT * FROM public.apply_manager_direct_correction(
      ${f.store}::uuid, ${staff}::uuid, 'ADD', NULL, NULL, 'CHECK_IN', NOW()+${offset}::interval, 'Fictitious current')`;
    assert.equal(rows[0].status, "APPROVED");
    assert.equal((await snapshot(staff)).state[0].state, "WORKING");
  }
});

test("past direct corrections remain append-only and recalculate state after replace and void", async () => {
  const staff = await scenario(), checkInTime = at(-10), changedTime = at(-3);
  const checkIn = (await apply(staff, "ADD", checkInTime))[0].correction_id;
  const checkOut = (await apply(staff, "ADD", at(-5), { type: "CHECK_OUT" }))[0].correction_id;
  await apply(staff, "REPLACE", changedTime, { type: "CHECK_OUT", addition: checkOut });
  let current = await snapshot(staff);
  assert.equal(current.state[0].state, "OFF_DUTY");
  assert.equal(Date.parse(current.state[0].last_event_at), Date.parse(changedTime));
  assert.equal(current.corrections.length, 3);
  await apply(staff, "VOID", null, { addition: checkOut });
  current = await snapshot(staff);
  assert.equal(current.state[0].state, "WORKING");
  assert.equal(Date.parse(current.state[0].last_event_at), Date.parse(checkInTime));
  await apply(staff, "VOID", null, { addition: checkIn });
  current = await snapshot(staff);
  assert.equal(current.corrections.length, 5); assert.equal(current.effective.length, 0);
  assert.equal(current.state[0].state, "OFF_DUTY");
  assert.equal(current.state[0].last_event_at, null); assert.equal(current.state[0].last_event_id, null);
});

test("future direct correction API returns a specific 400 and leaves both target types unchanged", async () => {
  for (const target of ["new", "original", "addition"]) {
    const staff = await scenario();
    const id = target === "new" ? undefined : target === "original" ? await seedOriginal(staff, at(-10)) : (await apply(staff, "ADD", at(-10)))[0].correction_id;
    const before = await snapshot(staff);
    const result = await call(staff, target === "new" ? "ADD" : "REPLACE", at(2), { targetEffectiveId: id });
    assert.equal(result.status, 400); assert.equal(result.body.code, "OCCURRED_AT_IN_FUTURE");
    assert.deepEqual(await snapshot(staff), before);
  }
});

test("future rejection does not weaken manager authentication or store boundaries", async () => {
  const staff = await scenario(), before = await snapshot(staff);
  const ordinary = f.getSql({ mode: "staff", lineIdentity: "fixture_actor", storeId: f.store });
  await assert.rejects(apply(staff, "ADD", at(2), { sql: ordinary }), /MANAGER_ACCESS_REQUIRED/);
  await assert.rejects(apply(f.otherStaff, "ADD", at(2)), /MANAGER_ACCESS_REQUIRED/);
  assert.equal((await call(staff, "ADD", at(2), { idToken: "invalid" })).status, 401);
  assert.equal((await call(staff, "ADD", at(2), { idToken: "fixture_actor" })).status, 403);
  assert.equal((await call(f.otherStaff, "ADD", at(2))).status, 404);
  assert.deepEqual(await snapshot(staff), before);
});

test("0042 preserves existing data and privileges while permitting cancellation of legacy future records", async () => {
  const old = await setup({ throughMigration: "0041_missed_correction_consistency.sql" });
  try {
    const sql = old.getSql({ mode: "manager", lineIdentity: "fixture_manager", storeId: old.store });
    const originalStaff = await scenario(old), additionStaff = await scenario(old);
    const original = await seedOriginal(originalStaff, at(10), old);
    const addition = (await apply(additionStaff, "ADD", at(10), { sql, store: old.store }))[0].correction_id;
    const before = [await snapshot(originalStaff, old), await snapshot(additionStaff, old)];
    const privileges = async () => (await old.db.query(`SELECT proacl::text,prosecdef,proconfig FROM pg_proc WHERE oid=$1::regprocedure`, [signature])).rows;
    const aclBefore = await privileges();
    await old.db.exec(await migration());
    assert.deepEqual([await snapshot(originalStaff, old), await snapshot(additionStaff, old)], before);
    assert.deepEqual(await privileges(), aclBefore);
    assert.equal(aclBefore[0].prosecdef, false);
    const currentApi = directApi(old);
    for (const [staff, id] of [[originalStaff, original], [additionStaff, addition]]) {
      const result = await call(staff, "VOID", null, { targetEffectiveId: id }, old, currentApi);
      assert.equal(result.status, 200); assert.equal(result.body.ok, true);
      const current = await snapshot(staff, old);
      assert.equal(current.effective.length, 0); assert.equal(current.state[0].state, "OFF_DUTY");
      assert.equal(current.state[0].last_event_at, null);
      assert.equal(current.corrections.at(-1)?.status, "APPROVED");
    }
    assert.equal((await snapshot(originalStaff, old)).original.length, 1, "VOID retains the original future record for audit");
    assert.equal((await snapshot(additionStaff, old)).corrections.length, 2, "VOID retains the original added future record for audit");
  } finally { await old.db.close(); }
});
