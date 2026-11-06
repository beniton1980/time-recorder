import assert from "node:assert/strict";
import test from "node:test";
import * as jsxRuntime from "react/jsx-runtime";
import { loadTs } from "./helpers/load-ts.mjs";

const settle = () => new Promise(resolve => setImmediate(resolve));
const same = (a, b) => a && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
const text = tree => typeof tree === "string" || typeof tree === "number" ? String(tree) : Array.isArray(tree) ? tree.map(text).join("") : text(tree?.props?.children ?? "");
function nodes(tree, type) {
  if (!tree || typeof tree !== "object") return [];
  if (Array.isArray(tree)) return tree.flatMap(x => nodes(x, type));
  return [...(tree.type === type ? [tree] : []), ...nodes(tree.props?.children, type)];
}
function screen() {
  const slots = [], jobs = [], requests = [];
  let index = 0, model, key = "initial";
  const getStoreToken = () => "fixture-only-token";
  const react = {
    createContext: () => ({ Provider: "provider" }), useContext: () => model,
    useState(initial) { const i = index++; if (!(i in slots)) slots[i] = initial; return [slots[i], value => { slots[i] = typeof value === "function" ? value(slots[i]) : value; }]; },
    useRef(initial) { const i = index++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useCallback(fn, deps) { const i = index++; if (!same(slots[i]?.deps, deps)) slots[i] = { fn, deps }; return slots[i].fn; },
    useEffect(fn, deps) { const i = index++; if (!same(slots[i]?.deps, deps)) { const old = slots[i]; slots[i] = { deps }; jobs.push(() => { old?.cleanup?.(); slots[i].cleanup = fn(); }); } },
  };
  const component = loadTs("app/attendance-attention.tsx", {
    react, "react/jsx-runtime": jsxRuntime,
    "@line/liff": { default: { getIDToken: () => "fixture-only-identity" } },
    "@/lib/attendance-request": { withAttendanceDeadline: fn => fn(new AbortController().signal) },
    "./attendance-attention.module.css": { default: {} },
  }, { document: { addEventListener() {}, removeEventListener() {}, visibilityState: "visible" },
    fetch: (_url, options) => new Promise((resolve, reject) => requests.push({ body: JSON.parse(options.body), resolve: value => resolve({ ok: true, json: async () => value }), reject })),
  });
  return {
    requests,
    render(nextKey = key) { key = nextKey; index = 0; model = component.AttendanceAttentionProvider({ getStoreToken, refreshKey: key, children: null }).props.value; return model; },
    async effects() { jobs.splice(0).forEach(fn => fn()); await settle(); },
    notice: () => component.AttendanceAttentionNotice(),
    panel: onCorrect => component.default({ disabled: false, onCorrect, onHistory() {} }),
    async reply(value, request = requests.shift()) { request.resolve({ ok: true, items: [], checkCount: 0, next: null, ...value }); await settle(); this.render(); },
  };
}
const carried = { id: "old-work", bucket: "check", message: "前日の勤務は続いていますか？", continuing: true, source: null, eventType: "CHECK_OUT", requestId: null };

test("one shared response drives the compact notice and existing actions; continuation closes only that notice", async () => {
  const s = screen(); s.render(); await s.effects();
  await s.reply({}); assert.equal(s.notice(), null);
  s.render("refreshed"); await s.effects();
  await s.reply({ items: [carried], checkCount: 1 });
  assert.match(text(s.notice()), /前日の勤務は続いていますか/);
  const calls = []; s.render().panel.current = { focus: () => calls.push("focus"), scrollIntoView: () => calls.push("scroll") };
  nodes(s.notice(), "button")[0].props.onClick(); assert.deepEqual(calls, ["focus", "scroll"]);
  let submitted;
  nodes(s.panel((...args) => { submitted = args; }), "button").find(x => text(x) === "退勤を申請").props.onClick();
  assert.equal(submitted[0].id, carried.id); assert.equal(submitted[1], false);
  nodes(s.panel(() => {}), "button").find(x => text(x) === "勤務を続けています").props.onClick();
  s.render(); assert.equal(s.notice(), null); assert.match(text(s.panel(() => {})), /勤務継続中として/);
  assert.equal(s.requests.length, 0, "summary and detail never issue separate requests");
});

test("late pre-refresh data cannot recreate a resolved notice; failure offers the existing retry area", async () => {
  const s = screen(); s.render(); await s.effects(); const old = s.requests.shift();
  s.render("after-correction"); await s.effects(); await s.reply({});
  await s.reply({ items: [carried], checkCount: 1 }, old); assert.equal(s.notice(), null);
  s.render("offline"); await s.effects(); s.requests.shift().reject(new Error("fixture offline")); await settle(); s.render();
  assert.match(text(s.notice()), /取得できませんでした/);
  assert.match(text(s.panel(() => {})), /打刻は引き続き利用できます/);
});
