import assert from "node:assert/strict";
import test from "node:test";
import * as jsxRuntime from "react/jsx-runtime";
import { loadTs } from "./helpers/load-ts.mjs";

function harness(navigator = {}) {
  const slots = [], cleanups = [], revoked = [], opened = [];
  let index = 0, nextUrl = 0;
  const component = loadTs("app/manager/report-file.tsx", {
    "react/jsx-runtime": jsxRuntime,
    react: {
      useState(value) { const i = index++; if (!(i in slots)) slots[i] = value; return [slots[i], next => { slots[i] = next; }]; },
      useRef(value) { const i = index++; if (!(i in slots)) slots[i] = { current: value }; return slots[i]; },
      useEffect(effect) { const i = index++; if (!(i in slots)) { slots[i] = true; cleanups.push(effect()); } },
    },
    "@line/liff": { default: { openWindow: input => opened.push(input) } },
    "./report-file.module.css": { default: {} },
  }, {
    navigator, File,
    URL: class extends URL { static createObjectURL() { return `blob:fixture-${++nextUrl}`; } static revokeObjectURL(url) { revoked.push(url); } },
    window: { location: { origin: "https://fixture.invalid", href: "https://fixture.invalid/manager?access_token=SECRET#credential" } },
  });
  return { revoked, opened, render(props) { index = 0; return props ? component.default(props) : component.useReportFile(); }, unmount() { cleanups.forEach(fn => fn?.()); } };
}
const nodes = (tree, type) => !tree || typeof tree !== "object" ? [] : Array.isArray(tree) ? tree.flatMap(item => nodes(item, type)) : [...(tree.type === type ? [tree] : []), ...nodes(tree.props?.children, type)];
const text = tree => typeof tree === "string" ? tree : Array.isArray(tree) ? tree.map(text).join("") : tree?.props ? text(tree.props.children) : "";
const props = format => ({ prepared: { file: new File(["fixture bytes"], `架空店舗-2026-09-勤怠.${format}`, { type: format === "pdf" ? "application/pdf" : "text/csv" }), url: "blob:ready" }, storeId: "fixture-store" });

test("prepared bytes and MIME survive retries; URLs live until replacement, clear or unmount", async () => {
  const h = harness();
  h.render().prepare(new Blob(["%PDF-fixture"]), "架空/店舗.pdf", "pdf");
  const first = h.render().prepared;
  assert.equal(first.file.name, "架空-店舗.pdf"); assert.equal(first.file.type, "application/pdf");
  assert.equal(await first.file.text(), "%PDF-fixture"); assert.deepEqual(h.revoked, []);
  h.render().prepare(new Blob(["\ufeff氏名,時間\r\n架空,60"], { type: "text/csv;charset=utf-8" }), "架空.csv", "csv");
  assert.equal(h.render().prepared.file.type, "text/csv"); assert.deepEqual(h.revoked, [first.url]);
  h.render().clear(); assert.equal(h.render().prepared, null); assert.equal(h.revoked.length, 2);
  h.render().prepare(new Blob(["third"]), "3.pdf", "pdf"); h.unmount(); assert.equal(h.revoked.length, 3);
});

test("PDF and CSV open the native sheet on the save tap with no asynchronous preparation", async () => {
  for (const format of ["pdf", "csv"]) {
    const p = props(format), calls = []; let finish;
    const h = harness({ canShare: data => data.files[0] === p.prepared.file, share: data => { calls.push(data); return new Promise(resolve => { finish = resolve; }); } });
    const tree = h.render(p); assert.equal(calls.length, 0);
    const button = nodes(tree, "button")[0]; const pending = button.props.onClick();
    assert.equal(calls.length, 1); assert.equal(calls[0].files[0], p.prepared.file);
    button.props.onClick(); assert.equal(calls.length, 1);
    assert.equal(nodes(h.render(p), "button")[0].props.disabled, true);
    finish(); await pending; await new Promise(resolve => setImmediate(resolve));
    assert.match(text(h.render(p)), /保存した場合/); assert.doesNotMatch(text(h.render(p)), /保存しました/);
  }
});

test("cancellation and unavailable native sharing retain a usable download and browser escape", async () => {
  for (const name of ["AbortError", "NotAllowedError", "DataError"]) {
    const p = props("csv"), h = harness({ canShare: () => true, share: async () => { const e = new Error("private detail"); e.name = name; throw e; } });
    nodes(h.render(p), "button")[0].props.onClick(); await new Promise(resolve => setImmediate(resolve));
    const tree = h.render(p);
    assert.match(text(tree), name === "AbortError" ? /完了しませんでした/ : /開けませんでした/);
    assert.doesNotMatch(text(tree), /private detail/);
    assert.equal(nodes(tree, "a")[0].props.href, "blob:ready");
  }
  for (const nav of [{}, { canShare: () => false, share() {} }, { canShare() { throw new Error(); }, share() {} }]) {
    const p = props("pdf"), h = harness(nav), tree = h.render(p);
    assert.equal(nodes(tree, "a")[0].props.download, p.prepared.file.name);
    assert.equal(text(nodes(tree, "a")[0]), "ファイルをダウンロード");
    nodes(tree, "button")[0].props.onClick();
    assert.deepEqual(h.opened.map(x => ({ ...x })), [{ url: "https://fixture.invalid/manager?store_id=fixture-store", external: true }]);
    assert.deepEqual(h.revoked, []);
  }
});
