import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("attendance screen explains soft GPS without labeling staff as fraudulent", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  assert.match(page, /打刻時に店舗からの距離を確認します/);
  assert.match(page, /位置情報を取得できない場合や[\s\S]*打刻は記録されます/);
  assert.match(page, /不正の断定ではなく、確認の目安/);
  assert.doesNotMatch(page, /位置情報を許可しないと打刻できません/);
});
