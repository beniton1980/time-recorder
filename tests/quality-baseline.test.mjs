import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("clock initialization remains hydration-safe and cleans up both timers", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  assert.match(page, /window\.setTimeout\(updateClock, 0\)/);
  assert.match(page, /window\.clearTimeout\(initialTimer\)/);
  assert.match(page, /window\.clearInterval\(timer\)/);
  assert.doesNotMatch(page, /useEffect\(\(\) => \{\s*setNow\(new Date\(\)\)/);
});
