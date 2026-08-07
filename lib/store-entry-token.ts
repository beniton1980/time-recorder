import { createHash } from "node:crypto";

const storeTokenPattern = /^[A-Za-z0-9_-]{32,128}$/;

export function hashStoreEntryToken(token: unknown): string | null {
  if (typeof token !== "string" || !storeTokenPattern.test(token)) {
    return null;
  }

  return createHash("sha256").update(token, "utf8").digest("hex");
}
