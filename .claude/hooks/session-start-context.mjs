import process from "node:process";

const sources = new Set(["startup", "resume", "clear", "compact", "fork"]);
const referencePages = [
  ["ONOGAMI Project Hub", "https://app.notion.com/p/3b7f4b5e813281468d31f6dc0d421ccb"],
  ["01 | Project Charter and business strategy", "https://app.notion.com/p/3b7f4b5e81328163a85df45df342153f"],
  ["03 | Technical handoff for development AI", "https://app.notion.com/p/3b7f4b5e813281a883f3e79af1ddd15d"],
  ["07 | Security, privacy, and operations standards", "https://app.notion.com/p/3bbf4b5e813281e783a1eff8e46466b2"],
];

function normalContext() {
  const pages = referencePages.map(([title, url]) => `- ${title}: ${url}`).join("\n");
  return [
    "ONOGAMI mandatory session-start context:",
    "Before changing code, configuration, data, deployments, or external systems, use the connected Notion tools to fetch and read every source-of-truth page below in this session:",
    pages,
    "Use the current page contents, not remembered or copied summaries. Apply the strictest rule when sources differ and ask the Owner before making a material assumption.",
    "If any page cannot be fetched, is ambiguous, or appears stale, do not make changes or trigger external side effects; explain the limitation and ask the Owner how to proceed.",
    "Never copy secret values, tokens, real LINE user IDs, exact GPS coordinates, or unnecessary personal data into prompts, logs, Notion, issues, or pull requests.",
  ].join("\n");
}

function failClosedContext() {
  return [
    "ONOGAMI SessionStart validation failed.",
    "Do not change code, configuration, data, deployments, or external systems.",
    "Tell the Owner that the mandatory Project Hub, 01, 03, and 07 context could not be initialized and ask how to proceed.",
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
