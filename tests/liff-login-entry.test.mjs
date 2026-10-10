import assert from "node:assert/strict";
import test from "node:test";
import * as jsxRuntime from "react/jsx-runtime";
import {loadTs} from "./helpers/load-ts.mjs";

const settle = () => new Promise(resolve => setImmediate(resolve));
const text = node => typeof node === "string" ? node : Array.isArray(node)
  ? node.map(text).join("") : node?.props ? text(node.props.children) : "";
function nodes(node, type) {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(child => nodes(child, type));
  return [...(node.type === type ? [node] : []), ...nodes(node.props?.children, type)];
}

function screen({path = "app/page.tsx", loggedIn = false, inClient = false,
  href = "https://fixture.example/?store_token=fixture-store-token", delayedInit = false,
  initError = false, loginError = false} = {}) {
  const states = [], refs = [], effects = [], cleanups = [];
  const calls = {init: [], login: [], requests: [], replace: [], close: 0};
  let stateIndex = 0, refIndex = 0, started = false, finishInit;
  const initWait = new Promise(resolve => { finishInit = resolve; });
  const liff = {
    init: async options => {
      calls.init.push(options);
      if (delayedInit) await initWait;
      if (initError) throw new Error("fixture private error");
    },
    isLoggedIn: () => loggedIn,
    isInClient: () => inClient,
    getIDToken: () => loggedIn ? "fixture-id-token" : null,
    login: options => {
      calls.login.push(options);
      if (loginError) throw new Error("fixture private error");
    },
    closeWindow: () => { calls.close += 1; },
  };
  const modules = {
    "react/jsx-runtime": jsxRuntime,
    react: {
      useState(initial) {
        const index = stateIndex++;
        if (!(index in states)) states[index] = initial;
        return [states[index], value => { states[index] = typeof value === "function" ? value(states[index]) : value; }];
      },
      useRef(initial) { const index = refIndex++; refs[index] ??= {current: initial}; return refs[index]; },
      useEffect(effect, deps) { if (!started && deps.length === 0) effects.push(effect); },
    },
    "@line/liff": {default: liff},
    "@/lib/punch-location.mjs": {},
    "@/lib/punch-performance.mjs": {measurePunchStage: (_stage, task) => task()},
    "@/lib/attendance-request": {withAttendanceDeadline: task => task(new AbortController().signal)},
    "@/lib/attendance-operation": {readPendingOperation: () => null, tabOperationStorage: () => null},
  };
  const component = loadTs(path, modules, {
    process: {env: {}},
    window: {
      location: {href, search: new URL(href).search, replace: url => calls.replace.push(url)},
      setTimeout: () => 0, setInterval: () => 0, clearTimeout() {}, clearInterval() {}, close() {},
    },
    fetch: async (url, options) => {
      calls.requests.push({url, body: JSON.parse(options.body)});
      return {ok: true, json: async () => ({ok: true, registered: false, store: {store_name: "Fixture Store"}})};
    },
  });
  return {
    calls,
    render() { stateIndex = refIndex = 0; return component.default(); },
    async start() { this.render(); started = true; effects.forEach(effect => cleanups.push(effect())); await settle(); },
    releaseInit: finishInit,
    unmount() { cleanups.forEach(cleanup => cleanup?.()); },
  };
}

const loginButton = s => nodes(s.render(), "button").find(button => text(button) === "LINEでログイン");

test("external staff entry waits for init and starts login synchronously on the user's tap", async () => {
  const href = "https://fixture.example/?store_token=fixture-store-token";
  const s = screen({href, delayedInit: true});
  await s.start();
  assert.equal(loginButton(s), undefined);
  assert.equal(s.calls.login.length, 0);
  s.releaseInit(); await settle();
  assert.equal(s.calls.login.length, 0, "initialization must not automatically redirect to login");
  assert.equal(s.calls.requests.length, 0, "unauthenticated entry must not call staff APIs");
  loginButton(s).props.onClick();
  assert.equal(s.calls.login.length, 1, "login must start in the tap without awaiting another task");
  assert.equal(s.calls.login[0].redirectUri, href, "retain the original store QR on return");
  assert.equal(loginButton(s).props.disabled, undefined, "a blocked navigation must not leave a disabled button");
});

test("return from LINE initializes again and bootstraps the same store with the ID token", async () => {
  const s = screen({loggedIn: true}); await s.start();
  assert.equal(s.calls.init.length, 1);
  assert.equal(s.calls.login.length, 0);
  assert.equal(s.calls.requests.length, 1);
  assert.equal(s.calls.requests[0].url, "/api/session/bootstrap");
  assert.deepEqual(s.calls.requests[0].body, {idToken: "fixture-id-token", storeToken: "fixture-store-token"});
  assert.match(text(s.render()), /Fixture Storeへ初回登録/);
});

test("unauthenticated LIFF browser shows reopening guidance without calling liff.login", async () => {
  const s = screen({inClient: true}); await s.start();
  assert.equal(loginButton(s), undefined);
  assert.equal(s.calls.login.length, 0);
  assert.equal(s.calls.requests.length, 0);
  assert.match(text(s.render()), /店舗のQRコードを読み直してください/);
  nodes(s.render(), "button").find(button => text(button) === "画面を閉じる").props.onClick();
  assert.equal(s.calls.close, 1);
});

test("missing store QR, failed init and unmounted entry do not start login", async () => {
  for (const options of [{href: "https://fixture.example/"}, {initError: true}]) {
    const s = screen(options); await s.start();
    assert.equal(loginButton(s), undefined);
    assert.equal(s.calls.login.length, 0);
    assert.equal(s.calls.requests.length, 0);
    assert.doesNotMatch(text(s.render()), /fixture private error/);
  }
  const s = screen({delayedInit: true}); await s.start();
  s.unmount(); s.releaseInit(); await settle();
  assert.equal(loginButton(s), undefined);
  assert.equal(s.calls.login.length, 0);
  assert.equal(s.calls.requests.length, 0);
});

test("login launch failure keeps a retry and does not expose SDK error details", async () => {
  const s = screen({loginError: true}); await s.start();
  loginButton(s).props.onClick();
  assert.match(text(s.render()), /ログイン画面を開けませんでした/);
  assert.doesNotMatch(text(s.render()), /fixture private error/);
  loginButton(s).props.onClick();
  assert.equal(s.calls.login.length, 2);
  assert.equal(s.calls.requests.length, 0);
});

test("staff liff-entry hands off once without an extra login tap and preserves only the QR", async () => {
  const s = screen({path: "app/liff-entry/page.tsx", href: "https://fixture.example/liff-entry?store_token=fixture-store-token&untrusted=drop"});
  await s.start();
  assert.equal(s.calls.init.length, 1);
  assert.equal(s.calls.login.length, 0);
  assert.deepEqual(s.calls.replace, ["/?store_token=fixture-store-token"]);
});
