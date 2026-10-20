import assert from "node:assert/strict";
import { test } from "node:test";
import * as jsxRuntime from "react/jsx-runtime";
import * as periods from "../lib/payroll-default-period.mjs";
import { loadTs } from "./helpers/load-ts.mjs";

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
const ReportFileMock = () => null;
const text = tree => typeof tree === "string" || typeof tree === "number" ? String(tree) : Array.isArray(tree) ? tree.map(text).join("") : tree?.props ? text(tree.props.children) : "";
function nodes(tree, type) {
  if (!tree || typeof tree !== "object") return [];
  if (Array.isArray(tree)) return tree.flatMap(item => nodes(item, type));
  return [...(tree.type === type ? [tree] : []), ...nodes(tree.props?.children, type)];
}
function screen() {
  const slots = [], calls = [], working = [], confirmations = [];
  let prepared = null;
  let index = 0, cleanup, monthResponse = async body => ({ ok: true, reportMonth: body.reportMonth, closingRule: "day_25", today: "2026-10-14", reports: [] });
  let actionResponse = async () => ({ ok: true, blob: async () => new Blob(["fixture"]), json: async () => ({ status: "SENT" }) });
  const component = loadTs("app/manager/past-monthly-report.tsx", {
    "react/jsx-runtime": jsxRuntime,
    react: {
      useState(initial) { const i = index++; if (!(i in slots)) slots[i] = initial; return [slots[i], value => { slots[i] = value; }]; },
      useRef(initial) { const i = index++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
      useEffect(fn) { if (!cleanup) cleanup = fn(); },
    },
    "@line/liff": { default: { getIDToken: () => "fixture" } },
    "@/lib/payroll-default-period.mjs": periods,
    "./manager.module.css": { default: {} },
    "./report-file": { default: ReportFileMock, useReportFile: () => ({
      prepared, clear: () => { prepared = null; },
      prepare: (blob, name, format) => { prepared = { blob, name, format, url: "blob:fixture" }; },
    }) },
  }, {
    window: { confirm: message => { confirmations.push(message); return true; } },
    URL: { createObjectURL: () => "blob:fixture", revokeObjectURL: () => {} },
    document: { createElement: () => ({ click() {}, remove() {} }), body: { appendChild() {} } },
    fetch: async (url, options) => {
      const body = JSON.parse(options.body); calls.push({ url, body });
      if (url.endsWith("/reports")) return { ok: true, json: () => monthResponse(body) };
      return actionResponse(body);
    },
  });
  return { calls, working, confirmations,
    render() { index = 0; return component.default({ storeId: "fixture-store", storeName: "架空店舗", recipient: "fixture@example.invalid", disabled: false, onWorkingChange: value => working.push(value), onSent: async () => {} }); },
    setMonths(fn) { monthResponse = fn; }, setAction(fn) { actionResponse = fn; }, unmount() { cleanup(); },
  };
}
const button = (s, label) => nodes(s.render(), "button").find(n => text(n) === label);
const field = (s, label) => { const row = nodes(s.render(), "label").find(n => text(n).startsWith(label)); return [...nodes(row, "input"), ...nodes(row, "select")][0]; };
const change = (s, label, value) => { field(s, label).props.onChange({ target: { value } }); return settle(); };
const click = async (s, label) => { button(s, label).props.onClick(); await settle(); };

test("monthly UI calculates closing periods, sends the displayed dates, and keeps manual dates in an optional panel", async () => {
  const s = screen();
  await change(s, "対象月", "2026-09");
  assert.match(text(s.render()), /2026\/08\/26〜2026\/09\/25/);
  assert.equal(field(s, "開始日"), undefined);
  await click(s, "PDFを取得");
  assert.equal(s.calls.at(-1).body.periodStart, "2026-08-26");
  assert.equal(s.calls.at(-1).body.periodEnd, "2026-09-25");
  assert.equal(s.confirmations.length, 0);
  change(s, "この帳票の締め日", "day_15");
  assert.match(text(s.render()), /2026\/08\/16〜2026\/09\/15/);
  await click(s, "期間を調整");
  change(s, "開始日", "2026-08-15"); // 32 inclusive days: not allowed.
  assert.equal(button(s, "PDFを取得").props.disabled, true);
  await click(s, "月単位の期間に戻す");
  assert.equal(button(s, "PDFを取得").props.disabled, false);
  change(s, "この帳票の締め日", "month_end");
  assert.match(text(s.render()), /2026\/09\/01〜2026\/09\/30/);
  await change(s, "対象月", "2024-02"); change(s, "この帳票の締め日", "month_end");
  assert.match(text(s.render()), /2024\/02\/01〜2024\/02\/29/);
  await change(s, "対象月", "2026-01");
  assert.match(text(s.render()), /2025\/12\/26〜2026\/01\/25/);
  await change(s, "対象月", "2026-10");
  assert.equal(button(s, "PDFを取得").props.disabled, true);
  assert.match(text(s.render()), /締め日の翌日から取得/);
});

test("saved periods override the current closing day and multiple periods require an explicit choice", async () => {
  const s = screen();
  const reports = [{ id: "first", period_start: "2026-08-26", period_end: "2026-09-25" }];
  s.setMonths(async body => ({ ok: true, reportMonth: body.reportMonth, closingRule: "day_15", today: "2026-10-14", reports }));
  await change(s, "対象月", "2026-09");
  assert.match(text(s.render()), /2026\/08\/26〜2026\/09\/25/);
  assert.equal(field(s, "この帳票の締め日"), undefined);
  reports.push({ id: "second", period_start: "2026-08-16", period_end: "2026-09-15" });
  await change(s, "対象月", "2026-09");
  assert.equal(button(s, "PDFを取得").props.disabled, true);
  change(s, "送信済みの期間", "second");
  await click(s, "補助CSVを取得");
  assert.equal(s.calls.at(-1).body.periodStart, "2026-08-16");
  assert.equal(s.calls.at(-1).body.periodEnd, "2026-09-15");
});

test("failed and stale month lookups never enable a guessed period, and unmounted lookups are ignored", async () => {
  const s = screen(); let release;
  s.setMonths(body => body.reportMonth === "2026-08" ? new Promise(resolve => { release = resolve; }) : Promise.reject(new Error("fixture network")));
  const first = change(s, "対象月", "2026-08"); await settle();
  await change(s, "対象月", "2026-09");
  release({ ok: true, reportMonth: "2026-08", closingRule: "day_25", today: "2026-10-14", reports: [] }); await first; await settle();
  assert.equal(field(s, "対象月").props.value, "2026-09");
  assert.equal(button(s, "PDFを取得").props.disabled, true);
  assert.match(text(s.render()), /送信履歴を確認できませんでした/);
  s.setMonths(async body => ({ ok: true, reportMonth: body.reportMonth, closingRule: "month_end", today: "2026-10-14", reports: [] }));
  await click(s, "この月を再確認");
  assert.match(text(s.render()), /2026\/09\/01〜2026\/09\/30/);
  s.setMonths(() => new Promise(resolve => { release = resolve; }));
  const last = change(s, "対象月", "2026-08"); await settle(); s.unmount();
  release({ ok: true, reportMonth: "2026-08", closingRule: "day_25", today: "2026-10-14", reports: [] }); await last; await settle();
  assert.equal(button(s, "PDFを取得").props.disabled, true);
});

test("response loss retains the chosen month and period while duplicate clicks share one in-flight action", async () => {
  const s = screen(); await change(s, "対象月", "2026-09"); let release;
  s.setAction(() => new Promise(resolve => { release = resolve; }));
  const send = button(s, "この期間をメール送信"); send.props.onClick(); send.props.onClick(); await settle();
  assert.equal(s.calls.filter(c => c.url.endsWith("/period")).length, 1);
  assert.equal(field(s, "対象月").props.disabled, true);
  assert.match(s.confirmations[0], /2026\/08\/26〜2026\/09\/25/);
  release({ ok: true, json: async () => { throw new Error("response lost"); } }); await settle();
  assert.match(text(s.render()), /送信結果を確認できませんでした/);
  assert.equal(field(s, "対象月").props.value, "2026-09");
  assert.match(text(s.render()), /2026\/08\/26〜2026\/09\/25/);
  assert.deepEqual(s.working, [true, false]);
  s.setAction(async () => ({ ok: true, json: async () => ({ status: "ALREADY_SENT" }) }));
  await click(s, "この期間をメール送信");
  assert.match(text(s.render()), /初回送信済みです/);
});

test("files require an explicit save step, and period changes or failed retrievals discard old files", async () => {
  const s = screen();
  const file = () => nodes(s.render(), ReportFileMock)[0]?.props.prepared;
  await change(s, "対象月", "2026-09"); await click(s, "PDFを取得");
  assert.equal(file().name, "架空店舗-2026-08-26-2026-09-25-勤怠.pdf");
  assert.equal(file().format, "pdf");
  assert.doesNotMatch(text(s.render()), /ダウンロードをご確認|保存しました/);
  await change(s, "この帳票の締め日", "day_15"); assert.equal(file(), undefined);
  await click(s, "補助CSVを取得"); assert.equal(file().format, "csv");
  await click(s, "期間を調整"); assert.equal(file(), undefined);
  await click(s, "PDFを取得"); await change(s, "開始日", "2026-08-17"); assert.equal(file(), undefined);
  await click(s, "PDFを取得"); await change(s, "終了日", "2026-09-14"); assert.equal(file(), undefined);
  await click(s, "PDFを取得"); await change(s, "対象月", "2026-08"); assert.equal(file(), undefined);
  await click(s, "PDFを取得");
  s.setAction(async () => { throw new Error("offline"); });
  await click(s, "補助CSVを取得"); assert.equal(file(), undefined);
  assert.match(text(s.render()), /帳票を取得できませんでした/);
  assert.equal(s.calls.some(call => call.body.action === "send"), false);
});

test("a response arriving after leaving the store cannot prepare a file", async () => {
  const s = screen(); await change(s, "対象月", "2026-09"); let release;
  s.setAction(() => new Promise(resolve => { release = resolve; }));
  button(s, "PDFを取得").props.onClick(); await settle(); s.unmount();
  release({ ok: true, blob: async () => new Blob(["late"]) }); await settle();
  assert.equal(nodes(s.render(), ReportFileMock).length, 0);
});
