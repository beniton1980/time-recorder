import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("attendance screen explains soft GPS without labeling staff as fraudulent", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  assert.match(page, /位置情報は距離確認に使用します/);
  assert.match(page, /取得できなくても打刻できます/);
  assert.match(page, /不正の断定ではなく、確認の目安/);
  assert.doesNotMatch(page, /位置情報を許可しないと打刻できません/);
});

test("GPS details stay collapsed below the primary punch actions", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  const actions = page.indexOf('className="punch-actions"');
  const details = page.indexOf('<details className="location-guide">');
  assert.ok(actions >= 0 && details > actions);
  assert.match(page, /<details className="location-guide">[\s\S]*<summary>/);
  assert.doesNotMatch(page, /<details className="location-guide" open>/);
});
