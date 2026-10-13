import assert from "node:assert/strict";
import test from "node:test";
import * as jsxRuntime from "react/jsx-runtime";
import { loadTs } from "./helpers/load-ts.mjs";

const datetime = loadTs("lib/manager-correction-datetime.ts");
const settle = () => new Promise(resolve => setImmediate(resolve));
function nodes(tree, type) {
  if (!tree || typeof tree !== "object") return [];
  if (Array.isArray(tree)) return tree.flatMap(item => nodes(item, type));
  return [...(tree.type === type ? [tree] : []), ...nodes(tree.props?.children, type)];
}
const text = tree => typeof tree === "string" ? tree : Array.isArray(tree) ? tree.map(text).join("") : tree?.props ? text(tree.props.children) : "";
const button = (screen, label) => nodes(screen.render(), "button").find(item => text(item) === label);
function screen(businessDate = "2026-04-30", occurredAt = "2026-05-01T02:00:00+09:00") {
  const event = { effectiveId: "fixture-event", businessDate, eventType: "CHECK_OUT", occurredAt, corrected: false };
  const states = [
    { ok: true, store: { id: "fixture-store", name: "架空店舗" }, staff: { id: "fixture-staff", legalName: "架空スタッフ" }, month: businessDate.slice(0, 7), events: [event] },
  ];
  const calls = [], redirects = [];
  let index = 0, result = { ok: true }, status = 200;
  const component = loadTs("app/manager/staff-attendance/edit/page.tsx", {
    "react/jsx-runtime": jsxRuntime,
    react: {
      useState(initial) { const i = index++; if (!(i in states)) states[i] = initial; return [states[i], value => { states[i] = typeof value === "function" ? value(states[i]) : value; }]; },
      useEffect() {}, useMemo: fn => fn(), useRef: value => ({ current: value }),
      useSyncExternalStore: () => `?store_id=fixture-store&staff_id=fixture-staff&date=${businessDate}`,
    },
    "@line/liff": { default: { getIDToken: () => "fixture-identity" } },
    "@/lib/manager-correction-datetime": datetime,
    "./edit.module.css": { default: {} },
  }, {
    HTMLElement: class {}, document: { activeElement: null },
    window: { requestAnimationFrame: fn => fn(), location: { replace: url => redirects.push(url) } },
    fetch: async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return { ok: status < 400, json: async () => result }; },
  });
  return { calls, redirects, render() { index = 0; return component.default(); }, respond(value, code = 200) { result = value; status = code; } };
}
const input = (s, type) => nodes(s.render(), "input").find(item => item.props.type === type);
function reason(s, value) { nodes(s.render(), "select").at(-1).props.onChange({ target: { value } }); }

for (const [businessDate, occurredAt, expectedDate] of [
  ["2026-04-30", "2026-04-30T17:00:00Z", "2026-05-01"],
  ["2025-12-31", "2025-12-31T15:00:00Z", "2026-01-01"],
  ["2026-04-30", "2026-04-30T05:00:00Z", "2026-04-30"],
]) {
  test(`editing ${occurredAt} uses the actual JST date, including month/year rollover`, async () => {
    const s = screen(businessDate, occurredAt);
    button(s, "変更").props.onClick();
    assert.equal(input(s, "date").props.value, expectedDate);
    reason(s, "打刻時刻の誤り");
    button(s, "修正内容を確認").props.onClick();
    await button(s, "この内容で確定").props.onClick(); await settle();
    assert.equal(s.calls.length, 1);
    assert.equal(s.calls[0].body.occurredAt, new Date(occurredAt).toISOString(), "opening and confirming must not subtract a day");
    assert.equal(new URL(s.redirects[0], "https://fixture.invalid").searchParams.get("month"), businessDate.slice(0, 7), "return to the attendance month being reviewed");
  });
}

test("future rejection keeps the manager's inputs and allows a corrected retry", async () => {
  const s = screen();
  button(s, "変更").props.onClick();
  input(s, "date").props.onChange({ target: { value: "2099-05-01" } });
  input(s, "time").props.onChange({ target: { value: "02:10" } });
  reason(s, "打刻時刻の誤り");
  button(s, "修正内容を確認").props.onClick();
  s.respond({ ok: false, code: "OCCURRED_AT_IN_FUTURE" }, 400);
  await button(s, "この内容で確定").props.onClick(); await settle();
  assert.match(text(s.render()), /未来の日時には修正できません/);
  assert.equal(s.redirects.length, 0);
  button(s, "戻って修正").props.onClick();
  assert.equal(input(s, "date").props.value, "2099-05-01");
  assert.equal(input(s, "time").props.value, "02:10");
  assert.equal(nodes(s.render(), "select").at(-1).props.value, "打刻時刻の誤り");
  input(s, "date").props.onChange({ target: { value: "2026-05-01" } });
  button(s, "修正内容を確認").props.onClick();
  s.respond({ ok: true });
  await button(s, "この内容で確定").props.onClick(); await settle();
  assert.equal(s.calls[1].body.occurredAt, "2026-04-30T17:10:00.000Z");
  assert.equal(s.redirects.length, 1);
});

test("void shows the actual target date without editable date/time or a replacement timestamp", async () => {
  const s = screen();
  button(s, "取消").props.onClick();
  assert.equal(nodes(s.render(), "input").length, 0);
  assert.match(text(s.render()), /取り消す打刻：2026\/5\/1.*02:00/);
  reason(s, "誤打刻");
  button(s, "修正内容を確認").props.onClick();
  await button(s, "この内容で確定").props.onClick(); await settle();
  assert.equal(s.calls[0].body.operation, "VOID");
  assert.equal(s.calls[0].body.targetEffectiveId, "fixture-event");
  assert.equal("occurredAt" in s.calls[0].body, false);
});

test("date/time conversion uses Japan time independent of the device timezone", () => {
  const original = process.env.TZ;
  try {
    for (const zone of ["UTC", "America/Los_Angeles", "Asia/Tokyo"]) {
      process.env.TZ = zone;
      const parts = datetime.managerCorrectionInputParts("2025-12-31T15:00:00Z");
      assert.equal(parts.date, "2026-01-01");
      assert.equal(parts.time, "00:00");
      assert.equal(datetime.managerCorrectionTimestamp(parts.date, parts.time), "2025-12-31T15:00:00.000Z");
    }
  } finally { if (original === undefined) delete process.env.TZ; else process.env.TZ = original; }
});

test("a missing date is explained before submission", () => {
  const s = screen(); button(s, "打刻を追加").props.onClick();
  nodes(s.render(), "select")[0].props.onChange({ target: { value: "CHECK_IN" } });
  input(s, "date").props.onChange({ target: { value: "" } });
  input(s, "time").props.onChange({ target: { value: "09:00" } });
  button(s, "修正内容を確認").props.onClick();
  assert.match(text(s.render()), /打刻種類・日付・時刻を入力してください/);
  assert.equal(s.calls.length, 0);
});
