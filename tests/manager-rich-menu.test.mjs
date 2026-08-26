import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const menuSource = fs.readFileSync("lib/line/manager-rich-menu.ts", "utf8");
const sessionSource = fs.readFileSync("app/api/manager/session/route.ts", "utf8");
const envExample = fs.readFileSync(".env.example", "utf8");

const managerAccessCheckIndex = sessionSource.indexOf("if (memberships.length === 0)");
const richMenuSyncIndex = sessionSource.indexOf("ensureManagerRichMenuLinked(identity.sub)");

test("manager rich menu uses the two approved LIFF destinations", () => {
  assert.match(menuSource, /2010761826-6FNSE1PD/);
  assert.match(menuSource, /\/manager`/);
  assert.match(menuSource, /\/manager\/clock-poster`/);
  assert.match(menuSource, /label: "管理画面"/);
  assert.match(menuSource, /label: "打刻用掲示"/);
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
