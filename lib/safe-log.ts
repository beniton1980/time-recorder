type SafeLogFields = {
  route?: string;
  durationMs?: number;
  lineVerificationMs?: number;
  databaseMs?: number;
};

function write(level: "info" | "error", event: string, fields: SafeLogFields = {}) {
  const entry = JSON.stringify({ level, event, ...fields });
  if (level === "error") console.error(entry);
  else console.log(entry);
}

export function logServerError(event: string, fields?: SafeLogFields) {
  write("error", event, fields);
}

export function logServerInfo(event: string, fields?: SafeLogFields) {
  write("info", event, fields);
}
