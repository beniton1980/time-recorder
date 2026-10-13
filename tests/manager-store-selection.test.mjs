import assert from "node:assert/strict";
import test from "node:test";
import * as jsxRuntime from "react/jsx-runtime";
import { loadTs } from "./helpers/load-ts.mjs";

const datetime = loadTs("lib/manager-correction-datetime.ts");
const validation = loadTs("lib/correction-validation.ts");
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
function nodes(tree, type) {
  if (!tree || typeof tree !== "object") return [];
  if (Array.isArray(tree)) return tree.flatMap(item => nodes(item, type));
  return [...(tree.type === type ? [tree] : []), ...nodes(tree.props?.children, type)];
}
const text = tree => typeof tree === "string" || typeof tree === "number" ? String(tree) : Array.isArray(tree) ? tree.map(text).join("") : tree?.props ? text(tree.props.children) : "";
function dashboard(store, ids) {
  return { ok: true, manager: { store_id: store, store_name: `架空店舗${store}`, legal_name: "架空管理者", store_latitude: null },
    businessDate: "2026-10-13", corrections: [], coManagers: [],
    attendance: ids.map(id => ({ staff_id: id, legal_name: `架空${id}` })),
    staffMemberships: ids.map(id => ({ staff_id: id, legal_name: `架空${id}`, status: "active", state: "OFF_DUTY" })) };
}
function screen() {
  const states = [], effects = [], calls = [];
  let index = 0, result = dashboard("A", ["A1", "A2"]), hold, release;
  const location = { href: "https://fixture.invalid/manager?store_id=A", search: "?store_id=A" };
  const component = loadTs("app/manager/page.tsx", {
    "react/jsx-runtime": jsxRuntime,
    react: {
      useState(initial) { const i = index++; if (!(i in states)) states[i] = typeof initial === "function" ? initial() : initial; return [states[i], v => { states[i] = typeof v === "function" ? v(states[i]) : v; }]; },
      useEffect: fn => effects.push(fn), useCallback: fn => fn,
    },
    "@line/liff": { default: { init: async () => {}, isLoggedIn: () => true, getIDToken: () => "fixture-identity" } },
    "@/lib/manager-correction-datetime": datetime, "@/lib/correction-validation": validation,
    "./manager.module.css": { default: {} },
  }, {
    process: { env: {} }, URL,
    window: { location, confirm: () => true, history: { replaceState: (_a, _b, url) => { location.href = String(url); location.search = url.search; } } },
    fetch: async (url, options) => {
      const body = JSON.parse(options.body); calls.push({ url, body });
      if (url.endsWith("/session")) return { ok: true, json: async () => ({ ok: true, manager: { memberships: ["A", "B"].map(store => ({ store_id: store, store_name: `架空店舗${store}` })) } }) };
      if (url.endsWith("/dashboard")) { if (hold) await hold; return { ok: result.ok, json: async () => result }; }
      return { ok: true, json: async () => ({ ok: true, reports: [] }) };
    },
  });
  return { calls, location, render() { index = 0; return component.default(); },
    async start() { this.render(); effects[0](); await settle(); },
    respond(value) { result = value; }, hold() { hold = new Promise(resolve => { release = resolve; }); },
    async release() { release(); hold = null; await settle(); } };
}
const attendance = s => nodes(s.render(), "section").find(n => n.props["data-dashboard-key"] === "attendance");
const select = s => nodes(attendance(s), "select")[0];
const link = s => nodes(attendance(s), "a")[0];
const storeSelect = s => nodes(s.render(), "select")[0];
const choose = (s, id) => select(s).props.onChange({ target: { value: id } });
const switchTo = (s, id) => storeSelect(s).props.onChange({ target: { value: id } });
const options = s => nodes(select(s), "option").map(n => n.props.value);
function assertTarget(s, store, staff) {
  assert.equal(select(s).props.value, staff);
  const url = new URL(link(s).props.href, "https://fixture.invalid");
  assert.equal(url.searchParams.get("store_id"), store);
  assert.equal(url.searchParams.get("staff_id"), staff);
}

test("store switching updates staff, count and destination together, blocking navigation while pending", async () => {
  const s = screen(); await s.start();
  assertTarget(s, "A", "A1"); choose(s, "A2"); assertTarget(s, "A", "A2");
  s.respond(dashboard("B", ["B1"])); s.hold(); switchTo(s, "B");
  assert.equal(select(s).props.disabled, true); assert.equal(link(s), undefined);
  await s.release(); assertTarget(s, "B", "B1"); assert.deepEqual(options(s), ["B1"]);
  assert.match(text(attendance(s)), /1名/);
  s.respond(dashboard("A", ["A1", "A2"])); switchTo(s, "A"); await settle();
  assertTarget(s, "A", "A1"); assert.deepEqual(options(s), ["A1", "A2"]);
});

test("failed switch retains the previous store, selected staff and URL, then allows retry", async () => {
  const s = screen(); await s.start(); choose(s, "A2");
  s.respond({ ok: false }); switchTo(s, "B"); await settle();
  assertTarget(s, "A", "A2"); assert.equal(new URL(s.location.href).searchParams.get("store_id"), "A");
  assert.match(text(s.render()), /管理者画面を読み込めませんでした/);
  s.respond(dashboard("B", ["B1"])); switchTo(s, "B"); await settle(); assertTarget(s, "B", "B1");
});

test("empty current staff never offers a stale personal attendance link", async () => {
  const s = screen(); await s.start(); s.respond(dashboard("B", [])); switchTo(s, "B"); await settle();
  assert.equal(link(s), undefined); assert.equal(select(s).props.disabled, true);
  assert.match(text(attendance(s)), /0名.*対象のスタッフはいません/);
});

test("refresh after staff status save replaces removed candidates and uses current names", async () => {
  const s = screen(); await s.start(); choose(s, "A2");
  const updated = dashboard("A", ["A1"]); updated.attendance[0].legal_name = "架空スタッフ改名後";
  s.respond(updated);
  const row = nodes(s.render(), "li").find(n => text(n).includes("架空A2"));
  nodes(row, "button").find(n => text(n) === "一時停止").props.onClick(); await settle();
  assertTarget(s, "A", "A1"); assert.deepEqual(options(s), ["A1"]);
  assert.match(text(select(s)), /架空スタッフ改名後/);
  const save = s.calls.find(c => c.url.endsWith("/staff/status"));
  assert.equal(save.body.storeId, "A"); assert.equal(save.body.staffId, "A2");
});

test("refresh preserving the selected membership also preserves its destination", async () => {
  const s = screen(); await s.start(); choose(s, "A2");
  s.respond(dashboard("A", ["A2"]));
  const row = nodes(s.render(), "li").find(n => text(n).includes("架空A1"));
  nodes(row, "button").find(n => text(n) === "一時停止").props.onClick(); await settle();
  assertTarget(s, "A", "A2");
});
