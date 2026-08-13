function isPreview() {
  return process.env.VERCEL_ENV === "preview";
}

function databaseHostname(databaseUrl) {
  try {
    return new URL(databaseUrl).hostname.toLowerCase();
  } catch {
    throw new Error("INVALID_DATABASE_URL");
  }
}

export function assertDatabaseEnvironmentSafety(databaseUrl) {
  if (!isPreview()) return;

  const productionHost = process.env.ONOGAMI_PRODUCTION_DATABASE_HOST
    ?.trim()
    .toLowerCase();
  if (
    process.env.ONOGAMI_PREVIEW_DATABASE_ISOLATED !== "true"
    || !productionHost
    || databaseHostname(databaseUrl) === productionHost
  ) {
    throw new Error("PREVIEW_DATABASE_NOT_ISOLATED");
  }
}

export function isEmailDeliveryAllowed() {
  return !isPreview() || process.env.ONOGAMI_PREVIEW_EMAIL_ENABLED === "true";
}
