import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import * as jsxRuntime from "react/jsx-runtime";
import { loadTs } from "./helpers/load-ts.mjs";
import { coManagerFixture } from "./helpers/co-manager-fixture.mjs";

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
const text = tree => typeof tree === "string" || typeof tree === "number" ? String(tree) : Array.isArray(tree) ? tree.map(text).join("") : text(tree?.props?.children ?? "");
function buttons(tree) {
  if (!tree || typeof tree !== "object") return [];
  if (Array.isArray(tree)) return tree.flatMap(buttons);
  return [...(tree.type === "button" ? [tree] : []), ...buttons(tree.props?.children)];
}
function screen({ storage = new Map(), send, refresh = async () => {}, confirm = () => true, store = "A", report = "report" } = {}) {
  const slots = [], effects = [], calls = [], confirmations = [];
  let index = 0, lists = 0;
  const component = loadTs("app/manager/page.tsx", {
    "react/jsx-runtime": jsxRuntime,
    react: {
      useState(initial) { const i = index++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial; return [slots[i], v => { slots[i] = typeof v === "function" ? v(slots[i]) : v; }]; },
      useRef(initial) { const i = index++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
      useEffect: fn => effects.push(fn), useCallback: fn => fn,
    },
    "@line/liff": { default: { init: async () => {}, isLoggedIn: () => true, getIDToken: () => "fixture" } },
    "@/lib/manager-correction-datetime": loadTs("lib/manager-correction-datetime.ts"),
    "@/lib/correction-validation": loadTs("lib/correction-validation.ts"),
    "@/lib/consultation": loadTs("lib/consultation.ts"),
    "./manager.module.css": { default: {} },
    "./past-monthly-report": { default: () => null },
    "./consultation-history": { default: () => null },
    "./report-file": { default: () => null, useReportFile: () => ({ prepared: null, clear() {} }) },
  }, {
    process: { env: {} }, crypto: { randomUUID },
    window: { location: { href: "https://fixture.invalid/manager", search: "" },
      sessionStorage: { getItem: k => storage.get(k) ?? null, setItem: (k,v) => storage.set(k,v), removeItem: k => storage.delete(k) },
      confirm: message => { confirmations.push(message); return confirm(); } },
    fetch: async (url, options) => {
      const body = JSON.parse(options.body); calls.push({ url, body });
      if (url.endsWith("/reissue")) return send(body);
      if (url.endsWith("/session")) return Response.json({ ok: true, manager: { memberships: [{ store_id: store }] } });
      if (url.endsWith("/reports")) { if (lists++ > 0) await refresh(); return Response.json({ ok: true, reports: [{ id: report, period_start: "2026-08-26", period_end: "2026-09-25" }] }); }
      return Response.json({ ok: true, businessDate: "2026-10-16", manager: { store_id: store, store_name: "架空店舗", monthly_report_email: "fixture@example.invalid", monthly_report_email_verified_at: "2026-08-01", monthly_report_email_consented_at: "2026-08-01", monthly_report_email_consent_version: "2026-08-21-v1" }, attendance: [], corrections: [], staffMemberships: [], coManagers: [] });
    },
  });
  return { calls, confirmations, storage,
    render() { index = 0; return component.default(); },
    async start() { this.render(); effects.forEach(fn => fn()); await settle(); },
    async click() { buttons(this.render()).find(b => text(b) === "再発行して送信").props.onClick(); await settle(); },
  };
}

test("a lost reissue response retains the operation across retries/reload, then permits a separate intentional issue", async () => {
  const delivered = new Set(); let lost = true;
  const send = async body => {
    const already = delivered.has(body.requestId); delivered.add(body.requestId);
    if (lost) { lost = false; throw new TypeError("Network lost after delivery"); }
    return Response.json({ ok: true, status: already ? "ALREADY_PROCESSED" : "SENT", deliveryStatus: "SENT" });
  };
  let s = screen({ send }); await s.start(); await s.click();
  const lostMessage = text(s.render());
  assert.equal(delivered.size, 1);
  s = screen({ send, storage: s.storage }); await s.start(); await s.click();
  assert.equal(delivered.size, 1, "a retry must not send a second email");
  assert.match(lostMessage, /送信結果を確認できませんでした/);
  assert.match(text(s.render()), /送信済み/);
  await s.click(); assert.equal(delivered.size, 2, "a new confirmed reissue is allowed after completion");
});

test("PROCESSING remains recoverable and is never presented as sent", async () => {
  let status = "PROCESSING";
  const s = screen({ send: async () => Response.json({ ok: true, status: "ALREADY_PROCESSED", deliveryStatus: status }) });
  await s.start(); await s.click();
  assert.match(text(s.render()), /送信処理中/); assert.doesNotMatch(text(s.render()), /送信しました/);
  const first = s.calls.at(-1).body.requestId;
  status = "SENT"; await s.click();
  assert.equal(s.calls.filter(c => c.url.endsWith("/reissue")).at(-1).body.requestId, first);
  assert.match(text(s.render()), /送信済み/);
});

test("refresh failure cannot turn a confirmed send into a send failure", async () => {
  const s = screen({ send: async () => Response.json({ ok: true, status: "SENT" }), refresh: async () => { throw new SyntaxError("invalid JSON"); } });
  await s.start(); await s.click();
  assert.match(text(s.render()), /送信しました/); assert.doesNotMatch(text(s.render()), /invalid JSON|送信結果を確認できません/);
  assert.equal(s.storage.size, 0);
});

test("rapid clicks submit only one request; cancel and unavailable storage submit none", async () => {
  let finish;
  const s = screen({ send: () => new Promise(resolve => { finish = resolve; }) });
  await s.start();
  const click = buttons(s.render()).find(b => text(b) === "再発行して送信").props.onClick;
  click(); click(); await settle();
  assert.equal(s.calls.filter(c => c.url.endsWith("/reissue")).length, 1);
  finish(Response.json({ ok: true, status: "SENT" })); await settle();
  for (const options of [{ confirm: () => false }, { storage: { get() { throw new Error("Storage unavailable"); } } }]) {
    const blocked = screen({ ...options, send: () => assert.fail("must not send") });
    await blocked.start(); await blocked.click();
    assert.equal(blocked.calls.filter(c => c.url.endsWith("/reissue")).length, 0);
  }
});

test("pending request IDs are isolated by store and report", async () => {
  const storage = new Map(), requests = [];
  const send = async body => { requests.push(body); throw new Error("lost"); };
  for (const [store,report] of [["A","report"],["B","report"],["A","other"],["A","report"]]) {
    const s = screen({ storage, send, store, report }); await s.start(); await s.click();
  }
  assert.equal(new Set(requests.slice(0,3).map(r => r.requestId)).size,3);
  assert.equal(requests[0].requestId,requests[3].requestId);
});

test("the real screen and reissue API recover a lost successful response with one database attempt", async () => {
  const f = await coManagerFixture();
  try {
    await f.seedReport();
    const report = (await f.call("monthly-attendance/reports")).body.reports[0].id;
    let loseResponse = true;
    const send = async body => {
      const result = await f.call("monthly-attendance/reissue", { ...body, idToken: "fixture_delegate" });
      assert.equal(result.status, 200);
      if (loseResponse) { loseResponse = false; throw new TypeError("response lost"); }
      return Response.json(result.body);
    };
    const finished = async s => {
      const deadline = Date.now() + 10000;
      while (text(s.render()).includes("再発行中…") && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      assert.doesNotMatch(text(s.render()), /再発行中…/);
    };
    let s = screen({ store: f.store, report, send }); await s.start(); await s.click(); await finished(s);
    assert.match(text(s.render()), /送信結果を確認できませんでした/);
    s = screen({ store: f.store, report, send, storage: s.storage }); await s.start(); await s.click(); await finished(s);
    assert.match(text(s.render()), /送信済み/);
    assert.equal(f.emails.length, 1);
    assert.deepEqual((await f.db.query("SELECT status,attempt_count FROM monthly_attendance_deliveries WHERE delivery_version LIKE 'reissue-%'")).rows, [{ status: "SENT", attempt_count: 1 }]);
    assert.equal((await f.db.query("SELECT COUNT(*)::int n FROM monthly_attendance_delivery_attempts")).rows[0].n, 1);
  } finally { await f.db.close(); }
});
