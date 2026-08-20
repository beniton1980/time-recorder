import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const sensitiveLogPayload = /\b(?:accessToken|accuracy|apiKey|authorization|body|clientAccuracy|clientLatitude|clientLongitude|contactEmail|contact_email|cronSecret|databaseUrl|distance|email|error|idToken|identity|inviteToken|inviteTokenHash|latitude|legalName|legal_name|lineIdentity|lineUserId|line_user_id|longitude|managerLegalName|manager_legal_name|message|operator|rawStoreToken|rawToken|recipient|requestId|resend|stack|storeId|storeToken|storeTokenHash|tokenHash)\b/i;
const hardcodedSensitiveValues = [
  [/postgres(?:ql)?:\/\/[^/'"\s]+:[^@/'"\s]+@/i, "database connection string"],
  [/\b(?:re|sk|ghp|github_pat)_[A-Za-z0-9_-]{20,}\b/, "API token"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, "JWT"],
  [/\bU[0-9a-f]{32}\b/i, "LINE user ID"],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/, "cloud access key"],
];

function extractCallArguments(source, functionPattern) {
  const calls = [];
  const matcher = new RegExp(`\\b(?:${functionPattern})\\s*\\(`, "g");
  for (const match of source.matchAll(matcher)) {
    const start = match.index + match[0].length;
    let depth = 1;
    let quote = null;
    let escaped = false;
    for (let index = start; index < source.length; index += 1) {
      const character = source[index];
      if (quote) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === quote) quote = null;
        continue;
      }
      if (character === '"' || character === "'" || character === "`") {
        quote = character;
      } else if (character === "(") {
        depth += 1;
      } else if (character === ")") {
        depth -= 1;
        if (depth === 0) {
          calls.push(source.slice(start, index));
          break;
        }
      }
    }
  }
  return calls;
}

function payloadAfterEvent(argumentsSource) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = 0; index < argumentsSource.length; index += 1) {
    const character = argumentsSource[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") quote = character;
    else if ("({[".includes(character)) depth += 1;
    else if (")}]".includes(character)) depth -= 1;
    else if (character === "," && depth === 0) return argumentsSource.slice(index + 1);
  }
  return "";
}

function findSensitiveLogging(path, source) {
  const violations = [];
  if (/console\.(?:debug|error|info|log|trace|warn)\s*\(/.test(source)) {
    violations.push(`${path}: direct console logging is prohibited`);
  }
  for (const call of extractCallArguments(source, "logServerError|logServerInfo")) {
    if (!/^\s*["'][a-z0-9_]+["']\s*(?:,|$)/.test(call)) {
      violations.push(`${path}: log event must be a fixed code`);
    }
    const payload = payloadAfterEvent(call);
    if (sensitiveLogPayload.test(payload) || /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/.test(payload)) {
      violations.push(`${path}: sensitive value passed to logger`);
    }
  }
  return violations;
}

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

test("logging calls and runtime source reject PII, tokens, and hardcoded secrets", async () => {
  const roots = ["app/api", "lib"];
  const violations = [];
  for (const root of roots) {
    const rootUrl = new URL(`../${root}/`, import.meta.url);
    const files = await readdir(rootUrl, { recursive: true });
    for (const relativePath of files.filter((path) => /\.(?:[cm]?[jt]sx?)$/.test(path))) {
      const path = `${root}/${relativePath.replaceAll("\\", "/")}`;
      const source = await read(path);
      if (path !== "lib/safe-log.ts") violations.push(...findSensitiveLogging(path, source));
      for (const [pattern, label] of hardcodedSensitiveValues) {
        if (pattern.test(source)) violations.push(`${path}: hardcoded ${label}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("PII detector flags an unsafe logging example", () => {
  const unsafe = 'logServerError("punch_failed", { manager_legal_name, clientLatitude, contact_email: "person@example.com" });';
  assert.deepEqual(findSensitiveLogging("fixture.ts", unsafe), [
    "fixture.ts: sensitive value passed to logger",
  ]);
  assert.deepEqual(findSensitiveLogging("fixture.js", "console.debug(rawToken);"), [
    "fixture.js: direct console logging is prohibited",
  ]);
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

