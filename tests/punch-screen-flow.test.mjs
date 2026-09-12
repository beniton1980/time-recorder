import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as jsxRuntime from "react/jsx-runtime";

const source = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;
const settle = () => new Promise((resolve) => setImmediate(resolve));

function screen() {
  const states = []; const refs = []; const calls = [];
  let stateIndex = 0; let refIndex = 0; let resolveLocation; let resolveSend;
  const membership = {
    staff_id: "fixture-staff", legal_name: "検証スタッフ", store_id: "fixture-store",
    store_name: "検証店舗", state: "OFF_DUTY", last_event_id: null,
    last_event_at: null, last_event_type: null, recent_punches: [],
  };
  const reader = { read: () => new Promise((resolve) => { resolveLocation = resolve; }), clear() {} };
  const modules = {
    "react/jsx-runtime": jsxRuntime,
    react: {
      useEffect() {},
      useState(initial) {
        const index = stateIndex++;
        if (!(index in states)) states[index] = index === 0 ? { kind: "ready", membership } : initial;
        return [states[index], (value) => { states[index] = value; }];
      },
      useRef(initial) {
        const index = refIndex++;
        refs[index] ??= { current: index === 0 ? "fixture-store-token" : index === 1 ? reader : initial };
        return refs[index];
      },
    },
    "@line/liff": { default: { getIDToken: () => "fixture-id-token" } },
    "@/lib/punch-location.mjs": {},
    "@/lib/punch-performance.mjs": { measurePunchStage: (_stage, task) => task() },
  };
  const exports = {};
  vm.runInNewContext(compiled, {
    exports, require: (name) => { assert.ok(modules[name], name); return modules[name]; },
    crypto: { randomUUID: () => "fixture-request-id" },
    fetch: (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return new Promise((resolve) => { resolveSend = resolve; }); },
  });
  function render() { stateIndex = 0; refIndex = 0; return exports.default(); }
  return {
    render, states, calls,
    locate: (value) => resolveLocation(value),
    send: (ok) => resolveSend({ ok, json: async () => ok ? {
      ok: true, punch: { state: "WORKING", event_id: "fixture-event", occurred_at: "2026-09-12T12:00:00Z", location_status: "OK" },
    } : { ok: false } }),
  };
}

function nodes(tree, type) {
  if (!tree || typeof tree !== "object") return [];
  if (Array.isArray(tree)) return tree.flatMap((child) => nodes(child, type));
  return [...(tree.type === type ? [tree] : []), ...nodes(tree.props?.children, type)];
}
const punchButton = (tree) => nodes(tree, "button").find((button) => button.props.className === "punch-button");

test("tap locks immediately, shows real stages, and confirms only after server success", async () => {
  const s = screen(); const button = punchButton(s.render());
  button.props.onClick(); button.props.onClick();
  assert.equal(punchButton(s.render()).props.disabled, true);
  assert.equal(punchButton(s.render()).props.children, "位置情報を確認しています…");
  assert.equal(s.calls.length, 0);
  s.locate({ latitude: 35, longitude: 139, accuracy: 10 }); await settle();
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].url, "/api/punch");
  assert.equal(s.calls[0].body.storeToken, "fixture-store-token");
  assert.equal(s.calls[0].body.idToken, "fixture-id-token");
  assert.equal(punchButton(s.render()).props.children, "打刻を送信しています…");
  assert.equal(s.states[0].membership.state, "OFF_DUTY");
  s.send(true); await settle();
  assert.equal(s.states[0].membership.state, "WORKING");
  assert.equal(s.states[0].membership.recent_punches.length, 1);
  assert.equal(punchButton(s.render()).props.disabled, false);
});

test("unavailable location still sends, a server failure stays unrecorded and unlocks retry", async () => {
  const s = screen(); punchButton(s.render()).props.onClick();
  s.locate(null); await settle();
  assert.equal(s.calls[0].body.location, null);
  s.send(false); await settle();
  assert.equal(s.states[0].membership.state, "OFF_DUTY");
  assert.equal(s.states[0].membership.recent_punches.length, 0);
  assert.equal(punchButton(s.render()).props.disabled, false);
  assert.ok(s.states.includes("打刻を完了できませんでした。"));
});
