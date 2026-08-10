import { NextResponse } from "next/server";
import { getSql } from "@/lib/db";
import {
  OperatorAccessError,
  operatorErrorResponse,
  verifyOperator,
} from "@/lib/onboarding/verify-operator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type DeleteRequest = {
  idToken?: unknown;
  requestId?: unknown;
  confirmationStoreName?: unknown;
};

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  let body: DeleteRequest;

  try {
    body = (await request.json()) as DeleteRequest;
  } catch {
    return NextResponse.json(
      { ok: false, code: "INVALID_JSON" },
      { status: 400 },
    );
  }

  if (typeof body.requestId !== "string" || !uuidPattern.test(body.requestId)) {
    return NextResponse.json(
      { ok: false, code: "INVALID_REQUEST_ID" },
      { status: 400 },
    );
  }

  if (
    typeof body.confirmationStoreName !== "string"
    || body.confirmationStoreName.trim().length === 0
    || body.confirmationStoreName.length > 200
  ) {
    return NextResponse.json(
      { ok: false, code: "STORE_NAME_CONFIRMATION_REQUIRED" },
      { status: 400 },
    );
  }

  try {
    await verifyOperator(body.idToken);
    const sql = getSql();
    const deleted = await sql`
      SELECT *
      FROM delete_onboarding_test_store(
        ${body.requestId}::uuid,
        ${body.confirmationStoreName.trim()}
      )
    `;

    return NextResponse.json({
      ok: true,
      deletedStore: {
        id: deleted[0].deleted_store_id,
        name: deleted[0].deleted_store_name,
      },
    });
  } catch (error) {
    if (error instanceof OperatorAccessError) {
      const response = operatorErrorResponse(error);
      return NextResponse.json(response.body, { status: response.status });
    }

    const message = error instanceof Error ? error.message : "";
    const knownCodes = [
      "ONBOARDING_REQUEST_NOT_FOUND",
      "TEST_STORE_NOT_PROVISIONED",
      "TEST_STORE_NOT_FOUND",
      "STORE_NAME_CONFIRMATION_MISMATCH",
      "TEST_STORE_HAS_ATTENDANCE_HISTORY",
    ];
    const code = knownCodes.find((candidate) => message.includes(candidate));

    if (code) {
      return NextResponse.json(
        { ok: false, code },
        {
          status: code === "ONBOARDING_REQUEST_NOT_FOUND"
            || code === "TEST_STORE_NOT_FOUND"
            ? 404
            : code === "STORE_NAME_CONFIRMATION_MISMATCH"
              ? 400
              : 409,
        },
      );
    }

    console.error("Onboarding test store deletion failed", {
      requestId: body.requestId,
      error: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      { ok: false, code: "TEST_STORE_DELETION_UNAVAILABLE" },
      { status: 503 },
    );
  }
}
