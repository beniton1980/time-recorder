import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { fixture } from "./helpers/recovery-database.mjs";

test("own history survives reload and manager decisions without exposing another staff/store or internal fields", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const history = f.api("correction-requests/history");
  const created = await f.call(f.correction, { clientRequestId: randomUUID(), category: "OTHER", reason: "架空の申請内容" });
  assert.equal(created.correctionRequest.status, "PENDING");
  const id = created.correctionRequest.id;
  assert.equal((await f.call(f.bootstrap, {})).operationResult, null); // Previous reload result has no general history.
  const before = await f.call(history, {});
  assert.equal(before.status, 200);
  assert.equal(before.requests.find(r => r.id === id).status, "PENDING");
  await f.db.query("INSERT INTO staff(id,store_id,line_user_id,legal_name,role) VALUES ($1,$2,'fixture_manager','Manager','MANAGER')", [randomUUID(), f.store]);
  assert.equal((await f.call(f.decision, { idToken: "fixture_manager", storeId: f.store, requestId: id, decision: "REJECTED" })).status, 200);
  const rejected = (await f.call(history, {})).requests.find(r => r.id === id);
  assert.equal(rejected.status, "REJECTED"); assert.ok(rejected.decidedAt);
  const ownApproval = await f.call(f.correction, { clientRequestId: randomUUID(), category: "OTHER", reason: "架空の出勤漏れ" });
  const approved = await f.call(f.decision, { idToken: "fixture_manager", storeId: f.store, requestId: ownApproval.correctionRequest.id,
    decision: "APPROVED", resolvedEventType: "CHECK_IN", resolvedOccurredAt: "2026-01-01T08:00:00+09:00" });
  assert.equal(approved.status, 200);
  const otherSameStore = randomUUID();
  await f.db.query("INSERT INTO staff(id,store_id,line_user_id,legal_name) VALUES ($1,$2,'fixture_new','Other same store')", [otherSameStore, f.store]);
  await f.db.query("INSERT INTO correction_requests(store_id,staff_id,operation,reason) VALUES ($1,$2,'REVIEW','SAME_STORE_SECRET'),($3,$4,'REVIEW','OTHER_STORE_SECRET')", [f.store, otherSameStore, f.otherStore, f.otherStaff]);
  const result = await f.call(history, { staffId: f.otherStaff, storeId: f.otherStore });
  const row = result.requests.find(r => r.id === ownApproval.correctionRequest.id);
  assert.equal(row.status, "APPROVED"); assert.equal(row.category, "OTHER"); assert.equal(row.reason, "架空の出勤漏れ");
  assert.equal(row.eventType, "CHECK_IN"); assert.equal(row.unattributed, false);
  const encoded = JSON.stringify(result);
  for (const secret of ["SAME_STORE_SECRET", "OTHER_STORE_SECRET", "approved_by", "client_request_payload", "fixture_manager", "line_user_id"]) assert.ok(!encoded.includes(secret));
});

test("paired breaks are one item, older records remain reachable, and timestamp ties do not skip or duplicate", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const history = f.api("correction-requests/history"), group = randomUUID();
  await f.db.query(`INSERT INTO correction_requests(id,store_id,staff_id,operation,requested_event_type,requested_occurred_at,group_id,client_request_id,client_request_payload)
    VALUES ($1,$2,$3,'ADD','BREAK_START','2026-01-01T12:00:00+09:00',$1,$4,'{"category":"MISSED_BREAK"}')`, [group, f.store, f.staff, randomUUID()]);
  await f.db.query("INSERT INTO correction_requests(store_id,staff_id,operation,requested_event_type,requested_occurred_at,group_id) VALUES ($1,$2,'ADD','BREAK_END','2026-01-01T13:00:00+09:00',$3)", [f.store, f.staff, group]);
  await f.db.query("INSERT INTO correction_requests(store_id,staff_id,operation,status,approved_by,approved_at,reason,requested_at) SELECT $1,$2,'ADD','APPROVED','manager-id',NOW(),'INTERNAL_NOTE','2026-01-01T00:00:00.123456Z' FROM generate_series(1,25)", [f.store, f.staff]);
  const one = await f.call(history, {});
  assert.equal(one.requests.length, 20); assert.ok(one.next); assert.match(one.next.requestedAt, /\.123456Z$/);
  const two = await f.call(history, { before: one.next });
  assert.equal(two.next, null);
  const all = [...one.requests, ...two.requests];
  assert.equal(all.length, 27); assert.equal(new Set(all.map(r => r.id)).size, 27);
  const paired = all.find(r => r.id === group);
  assert.equal(new Date(paired.breakEndedAt).toISOString(), "2026-01-01T04:00:00.000Z");
  assert.equal(all.filter(r => r.unattributed).length, 25);
  assert.ok(!JSON.stringify(all).includes("INTERNAL_NOTE"));
});

test("LINE identity, QR eligibility and active membership are required on every history request", async t => {
  const f = await fixture(); t.after(() => f.db.close()); const history = f.api("correction-requests/history");
  assert.equal((await f.call(history, { idToken: "bad" })).status, 401);
  assert.equal((await f.call(history, { storeToken: "invalid" })).status, 404);
  assert.equal((await f.call(history, { idToken: "fixture_other" })).status, 404);
  for (const before of ["x", { id: "bad", requestedAt: "x" }, { id: randomUUID(), requestedAt: "2026-01-01" }]) {
    assert.equal((await f.call(history, { before })).status, 400);
  }
  await f.db.query("UPDATE staff SET status='inactive' WHERE id=$1", [f.staff]);
  assert.equal((await f.call(history, {})).status, 404);
  await f.db.query("UPDATE staff SET status='departed' WHERE id=$1", [f.staff]);
  assert.equal((await f.call(history, {})).status, 404);
  await f.db.query("UPDATE staff SET status='active' WHERE id=$1", [f.staff]);
  await f.db.query("UPDATE store_entry_tokens SET revoked_at=NOW() WHERE store_id=$1", [f.store]);
  assert.equal((await f.call(history, {})).status, 404);
  await f.db.query("UPDATE store_entry_tokens SET revoked_at=NULL,expires_at=NOW()-INTERVAL '1 second' WHERE store_id=$1", [f.store]);
  assert.equal((await f.call(history, {})).status, 404);
  await f.db.query("UPDATE store_entry_tokens SET expires_at=NULL WHERE store_id=$1", [f.store]);
  await f.db.query("UPDATE stores SET status='suspended' WHERE id=$1", [f.store]);
  assert.equal((await f.call(history, {})).status, 404);
  await f.db.query("UPDATE stores SET status='active' WHERE id=$1", [f.store]);
  // The same LINE identity at two stores still only sees the QR's store.
  await f.db.query("UPDATE staff SET line_user_id='fixture_actor' WHERE id=$1", [f.otherStaff]);
  await f.db.query("INSERT INTO correction_requests(store_id,staff_id,operation,reason) VALUES ($1,$2,'REVIEW','OTHER_STORE')", [f.otherStore, f.otherStaff]);
  await f.db.query("INSERT INTO store_entry_tokens(store_id,token_hash) VALUES ($1,$2)", [f.otherStore, createHash('sha256').update('second-fixture-token').digest('hex')]);
  assert.ok(!(await f.call(history, {})).requests.some(r => r.reason === "OTHER_STORE"));
  const second = await f.call(history, { storeToken: 'second-fixture-token' });
  assert.equal(second.requests.length, 1); assert.equal(second.requests[0].reason, "OTHER_STORE");
});
