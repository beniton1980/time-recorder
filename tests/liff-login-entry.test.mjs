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
  initError = false, loginError = false, liffId} = {}) {
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
    "./correction-history": {default: () => null},
    "@/lib/punch-location.mjs": {},
    "@/lib/punch-performance.mjs": {measurePunchStage: (_stage, task) => task()},
    "@/lib/attendance-request": {withAttendanceDeadline: task => task(new AbortController().signal)},
    "@/lib/attendance-operation": {readPendingOperation: () => null, tabOperationStorage: () => null},
    "@/lib/correction-validation": loadTs("lib/correction-validation.ts"),
  };
  const component = loadTs(path, modules, {
    URL,
    process: {env: {NEXT_PUBLIC_ATTENDANCE_LIFF_ID: liffId}},
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

const loginButton = s => nodes(s.render(), "button").find(button => text(button) === "このブラウザーで続ける");
const appLink = s => nodes(s.render(), "a").find(link => text(link) === "LINEで開く");

for (const [liffId, expected] of [[undefined, "2010761826-6FNSE1PD"], ["fixture-preview-liff", "fixture-preview-liff"]]) {
  test(`external entry offers a direct ${liffId ? "preview" : "production"} LINE link without starting web login`, async () => {
    const storeToken = "fixture-token-with-special +/?=&";
    const params = new URLSearchParams({store_token: storeToken, entry: "manager", redirect_uri: "https://untrusted.example", id_token: "drop"});
    const s = screen({href: `https://fixture.example/?${params}#drop`, liffId}); await s.start();
    const link = appLink(s);
    const url = new URL(link.props.href);
    assert.equal(url.origin, "https://liff.line.me");
    assert.equal(url.pathname, `/${expected}`);
    assert.deepEqual([...url.searchParams], [["store_token", storeToken]]);
    assert.equal(url.hash, "");
    assert.equal(link.props.onClick, undefined, "native navigation must not be replaced by SDK or asynchronous JS");
    assert.equal(link.props.target, undefined, "open in the current context");
    assert.equal(link.props.rel, "noreferrer");
    assert.equal(s.calls.login.length, 0);
    assert.equal(s.calls.requests.length, 0);
    const help = nodes(s.render(), "details").find(n => n.props.className === "line-login-help");
    assert.notEqual(help.props.open, true, "keep the main action unambiguous");
    assert.ok(nodes(help, "button").some(n => text(n) === "このブラウザーで続ける"));
    assert.equal(appLink(s).props.href, link.props.href, "a blocked app launch still has a usable link on re-render");
  });
}

test("external staff entry waits for init and browser fallback starts login synchronously on tap", async () => {
  const href = "https://fixture.example/?store_token=fixture-store-token";
  const s = screen({href, delayedInit: true});
  await s.start();
  assert.equal(loginButton(s), undefined);
  assert.equal(appLink(s), undefined);
  assert.equal(s.calls.login.length, 0);
  s.releaseInit(); await settle();
  assert.equal(s.calls.login.length, 0, "initialization must not automatically redirect to login");
  assert.equal(s.calls.requests.length, 0, "unauthenticated entry must not call staff APIs");
  loginButton(s).props.onClick();
  assert.equal(s.calls.login.length, 1, "login must start in the tap without awaiting another task");
  assert.equal(s.calls.login[0].redirectUri, "https://fixture.example/liff-entry?store_token=fixture-store-token",
    "return inside the production LIFF endpoint while retaining the original store QR");
  assert.equal(loginButton(s).props.disabled, undefined, "a blocked navigation must not leave a disabled button");
});

test("LINE login returns through liff-entry once and bootstraps only the original store QR", async () => {
  const storeToken = "fixture-token-with-special +/?=";
  const origin = "https://fixture.example";
  const params = new URLSearchParams({store_token: storeToken, entry: "manager", untrusted: "drop"});
  const before = screen({href: `${origin}/?${params}#drop`}); await before.start();
  loginButton(before).props.onClick();
  assert.equal(before.calls.login.length, 1);
  assert.equal(before.calls.requests.length, 0);
  const redirectUri = before.calls.login[0].redirectUri;
  const returnUrl = new URL(redirectUri);
  assert.equal(returnUrl.origin, origin);
  assert.equal(returnUrl.pathname, "/liff-entry", "the root URL is outside the production LIFF endpoint");
  assert.deepEqual([...returnUrl.searchParams], [["store_token", storeToken]], "do not forward unrelated entry routes or parameters");
  assert.equal(returnUrl.hash, "");

  const entry = screen({path: "app/liff-entry/page.tsx", loggedIn: true, href: redirectUri}); await entry.start();
  assert.equal(entry.calls.init.length, 1, "complete OAuth initialization before leaving the entry endpoint");
  assert.equal(entry.calls.login.length, 0);
  assert.equal(entry.calls.replace.length, 1);
  assert.equal(entry.calls.replace[0], `/?${new URLSearchParams({store_token: storeToken})}`);

  const s = screen({loggedIn: true, href: new URL(entry.calls.replace[0], origin).toString()}); await s.start();
  assert.equal(s.calls.init.length, 1);
  assert.equal(s.calls.login.length, 0);
  assert.equal(s.calls.requests.length, 1);
  assert.equal(s.calls.requests[0].url, "/api/session/bootstrap");
  assert.deepEqual(s.calls.requests[0].body, {idToken: "fixture-id-token", storeToken});
  assert.match(text(s.render()), /Fixture Storeへ初回登録/);
});

test("unauthenticated LIFF browser shows reopening guidance without calling liff.login", async () => {
  const s = screen({inClient: true}); await s.start();
  assert.equal(loginButton(s), undefined);
  assert.equal(appLink(s), undefined);
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
    assert.equal(appLink(s), undefined);
    assert.equal(s.calls.login.length, 0);
    assert.equal(s.calls.requests.length, 0);
    assert.doesNotMatch(text(s.render()), /fixture private error/);
  }
  const s = screen({delayedInit: true}); await s.start();
  s.unmount(); s.releaseInit(); await settle();
  assert.equal(loginButton(s), undefined);
  assert.equal(appLink(s), undefined);
  assert.equal(s.calls.login.length, 0);
  assert.equal(s.calls.requests.length, 0);
});

test("login launch failure keeps a retry and does not expose SDK error details", async () => {
  const s = screen({loginError: true}); await s.start();
  loginButton(s).props.onClick();
  assert.match(text(s.render()), /ログイン画面を開けませんでした/);
  assert.doesNotMatch(text(s.render()), /fixture private error/);
  assert.equal(new URL(appLink(s).props.href).searchParams.get("store_token"), "fixture-store-token");
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
