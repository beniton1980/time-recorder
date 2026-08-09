import {
  LineTokenVerificationError,
  verifyLineIdToken,
} from "@/lib/line/verify-id-token";
import { operatorLineUserIds } from "@/lib/onboarding/validation";

export class OperatorAccessError extends Error {
  constructor(
    public readonly code:
      | "ID_TOKEN_REQUIRED"
      | "INVALID_ID_TOKEN"
      | "OPERATOR_ACCESS_REQUIRED"
      | "OPERATOR_NOT_CONFIGURED",
  ) {
    super(code);
  }
}

export async function verifyOperator(idToken: unknown) {
  if (typeof idToken !== "string" || idToken.length === 0) {
    throw new OperatorAccessError("ID_TOKEN_REQUIRED");
  }

  const allowed = operatorLineUserIds();
  if (allowed.size === 0) {
    throw new OperatorAccessError("OPERATOR_NOT_CONFIGURED");
  }

  try {
    const identity = await verifyLineIdToken(idToken);
    if (!allowed.has(identity.sub)) {
      throw new OperatorAccessError("OPERATOR_ACCESS_REQUIRED");
    }
    return identity;
  } catch (error) {
    if (error instanceof OperatorAccessError) throw error;
    if (error instanceof LineTokenVerificationError) {
      throw new OperatorAccessError("INVALID_ID_TOKEN");
    }
    throw error;
  }
}

export function operatorErrorResponse(error: OperatorAccessError) {
  const status = error.code === "ID_TOKEN_REQUIRED"
    ? 400
    : error.code === "INVALID_ID_TOKEN"
      ? 401
      : error.code === "OPERATOR_ACCESS_REQUIRED"
        ? 403
        : 503;

  return { status, body: { ok: false, code: error.code } };
}
