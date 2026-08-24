import {
  businessCategoryOptions,
  isOptionValue,
  priorAttendanceMethodOptions,
  reportedAcquisitionSourceOptions,
  staffCountRangeOptions,
  storeCountRangeOptions,
  type BusinessCategory,
  type PriorAttendanceMethod,
  type ReportedAcquisitionSource,
  type StaffCountRange,
  type StoreCountRange,
} from "@/lib/onboarding/business-attributes";

export const closingRules = ["month_end", "day_15", "day_25"] as const;

type ClosingRule = (typeof closingRules)[number];

export type OnboardingRequestInput = {
  clientRequestId: string;
  businessName: string;
  storeName: string;
  managerLegalName: string;
  contactEmail: string;
  storeAddress: string;
  businessCategory: BusinessCategory;
  staffCountRange: StaffCountRange;
  storeCountRange: StoreCountRange | null;
  priorAttendanceMethod: PriorAttendanceMethod;
  reportedAcquisitionSource: ReportedAcquisitionSource | null;
  timezone: "Asia/Tokyo";
  businessDayStartMinute: number;
  closingRule: ClosingRule;
};

type ValidationResult =
  | { ok: true; value: OnboardingRequestInput }
  | { ok: false; code: string };

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function clean(value: unknown, maxLength: number) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) return null;
  return normalized;
}

function cleanOptional(value: unknown, maxLength: number) {
  if (value === undefined || value === null || value === "") return null;
  return clean(value, maxLength);
}

export function validateOnboardingRequest(body: unknown): ValidationResult {
  if (!body || typeof body !== "object") {
    return { ok: false, code: "INVALID_REQUEST" };
  }

  const input = body as Record<string, unknown>;
  const clientRequestId = clean(input.clientRequestId, 36);
  const businessName = clean(input.businessName, 120);
  const storeName = clean(input.storeName, 120);
  const managerLegalName = clean(input.managerLegalName, 120);
  const contactEmail = clean(input.contactEmail, 254)?.toLowerCase() ?? null;
  const storeAddress = clean(input.storeAddress, 300);
  const businessCategory = clean(input.businessCategory, 50);
  const staffCountRange = clean(input.staffCountRange, 50);
  const storeCountRange = cleanOptional(input.storeCountRange, 50);
  const priorAttendanceMethod = clean(input.priorAttendanceMethod, 50);
  const reportedAcquisitionSource = cleanOptional(input.reportedAcquisitionSource, 50);
  const timezone = input.timezone ?? "Asia/Tokyo";
  const businessDayStartMinute = input.businessDayStartMinute ?? 300;
  const closingRule = input.closingRule ?? "month_end";

  if (!clientRequestId || !uuidPattern.test(clientRequestId)) {
    return { ok: false, code: "INVALID_CLIENT_REQUEST_ID" };
  }
  if (!businessName || !storeName || !managerLegalName || !storeAddress) {
    return { ok: false, code: "REQUIRED_FIELD_MISSING" };
  }
  if (!contactEmail || !emailPattern.test(contactEmail)) {
    return { ok: false, code: "INVALID_CONTACT_EMAIL" };
  }
  if (
    !isOptionValue(businessCategoryOptions, businessCategory)
    || !isOptionValue(staffCountRangeOptions, staffCountRange)
    || !isOptionValue(priorAttendanceMethodOptions, priorAttendanceMethod)
  ) {
    return { ok: false, code: "INVALID_BUSINESS_ATTRIBUTE" };
  }
  if (
    (storeCountRange !== null && !isOptionValue(storeCountRangeOptions, storeCountRange))
    || (
      reportedAcquisitionSource !== null
      && !isOptionValue(reportedAcquisitionSourceOptions, reportedAcquisitionSource)
    )
  ) {
    return { ok: false, code: "INVALID_BUSINESS_ATTRIBUTE" };
  }
  if (input.termsAccepted !== true) {
    return { ok: false, code: "TERMS_ACCEPTANCE_REQUIRED" };
  }
  if (timezone !== "Asia/Tokyo") {
    return { ok: false, code: "UNSUPPORTED_TIMEZONE" };
  }
  if (
    typeof businessDayStartMinute !== "number"
    || !Number.isInteger(businessDayStartMinute)
    || businessDayStartMinute < 0
    || businessDayStartMinute >= 1440
  ) {
    return { ok: false, code: "INVALID_BUSINESS_DAY_START" };
  }
  if (!closingRules.includes(closingRule as ClosingRule)) {
    return { ok: false, code: "INVALID_CLOSING_RULE" };
  }

  return {
    ok: true,
    value: {
      clientRequestId,
      businessName,
      storeName,
      managerLegalName,
      contactEmail,
      storeAddress,
      businessCategory,
      staffCountRange,
      storeCountRange,
      priorAttendanceMethod,
      reportedAcquisitionSource,
      timezone: "Asia/Tokyo",
      businessDayStartMinute,
      closingRule: closingRule as ClosingRule,
    },
  };
}

export function operatorLineUserIds() {
  return new Set(
    (process.env.ONOGAMI_OPERATOR_LINE_USER_IDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}
