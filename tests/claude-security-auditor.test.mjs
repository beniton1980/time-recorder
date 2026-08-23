import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const agentPath = ".claude/agents/security-auditor.md";
const source = readFileSync(agentPath, "utf8");

function frontmatterValue(name) {
  return source.match(new RegExp(`^${name}:\\s*(.+)$`, "m"))?.[1]?.trim();
}

test("security auditor is a project-scoped read-only subagent", () => {
  assert.equal(frontmatterValue("name"), "security-auditor");
  assert.match(frontmatterValue("description"), /independently audits/i);
  assert.equal(frontmatterValue("tools"), "Read, Grep, Glob");
  assert.equal(frontmatterValue("model"), "inherit");
  assert.equal(frontmatterValue("permissionMode"), "plan");
  assert.equal(frontmatterValue("maxTurns"), "30");

  for (const disallowed of ["Bash", "PowerShell", "Edit", "Write", "Agent", "WebFetch"]) {
    assert.doesNotMatch(frontmatterValue("tools"), new RegExp(`\\b${disallowed}\\b`));
  }
});

test("security auditor fails closed without the full 07 standard and one scope", () => {
  assert.match(source, /3bbf4b5e813281e783a1eff8e46466b2/);
  assert.match(source, /full current content/i);
  assert.match(source, /AUDIT_BLOCKED/);
  assert.match(source, /Do not inspect the repository/i);

  for (const scope of [
    "public-api",
    "tokens-and-logs",
    "web-session",
    "authorization-e2e",
    "supply-chain-data",
  ]) {
    assert.ok(source.includes(`\`${scope}\``), scope);
  }
});

test("security auditor excludes implementation context and all mutations", () => {
  assert.match(source, /only policy and product-intent source/i);
  assert.match(source, /Do not inspect Git history, commits, pull requests/i);
  assert.match(source, /Notion pages 03, 06, or 10/i);
  assert.match(source, /Never edit, write, delete, rename, generate, install, execute, deploy, send, rotate, migrate/i);
  assert.match(source, /do not implement it/i);
});

test("security auditor uses the required finding format", () => {
  for (const severity of ["Critical", "High", "Medium", "Low"]) {
    assert.ok(source.includes(`\`${severity}\``), severity);
  }
  for (const timing of ["今すぐ", "公開前", "将来"]) {
    assert.ok(source.includes(`\`${timing}\``), timing);
  }
  for (const section of [
    "# Security audit result",
    "## Scope",
    "## 07 requirements checked",
    "## Findings",
    "## Unknowns requiring human or runtime verification",
    "## Out of scope",
    "## Counts",
  ]) {
    assert.ok(source.includes(section), section);
  }
  assert.match(source, /path:line/);
  assert.match(source, /No findings in the inspected scope\./);
});
