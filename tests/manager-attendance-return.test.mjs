import assert from "node:assert/strict";
import test from "node:test";
import * as jsxRuntime from "react/jsx-runtime";
import { loadTs } from "./helpers/load-ts.mjs";

const receiptId = "00000000-0000-4000-8000-000000000001";
const context = { storeId: "store-A", staffId: "staff-A", businessDate: "2026-04-08" };
const nodes = (tree, type) => !tree || typeof tree !== "object" ? [] : Array.isArray(tree) ? tree.flatMap(t => nodes(t, type)) : [...(!type || tree.type === type ? [tree] : []), ...nodes(tree.props?.children, type)];
const text = t => typeof t === "string" || typeof t === "number" ? String(t) : Array.isArray(t) ? t.map(text).join("") : t?.props ? text(t.props.children) : "";
function storage() {
  const values = new Map();
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
function returnModule(sessionStorage = storage()) {
  return loadTs("lib/manager-attendance-return.ts", {}, { window: { sessionStorage }, crypto: { randomUUID: () => receiptId } });
}
function report(staffId = "staff-A", month = "2026-04", pending = true) {
  return { ok: true, store: { id: "store-A", name: "架空店舗" }, staff: { id: staffId, legalName: staffId },
    staffOptions: ["staff-A", "staff-B"].map(id => ({ id, legalName: id, status: "active" })), month,
    period: { start: month + "-01", displayThrough: month + "-10" },
    summary: { workDays: 1, workDuration: "08:00", breakDuration: "00:00", issueDays: pending ? 1 : 0 },
    days: [{ businessDate: month + "-08", status: pending ? "NEEDS_REVIEW" : "CONFIRMED", attendanceReasons: pending ? ["UNCLOSED_SHIFT"] : [], reviewReasons: [], gpsIssueCount: 0, hasCorrection: !pending, checkIn: "09:00", checkOut: pending ? "" : "17:00", breakPeriods: [], workedDuration: pending ? "" : "08:00" }] };
}
function screen(query = "", sessionStorage = storage(), init = async () => {}) {
  const slots = [], pendingEffects = [], calls = [], focused = [];
  let index = 0, dirty = true, tree, refs = [];
  let respond = async body => ({ ok: true, json: async () => report(body.staffId, body.month) });
  const location = new URL("https://fixture.invalid/manager/staff-attendance?store_id=store-A&staff_id=staff-A&month=2026-04" + query);
  const same = (a, b) => a?.length === b?.length && a.every((v, i) => Object.is(v, b[i]));
  const component = loadTs("app/manager/staff-attendance/page.tsx", {
    "react/jsx-runtime": jsxRuntime,
    react: {
      useState(initial) { const i = index++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial; return [slots[i], value => { const next = typeof value === "function" ? value(slots[i]) : value; if (!Object.is(next, slots[i])) { slots[i] = next; dirty = true; } }]; },
      useRef(initial) { const i = index++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
      useMemo(fn, deps) { const i = index++; if (!same(slots[i]?.deps, deps)) slots[i] = { deps, value: fn() }; return slots[i].value; },
      useSyncExternalStore(_subscribe, snapshot) { index++; return snapshot(); },
      useEffect(fn, deps) { const i = index++; if (!same(slots[i]?.deps, deps)) { const previous = slots[i]; slots[i] = { deps }; pendingEffects.push(() => { previous?.cleanup?.(); slots[i].cleanup = fn(); }); } },
    },
    "@line/liff": { default: { init, isLoggedIn: () => true, getIDToken: () => "fixture-identity" } },
    "@/lib/manager-attendance-return": returnModule(sessionStorage),
    "./staff-attendance.module.css": { default: {} },
  }, {
    process: { env: {} }, URL, PopStateEvent: class {},
    window: { location, history: { replaceState: (_a, _b, url) => { location.href = String(url); } }, dispatchEvent: () => { dirty = true; } },
    fetch: async (url, options) => { const body = JSON.parse(options.body); calls.push({ url, body }); return respond(body); },
  });
  function render() {
    for (let round = 0; round < 20; round++) {
      if (!dirty && tree) break;
      dirty = false; index = 0; tree = component.default();
      for (const ref of refs) { if (typeof ref === "function") ref(null); else ref.current = null; }
      refs = [];
      for (const node of nodes(tree)) { const ref = node.props?.ref; if (!ref) continue; refs.push(ref); const element = { focus: () => {}, scrollIntoView: () => focused.push(node.props["data-returned-day"] ?? "notice") }; if (typeof ref === "function") ref(element); else ref.current = element; }
      for (const effect of pendingEffects.splice(0)) effect();
    }
    assert.equal(dirty, false, "render must settle"); return tree;
  }
  return { calls, focused, location, render, setResponse: fn => { respond = fn; },
    async settle() { for (let i = 0; i < 6; i++) { render(); await new Promise(resolve => setImmediate(resolve)); } return render(); },
    button(label) { return nodes(render(), "button").find(n => text(n) === label); },
    choose(id) { nodes(render(), "select")[0].props.onChange({ target: { value: id } }); render(); },
    month(value) { nodes(render(), "input")[0].props.onChange({ target: { value } }); render(); },
    edits() { return nodes(render(), "a").filter(n => text(n) === "この日の打刻を修正"); },
  };
}

test("switching staff/month removes old edit links immediately and discards late responses", async () => {
  const s = screen(); await s.settle(); assert.equal(s.edits().length, 10);
  let release;
  s.setResponse(body => new Promise(resolve => { release = () => resolve({ ok: true, json: async () => report(body.staffId, body.month) }); }));
  s.choose("staff-B"); assert.equal(s.edits().length, 0); await s.settle();
  s.setResponse(async body => ({ ok: true, json: async () => report(body.staffId, body.month) }));
  s.choose("staff-A"); await s.settle(); release(); await s.settle();
  assert.equal(nodes(s.render(), "h1")[0].props.children, "staff-A");
  assert.ok(s.edits().every(n => n.props.href.includes("staff_id=staff-A")));
  s.month("2026-03"); assert.equal(s.edits().length, 0); await s.settle();
  assert.ok(s.edits().every(n => n.props.href.includes("date=2026-03-")));
  assert.equal(s.location.searchParams.get("month"), "2026-03");
});

test("failed or mismatched reads offer retry without displaying another selection's data", async () => {
  const s = screen(); await s.settle();
  s.setResponse(async () => ({ ok: false, json: async () => ({ ok: false }) }));
  s.choose("staff-B"); await s.settle(); assert.equal(s.edits().length, 0);
  assert.match(text(s.render()), /読み込めません/);
  s.setResponse(async () => ({ ok: true, json: async () => report("staff-A") }));
  s.button("もう一度読み込む").props.onClick(); await s.settle();
  assert.equal(s.edits().length, 0); assert.match(text(s.render()), /対象の勤怠を確認できません/);
  s.setResponse(async () => ({ ok: true, json: async () => report("staff-B") }));
  s.button("もう一度読み込む").props.onClick(); await s.settle();
  assert.ok(s.edits().every(n => n.props.href.includes("staff_id=staff-B")));
});

test("a failed LINE initialization can be retried without leaving the selected month", async () => {
  let attempts = 0;
  const s = screen("", storage(), async () => { if (++attempts === 1) throw Error("fixture-init-failed"); });
  await s.settle();
  assert.equal(s.calls.length, 0);
  assert.equal(s.edits().length, 0);
  s.button("もう一度読み込む").props.onClick(); await s.settle();
  assert.equal(attempts, 2);
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].body.month, "2026-04");
  assert.equal(s.edits().length, 10);
});

test("review filter survives return; a resolved day stays hidden until explicitly opened", async () => {
  const saved = storage(); returnModule(saved).rememberCorrection({ ...context, operation: "ADD" });
  const s = screen(`&review=1&focus=2026-04-08&saved=${receiptId}`, saved);
  s.setResponse(async () => ({ ok: true, json: async () => report("staff-A", "2026-04", false) }));
  await s.settle();
  assert.equal(s.button("要確認のみ").props["aria-pressed"], true);
  assert.match(text(s.render()), /打刻を追加しました/); assert.equal(s.edits().length, 0);
  assert.deepEqual(s.focused, ["notice"]);
  s.button("修正した日を確認").props.onClick(); await s.settle();
  assert.equal(s.button("すべて").props["aria-pressed"], true);
  assert.equal(s.focused.at(-1), "2026-04-08");
  assert.match(text(nodes(s.render(), "li").find(n => n.props["data-returned-day"])), /17:00/);
  assert.equal(s.calls.length, 1, "opening the already loaded day does not save or refetch");
});

test("a saved operation and a failed refresh are distinguished; retry is read-only and retains the day", async () => {
  const saved = storage(); returnModule(saved).rememberCorrection({ ...context, operation: "VOID" });
  const s = screen(`&focus=2026-04-08&saved=${receiptId}`, saved);
  s.setResponse(async () => { throw Error("fixture-offline"); }); await s.settle();
  assert.match(text(s.render()), /保存は完了しましたが、最新の勤怠を読み込めません/);
  assert.equal(s.edits().length, 0);
  s.setResponse(async () => ({ ok: true, json: async () => ({ ...report(), days: [] }) }));
  s.button("もう一度読み込む").props.onClick(); await s.settle();
  assert.match(text(s.render()), /打刻を取消しました/);
  const returned = nodes(s.render(), "li").find(n => n.props["data-returned-day"]);
  assert.match(text(returned), /勤務記録なし/);
  assert.ok(s.calls.every(c => c.url === "/api/manager/staff-attendance"));
});

test("ordinary return focuses the target, and editing carries the selected review filter", async () => {
  const s = screen("&review=1&focus=2026-04-08"); await s.settle();
  assert.equal(s.focused.at(-1), "2026-04-08");
  assert.equal(s.edits().length, 1); assert.match(s.edits()[0].props.href, /&review=1$/);
  assert.match(text(s.render()), /勤怠に戻りました/); assert.doesNotMatch(text(s.render()), /打刻を.*しました/);
});

test("success notices are scoped, expire and are consumed once; storage unavailability cannot fail a save", async () => {
  const saved = storage(), mod = returnModule(saved);
  for (const operation of ["ADD", "REPLACE", "VOID"]) {
    mod.rememberCorrection({ ...context, operation });
    assert.equal(mod.consumeCorrectionReceipt(receiptId, context).operation, operation);
    assert.equal(mod.consumeCorrectionReceipt(receiptId, context), null);
  }
  for (const change of [{ staffId: "staff-B" }, { storeId: "store-B" }, { businessDate: "2026-04-09" }]) {
    mod.rememberCorrection({ ...context, operation: "ADD" });
    assert.equal(mod.consumeCorrectionReceipt(receiptId, { ...context, ...change }), null);
  }
  mod.rememberCorrection({ ...context, operation: "REPLACE" });
  const key = [...saved.values.keys()][0], value = JSON.parse(saved.getItem(key));
  saved.setItem(key, JSON.stringify({ ...value, savedAt: Date.now() - 31 * 60 * 1000 }));
  assert.equal(mod.consumeCorrectionReceipt(receiptId, context), null);
  const broken = returnModule({ setItem() { throw Error("blocked"); }, getItem() { throw Error("blocked"); } });
  assert.equal(broken.rememberCorrection({ ...context, operation: "ADD" }), undefined);
  assert.equal(broken.consumeCorrectionReceipt(receiptId, context), null);
  assert.equal(mod.isAttendanceDate("2026-02-31"), false);
  const forged = screen(`&focus=2026-04-08&saved=${receiptId}`); await forged.settle();
  assert.doesNotMatch(text(forged.render()), /打刻を.*しました/);
});
