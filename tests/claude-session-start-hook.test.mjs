import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const hookPath = ".claude/hooks/session-start-context.mjs";

function runHook(input) {
  const result = spawnSync(process.execPath, [hookPath], {
    cwd: process.cwd(),
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).hookSpecificOutput;
}

test("Claude settings registers SessionStart for every session source", () => {
  const settings = JSON.parse(readFileSync(".claude/settings.json", "utf8"));
  const entry = settings.hooks.SessionStart[0];
  assert.equal(entry.matcher, "startup|resume|clear|compact|fork");
  assert.equal(entry.hooks[0].type, "command");
  assert.equal(entry.hooks[0].command, `node \"\${CLAUDE_PROJECT_DIR}/${hookPath}\"`);
});

test("SessionStart injects all mandatory Notion sources and safety rules", () => {
  const output = runHook({ hook_event_name: "SessionStart", source: "startup" });
  assert.equal(output.hookEventName, "SessionStart");

  for (const pageId of [
    "3b7f4b5e813281468d31f6dc0d421ccb",
    "3b7f4b5e81328163a85df45df342153f",
    "3b7f4b5e813281a883f3e79af1ddd15d",
    "3bbf4b5e813281e783a1eff8e46466b2",
  ]) {
    assert.match(output.additionalContext, new RegExp(pageId));
  }
  assert.match(output.additionalContext, /use the connected Notion tools to fetch and read every source-of-truth page/i);
  assert.match(output.additionalContext, /do not make changes or trigger external side effects/i);
  assert.match(output.additionalContext, /Never copy secret values/i);
});

test("SessionStart fails closed when its event input is invalid", () => {
  for (const input of ["not-json", {}, { hook_event_name: "PreToolUse", source: "startup" }, { hook_event_name: "SessionStart", source: "unknown" }]) {
    const output = runHook(input);
    assert.equal(output.hookEventName, "SessionStart");
    assert.match(output.additionalContext, /validation failed/i);
    assert.match(output.additionalContext, /Do not change code, configuration, data, deployments, or external systems/i);
  }
});
