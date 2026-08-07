import { neon } from "@neondatabase/serverless";

export function getSql() {
  const databaseUrl =
    process.env.DATABASE_URL ??
    process.env.time_recorder_POSTGRES_URL_NON_POOLING;

  if (!databaseUrl) {
    throw new Error("A Neon database connection URL is not configured");
  }

  return neon(databaseUrl);
}
