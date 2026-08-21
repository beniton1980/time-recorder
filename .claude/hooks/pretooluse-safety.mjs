import process from "node:process";

// Defense in depth: Claude Code permissions and remote service protections remain the primary boundary.
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
const GIT_GLOBAL_OPTIONS = String.raw`(?:(?:(?:-c|-C|--git-dir|--work-tree|--namespace)\s+\S+|--(?:git-dir|work-tree|namespace)=\S+)\s+)*`;
const GIT_PREFIX = String.raw`(?:^|[\s;&|])git\s+${GIT_GLOBAL_OPTIONS}`;
const GIT_PUSH = new RegExp(`${GIT_PREFIX}push\\b[^\\r\\n]*`);

function normalizeCommand(raw) {
  return raw
    .toLowerCase()
    .replace(/[\u0000`]/g, "")
    .replace(/(["'])(?:[a-z]:[\\/]|\/)[^"'\r\n]*[\\/]git(?:\.exe)?\1/g, "git")
    .replace(/(?:[a-z]:[\\/]|\/)(?:[^\s;&|"']+[\\/])*git(?:\.exe)?/g, "git")
    .replace(
      /(^|[;&|]\s*)&\s*\$[a-z_][\w:]*\s+(?=(?:(?:(?:-c|-C|--git-dir|--work-tree|--namespace)\s+\S+|--(?:git-dir|work-tree|namespace)=\S+)\s+)*(?:push|filter-branch|filter-repo|replace|commit|rebase)\b)/g,
      "$1git ",
    )
    .replace(/[ \t]+/g, " ")
    .trim();
}

function isAmbiguousPush(command) {
  const push = command.match(GIT_PUSH)?.[0];
  if (!push) return false;

  const args = push.slice(push.search(/\bpush\b/) + "push".length).trim();
  if (!args) return true;
  const positional = args.split(/\s+/).filter((token) => !token.startsWith("-"));
  return positional.length <= 1;
}

const DENY_RULES = [
  [(command) => {
    const push = command.match(GIT_PUSH)?.[0];
    return Boolean(push && /(?:--force(?:-with-lease|-if-includes)?\b|-f(?:\s|$)|(?:^|\s)\+\S+)/.test(push));
  }, "Force-push is prohibited."],
  [(command) => {
    const push = command.match(GIT_PUSH)?.[0];
    return Boolean(push && /(?:^|\s)(?:\S+:)?(?:refs\/heads\/)?main(?:\s|$)/.test(push));
  }, "Direct pushes to main are prohibited; use a feature branch and PR."],
  [(command) => {
    const push = command.match(GIT_PUSH)?.[0];
    return Boolean(push && /(?:--delete(?:=|\b)|(?:^|\s)-d(?:\s|$)|(?:^|\s):\S+)/.test(push));
  }, "Deleting remote branches is prohibited."],
  [new RegExp(`${GIT_PREFIX}(?:filter-branch|filter-repo|replace|rebase)\\b|${GIT_PREFIX}commit\\b[^\\r\\n]*--amend\\b`), "Git history rewrites are prohibited."],
  [/(?:^|\s)(?:(?:npx|pnpm|yarn|bunx)\s+|npm\s+exec\s+)?prisma\s+(?:migrate\s+reset|db\s+push)\b/, "Destructive or schema-pushing Prisma commands are prohibited."],
  [(command) => /(?:^|\s)(?:psql|pgcli)\b/.test(command) && /\b(?:drop\s+(?:database|schema|table|view|role)|truncate\s+(?:table\s+)?|delete\s+from|alter\s+table\b[^;\r\n]*\bdisable\s+row\s+level\s+security)\b/.test(command), "Destructive SQL and RLS disabling are prohibited."],
  [/\bneondb_owner\b|\b(?:postgres_url_non_pooling|database_url_unpooled)\b/, "Owner database credentials must not be used."],
  [/(?:^|\s)(?:psql|pgcli)\b[^\r\n]*(?:neon\.tech|\bproduction\b|\bprod\b)/, "Direct production database connections are prohibited."],
  [/(?:^|\s)vercel\b[^\r\n]*(?:deployment-protection|protection-bypass|password-protection|sso-protection)/, "Vercel Deployment Protection changes are prohibited."],
  [/(?:curl(?:\.exe)?|wget|invoke-webrequest|invoke-restmethod|iwr|irm)\b[^\r\n]*(?:api\.resend\.com|\/api\/cron(?:\/|\b))/, "Manual Resend API and Cron endpoint calls are prohibited."],
  [/(?:^|[;&|]\s*)(?:cat|type|more|less|head|tail|get-content|gc)\s+[^\r\n;&|]*\.env(?:\.|\b)|(?:^|[;&|]\s*)(?:env|printenv|set)\s*(?:$|[;&|])|(?:^|\s)(?:echo|write-output)\s+[^\r\n]*(?:\$env:|\$\{?(?:database_url|resend_api_key|cron_secret|line_channel_secret|onogami_operator_line_user_ids)\}?|%(?:database_url|resend_api_key|cron_secret|line_channel_secret)%)/, "Printing environment files or secret values is prohibited."],
];

const ASK_RULES = [
  [isAmbiguousPush, "A push without an explicit refspec requires human confirmation."],
  [new RegExp(`${GIT_PREFIX}reset\\b[^\\r\\n]*--hard\\b`), "Hard reset requires explicit human confirmation."],
  [/(?:^|\s)vercel\s+(?:deploy\s+)?(?:--prod(?:uction)?\b|deploy\b[^\r\n]*--prod(?:uction)?\b)/, "Production deployment requires explicit human confirmation."],
  [/(?:^|\s)gh\s+pr\s+merge\b/, "PR merge requires explicit human confirmation."],
];

function output(permissionDecision, permissionDecisionReason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision,
      permissionDecisionReason,
    },
  }));
}

async function main() {
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;

  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    output("deny", "Safety hook received invalid JSON and failed closed.");
    return;
  }

  if (input?.hook_event_name !== "PreToolUse" || !SHELL_TOOLS.has(input?.tool_name) || typeof input?.tool_input?.command !== "string") {
    output("deny", "Safety hook received an unexpected tool payload and failed closed.");
    return;
  }

  const command = normalizeCommand(input.tool_input.command);

  for (const [matcher, reason] of DENY_RULES) {
    if (typeof matcher === "function" ? matcher(command) : matcher.test(command)) {
      output("deny", reason);
      return;
    }
  }

  for (const [matcher, reason] of ASK_RULES) {
    if (typeof matcher === "function" ? matcher(command) : matcher.test(command)) {
      output("ask", reason);
      return;
    }
  }

  // Do not auto-approve safe commands; defer to Claude Code's normal permission rules.
  process.exitCode = 0;
}

main().catch(() => {
  output("deny", "Safety hook failed unexpectedly and failed closed.");
});

