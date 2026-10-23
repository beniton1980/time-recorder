import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import * as jsxRuntime from "react/jsx-runtime";
import { loadTs } from "./helpers/load-ts.mjs";

const datetime = loadTs("lib/manager-correction-datetime.ts");
const validation = loadTs("lib/correction-validation.ts");
const attendanceReturn = loadTs("lib/manager-attendance-return.ts");
const pages = [
  ["app/manager/page.tsx", "/manager"],
  ["app/manager/staff-attendance/page.tsx", "/manager/staff-attendance"],
  ["app/manager/staff-attendance/edit/page.tsx", "/manager/staff-attendance/edit"],
];

async function start(page, path, env, seededStates = {}) {
  const effects = [], inits = [], logins = [], requests = [], redirects = [];
  let stateIndex = 0;
  const search = "?store_id=fixture-store&staff_id=fixture-staff&month=2026-04&date=2026-04-30";
  const href = `https://fixture.invalid${path}${search}`;
  const component = loadTs(page, {
    "react/jsx-runtime": jsxRuntime,
    "@/lib/consultation": loadTs("lib/consultation.ts"),
    "@/lib/attendance-request": { withAttendanceDeadline: fn => fn(new AbortController().signal) },
    "./consultation-history": { default: () => null },
    react: {
      useState(initial) {
        const index = stateIndex++;
        const value = index in seededStates ? seededStates[index] : typeof initial === "function" ? initial() : initial;
        return [value, () => {}];
      },
      useEffect: fn => effects.push(fn),
      useCallback: fn => fn,
      useMemo: fn => fn(),
      useRef: value => ({ current: value }),
      useSyncExternalStore: () => search,
    },
    "@line/liff": { default: {
      init: async options => { inits.push(options); },
      isLoggedIn: () => false,
      login: options => { logins.push(options); },
    } },
    "@/lib/manager-correction-datetime": datetime,
    "@/lib/correction-validation": validation,
    "@/lib/manager-attendance-return": attendanceReturn,
    "@/lib/manager-attendance-display": loadTs("lib/manager-attendance-display.ts"),
    "./manager.module.css": { default: {} },
    "./past-monthly-report": { default: () => null },
    "./report-file": { default: () => null, useReportFile: () => ({ prepared: null, clear() {} }) },
    "./staff-attendance.module.css": { default: {} },
    "./edit.module.css": { default: {} },
  }, {
    process: { env },
    window: { location: { href, search, replace: value => redirects.push(value) } },
    fetch: (...args) => { requests.push(args); throw new Error("Unexpected unauthenticated request"); },
  });
  const tree = component.default();
  const cleanups = effects.map(effect => effect());
  await new Promise(resolve => setImmediate(resolve));
  cleanups.forEach(cleanup => { if (typeof cleanup === "function") cleanup(); });
  return { inits, logins, requests, redirects, href, tree };
}

function nodes(tree, type) {
  if (!tree || typeof tree !== "object") return [];
  if (Array.isArray(tree)) return tree.flatMap(item => nodes(item, type));
  return [...(tree.type === type ? [tree] : []), ...nodes(tree.props?.children, type)];
}
const text = tree => typeof tree === "string" || typeof tree === "number" ? String(tree) : Array.isArray(tree) ? tree.map(text).join("") : tree?.props ? text(tree.props.children) : "";
const previewEnv = { NEXT_PUBLIC_MANAGER_LIFF_ID: "2010761826-fixture-manager" };
const manager = { legal_name: "架空管理者", store_id: "fixture-store", store_name: "架空店舗", store_latitude: null, store_longitude: null, monthly_report_email: null };
const dashboard = { manager, attendance: [], corrections: [], staffMemberships: [], coManagers: [], businessDate: "2026-04-30" };

test("Preview retains review and attendance before enhancement, hiding unrelated manager tools", async () => {
  const css = readFileSync(new URL("../app/manager/renewal.css", import.meta.url), "utf8");
  assert.match(css, /main\[data-manager-attendance-preview="true"\] > section > header > a,[\s\S]*?main\[data-manager-attendance-preview="true"\] > section > section:not\(\[data-dashboard-key="attendance"\]\):not\(\[data-dashboard-key="review"\]\)\s*\{\s*display: none !important;/);
  const enhancer = readFileSync(new URL("../app/manager/ManagerDashboardEnhancer.tsx", import.meta.url), "utf8");
  assert.match(enhancer, /querySelector<HTMLAnchorElement>\('a\[href\*="\/manager\/qr"\]'\)/, "the hidden QR anchor remains the poster store context source");
  for (const [env, preview] of [[{}, false], [previewEnv, true]]) {
    const result = await start(...pages[0], env, { 0: dashboard, 24: { legalName: "架空共同管理者", storeName: "架空店舗" } });
    const main = nodes(result.tree, "main")[0];
    assert.equal(main.props["data-manager-attendance-preview"], preview ? "true" : undefined);
    const qr = nodes(result.tree, "a").find(item => item.props.href.includes("/manager/qr"));
    assert.ok(qr, "keep the anchor in the DOM even in Preview");
    assert.equal(new URL(qr.props.href).searchParams.get("store_id"), "fixture-store");
    assert.equal(qr.props.hidden, preview);
    const share = nodes(result.tree, "button").filter(item => text(item) === "LINEで案内を共有");
    assert.equal(share.length, preview ? 0 : 1);
    assert.equal(text(result.tree).includes("検証用の管理画面です。"), preview);
  }
});

test("Preview review contains pending checkout decisions and the existing consultation route", async () => {
  const common = { legal_name: "架空スタッフ", requested_at: "2026-10-21T01:00:00Z", day_events: [] };
  const result = await start(...pages[0], previewEnv, { 0: { ...dashboard, corrections: [
    { ...common, id: "checkout-request", operation: "ADD", requested_event_type: "CHECK_OUT", requested_occurred_at: "2026-10-20T10:00:00Z" },
    { ...common, id: "consultation-request", operation: "REVIEW" },
  ] } });
  const review = nodes(result.tree, "section").find(node => node.props["data-dashboard-key"] === "review");
  assert.ok(review, "review is classified before client enhancement so Preview CSS can display it");
  assert.match(text(review), /未処理の訂正申請2件/);
  assert.match(text(review), /打刻漏れを追加：.*退勤/);
  assert.ok(nodes(review, "button").some(node => text(node) === "承認" && !node.props.disabled));
  assert.ok(nodes(review, "button").some(node => text(node) === "却下" && !node.props.disabled));
  const consultation = nodes(review, "a").find(node => text(node) === "相談内容・対象の打刻を確認");
  const target = new URL(consultation.props.href, "https://fixture.invalid");
  assert.equal(target.pathname, "/manager/consultations");
  assert.equal(target.searchParams.get("store_id"), "fixture-store");
  assert.equal(target.searchParams.get("id"), "consultation-request");
});

test("Preview attendance and edit screens retain only local navigation and identify the test environment", async () => {
  const staff = { id: "fixture-staff", legalName: "架空スタッフ" };
  const monthly = { staff, staffOptions: [], store: { id: "fixture-store", name: "架空店舗" }, month: "2026-04",
    period: { start: "2026-04-30", end: "2026-04-30", displayThrough: "2026-04-30" },
    summary: { workDays: 0, workDuration: "00:00", breakDuration: "00:00", issueDays: 0 }, days: [] };
  const attendance = await start(...pages[1], previewEnv, { 0: monthly, 1: "" });
  const links = nodes(attendance.tree, "a").map(item => item.props.href);
  assert.ok(links.includes("/manager"));
  assert.ok(links.some(href => href.startsWith("/manager/staff-attendance/edit?")));
  assert.ok(links.every(href => href === "/manager" || href.startsWith("/manager/staff-attendance/edit?")));
  assert.match(text(attendance.tree), /検証用の勤怠画面です/);
  const editing = await start(...pages[2], previewEnv, { 0: { staff, store: { id: "fixture-store" }, events: [] } });
  assert.equal(nodes(editing.tree, "a").length, 0);
  nodes(editing.tree, "button").find(item => text(item) === "← 個人勤怠へ戻る").props.onClick();
  assert.ok(editing.redirects[0].startsWith("/manager/staff-attendance?"));
  assert.match(text(editing.tree), /検証用の勤怠画面です/);
});

for (const [name, env, expected] of [
  ["production default", {}, "2010761826-6FNSE1PD"],
  ["empty override", { NEXT_PUBLIC_MANAGER_LIFF_ID: "" }, "2010761826-6FNSE1PD"],
  ["manager Preview", { NEXT_PUBLIC_MANAGER_LIFF_ID: "2010761826-fixture-manager", NEXT_PUBLIC_ATTENDANCE_LIFF_ID: "2010761826-fixture-staff" }, "2010761826-fixture-manager"],
  ["staff-only Preview setting", { NEXT_PUBLIC_ATTENDANCE_LIFF_ID: "2010761826-fixture-staff" }, "2010761826-6FNSE1PD"],
]) {
  test(`all manager attendance screens use the ${name} without bypassing login`, async () => {
    for (const [page, path] of pages) {
      const result = await start(page, path, env);
      assert.deepEqual(result.inits.map(options => options.liffId), [expected], page);
      assert.deepEqual(result.logins.map(options => options.redirectUri), [result.href], "login returns to the current Preview path");
      assert.equal(result.requests.length, 0, "no manager API request before LINE login");
    }
  });
}
