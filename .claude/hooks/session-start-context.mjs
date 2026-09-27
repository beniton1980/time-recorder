import process from "node:process";

const sources = new Set(["startup", "resume", "clear", "compact", "fork"]);
// Always read before any change (Owner decision 2026-09-28: security standards every session).
const mandatoryPages = [
  ["07 | Security, privacy, and operations standards", "https://app.notion.com/p/3bbf4b5e813281e783a1eff8e46466b2"],
];
// Read only when the task touches what the page governs (AI co-development common rule v1.0, section 3).
const conditionalPages = [
  ["03 | Technical handoff for development AI", "https://app.notion.com/p/3b7f4b5e813281a883f3e79af1ddd15d",
    "when changing authentication, LIFF/LINE, QR, database or migrations, monthly reports, deployment, or when the current main/production state matters"],
  ["01 | Project Charter and business strategy", "https://app.notion.com/p/3b7f4b5e81328163a85df45df342153f",
    "when the task adds or changes a feature, product scope, Free/Paid boundary, or other business decision"],
  ["ONOGAMI Project Hub", "https://app.notion.com/p/3b7f4b5e813281468d31f6dc0d421ccb",
    "when you need the current status (00), roadmap (06), or another source-of-truth page"],
];

function normalContext() {
  const mandatory = mandatoryPages.map(([title, url]) => `- ${title}: ${url}`).join("\n");
  const conditional = conditionalPages.map(([title, url, when]) => `- ${title}: ${url} (${when})`).join("\n");
  return [
    "ONOGAMI session-start context (see AGENTS.md):",
    "Before changing code, configuration, data, deployments, or external systems, use the connected Notion tools to fetch and read this mandatory source-of-truth page in this session:",
    mandatory,
    "Also fetch and read each page below before work that falls under its condition. Do not read pages the task does not need:",
    conditional,
    "Use the current page contents, not remembered or copied summaries. Apply the strictest rule when sources differ and ask the Owner before making a material assumption.",
    "If a page you are required to read cannot be fetched, is ambiguous, or appears stale, do not make changes or trigger external side effects; explain the limitation and ask the Owner how to proceed.",
    "Never copy secret values, tokens, real LINE user IDs, exact GPS coordinates, or unnecessary personal data into prompts, logs, Notion, issues, or pull requests.",
  ].join("\n");
}

function failClosedContext() {
  return [
    "ONOGAMI SessionStart validation failed.",
    "Do not change code, configuration, data, deployments, or external systems.",
    "Tell the Owner that the mandatory 07 security context could not be initialized and ask how to proceed.",
  ].join("\n");
}

let input;
try {
  input = JSON.parse(await new Promise((resolve, reject) => {
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => resolve(raw));
    process.stdin.on("error", reject);
  }));
} catch {
  input = null;
}

const validInput = input?.hook_event_name === "SessionStart" && sources.has(input.source);
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: validInput ? normalContext() : failClosedContext(),
  },
}));
