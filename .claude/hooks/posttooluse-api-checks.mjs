import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const checks = [
  { label: "npm run lint", args: ["run", "lint"] },
  { label: "npm test", args: ["test"] },
];

function block(reason) {
  return { decision: "block", reason };
}

export function isApiPath(projectRoot, filePath) {
  if (!path.isAbsolute(projectRoot) || !path.isAbsolute(filePath)) return false;

  const apiRoot = path.resolve(projectRoot, "app", "api");
  const relative = path.relative(apiRoot, path.resolve(filePath));
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function runNpm(args, projectRoot) {
  const executable = process.platform === "win32" ? "npm.cmd" : "npm";
  return spawnSync(executable, args, {
    cwd: projectRoot,
    shell: process.platform === "win32",
    stdio: "ignore",
  });
}

export function evaluatePostToolUse(input, options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
  const runCheck = options.runCheck ?? runNpm;

  if (
    input?.hook_event_name !== "PostToolUse"
    || !["Edit", "Write"].includes(input?.tool_name)
    || typeof input?.tool_input?.file_path !== "string"
    || !path.isAbsolute(input.tool_input.file_path)
  ) {
    return block("ONOGAMI PostToolUse validation failed. Stop changes and ask the Owner.");
  }

  if (!isApiPath(projectRoot, input.tool_input.file_path)) return null;

  const failed = [];
  for (const check of checks) {
    const result = runCheck(check.args, projectRoot);
    if (result?.status !== 0) failed.push(check.label);
  }

  if (failed.length > 0) {
    return block(`Automatic API checks failed: ${failed.join(", ")}. Fix the edited API code and rerun the failing checks.`);
  }

  return null;
}

async function readInput() {
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
  return JSON.parse(raw);
}

async function main() {
  let input;
  try {
    input = await readInput();
  } catch {
    input = null;
  }

  const output = evaluatePostToolUse(input);
  if (output) process.stdout.write(JSON.stringify(output));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
