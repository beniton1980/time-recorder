import assert from "node:assert/strict";
import { test } from "node:test";
import * as jsxRuntime from "react/jsx-runtime";
import { loadTs } from "./helpers/load-ts.mjs";
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
const text = t => typeof t === "string" ? t : Array.isArray(t) ? t.map(text).join("") : t?.props ? text(t.props.children) : "";
const nodes = (t, type) => !t || typeof t !== "object" ? [] : Array.isArray(t) ? t.flatMap(n => nodes(n, type)) : [...(t.type === type ? [t] : []), ...nodes(t.props?.children, type)];
function screen() {
  const slots = [], calls = []; let index = 0, mounted = false, cleanup;
  let response = async () => ({ ok: true, json: async () => ({ ok: true, requests: [], next: null }) });
  const component = loadTs("app/correction-history.tsx", {
    "react/jsx-runtime": jsxRuntime,
    react: {
      useState(initial) { const i = index++; if (!(i in slots)) slots[i] = initial; return [slots[i], v => { slots[i] = typeof v === "function" ? v(slots[i]) : v; }]; },
      useRef(initial) { const i = index++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
      useEffect(fn) { if (!mounted) { cleanup = fn(); mounted = true; } },
    },
    "@line/liff": { default: { getIDToken: () => "fixture" } },
    "@/lib/attendance-request": { withAttendanceDeadline: fn => fn(new AbortController().signal) },
    "./correction-history.module.css": { default: {} },
  }, { fetch: async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return response(); } });
  return { calls, render() { index = 0; return component.default({ getStoreToken: () => "fixture-qr" }); },
    setResponse(fn) { response = fn; }, unmount() { cleanup(); } };
}
const button = (s, label) => nodes(s.render(), "button").find(n => text(n).startsWith(label));
const click = async (s, label) => { button(s, label).props.onClick(); await settle(); };
const item = (id, status) => ({ id, status, requestedAt: "2026-10-01T01:00:00.123456Z", operation: "REVIEW", category: "OTHER", reason: "架空の申請", occurredAt: null, decidedAt: status === "PENDING" ? null : "2026-10-02T01:00:00Z" });
const reply = (requests, next = null) => async () => ({ ok: true, json: async () => ({ ok: true, requests, next }) });

test("history is lazy, displays status and next action, and refresh reflects a manager decision", async () => {
  const s = screen(); s.render(); assert.equal(s.calls.length, 0);
  s.setResponse(reply([item("one", "PENDING")])); await click(s, "修正申請の状況");
  assert.match(text(s.render()), /確認待ち/); assert.match(text(s.render()), /まだ勤怠には反映されていません/);
  s.setResponse(reply([item("one", "REJECTED"), item("two", "APPROVED")])); await click(s, "最新の状況を確認");
  assert.match(text(s.render()), /却下/); assert.match(text(s.render()), /内容を管理者に確認/); assert.match(text(s.render()), /承認済み/);
  assert.equal(s.calls[0].body.storeToken, "fixture-qr");
  await click(s, "修正申請の状況"); await click(s, "修正申請の状況"); assert.equal(s.calls.length, 3);
});

test("failed refresh does not show an empty or stale success; retry and pagination preserve the appropriate page", async () => {
  const s = screen(), next = { id: "one", requestedAt: "2026-10-01T01:00:00.123456Z" };
  s.setResponse(reply([item("one", "PENDING")], next)); await click(s, "修正申請の状況");
  s.setResponse(async () => { throw Error("offline"); }); await click(s, "以前の記録を見る");
  assert.match(text(s.render()), /取得できません/); assert.match(text(s.render()), /確認待ち/);
  s.setResponse(reply([item("two", "APPROVED")])); await click(s, "以前の記録を見る");
  assert.deepEqual(s.calls.at(-1).body.before, next); assert.equal(nodes(s.render(), "li").length, 2);
  s.setResponse(async () => ({ ok: false })); await click(s, "最新の状況を確認");
  assert.match(text(s.render()), /取得できません/); assert.doesNotMatch(text(s.render()), /確認待ち|承認済み|申請はありません/);
  s.setResponse(reply([])); await click(s, "最新の状況を確認"); assert.match(text(s.render()), /修正申請はありません/);
});

test("duplicate clicks share a lookup and an old membership's late response cannot update its unmounted history", async () => {
  const s = screen(); let resolve;
  s.setResponse(() => new Promise(r => { resolve = r; }));
  await click(s, "修正申請の状況"); await click(s, "最新の状況を確認"); assert.equal(s.calls.length, 1);
  s.unmount(); resolve(await reply([item("old", "APPROVED")])()); await settle();
  assert.doesNotMatch(text(s.render()), /承認済み/);
});

test("consultation progress and no-change completion do not claim an approval or an unreflected saved correction", async () => {
  const s=screen();s.setResponse(reply([{...item('one','PENDING'),hasSavedCorrections:true}]));await click(s,'修正申請の状況');
  assert.match(text(s.render()),/修正保存済み・未完了/);assert.doesNotMatch(text(s.render()),/まだ勤怠には反映されていません/);
  s.setResponse(reply([{...item('one','RESOLVED'),outcome:'NO_CHANGE'}]));await click(s,'最新の状況を確認');
  assert.match(text(s.render()),/対応済み/);assert.match(text(s.render()),/打刻の変更はありません/);assert.doesNotMatch(text(s.render()),/承認済み|却下/);
});
