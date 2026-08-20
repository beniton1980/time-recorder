import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { evaluatePostToolUse, isApiPath } from "../.claude/hooks/posttooluse-api-checks.mjs";

const hookPath = ".claude/hooks/posttooluse-api-checks.mjs";
const projectRoot = path.resolve(".");

function hookInput(filePath) {
  return {
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    tool_input: { file_path: filePath },
  };
}

test("Claude settings registers PostToolUse only for file edits", () => {
  const settings = JSON.parse(readFileSync(".claude/settings.json", "utf8"));
  const entry = settings.hooks.PostToolUse[0];
  assert.equal(entry.matcher, "Edit|Write");
  assert.equal(entry.hooks[0].type, "command");
  assert.equal(entry.hooks[0].command, `node \"\${CLAUDE_PROJECT_DIR}/${hookPath}\"`);
  assert.equal(entry.hooks[0].timeout, 600);
});

test("API path matching excludes siblings, traversal, and non-API files", () => {
  assert.equal(isApiPath(projectRoot, path.join(projectRoot, "app", "api", "clock", "route.ts")), true);
  assert.equal(isApiPath(projectRoot, path.join(projectRoot, "app", "apiary", "route.ts")), false);
  assert.equal(isApiPath(projectRoot, path.join(projectRoot, "app", "page.tsx")), false);
  assert.equal(isApiPath(projectRoot, path.join(projectRoot, "app", "api", "..", "page.tsx")), false);
  assert.equal(isApiPath("relative-root", path.join(projectRoot, "app", "api", "route.ts")), false);
});

test("API edits run lint and the full test suite in a fixed order", () => {
  const calls = [];
  const output = evaluatePostToolUse(
    hookInput(path.join(projectRoot, "app", "api", "clock", "route.ts")),
    {
      projectRoot,
      runCheck(args, cwd) {
        calls.push({ args, cwd });
        return { status: 0 };
      },
    },
  );

  assert.equal(output, null);
  assert.deepEqual(calls, [
    { args: ["run", "lint"], cwd: projectRoot },
    { args: ["test"], cwd: projectRoot },
  ]);
});

test("non-API edits do not run checks", () => {
  let calls = 0;
  const output = evaluatePostToolUse(hookInput(path.join(projectRoot, "app", "page.tsx")), {
    projectRoot,
    runCheck() {
      calls += 1;
      return { status: 0 };
    },
  });

  assert.equal(output, null);
  assert.equal(calls, 0);
});

test("failed checks block continuation without exposing command output", () => {
  const secretLikeOutput = "DATABASE_URL=postgres://example-secret";
  let call = 0;
  const output = evaluatePostToolUse(
    hookInput(path.join(projectRoot, "app", "api", "clock", "route.ts")),
    {
      projectRoot,
      runCheck() {
        call += 1;
        return call === 1 ? { status: 1, stdout: secretLikeOutput } : { status: 0 };
      },
    },
  );

  assert.equal(output.decision, "block");
  assert.match(output.reason, /npm run lint/);
  assert.doesNotMatch(output.reason, /DATABASE_URL|example-secret/);
});

test("invalid hook input fails closed", () => {
  for (const input of [
    null,
    {},
    { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: path.join(projectRoot, "app", "api", "route.ts") } },
    { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { file_path: path.join(projectRoot, "app", "api", "route.ts") } },
    { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: "app/api/route.ts" } },
  ]) {
    const output = evaluatePostToolUse(input, { projectRoot });
    assert.equal(output.decision, "block");
    assert.match(output.reason, /validation failed/i);
  }
});
