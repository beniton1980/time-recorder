import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { getSql } from "@/lib/db";
import { logServerError } from "@/lib/safe-log";

type RateLimitPolicy = {
  scope: string;
  limit: number;
  windowSeconds: number;
};

export const privateJsonHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
} as const;

function requestFingerprint(request: Request, value?: string) {
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = request.headers.get("x-real-ip") ?? forwardedFor ?? "unknown";
  return createHash("sha256")
    .update(value ?? ip, "utf8")
    .digest("hex");
}

async function consume(
  scope: string,
  fingerprintHash: string,
  limit: number,
  windowSeconds: number,
) {
  const sql = getSql();
  const result = await sql`
    SELECT * FROM consume_api_rate_limit(
      ${scope}, ${fingerprintHash}, ${limit}, ${windowSeconds}
    )
  `;
  return result[0] as Record<string, unknown> | undefined;
}

export async function enforceRateLimit(
  request: Request,
  policy: RateLimitPolicy,
  subject?: string,
) {
  let row: Record<string, unknown> | undefined;
  try {
    const clientRow = await consume(
      `${policy.scope}:client`,
      requestFingerprint(request),
      policy.limit * 10,
      policy.windowSeconds,
    );
    const subjectRow = subject
      ? await consume(
          `${policy.scope}:subject`,
          requestFingerprint(request, subject),
          policy.limit,
          policy.windowSeconds,
        )
      : undefined;
    row = clientRow?.allowed === false ? clientRow : subjectRow ?? clientRow;
  } catch {
    logServerError("api_rate_limit_check_failed");
    return NextResponse.json(
      { ok: false, code: "RATE_LIMIT_UNAVAILABLE" },
      { status: 503, headers: privateJsonHeaders },
    );
  }

  if (row?.allowed) return null;

  const retryAfter = Math.max(1, Number(row?.retry_after_seconds ?? policy.windowSeconds));
  return NextResponse.json(
    { ok: false, code: "RATE_LIMITED" },
    {
      status: 429,
      headers: {
        ...privateJsonHeaders,
        "Retry-After": String(retryAfter),
      },
    },
  );
}
