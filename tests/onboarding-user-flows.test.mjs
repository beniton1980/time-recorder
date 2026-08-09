import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const applyPath = new URL("../app/onboarding/apply/page.tsx", import.meta.url);
const operatorPath = new URL("../app/operator/onboarding/page.tsx", import.meta.url);
const invitePath = new URL("../app/onboarding/invite/page.tsx", import.meta.url);

test("application screen submits the validated onboarding fields with an idempotency key", async () => {
  const source = await readFile(applyPath, "utf8");
  assert.match(source, /crypto\.randomUUID\(\)/);
  assert.match(source, /\/api\/onboarding\/requests/);
  assert.match(source, /businessDayStartMinute/);
  assert.match(source, /termsAccepted: form\.termsAccepted/);
});

test("operator screen keeps approval and provisioning as separate confirmed actions", async () => {
  const source = await readFile(operatorPath, "utf8");
  assert.match(source, /requests\/decision/);
  assert.match(source, /requests\/provision/);
  assert.match(source, /window\.confirm\(item\.store_name \+ "の申請を"/);
  assert.match(source, /window\.confirm\(item\.store_name \+ "を作成し、管理者招待を発行しますか？"/);
  assert.match(source, /7日間有効・一度だけ利用可能/);
});

test("manager invite is claimed only after an explicit user action", async () => {
  const source = await readFile(invitePath, "utf8");
  assert.match(source, /async function claim\(\)/);
  assert.match(source, /onClick=\{\(\)=>void claim\(\)\}/);
  assert.match(source, /manager-invite\/claim/);
  assert.match(source, /MANAGER_INVITE_INVALID/);
  assert.doesNotMatch(source, /void claim\(\);/);
});
