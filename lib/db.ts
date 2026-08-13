import { neon } from "@neondatabase/serverless";
import { assertDatabaseEnvironmentSafety } from "@/lib/environment-safety.mjs";

export function getSql() {
  const databaseUrl =
    process.env.DATABASE_URL ??
    process.env.time_recorder_POSTGRES_URL_NON_POOLING;

  if (!databaseUrl) {
    throw new Error("A Neon database connection URL is not configured");
  }

  assertDatabaseEnvironmentSafety(databaseUrl);

  return neon(databaseUrl);
}
