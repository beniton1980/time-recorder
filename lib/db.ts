import { neon } from "@neondatabase/serverless";
import { assertDatabaseEnvironmentSafety } from "@/lib/environment-safety.mjs";

export function getSql() {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not configured");
  }

  assertDatabaseEnvironmentSafety(databaseUrl);

  return neon(databaseUrl);
}
