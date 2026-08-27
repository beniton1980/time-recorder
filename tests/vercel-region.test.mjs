import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Vercel functions run near the Neon Singapore database", async () => {
  const raw = await readFile(new URL("../vercel.json", import.meta.url), "utf8");
  const config = JSON.parse(raw);
  assert.deepEqual(config.regions, ["sin1"]);
  assert.ok(Array.isArray(config.crons));
  assert.equal(config.crons[0]?.path, "/api/cron/monthly-attendance");
});
