import assert from "node:assert/strict";
import test from "node:test";

import { monthlyAttendanceDeliveryErrorCode } from "../lib/monthly-attendance-delivery-error.mjs";

test("delivery errors preserve only approved operational codes", () => {
  for (const code of [
    "EMAIL_NOT_CONFIGURED",
    "EMAIL_DELIVERY_FAILED",
    "PDF_REQUIRED",
    "MONTHLY_REPORT_EMAIL_NOT_CONFIGURED",
  ]) {
    assert.equal(monthlyAttendanceDeliveryErrorCode(new Error(code)), code);
  }
});

test("delivery errors do not persist secrets, PII, or internal details", () => {
  for (const error of [
    new Error("postgres://runtime:secret@example.invalid/database"),
    new Error("recipient staff@example.com failed"),
    new Error("token=raw-manager-invite-token"),
    "non-error value",
  ]) {
    assert.equal(monthlyAttendanceDeliveryErrorCode(error), "INTERNAL_PROCESSING_FAILED");
  }
});
