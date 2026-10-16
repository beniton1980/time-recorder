import assert from "node:assert/strict";
import test from "node:test";
import * as jsxRuntime from "react/jsx-runtime";
import { loadTs } from "./helpers/load-ts.mjs";

const tick = () => new Promise(resolve => setImmediate(resolve));
const nodes = (tree, type) => !tree || typeof tree !== "object" ? [] : Array.isArray(tree) ? tree.flatMap(item => nodes(item, type)) : [...(tree.type === type ? [tree] : []), ...nodes(tree.props?.children, type)];
const text = tree => typeof tree === "string" || typeof tree === "number" ? String(tree) : Array.isArray(tree) ? tree.map(text).join("") : tree?.props ? text(tree.props.children) : "";
const run = (id, latest = true) => ({ id, period_start: "2026-09-01", period_end: "2026-09-30", gross_pay_yen: 8800, calculation_spec_version: "fixture", saved_at: "2026-10-01T00:00:00Z", staff_count: 1, version_number: latest ? 2 : 1, version_count: 2, is_latest: latest });
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function harness(search = "") {
  const slots = [], effects = [], cleanups = [], pending = [], revoked = [], created = [];
  let index = 0;
  const react = {
    useState(value) { const i = index++; if (!(i in slots)) slots[i] = value; return [slots[i], next => { slots[i] = next; }]; },
    useRef(value) { const i = index++; if (!(i in slots)) slots[i] = { current: value }; return slots[i]; },
    useEffect(effect) { const i = index++; if (!(i in slots)) { slots[i] = true; effects.push(effect); } },
  };
  const globals = { File, URLSearchParams, window: { location: { search } }, URL: class extends URL {
    static createObjectURL(file) { created.push(file); return `blob:${created.length}`; }
    static revokeObjectURL(url) { revoked.push(url); }
  } };
  const report = loadTs("app/manager/report-file.tsx", { "react/jsx-runtime": jsxRuntime, react, "@line/liff": { default: {} }, "./report-file.module.css": { default: {} } }, globals);
  const page = loadTs("app/manager/payroll/history/page.tsx", {
    "react/jsx-runtime": jsxRuntime, react,
    "@line/liff": { default: { init: async () => {}, isLoggedIn: () => true, getIDToken: () => "fixture" } },
    "@/lib/manager-api-auth-error": { managerApiAuthError: () => null },
    "../../report-file": report, "../payroll.module.css": { default: {} },
  }, { ...globals, fetch: (url, options) => new Promise(resolve => pending.push({ url, body: JSON.parse(options.body), resolve })) });
  return {
    pending, revoked, created,
    render() { index = 0; const tree = page.default(); for (const effect of effects.splice(0)) cleanups.push(effect()); return tree; },
    button(label) { const found = nodes(this.render(), "button").find(n => text(n).includes(label)); assert.ok(found, label); return found; },
    file() { return nodes(this.render(), report.default)[0]?.props.prepared; },
    changeStore(store) { nodes(this.render(), "select")[0].props.onChange({ target: { value: store } }); },
    async respond(body, status = 200) { assert.ok(pending.length); pending.shift().resolve(body instanceof Response ? body : reply(body, status)); await tick(); },
    async start() {
      this.render(); await tick();
      await this.respond({ ok: true, manager: { memberships: [{ store_id: "A", store_name: "店舗A" }, { store_id: "B", store_name: "店舗B" }] } });
    },
    async detail() { await this.start(); await this.respond({ ok: true, runs: [run("rA"), run("old", false)] }); this.button("最新版").props.onClick(); await this.respond({ ok: true, run: run("rA"), items: [], comparison: null }); },
    unmount() { cleanups.forEach(fn => fn?.()); },
  };
}

test("CSV is prepared for an explicit save, retains bytes and clears on leaving the saved version", async () => {
  const h = harness(); await h.detail();
  const click = h.button("CSV出力").props.onClick; click(); click();
  assert.equal(h.pending.length, 1);
  const bytes = new TextEncoder().encode('\ufeff"店舗名","金額"\r\n"架空A","8800"\r\n');
  await h.respond(new Response(bytes));
  assert.equal(h.created.length, 1); assert.equal(h.revoked.length, 0);
  assert.deepEqual(new Uint8Array(await h.file().file.arrayBuffer()), bytes);
  assert.equal(h.file().file.name, "ONOGAMI-控除前給与集計-2026-09-01-2026-09-30-第2版.csv");
  h.button("履歴一覧へ戻る").props.onClick();
  assert.equal(h.file(), undefined); assert.deepEqual(h.revoked, ["blob:1"]);
  h.button("以前の保存").props.onClick(); await h.respond({ ok: true, run: run("old", false), items: [], comparison: null });
  assert.equal(nodes(h.render(), "button").filter(n => text(n).includes("CSV出力")).length, 0);
});

test("late CSV success or failure cannot restore a file/error after store or saved-version navigation", async () => {
  for (const leave of ["store", "list", "unmount"]) for (const status of [200, 409]) {
    const h = harness(); await h.detail(); h.button("CSV出力").props.onClick();
    if (leave === "store") h.changeStore("B");
    else if (leave === "list") h.button("履歴一覧へ戻る").props.onClick();
    else h.unmount();
    await h.respond(status === 200 ? new Response("stale") : reply({ code: "PAYROLL_RUN_NOT_LATEST" }, status));
    assert.equal(h.created.length, 0); assert.equal(h.file(), undefined);
    assert.doesNotMatch(text(h.render()), /新しい保存結果があります/);
  }
});

test("stale history and detail cannot cross stores, and external browser store is membership checked", async () => {
  for (const search of ["?store_id=B", "?store_id=foreign"]) {
    const h = harness(search); await h.start();
    assert.equal(h.pending[0].body.storeId, search.endsWith("B") ? "B" : "A");
  }
  for (const target of ["list", "detail"]) {
    const h = harness(); await h.start();
    if (target === "detail") { await h.respond({ ok: true, runs: [run("rA")] }); h.button("最新版").props.onClick(); }
    h.changeStore("B");
    const old = h.pending.shift(); await h.respond({ ok: true, runs: [run("rB")] });
    old.resolve(reply(target === "list" ? { ok: true, runs: [run("rA")] } : { ok: true, run: run("rA"), items: [], comparison: null })); await tick();
    h.button("最新版").props.onClick(); assert.equal(h.pending[0].body.runId, "rB");
  }
});

test("a failed refresh removes the previous download and preserves latest-version rejection", async () => {
  const h = harness(); await h.detail(); h.button("CSV出力").props.onClick(); await h.respond(new Response("first"));
  h.button("CSV出力").props.onClick(); assert.equal(h.file(), undefined);
  await h.respond({ code: "PAYROLL_RUN_NOT_LATEST" }, 409);
  assert.equal(h.file(), undefined); assert.match(text(h.render()), /新しい保存結果があります/);
  assert.deepEqual(h.revoked, ["blob:1"]);
});
