import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const menuSource = fs.readFileSync("lib/line/manager-rich-menu.ts", "utf8");
const entrySource = fs.readFileSync("app/liff-entry/page.tsx", "utf8");
const sessionSource = fs.readFileSync("app/api/manager/session/route.ts", "utf8");
const envExample = fs.readFileSync(".env.example", "utf8");

const managerAccessCheckIndex = sessionSource.indexOf("if (memberships.length === 0)");
const richMenuSyncIndex = sessionSource.indexOf("ensureManagerRichMenuLinked(identity.sub)");

test("manager rich menu uses the LIFF base entry router", () => {
  assert.match(menuSource, /2010761826-6FNSE1PD/);
  assert.match(menuSource, /\?entry=manager/);
  assert.match(menuSource, /\?entry=clock-poster/);
  assert.match(menuSource, /onogami-manager-v2/);
  assert.match(menuSource, /label: "管理画面"/);
  assert.match(menuSource, /label: "打刻用掲示"/);
});

test("LIFF entry initializes before routing to manager destinations", () => {
  const initIndex = entrySource.indexOf("await liff.init");
  const managerIndex = entrySource.indexOf('entry === "manager"');
  const posterIndex = entrySource.indexOf('entry === "clock-poster"');
  assert.ok(initIndex >= 0, "LIFF init must exist");
  assert.ok(managerIndex > initIndex, "manager routing must follow LIFF init");
  assert.ok(posterIndex > initIndex, "poster routing must follow LIFF init");
  assert.match(entrySource, /window\.location\.replace\("\/manager"\)/);
  assert.match(entrySource, /window\.location\.replace\("\/manager\/clock-poster"\)/);
});

test("LIFF entry preserves the store token for normal punch flow", () => {
  assert.match(entrySource, /new URLSearchParams\(window\.location\.search\)/);
  assert.match(entrySource, /params\.get\("store_token"\)/);
  assert.match(entrySource, /allowed\.set\("store_token", storeToken\)/);
  assert.match(entrySource, /window\.location\.replace\(safeRootUrl\(params\)\)/);
});

test("manager rich menu is auto-selected and scoped per LINE user", () => {
  assert.match(menuSource, /selected: true/);
  assert.match(menuSource, /\/v2\/bot\/user\/\$\{encodeURIComponent\(userId\)\}\/richmenu/);
  assert.match(menuSource, /\/profile\/\$\{encodeURIComponent\(userId\)\}/);
});

test("rich menu sync only runs after manager access is confirmed", () => {
  assert.ok(managerAccessCheckIndex >= 0, "manager access guard must exist");
  assert.ok(richMenuSyncIndex > managerAccessCheckIndex, "rich menu sync must follow the access guard");
});

test("missing Messaging API token disables only rich menu sync", () => {
  assert.match(menuSource, /if \(!token\) return \{ state: "disabled" \}/);
  assert.match(envExample, /LINE_MESSAGING_CHANNEL_ACCESS_TOKEN=/);
});

test("rich menu image is committed at LINE's compact menu dimensions", () => {
  assert.match(menuSource, /width: 2500, height: 843/);
  assert.ok(fs.existsSync("public/manager-rich-menu.png"));
});
