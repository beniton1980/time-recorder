import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("server logs expose only allowlisted structured fields", async () => {
  const logger = await read("lib/safe-log.ts");
  assert.match(logger, /type SafeLogFields/);
  assert.doesNotMatch(logger, /token|latitude|longitude|legalName|storeId|requestId|stack|message/i);

  const apiRoot = new URL("../app/api/", import.meta.url);
  const routeFiles = await readdir(apiRoot, { recursive: true });
  const routes = routeFiles
    .filter((path) => path.endsWith("route.ts"))
    .map((path) => `app/api/${path.replaceAll("\\", "/")}`);
  for (const route of routes) {
    const source = await read(route);
    assert.doesNotMatch(source, /console\.(?:error|log|warn|info)/, route);
  }
});

test("CI installs exactly from the committed npm lockfile", async () => {
  const workflow = await read(".github/workflows/attendance-regression.yml");
  const lockfile = JSON.parse(await read("package-lock.json"));
  assert.match(workflow, /actions\/checkout@v6/);
  assert.match(workflow, /actions\/setup-node@v6/);
  assert.match(workflow, /cache: npm/);
  assert.match(workflow, /run: npm ci/);
  assert.doesNotMatch(workflow, /run: npm install/);
  assert.equal(lockfile.lockfileVersion, 3);
});
