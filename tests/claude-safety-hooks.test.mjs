import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const hookPath = ".claude/hooks/pretooluse-safety.mjs";

function evaluate(command, payload = null) {
  const input = payload ?? {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
  };
  const result = spawnSync(process.execPath, [hookPath], {
    cwd: process.cwd(),
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout ? JSON.parse(result.stdout).hookSpecificOutput : null;
}

test("Claude settings registers the Bash PreToolUse safety hook", () => {
  const settings = JSON.parse(readFileSync(".claude/settings.json", "utf8"));
  const entry = settings.hooks.PreToolUse[0];
  assert.equal(entry.matcher, "Bash");
  assert.equal(entry.hooks[0].command, `node ${hookPath}`);
});

test("dangerous commands are denied", () => {
  const commands = [
    "git push --force origin main",
    "git push origin main",
    "git push origin --delete old-branch",
    "git commit --amend --no-edit",
    "git rebase -i HEAD~2",
    "npx prisma migrate reset",
    "prisma db push",
    "psql -c 'DROP TABLE staff'",
    "psql -c 'ALTER TABLE staff DISABLE ROW LEVEL SECURITY'",
    "psql postgres://neondb_owner@example.neon.tech/neondb",
    "vercel deployment-protection disable",
    "curl https://api.resend.com/emails",
    "Invoke-WebRequest https://example.com/api/cron/monthly-attendance",
    "Get-Content .env.production",
    "printenv",
    "Write-Output $env:CRON_SECRET",
  ];

  for (const command of commands) {
    const decision = evaluate(command);
    assert.ok(decision, command);
    assert.equal(decision.permissionDecision, "deny", command);
  }
});

test("high-impact commands require human confirmation", () => {
  for (const command of ["git reset --hard HEAD~1", "vercel deploy --prod", "gh pr merge 123 --squash"]) {
    assert.equal(evaluate(command).permissionDecision, "ask", command);
  }
});

test("ordinary development commands remain unaffected", () => {
  const commands = [
    "git status",
    "git diff --check",
    "git push -u origin feature/claude-safety-hooks",
    "git branch -d merged-local-branch",
    "git log --oneline -5",
    "npm test",
    "npm run lint",
    "npx prisma migrate status",
    "npx prisma generate",
    "psql --version",
    "vercel inspect deployment-url",
    "gh pr view 100",
    "rg CRON_SECRET app tests",
    "Get-Content package.json",
  ];

  for (const command of commands) {
    assert.equal(evaluate(command), null, command);
  }
});

test("invalid or unexpected input fails closed", () => {
  assert.equal(evaluate("", "not-json").permissionDecision, "deny");
  assert.equal(evaluate("", { tool_name: "Bash", tool_input: {} }).permissionDecision, "deny");
});

