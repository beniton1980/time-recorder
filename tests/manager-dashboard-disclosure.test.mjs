import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "./helpers/load-ts.mjs";

function dashboard(initialCount) {
  class Element {
    dataset = {};
    style = {};
    attributes = {};
    listeners = {};
    tagName = "SECTION";
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(event, listener) { this.listeners[event] = listener; }
  }
  const section = new Element();
  const row = new Element();
  const count = { textContent: `${initialCount}件` };
  const heading = { textContent: "未処理の訂正申請", parentElement: row };
  row.querySelector = selector => selector === "span" ? count : null;
  section.querySelector = selector => selector === "h2" ? heading : selector === ":scope > div:first-child" ? row : null;
  const shell = new Element();
  shell.children = [section];
  shell.querySelector = selector => selector === '[data-dashboard-key="payroll"]' ? {} : null;
  let effect, observer, frame;
  const component = loadTs("app/manager/ManagerDashboardEnhancer.tsx", {
    react: { useEffect: fn => { effect = fn; } },
    "next/navigation": { usePathname: () => "/manager" },
  }, {
    HTMLElement: Element,
    document: { querySelector: () => shell, body: {} },
    window: {
      location: { hash: "" },
      requestAnimationFrame: fn => { frame = fn; return 1; },
      cancelAnimationFrame: () => {},
    },
    MutationObserver: class {
      constructor(fn) { observer = fn; }
      observe() {}
      disconnect() {}
    },
  });
  component.default();
  effect();
  frame();
  return {
    section, row,
    update(value) { count.textContent = `${value}件`; observer(); frame(); },
    toggle() { row.listeners.click(); },
  };
}

test("approving the final request keeps the review section open through subsequent refreshes", () => {
  const d = dashboard(2);
  for (const remaining of [1, 0, 0]) {
    d.update(remaining);
    assert.equal(d.section.dataset.dashboardCollapsed, "false");
    assert.equal(d.row.attributes["aria-expanded"], "true");
  }
});

test("empty review can be opened manually and pending review can be folded without a refresh undoing it", () => {
  const d = dashboard(0);
  assert.equal(d.row.attributes["aria-expanded"], "false");
  d.toggle(); d.update(0);
  assert.equal(d.row.attributes["aria-expanded"], "true");
  d.update(1); d.toggle(); d.update(1);
  assert.equal(d.row.attributes["aria-expanded"], "false");
});

test("new requests open a previously empty review section", () => {
  const d = dashboard(0);
  d.update(1);
  assert.equal(d.row.attributes["aria-expanded"], "true");
});
